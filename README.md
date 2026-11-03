# @cxk9911/dsh-quick-restart · 一键重启 DSH

[![npm](https://img.shields.io/npm/v/@cxk9911/dsh-quick-restart)](https://www.npmjs.com/package/@cxk9911/dsh-quick-restart)
[![license](https://img.shields.io/npm/l/@cxk9911/dsh-quick-restart)](LICENSE)
[![GitHub](https://img.shields.io/github/stars/CXK991/dsh-quick-restart)](https://github.com/CXK991/dsh-quick-restart)

**侧边栏左下角（设置按钮正上方）多一个「重启 DSH」按钮：点一下、确认一次，DSH 自动关闭并重新启动。**

把「改完东西要重启 DSH」从"找托盘 → 退出 → 再双击打开"变成一次点击。适用于折腾插件、
改配置、装 bundle 之后需要重启宿主的场景。

> One-click restart for [DeepSeek Harness](https://github.com/deepseek-ai): a button above
> **Settings** in the sidebar footer. Click → confirm → the app closes and starts again by itself.
> Built for the Windows desktop app; Windows-only auto-restart.

## 安装

**方式一：命令行（npm，推荐）**

```sh
# 桌面版（profile 名通常是 desktop）
dsh plugin --profile desktop add @cxk9911/dsh-quick-restart

# dsh web
dsh plugin --profile web add @cxk9911/dsh-quick-restart
```

也可以在 **设置 → 插件 → 安装** 里直接填包名 `@cxk9911/dsh-quick-restart`。

**方式二：官方 Discover（自建索引源，零审核）**

> 本插件**还没有收录进** dsh-market 的社区目录（同类重启插件已有多个），因此市场搜索里找不到；
> 想从 Discover 装的话，加一份索引源即可：

1. 先在 **Plugins → Experimental plugins → More** 打开 **Custom plugin markets**，出现 **Discover** 标签；
2. **Discover → Add index source**，粘贴下面任一地址：

```
https://cdn.jsdelivr.net/npm/@cxk9911/dsh-quick-restart/index.json
https://raw.githubusercontent.com/CXK991/dsh-quick-restart/main/index.json
```

**方式三：在本机开发/试用（link 安装）**

```sh
dsh plugin --profile desktop add "link:/path/to/dsh-quick-restart"
```

装完后**重启一次 DSH**（或让插件管理器触发 profile 重载），侧边栏底部就会出现按钮。

## 使用

1. 侧边栏**左下角**、设置按钮**正上方**，点 **「重启 DSH」**。
2. 确认框里点 **「立即重启」**。
3. DSH 关闭 → 助手等 1.2 秒 → 结束 DSH 进程 → 重新启动同一个可执行文件 → 窗口自己回来。

> 侧边栏收起时，Windows 桌面版的 shell 会把整个 sidebar 底部区域隐藏
> （`[data-windows-titlebar] [data-sidebar-collapsed] .footArea{display:none}`），
> 所以按钮在收起状态下**不显示**；展开侧边栏即可看到。Web / macOS 的收起态会显示成单个图标。

## 它长在哪

| 文件 | 位置 / 职责 |
|---|---|
| `client.js` | 客户端：`sidebar.footer.action`（设置上方的按钮）+ `shell.overlay`（确认浮层、重启中提示） |
| `index.js` | 宿主：`GET/POST /dsh-quick-restart/api/restart`；先回响应，再拉起助手重启 DSH |
| `restart.js` | 宿主：重启机制本体（可脱离 DSH 单独测试） |

流程：`确认` → `POST` → 宿主回 `{ok, protocol, bootId, mode}` → 助手等 1.2 秒 → 按进程名结束 DSH →
等它真的退出 → 启动同一个 exe。桌面窗口会自己重开，新窗口里是**新进程**（`bootId` 变了）。

## 重启是怎么做到的（四条实测结论，2026-11-03 本机复现）

宿主是 Electron 主进程的子进程，主进程没有对插件开放"重启" IPC（`重启应用与 Host`
菜单项只在开发版出现），所以走"外部拉起"：

1. **不能按进程树杀**（`taskkill /T`）。助手本身就是 DSH 的后代，按树杀会把它一起带走。
   按**进程名**（可执行文件名）结束则只命中 DSH：`Stop-Process -Name 'DeepSeek Harness'`。
2. **不能 `detached` 直起 powershell**。`spawn('powershell.exe', …, {detached:true})` 会在
   ~150ms 内 `exit 0` 且**一行脚本都不执行** —— powershell.exe 是控制台宿主，被
   DETACHED_PROCESS / 无控制台创建时启动即静默退出（与引号、base64 无关；attached
   直起同样命令就正常）。可用通道是加一层 `cmd.exe`：
   `node --(detached)--> cmd.exe --(普通创建)--> powershell.exe`。
3. **不能用 `Start-Process` 拉起新实例**。在"detached cmd + 隐藏控制台"的助手里，
   PowerShell 走到 `Start-Process`（走 ShellExecute，需要窗口站）会**直接死掉**（本机 4/4 复现）。
   改用 .NET `[System.Diagnostics.Process]::Start($psi)` + `$psi.UseShellExecute = $false`
   （走 CreateProcess），实测 3/3 成功。
4. **必须去掉 `ELECTRON_RUN_AS_NODE`**。DSH 的 host 是 Electron 主进程用
   `ELECTRON_RUN_AS_NODE=1` 起的，这个变量会一路继承到助手和新实例；带着它启动
   `DeepSeek Harness.exe`，Electron 会按 **Node 模式**跑、**不建窗口** —— 表现为
   "DSH 关了，但永远不回来"。所以脚本在启动新实例前显式
   `$psi.EnvironmentVariables.Remove('ELECTRON_RUN_AS_NODE')`。

助手脚本用 `-EncodedCommand`（UTF-16LE base64）传入，绕开所有引号/换行/中文转义问题；
运行时会把 `--- / targets= / killed / launched` 几步写到 `%TEMP%\dsh-quick-restart.log`，
方便出问题时看一眼卡在哪步。

**代码版本握手**：`GET` 会返回 `protocol`（当前 2）。前端在真正 `POST` 之前先 GET 一次，
版本对不上就**拒绝触发**并提示"先手动重开一次 DSH" —— 因为插件代码更新后，运行中的
DSH 进程可能还加载着旧版插件（旧版没有第 4 条修法），那时按下去就会变成"DSH 关了不回来"。

> 助手进程链：`cmd.exe`（detached）→ `powershell.exe`。注意这一行最终交给
> `cmd /d /s /c` 执行，**可执行文件路径不能加引号**，否则 cmd 会把首尾引号吃掉、
> 整行解析错位（表现同样是"助手起来了但一行都没执行"）。

> `dsh web` 命令行版也留了兜底：`process.execPath` 是 `node` 时，按同样的 node + argv
> 重新拉起（杀本进程 PID）。这条路径**没有实测过**（同一时间只能跑一个 DSH 实例），
> 桌面版才是主路径。

## 验证记录

**已验证**（假进程沙箱：把 node.exe 复制成 `DummyApp.exe` 当"假 DSH"，用插件自己的
`restart.js` 拉起助手，父进程**立刻退出**，并故意在环境里放 `ELECTRON_RUN_AS_NODE=1`
模拟真实 host）：

```
3/3 通过：oldAlive=false  bootLines=2  flags=1 -> unset  ticksAfterRestart=20  live=[新 PID]
helperLog: --- mode=desktop pid=… / targets=1 / killed / launched
```

即：旧实例被杀 → 新实例真被拉起来并持续运行 → 新实例的环境里 `ELECTRON_RUN_AS_NODE`
已被去掉（专门防"重启后没有窗口"）→ 助手自己退干净。

另外验证：插件安装后 `fiberPhase=active`；路由在（未登录请求被 DSH 信任栅栏 401 拒绝，
不存在的路径 404）；三个 JS 文件 `node --check` 通过；JSON/YAML/icon 合法。

**未验证**：真的重启一次桌面版 DSH（会中断当前会话）；按钮/确认框的实际渲染
（无浏览器控制能力，slot 写法与在本机正常工作的 `study-desk` / `dsh-bili-whale` 同形）。

## 限制

- 只在 **Windows 桌面版**能自动重启；非 Windows 平台返回明确错误，不会静默失败。
- 正在跑的任务会被中断（会话记录落盘，不会丢）；**非同名子进程**（MCP server、PTY 里的
  bash 等）不会被按名杀掉，可能成为孤儿进程，重启后可能重复起一份。
- 桌面版宿主用 `--port 0` **随机端口**：重启后端口会变。桌面窗口自己重开没问题；
  如果你是在浏览器里开的网页版，旧标签页连不回去，要回到桌面窗口。
- 重新拉起时**不带启动参数**（当前桌面版就是空参数启动；自定义参数启动的情况不会复现）。
- 接口只对本机已登录页面放行（`ctx.connection.requestRejection`，不可用时 fail-closed）；
  20 秒冷却窗口防止连点，窗口过后允许重试（万一助手没起来不会被永久锁死）。

## 开发

```sh
# 本机 link 安装（改完代码由 plugin_manager / HMR 的 profile 重载生效，不必重启 DSH）
dsh plugin --profile desktop add "link:D:/Cagent/dsh-quick-restart"
```

包结构：`index.js`（宿主）+ `client.js`（客户端）, `restart.js`（重启机制）, `cordis.patch.yml`
（bundle patch）, `locale/`（中英元数据与界面文案）, `icon.svg`。

改代码后如需重新加载：

```
plugin_manager: action=set_plugin, target=include:dsh-quick-restart, enabled=false
plugin_manager: action=set_plugin, target=include:dsh-quick-restart, enabled=true
```

## License

[MIT](LICENSE) © 2026 CXK991
