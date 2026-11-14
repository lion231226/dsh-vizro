/**
 * dsh-vizro — Dash server lifecycle for `vizro_run`.
 *
 * Servers are owned by the plugin fiber: one map keyed by entry path, each with
 * a free port, a bounded log ring, and a terminate on unload. Starting twice
 * returns the running instance instead of leaking a second process.
 */

import path from 'node:path'
import net from 'node:net'
import { fileURLToPath } from 'node:url'
import { resolveUv } from './env.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const PACKAGE_ROOT = path.resolve(HERE, '..', '..')
export const SERVE_PATH = path.join(PACKAGE_ROOT, 'sidecar', 'serve.py')

const READY_TIMEOUT_MS = 120_000
const HTTP_READY_TIMEOUT_MS = 30_000
const LOG_LIMIT = 200

/** Poll the app until it answers, because serve.py's marker precedes the bind. */
async function waitForHttp(url, timeoutMs = HTTP_READY_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) })
      if (res.ok) return true
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return false
}

export function findFreePort(preferred) {
  const tryPort = (port) =>
    new Promise((resolve) => {
      const server = net.createServer()
      server.once('error', () => resolve(undefined))
      server.once('listening', () => {
        server.close(() => resolve(port))
      })
      server.listen(port, '127.0.0.1')
    })
  return (async () => {
    if (preferred) {
      const ok = await tryPort(preferred)
      if (ok) return ok
    }
    for (let i = 0; i < 40; i += 1) {
      const port = 8500 + Math.floor(Math.random() * 900)
      const ok = await tryPort(port)
      if (ok) return ok
    }
    throw new Error('could not find a free port for the Vizro dev server')
  })()
}

export function createServers({ ctx, log = () => {} }) {
  const servers = new Map()
  const subprocess = ctx?.get?.('subprocess')

  async function spawnServe(entry, port) {
    const uv = await resolveUv(subprocess)
    if (!uv) throw new Error('uv was not found; install uv so vizro_run can start a Dash server')
    const argv = [uv, 'run', '--quiet', SERVE_PATH, entry, String(port)]

    if (subprocess !== undefined && typeof subprocess.spawn === 'function') {
      const handle = subprocess.spawn({
        argv,
        cwd: path.dirname(entry),
        stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
        graceMs: 5000,
        env: process.env,
      })
      return { handle, stdout: handle.stdout, stderr: handle.stderr, kill: () => handle.terminate(), exit: handle.done }
    }
    const { spawn } = await import('node:child_process')
    const proc = spawn(argv[0], argv.slice(1), { cwd: path.dirname(entry), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    return {
      handle: proc,
      stdout: proc.stdout,
      stderr: proc.stderr,
      kill: () => proc.kill(),
      exit: new Promise((resolve) => proc.once('exit', (code, signal) => resolve({ code, signal }))),
    }
  }

  async function start(entryInput, { port: preferredPort } = {}) {
    const entry = path.resolve(entryInput)
    const key = entry
    const existing = servers.get(key)
    if (existing && existing.state === 'running') return snapshot(existing)

    const port = await findFreePort(preferredPort)
    const record = {
      entry,
      port,
      url: `http://127.0.0.1:${port}/`,
      state: 'starting',
      startedAt: new Date().toISOString(),
      logs: [],
      proc: null,
      ready: null,
    }
    servers.set(key, record)
    record.ready = new Promise((resolve) => {
      record._resolveReady = resolve
    })

    const proc = await spawnServe(entry, port)
    record.proc = proc
    const push = (stream) => (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (line.trim() === '') continue
        record.logs.push(line)
        if (record.logs.length > LOG_LIMIT) record.logs.shift()
        if (line.includes('[dsh-vizro] ready')) {
          record.state = 'running'
          record._resolveReady?.(snapshot(record))
        }
        if (line.includes('[dsh-vizro] error')) {
          record.state = 'failed'
          record._resolveReady?.(snapshot(record))
        }
      }
      log(`vizro server ${port}: ${String(chunk).trimEnd()}`)
    }
    proc.stdout?.on('data', push('stdout'))
    proc.stderr?.on('data', push('stderr'))
    proc.exit?.then(({ code, signal } = {}) => {
      record.state = code === 0 ? 'stopped' : 'failed'
      record.exit = { code, signal }
      record._resolveReady?.(snapshot(record))
      log(`vizro server ${port} exited code=${code} signal=${signal}`)
    })

    const ready = await Promise.race([
      record.ready,
      new Promise((resolve) => setTimeout(() => resolve(undefined), READY_TIMEOUT_MS)),
    ])
    if (ready === undefined) {
      record.state = 'failed'
      record.logs.push(`startup timeout after ${READY_TIMEOUT_MS} ms`)
      stop(key)
      return snapshot(record)
    }
    if (record.state === 'running') {
      const up = await waitForHttp(record.url)
      if (!up) {
        record.state = 'failed'
        record.logs.push(`the server announced readiness but never answered on ${record.url}`)
        stop(key)
        return snapshot(record)
      }
    }
    return snapshot(record)
  }

  function snapshot(record) {
    /** Only defined fields: the tool result must stay lossless JSON. */
    const snap = {
      entry: record.entry,
      url: record.url,
      port: record.port,
      state: record.state,
      startedAt: record.startedAt,
      logs: record.logs.slice(-40),
    }
    if (record.exit !== undefined) snap.exit = record.exit
    return snap
  }

  function stop(keyInput) {
    const entry = path.resolve(keyInput)
    const record = servers.get(entry)
    if (!record) return { stopped: false, entry }
    try {
      record.proc?.kill()
    } catch (error) {
      log(`vizro server ${record.port}: kill failed: ${error?.message ?? error}`)
    }
    record.state = 'stopped'
    const snap = snapshot(record)
    servers.delete(entry)
    return { stopped: true, ...snap }
  }

  function status(keyInput) {
    const entry = path.resolve(keyInput)
    const record = servers.get(entry)
    return record ? snapshot(record) : { entry, state: 'not_started' }
  }

  function list() {
    return [...servers.values()].map(snapshot)
  }

  function disposeAll() {
    for (const record of servers.values()) {
      try {
        record.proc?.kill()
      } catch {
        // ignore
      }
    }
    servers.clear()
  }

  return { start, stop, status, list, disposeAll }
}
