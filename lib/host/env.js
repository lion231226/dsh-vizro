/**
 * dsh-vizro — environment discovery.
 *
 * The Harness runs as a GUI/service process and its inherited PATH does not
 * necessarily contain the user's Python or uv install, so `uv` is resolved in
 * three tiers: the subprocess provider's world, then the inherited PATH, then a
 * short list of conventional Windows/macOS/Linux locations.
 */

import { existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const UV_CANDIDATES = [
  path.join(os.homedir(), '.local', 'bin', 'uv'),
  path.join(os.homedir(), '.cargo', 'bin', 'uv.exe'),
  path.join(os.homedir(), '.cargo', 'bin', 'uv'),
  path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python313', 'Scripts', 'uv.exe'),
  path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python312', 'Scripts', 'uv.exe'),
  'C:\\Program Files\\uv\\uv.exe',
  '/opt/homebrew/bin/uv',
  '/usr/local/bin/uv',
  '/usr/bin/uv',
]

/** Look for uv without shelling out; returns an absolute path or undefined. */
export function findUvByPath() {
  for (const candidate of UV_CANDIDATES) {
    try {
      if (existsSync(candidate)) return candidate
    } catch {
      // ignore unreadable candidate
    }
  }
  const entries = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
  const names = process.platform === 'win32' ? ['uv.exe', 'uv.cmd', 'uv'] : ['uv']
  for (const dir of entries) {
    for (const name of names) {
      const candidate = path.join(dir, name)
      try {
        if (existsSync(candidate)) return candidate
      } catch {
        // ignore
      }
    }
  }
  return undefined
}

/**
 * Resolve the uv executable, preferring the provider's execution world.
 * @param {{ resolveExecutable?: (command: string) => Promise<string> }} [provider]
 */
export async function resolveUv(provider) {
  if (provider !== undefined && typeof provider.resolveExecutable === 'function') {
    try {
      return await provider.resolveExecutable('uv')
    } catch {
      // fall through to the local scan
    }
  }
  return findUvByPath()
}
