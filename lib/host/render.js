/**
 * dsh-vizro — "does the page actually paint?" check.
 *
 * Every server-side signal can be green while the browser renders nothing: a
 * React/DMC version mismatch answers 200, serves a full HTML shell and valid
 * `/_dash-layout` JSON, then throws in the console and leaves the body empty.
 * This module drives a headless Chromium/Edge over CDP (no Playwright, no
 * Python) and reports what a person would see.
 *
 * The browser is discovered, never required: when none is found the result is
 * `skipped`, which callers must surface as "unknown", not as a pass.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const CANDIDATES = {
  win32: [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ],
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ],
  linux: ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'],
}

const NOISE = [/favicon\.ico/i, /Download the React DevTools/i, /DevTools/i]

/** Explicit opt-out or override first, then PATH, then conventional installs. */
export function findBrowser(env = process.env) {
  const explicit = env.DSH_VIZRO_BROWSER
  if (explicit) {
    if (explicit === 'none' || explicit === 'off' || explicit === '0') return null
    if (existsSync(explicit)) return { path: explicit, name: path.basename(explicit), source: 'DSH_VIZRO_BROWSER' }
    return null
  }
  const names = process.platform === 'win32' ? ['msedge.exe', 'chrome.exe', 'chromium.exe'] : ['google-chrome', 'chromium', 'chromium-browser', 'microsoft-edge']
  for (const dir of (env.PATH || '').split(path.delimiter)) {
    if (!dir) continue
    for (const name of names) {
      const candidate = path.join(dir, name)
      if (existsSync(candidate)) return { path: candidate, name, source: 'PATH' }
    }
  }
  for (const candidate of CANDIDATES[process.platform] || []) {
    if (existsSync(candidate)) return { path: candidate, name: path.basename(candidate), source: 'conventional' }
  }
  return null
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Reject instead of hanging when a browser or CDP endpoint stops answering. */
function deadline(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms).unref?.()),
  ])
}

async function waitForFile(file, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const text = await readFile(file, 'utf8')
      const [port] = text.split(/\r?\n/)
      if (port && /^\d+$/.test(port.trim())) return Number(port.trim())
    } catch {
      // not written yet
    }
    await sleep(120)
  }
  return null
}

/** Minimal CDP client over one page target. */
function connect(wsUrl) {
  const ws = new WebSocket(wsUrl)
  let nextId = 1
  const pending = new Map()
  const errors = []
  const events = new Map()

  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve())
    ws.addEventListener('error', (event) => reject(new Error(`CDP socket error: ${event?.message ?? 'unknown'}`)))
  })

  ws.addEventListener('message', (event) => {
    let message
    try {
      message = JSON.parse(String(event.data))
    } catch {
      return
    }
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) reject(new Error(message.error.message || 'CDP error'))
      else resolve(message.result)
      return
    }
    if (message.method === 'Runtime.exceptionThrown') {
      const details = message.params?.exceptionDetails ?? {}
      errors.push(String(details.exception?.description || details.text || 'exception').split('\n')[0].slice(0, 300))
    } else if (message.method === 'Runtime.consoleAPICalled' && message.params?.type === 'error') {
      const text = (message.params.args || []).map((arg) => arg.value ?? arg.description ?? '').join(' ')
      errors.push(`console.error: ${text}`.slice(0, 300))
    } else if (message.method === 'Log.entryAdded' && message.params?.entry?.level === 'error') {
      errors.push(String(message.params.entry.text || 'log error').slice(0, 300))
    }
    const listeners = events.get(message.method)
    if (listeners) {
      for (const listener of listeners) listener(message.params)
      events.delete(message.method)
    }
  })

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params }))
    })

  const once = (method, timeoutMs) =>
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), timeoutMs)
      const listener = (params) => {
        clearTimeout(timer)
        resolve(params ?? {})
      }
      const list = events.get(method) || []
      list.push(listener)
      events.set(method, list)
    })

  return { ready, send, once, errors, close: () => ws.close() }
}

const EVALUATE = `(() => {
  const body = document.body;
  const text = (body?.innerText || '').replace(/\\u00a0/g, ' ').trim();
  return {
    title: document.title || '',
    textLength: text.length,
    firstText: text.slice(0, 200),
    nodes: document.querySelectorAll('*').length,
    hasRoot: !!document.querySelector('#react-entry-point, #_dash-app-content'),
    errorCard: !!document.querySelector('.dash-error-card')
  };
})()`

/**
 * Render `url` in a headless browser and report what painted.
 * @returns {Promise<{status:'ok'|'failed'|'skipped', browser:string|null, textLength?:number, firstText?:string, title?:string, errors:string[], detail:string, durationMs:number}>}
 */
export async function renderCheck({ url, timeoutMs = 25_000, minChars = 10, env = process.env } = {}) {
  const started = Date.now()
  const browser = findBrowser(env)
  if (!browser) {
    return {
      status: 'skipped',
      browser: null,
      errors: [],
      detail:
        'No Chromium-based browser found. Set DSH_VIZRO_BROWSER to a chrome/msedge executable to enable the DOM check; this result is unknown, not a pass.',
      durationMs: Date.now() - started,
    }
  }

  const profileDir = await mkdtemp(path.join(tmpdir(), 'dsh-vizro-render-'))
  const child = spawn(
    browser.path,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--remote-debugging-port=0',
      `--user-data-dir=${profileDir}`,
      'about:blank',
    ],
    { stdio: 'ignore', windowsHide: true },
  )

  let client = null
  try {
    const port = await waitForFile(path.join(profileDir, 'DevToolsActivePort'), 15_000)
    if (!port) {
      return {
        status: 'failed',
        browser: browser.name,
        errors: [],
        detail: 'the headless browser started but never exposed a DevTools port',
        durationMs: Date.now() - started,
      }
    }
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) }).then((r) => r.json())
    const target = (targets || []).find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
    if (!target) {
      return {
        status: 'failed',
        browser: browser.name,
        errors: [],
        detail: 'the headless browser exposed no page target',
        durationMs: Date.now() - started,
      }
    }

    client = connect(target.webSocketDebuggerUrl)
    await deadline(client.ready, 10_000, 'CDP connect')
    await client.send('Page.enable')
    await client.send('Runtime.enable')
    await client.send('Log.enable')

    const loaded = client.once('Page.loadEventFired', Math.min(15_000, timeoutMs))
    await deadline(client.send('Page.navigate', { url }), 8_000, 'Page.navigate')
    const loadEvent = await loaded
    if (loadEvent === null) {
      return {
        status: 'failed',
        browser: browser.name,
        errors: client.errors,
        detail: `the page did not finish loading within ${Math.min(15_000, timeoutMs)} ms`,
        durationMs: Date.now() - started,
      }
    }
    // Give React one paint after load: the Dash renderer mounts after the event.
    await sleep(1200)

    const evaluation = await deadline(
      client.send('Runtime.evaluate', { expression: EVALUATE, returnByValue: true, awaitPromise: true }),
      8_000,
      'Runtime.evaluate',
    )
    const value = evaluation?.result?.value ?? {}
    const errors = client.errors.filter((line) => !NOISE.some((pattern) => pattern.test(line)))
    const textLength = Number(value.textLength || 0)

    if (textLength < minChars) {
      return {
        status: 'failed',
        browser: browser.name,
        textLength,
        firstText: value.firstText ?? '',
        title: value.title ?? '',
        nodes: value.nodes,
        errors,
        detail:
          textLength === 0
            ? 'the page loaded but rendered no visible text (blank dashboard)'
            : `only ${textLength} character(s) of visible text rendered`,
        durationMs: Date.now() - started,
      }
    }
    if (errors.length > 0) {
      return {
        status: 'failed',
        browser: browser.name,
        textLength,
        firstText: value.firstText,
        title: value.title,
        errors,
        detail: `the page painted but the browser reported ${errors.length} error(s)`,
        durationMs: Date.now() - started,
      }
    }
    return {
      status: 'ok',
      browser: browser.name,
      textLength,
      firstText: value.firstText,
      title: value.title,
      nodes: value.nodes,
      errors: [],
      detail: `rendered ${textLength} characters of visible text`,
      durationMs: Date.now() - started,
    }
  } catch (error) {
    return {
      status: 'failed',
      browser: browser.name,
      errors: client?.errors?.filter((line) => !NOISE.some((pattern) => pattern.test(line))) ?? [],
      detail: `render check failed: ${error?.message ?? error}`,
      durationMs: Date.now() - started,
    }
  } finally {
    try {
      client?.close()
    } catch {
      // ignore
    }
    try {
      child.kill()
    } catch {
      // ignore
    }
    await sleep(150)
    await rm(profileDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
  }
}
