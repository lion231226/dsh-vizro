/**
 * dsh-vizro — Python sidecar manager.
 *
 * One long-lived `uv run sidecar/worker.py` process per plugin instance. The
 * worker speaks JSON lines (see sidecar/worker.py) and is started lazily on the
 * first call: the first start may spend 30–60 s installing vizro, every later
 * call is milliseconds. Idle workers are reaped so a background panel does not
 * pin a Python process for the whole session.
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveUv } from './env.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const PACKAGE_ROOT = path.resolve(HERE, '..', '..')
export const WORKER_PATH = path.join(PACKAGE_ROOT, 'sidecar', 'worker.py')

const FIRST_CALL_TIMEOUT_MS = 240_000
const CALL_TIMEOUT_MS = 120_000
const IDLE_TIMEOUT_MS = 10 * 60_000

export class SidecarError extends Error {
  constructor(type, message, detail) {
    super(message)
    this.name = 'SidecarError'
    this.type = type
    this.detail = detail
  }
}

export function createSidecar({ ctx, log = () => {} } = {}) {
  /** @type {import('node:child_process').ChildProcess | null} */
  let child = null
  let buffer = ''
  let stderrTail = []
  let seq = 0
  let starting = null
  let idleTimer = null
  const pending = new Map()
  let uvPath

  const subprocess = ctx?.get?.('subprocess')

  function settle(id, payload) {
    const entry = pending.get(id)
    if (entry === undefined) return
    pending.delete(id)
    clearTimeout(entry.timer)
    if (payload.ok) entry.resolve(payload.result)
    else entry.reject(new SidecarError(payload.error?.type ?? 'sidecar_error', payload.error?.message ?? 'sidecar failed', payload.error?.detail))
  }

  function feed(chunk) {
    buffer += chunk
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      index = buffer.indexOf('\n')
      if (line === '') continue
      let payload
      try {
        payload = JSON.parse(line)
      } catch {
        log(`sidecar: non-JSON stdout line ignored: ${line.slice(0, 200)}`)
        continue
      }
      settle(payload.id, payload)
    }
  }

  function attachStderr(stream) {
    if (!stream) return
    stream.on('data', (chunk) => {
      const text = String(chunk)
      stderrTail.push(text)
      if (stderrTail.length > 40) stderrTail.shift()
      log(`sidecar stderr: ${text.trimEnd()}`)
    })
  }

  async function spawnWorker() {
    uvPath = uvPath ?? (await resolveUv(subprocess))
    if (!uvPath) {
      throw new SidecarError(
        'uv_missing',
        'uv was not found. Install uv (https://docs.astral.sh/uv/) so the plugin can run the Python sidecar, or set uvPath in the plugin config.',
      )
    }
    log(`sidecar: spawning ${uvPath} run ${WORKER_PATH}`)

    if (subprocess !== undefined && typeof subprocess.spawn === 'function') {
      const handle = subprocess.spawn({
        argv: [uvPath, 'run', '--quiet', WORKER_PATH],
        cwd: PACKAGE_ROOT,
        stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
        graceMs: 5000,
        env: process.env,
      })
      handle.stdout?.on('data', (chunk) => feed(String(chunk)))
      attachStderr(handle.stderr)
      return {
        stdin: handle.stdin,
        stdout: handle.stdout,
        kill: () => handle.terminate(),
        exit: handle.done,
      }
    }

    const { spawn } = await import('node:child_process')
    const proc = spawn(uvPath, ['run', '--quiet', WORKER_PATH], {
      cwd: PACKAGE_ROOT,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    proc.stdout.on('data', (chunk) => feed(String(chunk)))
    attachStderr(proc.stderr)
    return {
      stdin: proc.stdin,
      kill: () => proc.kill(),
      exit: new Promise((resolve) => proc.once('exit', (code, signal) => resolve({ code, signal }))),
      proc,
    }
  }

  async function ensureChild() {
    if (child !== null) return child
    if (starting !== null) return starting
    starting = (async () => {
      const handle = await spawnWorker()
      child = handle
      const stdin = handle.stdin ?? handle.proc?.stdin
      if (!stdin || typeof stdin.write !== 'function') {
        try {
          handle.kill()
        } catch {
          // ignore
        }
        child = null
        throw new SidecarError('sidecar_stdio', 'could not attach to the sidecar stdin')
      }
      child.stdin = stdin
      handle.exit?.then(({ code, signal } = {}) => {
        log(`sidecar: exited code=${code} signal=${signal}`)
        for (const [id, entry] of pending) {
          clearTimeout(entry.timer)
          entry.reject(new SidecarError('sidecar_exited', `The Python sidecar exited (code=${code}, signal=${signal}). ${stderrTail.slice(-5).join('')}`))
          pending.delete(id)
        }
        child = null
      })
      return child
    })()
    try {
      return await starting
    } finally {
      starting = null
    }
  }

  function touch() {
    if (idleTimer !== null) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      idleTimer = null
      dispose('idle')
    }, IDLE_TIMEOUT_MS)
    idleTimer.unref?.()
  }

  async function request(method, params = {}, { timeoutMs } = {}) {
    const handle = await ensureChild()
    touch()
    const id = ++seq
    const budget = timeoutMs ?? (seq === 1 ? FIRST_CALL_TIMEOUT_MS : CALL_TIMEOUT_MS)
    const payload = JSON.stringify({ id, method, params }) + '\n'
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(
          new SidecarError(
            'timeout',
            `Sidecar call ${method} timed out after ${budget} ms.${
              seq === 1 ? ' The first call installs vizro through uv and can take a minute.' : ''
            } ${stderrTail.slice(-3).join('')}`.trim(),
          ),
        )
      }, budget)
      timer.unref?.()
      pending.set(id, { resolve, reject, timer })
      try {
        handle.stdin.write(payload)
      } catch (error) {
        clearTimeout(timer)
        pending.delete(id)
        reject(new SidecarError('sidecar_write', `could not write to the sidecar: ${error?.message ?? error}`))
      }
    })
  }

  function dispose(reason = 'dispose') {
    if (idleTimer !== null) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
    if (child !== null) {
      log(`sidecar: disposing (${reason})`)
      try {
        child.stdin?.write(JSON.stringify({ id: 0, method: 'shutdown', params: {} }) + '\n')
      } catch {
        // ignore: the process may already be gone
      }
      try {
        child.kill()
      } catch {
        // ignore
      }
      child = null
    }
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer)
      entry.reject(new SidecarError('sidecar_disposed', 'plugin unloaded'))
      pending.delete(id)
    }
  }

  return { request, dispose, get stderrTail() {
    return stderrTail.join('')
  } }
}
