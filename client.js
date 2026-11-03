/**
 * dsh-quick-restart —— 客户端半边。
 *
 * 侧边栏左下角（设置按钮上方，`sidebar.footer.action`）一个「重启 DSH」按钮；
 * 按下后弹确认框（`shell.overlay` 浮层），确认 → POST 宿主接口 →
 * 桌面版 DSH 会被关掉重新拉起，新窗口自己回来。
 *
 * 数据流：按钮 → 确认框 → POST /dsh-quick-restart/api/restart →（宿主半边）
 *         PowerShell 助手杀进程并重新拉起。
 */
window.__ModuleLoader__.load({
  id: '@cxk991/dsh-quick-restart',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useRef } = React

    const NS = 'quick-restart'
    const API = '/dsh-quick-restart/api/restart'
    /** 宿主接口协议版本；与 index.js 的 PROTOCOL 必须一致。 */
    const EXPECTED_PROTOCOL = 2
    /** 桌面版页面会在 ~1.2s 后被一起关掉，所以不需要真等；CLI 版才轮询。 */
    const POLL_TIMEOUT_MS = 20000

    const zh = {
      action: '重启 DSH',
      confirmTitle: '重启 DSH？',
      confirmBody: 'DSH 会立即关闭并重新启动。正在跑的任务会中断，会话记录不会丢。',
      cancel: '取消',
      confirm: '立即重启',
      restarting: '正在重启 DSH…',
      restartingHint: '窗口会自动重开，等它自己回来就好。',
      waitingHint: '已发出重启指令，正在等新的 DSH 起来…',
      failedTitle: '重启没能发起',
      stale: '插件代码刚更新过，但当前 DSH 进程还在跑旧版插件。请先手动退出并重开一次 DSH（托盘 → 退出），之后这个按钮就正常了。',
      gaveUpTitle: '没等到 DSH 回来',
      gaveUp: '桌面版窗口通常会自己重开。如果你是在浏览器里开的网页版：重启后端口会变，请回到桌面窗口。',
      close: '关闭',
      retry: '重试',
    }
    const en = {
      action: 'Restart DSH',
      confirmTitle: 'Restart DSH?',
      confirmBody: 'DSH will close and start again immediately. Running tasks are interrupted; session history is kept.',
      cancel: 'Cancel',
      confirm: 'Restart now',
      restarting: 'Restarting DSH…',
      restartingHint: 'The window reopens by itself — just wait for it.',
      waitingHint: 'Restart requested. Waiting for the new DSH to come back…',
      failedTitle: 'Could not start the restart',
      stale: 'The plugin was updated but this DSH process still runs the older plugin code. Quit and reopen DSH once, then this button works normally.',
      gaveUpTitle: 'DSH did not come back',
      gaveUp: 'The desktop window usually reopens by itself. If you opened the Web GUI in a browser, its port changes on restart — return to the desktop window.',
      close: 'Close',
      retry: 'Retry',
    }

    function isChinese() {
      try {
        const language = document.documentElement.lang || navigator.language || ''
        return String(language).toLowerCase().startsWith('zh')
      } catch {
        return true
      }
    }

    let translate = (key) => (isChinese() ? zh[key] : en[key]) ?? zh[key] ?? key

    // ------------------------------------------------------------------
    // 极简共享状态：页脚按钮和浮层确认框是两个不同 slot 的注册，靠它互通。
    // ------------------------------------------------------------------
    let view = { open: false, phase: 'idle', error: '' }
    const listeners = new Set()

    function patchView(next) {
      view = { ...view, ...next }
      for (const listener of [...listeners]) {
        try {
          listener()
        } catch {
          /* 一个订阅者出错不影响其他订阅者 */
        }
      }
    }

    function useView() {
      const [, force] = React.useState(0)
      useEffect(() => {
        const listener = () => force((value) => value + 1)
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      }, [])
      return view
    }

    function sleep(ms) {
      return new Promise((resolve) => window.setTimeout(resolve, ms))
    }

    // ------------------------------------------------------------------
    // 重启流程
    // ------------------------------------------------------------------
    async function requestRestart() {
      patchView({ phase: 'restarting', error: '' })

      // 先握手：确认宿主跑的是同一代插件代码。
      // 插件代码刚更新、进程还活着旧代码时，绝不能真的按下重启 —— 旧代码会带着
      // ELECTRON_RUN_AS_NODE 拉起 DSH，结果是"关了但窗口不回来"。
      let probeResponse
      let probe
      try {
        probeResponse = await fetch(API, {
          method: 'GET',
          headers: { accept: 'application/json' },
          cache: 'no-store',
        })
        probe = await probeResponse.json().catch(() => null)
      } catch (error) {
        patchView({ phase: 'failed', error: String(error?.message ?? error) })
        return
      }
      if (!probeResponse.ok) {
        patchView({ phase: 'failed', error: `HTTP ${probeResponse.status}` })
        return
      }
      if (!probe || probe.protocol !== EXPECTED_PROTOCOL) {
        patchView({ phase: 'failed', error: translate('stale') })
        return
      }

      let response
      let payload
      try {
        response = await fetch(API, {
          method: 'POST',
          headers: { accept: 'application/json' },
          cache: 'no-store',
        })
        payload = await response.json().catch(() => null)
      } catch (error) {
        // 桌面窗口里请求可能被"关掉 DSH"打断 —— 那正常，重启已经上路。
        patchView({ phase: 'restarting' })
        return
      }

      if (!response.ok) {
        patchView({
          phase: 'failed',
          error: `HTTP ${response.status}${payload && payload.error ? ` · ${String(payload.error)}` : ''}`,
        })
        return
      }
      if (payload && payload.ok === false) {
        patchView({ phase: 'failed', error: String(payload.error ?? 'unknown error') })
        return
      }

      if (payload && payload.mode === 'desktop') {
        // 桌面版：十几秒内整个窗口就会被关掉重开，这里不需要轮询。
        patchView({ phase: 'restarting' })
        return
      }
      await waitForReturn(payload?.bootId)
    }

    /** 轮询宿主接口，直到看到"另一个 bootId"——那才是新起来的 DSH（CLI 版才会走到这里）。 */
    async function waitForReturn(previousBootId) {
      const startedAt = Date.now()
      patchView({ phase: 'waiting' })
      await sleep(1500) // 先让旧实例真的死掉，避免把旧响应当成"回来了"
      while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
        try {
          const response = await fetch(API, {
            method: 'GET',
            headers: { accept: 'application/json' },
            cache: 'no-store',
          })
          if (response.ok) {
            const info = await response.json().catch(() => null)
            const bootId = String(info?.bootId ?? '')
            if (info?.ok === true && bootId !== '' && bootId !== String(previousBootId ?? '')) {
              window.location.reload()
              return
            }
          }
        } catch {
          /* 端口关着 —— 继续等 */
        }
        await sleep(700)
      }
      patchView({ phase: 'gaveUp' })
    }

    /** 关闭浮层只影响显示：POST 已经发出，重启不会被取消。 */
    function closeDialog() {
      patchView({ open: false, phase: 'idle', error: '' })
    }

    // ------------------------------------------------------------------
    // 样式与图标
    // ------------------------------------------------------------------
    const CSS = [
      '.dqr-foot{box-sizing:border-box;display:flex;align-items:center;gap:8px;height:36px;margin:0 2px;padding:7px 8px;border:none;border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:22px;text-align:left;cursor:pointer;flex:1;min-width:0}',
      '.dqr-foot:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dqr-foot:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}',
      '.dqr-foot--rail{flex:none;width:36px;height:36px;justify-content:center;padding:0;margin:0}',
      '.dqr-foot-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dqr-glyph{flex:none;display:inline-flex;align-items:center;justify-content:center}',
      '.dqr-overlay{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.42)}',
      '.dqr-dialog{box-sizing:border-box;width:min(420px,100%);padding:20px 22px 18px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);box-shadow:0 18px 48px rgba(0,0,0,.28);font-size:14px;line-height:22px}',
      '.dqr-title{margin:0 0 8px;font-size:16px;font-weight:600;line-height:24px}',
      '.dqr-body{margin:0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}',
      '.dqr-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:18px}',
      '.dqr-btn{height:32px;padding:0 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;cursor:pointer}',
      '.dqr-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dqr-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.dqr-btn--danger{color:var(--dsw-alias-state-error-primary)}',
      '.dqr-progress{display:flex;align-items:center;gap:10px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}',
      '.dqr-spin{width:16px;height:16px;flex:none;border-radius:50%;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-brand-primary);animation:dqr-spin .8s linear infinite}',
      '@keyframes dqr-spin{to{transform:rotate(360deg)}}',
      '.dqr-error{margin:10px 0 0;color:var(--dsw-alias-state-error-primary);font-size:13px;line-height:20px}',
    ].join('\n')

    function Styles() {
      return h('style', { dangerouslySetInnerHTML: { __html: CSS } })
    }

    function Glyph(props) {
      const size = Number(props && props.size) || 16
      return h(
        'span',
        { className: 'dqr-glyph' },
        h(
          'svg',
          {
            width: size,
            height: size,
            viewBox: '0 0 24 24',
            fill: 'none',
            'aria-hidden': true,
            style: { display: 'block' },
          },
          h('path', {
            d: 'M20.2 12a8.2 8.2 0 1 1-2.4-5.8',
            stroke: 'currentColor',
            strokeWidth: 1.7,
            strokeLinecap: 'round',
          }),
          h('path', {
            d: 'M20.4 4.2v4.4h-4.4',
            stroke: 'currentColor',
            strokeWidth: 1.7,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
          }),
        ),
      )
    }

    // ------------------------------------------------------------------
    // 侧边栏左下角按钮
    // ------------------------------------------------------------------
    function FooterAction(props) {
      useView()
      const wide = !(props && props.wide === false)
      return h(
        React.Fragment,
        null,
        h(Styles),
        h(
          'button',
          {
            type: 'button',
            className: wide ? 'dqr-foot' : 'dqr-foot dqr-foot--rail',
            title: translate('action'),
            'aria-label': translate('action'),
            'data-dsh-quick-restart': 'footer-action',
            onClick: () => {
              if (view.open) return
              patchView({ open: true, phase: 'confirming', error: '' })
            },
          },
          h(Glyph, { size: wide ? 16 : 18 }),
          wide ? h('span', { className: 'dqr-foot-label' }, translate('action')) : null,
        ),
      )
    }

    // ------------------------------------------------------------------
    // 浮层确认框
    // ------------------------------------------------------------------
    function Dialog() {
      const { open, phase, error } = useView()
      const focusRef = useRef(null)

      useEffect(() => {
        if (!open) return undefined
        const previous = document.activeElement
        const onKey = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            closeDialog()
          }
        }
        window.addEventListener('keydown', onKey)
        const timer = window.setTimeout(() => {
          const node = focusRef.current
          if (node && typeof node.focus === 'function') node.focus()
        }, 0)
        return () => {
          window.removeEventListener('keydown', onKey)
          window.clearTimeout(timer)
          if (previous && typeof previous.focus === 'function') previous.focus()
        }
      }, [open])

      if (!open) return null

      const busy = phase === 'restarting' || phase === 'waiting'
      const title =
        phase === 'confirming'
          ? translate('confirmTitle')
          : phase === 'waiting'
            ? translate('waitingHint')
            : phase === 'gaveUp'
              ? translate('gaveUpTitle')
              : phase === 'failed'
                ? translate('failedTitle')
                : translate('restarting')
      const body =
        phase === 'confirming'
          ? translate('confirmBody')
          : busy
            ? translate('restartingHint')
            : phase === 'gaveUp'
              ? translate('gaveUp')
              : null

      const actions = []
      if (phase === 'confirming') {
        actions.push(
          h(
            'button',
            {
              key: 'cancel',
              type: 'button',
              className: 'dqr-btn',
              ref: focusRef,
              onClick: closeDialog,
            },
            translate('cancel'),
          ),
          h(
            'button',
            {
              key: 'confirm',
              type: 'button',
              className: 'dqr-btn dqr-btn--danger',
              onClick: () => {
                void requestRestart()
              },
            },
            translate('confirm'),
          ),
        )
      } else if (phase === 'failed') {
        actions.push(
          h(
            'button',
            {
              key: 'close',
              type: 'button',
              className: 'dqr-btn',
              ref: focusRef,
              onClick: closeDialog,
            },
            translate('close'),
          ),
          h(
            'button',
            {
              key: 'retry',
              type: 'button',
              className: 'dqr-btn dqr-btn--danger',
              onClick: () => {
                void requestRestart()
              },
            },
            translate('retry'),
          ),
        )
      } else {
        actions.push(
          h(
            'button',
            {
              key: 'close',
              type: 'button',
              className: 'dqr-btn',
              ref: focusRef,
              onClick: closeDialog,
            },
            translate('close'),
          ),
        )
      }

      return h(
        React.Fragment,
        null,
        h(Styles),
        h(
          'div',
          {
            className: 'dqr-overlay',
            role: 'presentation',
            onClick: (event) => {
              if (event.target === event.currentTarget) closeDialog()
            },
          },
          h(
            'div',
            {
              className: 'dqr-dialog',
              role: 'dialog',
              'aria-modal': 'true',
              'aria-labelledby': 'dqr-dialog-title',
              'data-dsh-quick-restart': 'dialog',
            },
            h('h2', { className: 'dqr-title', id: 'dqr-dialog-title' }, title),
            busy
              ? h(
                  'div',
                  { className: 'dqr-progress' },
                  h('span', { className: 'dqr-spin', 'aria-hidden': true }),
                  h('span', null, translate('restarting')),
                )
              : null,
            body ? h('p', { className: 'dqr-body' }, body) : null,
            error ? h('p', { className: 'dqr-error' }, error) : null,
            h('div', { className: 'dqr-actions' }, actions),
          ),
        ),
      )
    }

    // ------------------------------------------------------------------
    // 注册
    // ------------------------------------------------------------------
    const inject = ['slots', 'locale']

    function apply(ctx) {
      translate = (key) => {
        try {
          const bound = ctx.locale.bind(NS)
          const value = bound(key)
          if (typeof value === 'string' && value !== '' && value !== key) return value
        } catch {
          /* 语言服务异常时退回内置字典 */
        }
        return (isChinese() ? zh[key] : en[key]) ?? zh[key] ?? key
      }

      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-quick-restart: locale')

      ctx.effect(() => {
        const disposeFooter = ctx.slots.inject('sidebar.footer.action', () =>
          ctx.slots.register(
            {
              name: 'sidebar.footer.action',
              id: NS,
              order: 20,
              label: () => translate('action'),
            },
            FooterAction,
          ),
        )
        const disposeDialog = ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            {
              name: 'shell.overlay',
              id: `${NS}-dialog`,
              order: 50,
              label: () => translate('confirmTitle'),
            },
            Dialog,
          ),
        )
        return () => {
          disposeFooter()
          disposeDialog()
        }
      }, 'dsh-quick-restart: slots')
    }

    const module = { exports: {} }
    module.exports.apply = apply
    module.exports.inject = inject
    module.exports.FooterAction = FooterAction
    module.exports.Dialog = Dialog
    return module.exports
  },
})
