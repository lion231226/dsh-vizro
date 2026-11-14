/**
 * dsh-vizro — host half.
 *
 * Registers seven native tools, six skills, and the workbench routes.
 * Everything long-lived (the Python sidecar, any Dash dev server) is owned by
 * this fiber and released when the plugin unloads.
 */

import { createSidecar } from './sidecar.js'
import { createServers } from './servers.js'
import { createTools } from './tools.js'
import { registerSkills } from './skills.js'
import { createRoutes } from './routes.js'

export const name = 'vizro'

/** The tool registry is the only hard dependency; skills/routes are optional. */
export const inject = ['tools']

export const PLUGIN_VERSION = '0.3.2'

function makeLogger(ctx) {
  const prefix = '[dsh-vizro]'
  return (message) => {
    try {
      const logger = ctx?.logger
      if (logger && typeof logger.debug === 'function') logger.debug(`${prefix} ${message}`)
      else if (typeof console !== 'undefined' && typeof console.debug === 'function') console.debug(`${prefix} ${message}`)
    } catch {
      // logging must never break boot
    }
  }
}

export function apply(ctx) {
  const log = makeLogger(ctx)
  const sidecar = createSidecar({ ctx, log })
  const servers = createServers({ ctx, log })

  /** Cordis exposes injected services on ctx; the mock/testing form uses ctx.get. */
  const service = (key) => {
    try {
      const direct = ctx?.[key]
      if (direct !== undefined && direct !== null) return direct
      return ctx?.get?.(key)
    } catch {
      return undefined
    }
  }

  const toolsService = service('tools')
  const skills = service('skills')
  const webServer = service('webServer')
  const subprocess = service('subprocess')
  const workingDirectory = service('workingDirectory')
  const workspaceRoot = workingDirectory?.defaultDirectory ?? process.cwd()
  const runtime = { sidecar, servers, log, ctx, skillsService: skills, subprocess }

  // -- tools ---------------------------------------------------------------
  let toolCount = 0
  for (const tool of createTools({ runtime })) {
    try {
      if (toolsService === undefined || toolsService === null) throw new Error('tools service unavailable')
      ctx.effect(() => toolsService.register(tool), `dsh-vizro: tool ${tool.name}`)
      toolCount += 1
    } catch (error) {
      log(`tool ${tool.name} failed to register: ${error?.message ?? error}`)
    }
  }

  // -- skills --------------------------------------------------------------
  // `skills` is not necessarily resolvable at apply time: Cordis exposes it
  // through the injection waterfall, so the registration lives in an inject
  // block and retries when the service appears. A plain ctx.get() here returns
  // undefined even though the service exists.
  const registerSkillLayer = (sctx) => {
    runtime.skillsService = sctx.skills
    sctx.effect(
      () => registerSkills(sctx.skills, (message) => log(`skill registration failed: ${message}`)),
      'dsh-vizro: skills',
    )
  }
  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['skills'], registerSkillLayer)
    } else if (skills !== undefined && skills !== null && typeof skills.register === 'function') {
      ctx.effect(() => registerSkills(skills, (message) => log(`skill registration failed: ${message}`)), 'dsh-vizro: skills')
    }
  } catch (error) {
    log(`skills registration failed: ${error?.message ?? error}`)
  }

  // -- workbench routes ----------------------------------------------------
  const registerRouteLayer = (sctx) => {
    sctx.effect(() => {
      const disposers = createRoutes({ runtime, workspaceRoot }).map((route) => sctx.webServer.register(route))
      return () => {
        for (const dispose of disposers) {
          try {
            dispose()
          } catch {
            // ignore
          }
        }
      }
    }, 'dsh-vizro: routes')
  }
  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['webServer'], registerRouteLayer)
    } else if (webServer !== undefined && webServer !== null && typeof webServer.register === 'function') {
      registerRouteLayer({ webServer, effect: (factory) => ctx.effect(factory, 'dsh-vizro: routes') })
    }
  } catch (error) {
    log(`route registration failed: ${error?.message ?? error}`)
  }

  // -- teardown ------------------------------------------------------------
  ctx.effect(
    () => () => {
      servers.disposeAll()
      sidecar.dispose('plugin unload')
    },
    'dsh-vizro: teardown',
  )

  log(`ready: ${toolCount} tools, skills=${runtime.skillsService ? 'on' : 'pending'}, routes=${webServer ? 'on' : 'pending'}, workspace=${workspaceRoot}`)
}


