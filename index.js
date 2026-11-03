/**
 * dsh-quick-restart —— 宿主半边。
 *
 * 只做一件事：提供 `POST /dsh-quick-restart/api/restart`。
 * 收到请求后先回响应，再 spawn 一个**脱离当前 DSH 进程**的 PowerShell 小助手，
 * 由它在约 1.2 秒后把 DSH 关掉并重新拉起（机制本体见 restart.js）。
 *
 * 为什么必须"脱离"：重启要从 DSH 内部杀掉 DSH 自己，助手如果是当前进程的
 * 子孙且按进程树杀，就会跟着一起被结束掉。
 *
 * 为什么不用 Electron 的 `app.relaunch()`：宿主是 Electron 主进程的子进程，
 * 主进程没有对插件开放"重启"IPC（`重启应用与 Host` 菜单项只在开发版出现）。
 */
import { planRestart, spawnRestartHelper } from './restart.js'

const ROUTE_PATH = '/dsh-quick-restart/api/restart'
/** 接口协议版本：前端用它确认"宿主跑的是同一代代码"（插件代码更新后，旧进程还在跑旧代码时拒绝触发）。 */
const PROTOCOL = 2

/** 重启冷却窗口：窗口内重复 POST 返回 409；窗口过后允许重试 —— 万一助手没起来，
 *  用户不会被一个永久 `true` 锁死（助手正常工作时进程已经死了，这个状态自然清零）。 */
const RESTART_COOLDOWN_MS = 20000
/** 上次触发重启的时间戳（0 = 本次运行还没触发过）。 */
let lastRestartAt = 0
/** 本次 DSH 运行的随机标识：重启后是新进程，它必然变化。前端靠它认出新实例。 */
const BOOT_ID = `${String(Date.now())}-${Math.random().toString(36).slice(2, 10)}`

function respondJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

/** 冷却窗口还剩多少毫秒（0 = 现在允许再触发一次）。 */
function cooldownRemaining() {
  if (lastRestartAt === 0) return 0
  return Math.max(0, RESTART_COOLDOWN_MS - (Date.now() - lastRestartAt))
}

/**
 * 沿用 DSH 自己的信任栅栏：只认 `connection.requestRejection` 的判定（Host 白名单 +
 * 登录态），任一环节不可用时 fail-closed。
 * @returns {undefined | { status: number, reason: string }} 拒绝原因；放行时为 undefined。
 */
function requestRejection(ctx, req) {
  try {
    const connection = ctx.connection ?? (typeof ctx.get === 'function' ? ctx.get('connection') : undefined)
    if (connection === undefined || connection === null) {
      return { status: 503, reason: 'DSH 的连接服务不可用，拒绝访问（fail-closed）' }
    }
    if (typeof connection.requestRejection !== 'function') {
      return { status: 503, reason: 'DSH 的信任栅栏不可用，拒绝访问（fail-closed）' }
    }
    const code = connection.requestRejection(req)
    if (code === undefined || code === null || code === false) return undefined
    return { status: typeof code === 'number' ? code : 403, reason: '请求未通过 DSH 的登录态校验' }
  } catch (error) {
    return { status: 503, reason: `信任校验异常，拒绝访问：${String(error?.message ?? error)}` }
  }
}

export default {
  name: 'dsh-quick-restart',
  inject: ['webServer', 'connection'],
  apply(ctx) {
    ctx.effect(
      () =>
        ctx.webServer.register({
          kind: 'exact',
          path: ROUTE_PATH,
          handler: async (req, res) => {
            const rejection = requestRejection(ctx, req)
            if (rejection !== undefined) {
              respondJson(res, rejection.status, { ok: false, error: rejection.reason })
              return
            }

            // GET：只报身份和计划，不动任何进程（自检 / 前端轮询用）。
            if (req.method === 'GET') {
              let plan
              try {
                plan = planRestart()
              } catch (error) {
                respondJson(res, 500, { ok: false, error: String(error?.message ?? error) })
                return
              }
              respondJson(res, 200, {
                ok: true,
                protocol: PROTOCOL,
                bootId: BOOT_ID,
                mode: plan.mode,
                exe: plan.exe,
                killPid: plan.killPid,
                restarting: cooldownRemaining() > 0,
                cooldownRemainingMs: cooldownRemaining(),
              })
              return
            }

            if (req.method !== 'POST') {
              respondJson(res, 405, { ok: false, error: '只接受 GET / POST' })
              return
            }
            const remaining = cooldownRemaining()
            if (remaining > 0) {
              respondJson(res, 409, {
                ok: false,
                error: '已经在重启了',
                cooldownRemainingMs: remaining,
              })
              return
            }

            let plan
            try {
              plan = planRestart()
              const helperPid = spawnRestartHelper(plan)
              lastRestartAt = Date.now()
              console.info(
                `[dsh-quick-restart] ${plan.mode} 重启已排队：kill=${String(plan.killPid)} launcher=${String(helperPid)} exe=${plan.exe}`,
              )
            } catch (error) {
              lastRestartAt = 0
              respondJson(res, 500, { ok: false, error: String(error?.message ?? error) })
              return
            }

            respondJson(res, 200, {
              ok: true,
              protocol: PROTOCOL,
              bootId: BOOT_ID,
              mode: plan.mode,
              message: '正在重启 DSH…',
            })
          },
        }),
      'dsh-quick-restart: restart route',
    )
  },
}
