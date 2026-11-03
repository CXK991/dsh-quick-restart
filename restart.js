/**
 * dsh-quick-restart 的重启机制本体（宿主侧，纯 Node，无 Cordis 依赖）。
 *
 * 单独放一个文件是为了能脱离 DSH 单独测试：`planRestart()` 读当前进程状态，
 * `buildRestartScript()` 生成 PowerShell，`spawnRestartHelper()` 以脱离方式拉起助手。
 */
import { spawn } from 'node:child_process'
import { basename, dirname, join } from 'node:path'

/** 回完 HTTP 响应到真正动手之间的等待：让浏览器/渲染进程先收到 JSON。 */
export const KILL_DELAY_MS = 1200

/** 纯 Node 进程 = 命令行版（`dsh web`）；其他 = 桌面版 Electron 可执行文件。 */
const NODE_EXE = /^node(\.exe)?$/i

/**
 * 规划这次重启要杀谁、怎么拉起。
 * - desktop：按可执行文件名结束所有 DSH 进程，再启动同一个 exe。
 * - cli：结束本进程，再按同样的 node + argv 拉起。
 */
export function planRestart() {
  const exe = process.execPath
  const exeName = basename(exe)
  if (NODE_EXE.test(exeName)) {
    return {
      mode: 'cli',
      exe,
      workdir: process.cwd(),
      argv: process.argv.slice(1),
      killPid: process.pid,
      processName: undefined,
    }
  }
  return {
    mode: 'desktop',
    exe,
    workdir: dirname(exe),
    argv: [],
    killPid: process.ppid,
    processName: exeName.replace(/\.exe$/i, ''),
  }
}

/** PowerShell 单引号字符串字面量（内部单引号翻倍）。 */
export function psString(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

/** Windows 命令行参数引用：含空白或引号的参数自己包一层双引号。 */
export function windowsArgument(value) {
  const text = String(value)
  if (!/[\s"]/u.test(text)) return text
  return `"${text.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/u, '$1$1')}"`
}

/** 系统自带的 Windows PowerShell（写死路径，不靠 PATH 解析）。 */
function systemPowerShell() {
  const root = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows'
  return join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

/**
 * 生成重启脚本。四个实测约束（2026-11-03 本机复现）：
 *
 * 1. **不能按进程树杀**（`taskkill /T`）：助手本身就是 DSH 的后代，按树杀会把它一起带走。
 *    按**进程名**结束则只命中 DSH。
 * 2. **不能 `detached` 直起 powershell**：它会 ~150ms 内 `exit 0` 且一行脚本都不执行
 *    （powershell 是控制台宿主，DETACHED_PROCESS / 无控制台创建时启动即静默退出）。
 *    所以外层用 detached 的 `cmd.exe` 兜一层（见 spawnRestartHelper）。
 * 3. **不能用 `Start-Process` 拉起新实例**：在"detached cmd + 隐藏控制台"的助手里会
 *    直接死掉（走 ShellExecute，需要窗口站；本机 4/4 复现）。改用 .NET
 *    `ProcessStartInfo`（`UseShellExecute=false`，走 CreateProcess），实测 3/3 成功。
 * 4. **必须去掉 `ELECTRON_RUN_AS_NODE`**：DSH 的 host 是 Electron 主进程用
 *    `ELECTRON_RUN_AS_NODE=1` 起的，这个环境变量会一路继承到助手和新实例；
 *    带着它启动 `DeepSeek Harness.exe`，Electron 会按 Node 模式跑、**不建窗口**，
 *    于是"DSH 关了但永远不回来"。新实例必须像用户手动双击那样启动。
 *
 * @param {object} plan planRestart() 的返回值
 * @param {number} delayMs 推迟多久动手
 */
export function buildRestartScript(plan, delayMs) {
  const trace = `'--- ' + (Get-Date -Format o) + ' mode=${plan.mode} pid=' + $PID`
  const lines = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$logFile = Join-Path $env:TEMP 'dsh-quick-restart.log'`,
    'function Trace($m) { ($m) | Out-File -FilePath $logFile -Append -Encoding utf8 }',
    `Trace (${trace})`,
    `Start-Sleep -Milliseconds ${String(delayMs)}`,
  ]

  if (plan.mode === 'desktop') {
    lines.push(
      `$procName = ${psString(plan.processName)}`,
      '$targets = @(Get-Process -Name $procName -ErrorAction SilentlyContinue)',
      `Trace ('targets=' + $targets.Count)`,
      'if ($targets.Count -gt 0) { $targets | Stop-Process -Force -ErrorAction SilentlyContinue }',
      'for ($i = 0; $i -lt 100; $i++) { if (-not (Get-Process -Name $procName -ErrorAction SilentlyContinue)) { break }; Start-Sleep -Milliseconds 100 }',
      'Start-Sleep -Milliseconds 500',
    )
  } else {
    lines.push(
      `$targetPid = ${String(plan.killPid)}`,
      'Stop-Process -Id $targetPid -Force -ErrorAction SilentlyContinue',
      'for ($i = 0; $i -lt 100; $i++) { if (-not (Get-Process -Id $targetPid -ErrorAction SilentlyContinue)) { break }; Start-Sleep -Milliseconds 100 }',
      'Start-Sleep -Milliseconds 400',
    )
  }

  lines.push(
    `Trace 'killed'`,
    '$psi = New-Object System.Diagnostics.ProcessStartInfo',
    `$psi.FileName = ${psString(plan.exe)}`,
    `$psi.WorkingDirectory = ${psString(plan.workdir)}`,
  )
  if (plan.mode !== 'desktop') {
    const argumentsText = plan.argv.map(windowsArgument).join(' ')
    if (argumentsText !== '') lines.push(`$psi.Arguments = ${psString(argumentsText)}`)
  }
  lines.push(
    '$psi.UseShellExecute = $false',
    '$psi.CreateNoWindow = $true',
    '$psi.EnvironmentVariables.Remove(\'ELECTRON_RUN_AS_NODE\')',
    'try {',
    '  [System.Diagnostics.Process]::Start($psi) | Out-Null',
    "  Trace 'launched'",
    '} catch {',
    "  Trace ('launch failed: ' + ($_ | Out-String))",
    '}',
  )

  return lines.join('\n')
}

/**
 * 以"脱离 + 有控制台"的方式启动重启助手（仅 Windows）。返回启动器 PID（只用于日志）。
 *
 * 通道：node --(detached)--> cmd.exe --(普通创建)--> powershell.exe
 *   - detached 的 `cmd.exe` 自己能正常跑（detached 的 powershell 不行，见上）；
 *   - cmd 再普通创建 powershell，powershell 就能拿到控制台并真正执行；
 *   - cmd 是 detached 的，因此助手**不会**在 DSH 被杀时被连带带走。
 *
 * 备查：attached 的 powershell 发射器 + `Start-Process -WindowStyle Hidden` 也可行，
 * 但要求父进程再活 ~0.5–1s 让发射器完成交接，时序余量更小，故不采用。
 *
 * @throws 平台不支持或 spawn 立刻失败时抛出
 */
export function spawnRestartHelper(plan, delayMs = KILL_DELAY_MS) {
  if (process.platform !== 'win32') {
    throw new Error('快速重启目前只支持 Windows 桌面版 DSH')
  }
  const script = buildRestartScript(plan, delayMs)
  // EncodedCommand 用 UTF-16LE base64：绕开一切引号/换行/中文转义问题，
  // 顺带保证这一整行里没有 cmd.exe 会咬的 & | ^ 之类字符。
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  // ⚠️ 这一行最终交给 `cmd /d /s /c` 执行，首尾引号会被 cmd 吃掉：
  //    可执行文件路径**不要**加引号（%SystemRoot% 展开后没有空格），否则整行解析错位，
  //    表现为"助手进程起来了但一行都没执行"。
  const command = `${systemPowerShell()} -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}`
  const child = spawn('cmd.exe', ['/d', '/s', '/c', command], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()
  return child.pid
}
