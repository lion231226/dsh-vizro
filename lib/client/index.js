/**
 * dsh-vizro — browser half.
 *
 * One panel inside Settings → Vizro. It lists the Vizro apps found in the
 * workspace, starts/stops their dev servers, and embeds the preview. Every
 * failure degrades to a sentence instead of throwing: a throwing client plugin
 * breaks the shell boot.
 *
 * Host contract (lib/host/routes.js):
 *   GET  /api/vizro/status  → {ok, servers[], apps[], skills[]}
 *   POST /api/vizro/run     → body {action:'start'|'stop'|'logs', entry}
 *
 * Loaded through the shell module loader, so the file is a factory body: the
 * only imports are the shell-seeded `react` and `react/jsx-runtime`.
 */

window.__ModuleLoader__.load({
  id: 'dsh-vizro',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const NS = 'dsh-vizro'
    const SLOT = 'settings.section'
    const SLOT_ID = 'vizro'
    const SLOT_ORDER = 60
    const API_STATUS = '/api/vizro/status'
    const API_RUN = '/api/vizro/run'
    const POLL_MS = 5000

    const zh = {
      'section.title': 'Vizro',
      'section.desc': '在 DeepSeek Harness 里构建、校验并预览 Vizro 仪表盘。',
      'apps.title': '工作区里的 Vizro 应用',
      'apps.empty': '没有找到 Vizro 应用。让 agent 用 vizro_scaffold 生成一个。',
      'apps.hint': '预览需要先启动本地服务；停止后端口立即释放。',
      'btn.start': '启动预览',
      'btn.stop': '停止',
      'btn.open': '新标签打开',
      'btn.refresh': '刷新',
      'state.running': '运行中',
      'state.starting': '启动中',
      'state.stopped': '已停止',
      'state.failed': '启动失败',
      'state.not_started': '未启动',
      'skills.title': '已装技能',
      'error.status': '读取状态失败：',
      'loading': '读取中…',
    }

    const en = {
      'section.title': 'Vizro',
      'section.desc': 'Build, validate and preview Vizro dashboards inside DeepSeek Harness.',
      'apps.title': 'Vizro apps in this workspace',
      'apps.empty': 'No Vizro app found. Ask the agent to run vizro_scaffold.',
      'apps.hint': 'A preview needs the local server; stopping it releases the port immediately.',
      'btn.start': 'Start preview',
      'btn.stop': 'Stop',
      'btn.open': 'Open in a tab',
      'btn.refresh': 'Refresh',
      'state.running': 'running',
      'state.starting': 'starting',
      'state.stopped': 'stopped',
      'state.failed': 'failed',
      'state.not_started': 'not started',
      'skills.title': 'Skills installed',
      'error.status': 'Could not read status: ',
      'loading': 'Loading…',
    }

    const DICTS = { zh, en }

    const STYLE = {
      wrap: { padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: '14px' },
      h: { fontSize: '15px', fontWeight: 600, margin: 0 },
      muted: { fontSize: '12px', opacity: 0.65, margin: 0 },
      card: {
        border: '1px solid rgba(127,127,127,.28)',
        borderRadius: '10px',
        padding: '12px',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
      },
      row: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      code: { fontSize: '12px', opacity: 0.8, wordBreak: 'break-all' },
      btn: {
        fontSize: '12px',
        padding: '4px 10px',
        borderRadius: '6px',
        border: '1px solid rgba(127,127,127,.4)',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        textDecoration: 'none',
      },
      preview: { width: '100%', height: '520px', border: '1px solid rgba(127,127,127,.28)', borderRadius: '8px', background: 'white' },
      pill: (state) => ({
        fontSize: '11px',
        padding: '1px 8px',
        borderRadius: '999px',
        border: '1px solid rgba(127,127,127,.4)',
        opacity: state === 'running' ? 0.95 : 0.7,
      }),
    }

    function VizroPanel(props) {
      const react = require('react')
      const t = typeof props?.t === 'function' ? props.t : (key) => en[key] ?? key
      const { useEffect, useMemo, useState } = react
      const [status, setStatus] = useState(null)
      const [error, setError] = useState('')
      const [busy, setBusy] = useState('')

      const load = useMemo(
        () => async () => {
          try {
            const res = await fetch(API_STATUS, { headers: { accept: 'application/json' } })
            if (!res.ok) throw new Error('HTTP ' + res.status)
            setStatus(await res.json())
            setError('')
          } catch (err) {
            setError(String((err && err.message) || err))
          }
        },
        [],
      )

      useEffect(() => {
        let alive = true
        const tick = () => {
          if (alive) void load()
        }
        tick()
        const timer = setInterval(tick, POLL_MS)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [load])

      const act = async (entry, action) => {
        setBusy(action + ':' + entry)
        try {
          const res = await fetch(API_RUN, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: action, entry: entry }),
          })
          const payload = await res.json().catch(() => ({}))
          if (!res.ok || payload.ok === false) throw new Error(payload.error || 'HTTP ' + res.status)
          await load()
        } catch (err) {
          setError(String((err && err.message) || err))
        } finally {
          setBusy('')
        }
      }

      const apps = (status && status.apps) || []
      const servers = (status && status.servers) || []
      const skills = (status && status.skills) || []
      const byEntry = new Map(servers.map((server) => [server.entry, server]))
      const running = servers.filter((server) => server.state === 'running')

      const children = [
        react.createElement('h3', { key: 'title', style: STYLE.h }, t('section.title')),
        react.createElement('p', { key: 'desc', style: STYLE.muted }, t('section.desc')),
      ]
      if (error) children.push(react.createElement('p', { key: 'err', style: { ...STYLE.muted, color: 'crimson' } }, t('error.status') + error))
      children.push(
        react.createElement(
          'div',
          { key: 'apps-head', style: STYLE.row },
          react.createElement('h4', { style: STYLE.h }, t('apps.title')),
          react.createElement('button', { type: 'button', style: STYLE.btn, onClick: () => void load() }, t('btn.refresh')),
          status === null ? react.createElement('span', { style: STYLE.muted }, t('loading')) : null,
        ),
      )
      if (apps.length === 0 && status !== null) children.push(react.createElement('p', { key: 'empty', style: STYLE.muted }, t('apps.empty')))

      for (const app of apps) {
        const server = byEntry.get(app.path)
        const state = (server && server.state) || 'not_started'
        const isRunning = state === 'running' || state === 'starting'
        const rowChildren = [
          react.createElement('strong', { key: 'name', style: { fontSize: '13px' } }, app.name),
          react.createElement('span', { key: 'state', style: STYLE.pill(state) }, t('state.' + state)),
          server && server.url
            ? react.createElement('a', { key: 'open', style: STYLE.btn, href: server.url, target: '_blank', rel: 'noreferrer' }, t('btn.open'))
            : null,
        ]
        const body = [
          react.createElement('div', { key: 'row', style: STYLE.row }, rowChildren),
          react.createElement('div', { key: 'path', style: STYLE.code }, app.path),
          react.createElement(
            'div',
            { key: 'actions', style: STYLE.row },
            react.createElement(
              'button',
              { type: 'button', style: STYLE.btn, disabled: busy !== '' || isRunning, onClick: () => void act(app.path, 'start') },
              busy === 'start:' + app.path ? '…' : t('btn.start'),
            ),
            react.createElement(
              'button',
              { type: 'button', style: STYLE.btn, disabled: busy !== '' || !isRunning, onClick: () => void act(app.path, 'stop') },
              t('btn.stop'),
            ),
          ),
        ]
        if (isRunning && server && server.url) {
          body.push(react.createElement('iframe', { key: 'preview', title: app.name, src: server.url, style: STYLE.preview }))
        }
        if (server && server.logs && server.logs.length) {
          body.push(react.createElement('pre', { key: 'logs', style: { ...STYLE.code, maxHeight: '120px', overflow: 'auto', margin: 0 } }, server.logs.slice(-8).join('\n')))
        }
        children.push(react.createElement('div', { key: app.path, style: STYLE.card }, body))
      }

      if (skills.length) {
        const skillRows = skills.map((skill) => react.createElement('div', { key: skill.name, style: STYLE.code }, '• ' + skill.name))
        children.push(react.createElement('div', { key: 'skills', style: STYLE.card }, [react.createElement('h4', { key: 'h', style: STYLE.h }, t('skills.title') + ' (' + skills.length + ')'), ...skillRows]))
      }
      if (running.length) children.push(react.createElement('p', { key: 'hint', style: STYLE.muted }, t('apps.hint')))

      return react.createElement('div', { style: STYLE.wrap }, children)
    }

    function apply(ctx) {
      if (ctx === null || ctx === undefined) return
      const guard = (label, run) => {
        try {
          return run()
        } catch (error) {
          console.warn('[' + NS + '] ' + label + ' failed:', error)
          return undefined
        }
      }
      guard('dictionaries', () => {
        if (!ctx.locale || typeof ctx.locale.register !== 'function') return
        ctx.effect(() => ctx.locale.register(NS, DICTS), NS + ': dictionaries')
      })
      guard('settings section', () => {
        if (!ctx.slots || typeof ctx.slots.inject !== 'function' || typeof ctx.slots.register !== 'function') return
        ctx.effect(
          () => ctx.slots.inject(SLOT, () => ctx.slots.register({ name: SLOT, id: SLOT_ID, order: SLOT_ORDER, locale: NS }, VizroPanel)),
          NS + ': settings section',
        )
      })
    }

    const inject = ['slots', 'locale']

    exports.apply = apply
    exports.inject = inject
    exports.VizroPanel = VizroPanel
    exports.DICTS = DICTS
    exports.__internals = { NS, SLOT, POLL_MS }

    return module.exports
  },
})
