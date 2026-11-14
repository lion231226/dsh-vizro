/**
 * dsh-vizro — host routes for the workbench panel.
 *
 * Plain Node handlers behind the Harness web server. They only read what the
 * plugin already owns (server map, skills, workspace files); no Python call is
 * made from a route, so the panel stays responsive while the sidecar is cold.
 */

import path from 'node:path'
import { readdirSync, readFileSync } from 'node:fs'
import { loadSkills } from './skills.js'

export const API_ROOT = '/api/vizro'

function writeJson(res, status, body) {
  try {
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify(body))
  } catch {
    try {
      res.end()
    } catch {
      // ignore
    }
  }
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(new Error(`invalid JSON body: ${error.message}`))
      }
    })
    req.on('error', reject)
  })
}

/** Find Vizro entry files under a directory (depth <= 2, bounded). */
export function findApps(root, depth = 2, limit = 40) {
  const found = []
  const walk = (dir, level) => {
    if (level > depth || found.length >= limit) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (found.length >= limit) return
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name.startsWith('.')) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full, level + 1)
      } else if (entry.name.endsWith('.py')) {
        try {
          const head = readFileSync(full, 'utf8').slice(0, 4000)
          if (head.includes('Vizro().build') || head.includes('from vizro import Vizro')) {
            found.push({ path: full, name: path.basename(full), dir, modified: undefined })
          }
        } catch {
          // unreadable file, skip
        }
      }
    }
  }
  walk(root, 0)
  return found
}

export function createRoutes({ runtime, workspaceRoot }) {
  const { servers } = runtime
  const root = workspaceRoot ?? process.cwd()

  return [
    {
      path: `${API_ROOT}/status`,
      method: 'GET',
      async handler(_req, res) {
        writeJson(res, 200, {
          ok: true,
          plugin: 'dsh-vizro',
          servers: servers.list(),
          apps: findApps(root),
          skills: loadSkills().map((skill) => ({ name: skill.name, description: skill.description })),
        })
      },
    },
    {
      path: `${API_ROOT}/run`,
      method: 'POST',
      async handler(req, res) {
        let body
        try {
          body = await readBody(req)
        } catch (error) {
          writeJson(res, 400, { ok: false, error: error.message })
          return
        }
        const action = body.action ?? 'start'
        const entry = typeof body.entry === 'string' ? body.entry : ''
        if (entry === '') {
          writeJson(res, 400, { ok: false, error: 'entry is required' })
          return
        }
        try {
          if (action === 'start') writeJson(res, 200, { ok: true, server: await servers.start(entry, { port: body.port }) })
          else if (action === 'stop') writeJson(res, 200, { ok: true, server: servers.stop(entry) })
          else if (action === 'logs') writeJson(res, 200, { ok: true, server: servers.status(entry) })
          else writeJson(res, 400, { ok: false, error: `unknown action: ${action}` })
        } catch (error) {
          writeJson(res, 500, { ok: false, error: String(error?.message ?? error) })
        }
      },
    },
    {
      path: `${API_ROOT}/health`,
      method: 'GET',
      async handler(_req, res) {
        writeJson(res, 200, { ok: true, plugin: 'dsh-vizro', version: '0.4.0', servers: servers.list().length })
      },
    },
  ]
}




