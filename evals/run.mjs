#!/usr/bin/env node
/**
 * dsh-vizro — deterministic acceptance harness.
 *
 * This is the offline half of the dashboard-build evals: it exercises the
 * plugin's own machinery (scaffold, validation, profiling, serving, probing)
 * and asserts the environment-level expectations that do not need an LLM. The
 * agent-behaviour expectations from vizro-e2e-flow's evals (spec quality, chart
 * choice, interaction design) are NOT covered here — those need a real agent
 * run and are listed in evals/README.md.
 *
 * Run: node evals/run.mjs   (exit code 1 when any case fails)
 */

import path from 'node:path'
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createSidecar } from '../lib/host/sidecar.js'
import { createServers } from '../lib/host/servers.js'
import { createTools } from '../lib/host/tools.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WORK = path.join(HERE, `.work-${process.pid}`)
const CASE_TIMEOUT_MS = 120_000

const results = []
function record(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  - ${detail}` : ''}`)
}

/** Reject instead of hanging forever when a child process misbehaves. */
function withTimeout(promise, label) {
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${CASE_TIMEOUT_MS} ms`)), CASE_TIMEOUT_MS).unref?.()),
  ])
}

async function main() {
  await rm(WORK, { recursive: true, force: true })
  await mkdir(WORK, { recursive: true })

  const ctx = { get: () => undefined }
  const sidecar = createSidecar({ ctx })
  const servers = createServers({ ctx })
  const runtime = { sidecar, servers, log: () => {} }
  const tools = Object.fromEntries(createTools({ runtime }).map((tool) => [tool.name, tool]))
  const call = (name, args) => withTimeout(tools[name].execute(args, { signal: AbortSignal.timeout(CASE_TIMEOUT_MS) }), name)

  const demo = path.join(WORK, 'demo')

  console.log('> case 1 scaffold')
  try {
    const out = await call('vizro_scaffold', { dir: demo, title: 'Eval dashboard' })
    const appSource = await readFile(path.join(demo, 'app.py'), 'utf8')
    const specs = await Promise.all(
      ['1_information_architecture', '2_interaction_ux', '3_visual_design'].map((name) => readFile(path.join(demo, 'spec', `${name}.md`), 'utf8')),
    )
    record(
      'scaffold produces app.py + three specs, validates clean',
      out.scaffold_validates === true && specs.every((text) => text.length > 80) && appSource.includes('Vizro().build'),
      `files=${out.files.length}`,
    )
  } catch (error) {
    record('scaffold produces app.py + three specs, validates clean', false, String(error?.message ?? error))
  }

  console.log('> case 2 validate scaffold')
  try {
    const out = await call('vizro_validate', { code_path: path.join(demo, 'app.py') })
    record('code validation accepts the scaffolded app', out.valid === true && out.found === 'app', `found=${out.found ?? '-'}`)
  } catch (error) {
    record('code validation accepts the scaffolded app', false, String(error?.message ?? error))
  }

  console.log('> case 3 reject unknown type')
  try {
    const out = await call('vizro_validate', { config: { pages: [{ title: 'bad', components: [{ type: 'nope' }] }] } })
    const first = out.errors?.[0] ?? {}
    record(
      'config validation rejects unknown type with loc',
      out.valid === false && String(first.loc ?? '').startsWith('pages.0.components.0'),
      `loc=${first.loc ?? '-'}`,
    )
  } catch (error) {
    record('config validation rejects unknown type with loc', false, String(error?.message ?? error))
  }

  console.log('> case 4 config + data')
  try {
    const csv = path.join(WORK, 'sales.csv')
    await writeFile(csv, 'region,month,revenue\nNorth,2026-01,1200\nSouth,2026-01,900\nNorth,2026-02,1500\n')
    const out = await call('vizro_validate', {
      config: {
        pages: [
          {
            title: 'Sales',
            components: [{ type: 'graph', figure: { _target_: 'bar', data_frame: 'sales', x: 'region', y: 'revenue' } }],
          },
        ],
      },
      data: { sales: { path: csv } },
    })
    record(
      'config + data validates and renders Python',
      out.valid === true && String(out.python_code ?? '').includes('vm.Dashboard'),
      `stats=${JSON.stringify(out.stats ?? {})}`,
    )
  } catch (error) {
    record('config + data validates and renders Python', false, String(error?.message ?? error))
  }

  console.log('> case 5 refuse import-time run')
  try {
    const unguarded = path.join(WORK, 'unguarded.py')
    await writeFile(
      unguarded,
      [
        'import vizro.models as vm',
        'import vizro.plotly.express as px',
        'from vizro import Vizro',
        'app = Vizro().build(vm.Dashboard(pages=[vm.Page(title="p", components=[vm.Graph(figure=px.scatter(px.data.iris(), x="sepal_length", y="sepal_width"))])]))',
        'app.run(port=0)',
      ].join('\n'),
    )
    const out = await call('vizro_validate', { code_path: unguarded })
    record(
      'code validation refuses import-time app.run()',
      out.valid === false && /app\.run\(\)/.test(JSON.stringify(out.errors ?? [])),
      `type=${out.errors?.[0]?.type ?? '-'}`,
    )
  } catch (error) {
    record('code validation refuses import-time app.run()', false, String(error?.message ?? error))
  }

  console.log('> case 6 profile determinism')
  try {
    const csv = path.join(WORK, 'profile.csv')
    await writeFile(csv, 'region,revenue,date\nNorth,1200,2026-01-05\nSouth,900,2026-01-06\nNorth,1500,2026-02-05\n')
    const first = await call('vizro_data', { path: csv, name: 'profile' })
    const second = await call('vizro_data', { path: csv, name: 'profile' })
    const same = JSON.stringify(first) === JSON.stringify(second)
    const columns = Object.fromEntries((first.columns ?? []).map((column) => [column.name, column]))
    record(
      'data profile is deterministic and decision-grade',
      same && first.rows === 3 && columns.revenue?.min === 900 && columns.revenue?.max === 1500 && columns.region?.nunique === 2 && first.sample?.length === 3,
      `same=${same} cols=${first.columns_count}`,
    )
  } catch (error) {
    record('data profile is deterministic and decision-grade', false, String(error?.message ?? error))
  }

  console.log('> case 7 run + probe')
  try {
    const started = await call('vizro_run', { action: 'start', entry: path.join(demo, 'app.py') })
    const up = started.state === 'running' && /^http:\/\/127\.0\.0\.1:\d+\/$/.test(started.url ?? '')
    const probed = up ? await call('vizro_probe', { entry: path.join(demo, 'app.py'), render: 'off' }) : { ok: false, checks: [] }
    const checks = Object.fromEntries((probed.checks ?? []).map((check) => [check.name, check.ok]))
    record(
      'run starts a server and probe verifies it',
      up && probed.ok === true && checks.http === true && checks['dash-dependencies'] === true,
      `url=${started.url ?? '-'} checks=${Object.keys(checks).length}`,
    )
  } catch (error) {
    record('run starts a server and probe verifies it', false, String(error?.message ?? error))
  } finally {
    try {
      await call('vizro_run', { action: 'stop', entry: path.join(demo, 'app.py') })
    } catch {
      // teardown is best-effort here; case 8 asserts the failure path
    }
  }

  console.log('> case 8 broken app')
  try {
    const broken = path.join(WORK, 'broken.py')
    await writeFile(broken, 'import vizro.models as vm\ndashboard = vm.Dashboard(pages=[vm.Page(title="b", components=[{"type": "nope"}])])\napp = None\n')
    const started = await call('vizro_run', { action: 'start', entry: broken })
    const probed = await call('vizro_probe', { entry: broken, render: 'off' })
    record('broken app reports failed state and probe refuses it', started.state === 'failed' && probed.ok === false, `state=${started.state}`)
  } catch (error) {
    record('broken app reports failed state and probe refuses it', false, String(error?.message ?? error))
  }

  console.log('> case 9 tool surface')
  try {
    const names = Object.keys(tools).sort()
    const expected = ['vizro_data', 'vizro_doctor', 'vizro_probe', 'vizro_run', 'vizro_scaffold', 'vizro_schema', 'vizro_validate']
    record(
      'seven tools with descriptions and output renderers',
      JSON.stringify(names) === JSON.stringify(expected) && Object.values(tools).every((tool) => tool.output?.render),
      names.join(','),
    )
  } catch (error) {
    record('seven tools with descriptions and output renderers', false, String(error?.message ?? error))
  }

  console.log('> case 10 render check')
  let browserAvailable = false
  try {
    const { findBrowser } = await import('../lib/host/render.js')
    browserAvailable = Boolean(findBrowser())
    const started = await call('vizro_run', { action: 'start', entry: path.join(demo, 'app.py') })
    const out = started.state === 'running' ? await call('vizro_probe', { entry: path.join(demo, 'app.py'), render: 'auto' }) : { checks: [], verdict: started.state }
    const render = (out.checks ?? []).find((check) => check.name === 'render')
    const ok = browserAvailable
      ? render?.ok === true && out.verdict === 'pass'
      : render?.ok === null && out.verdict === 'unknown'
    record(
      browserAvailable ? 'probe renders the dashboard in a headless browser' : 'probe reports render as unknown without a browser',
      ok,
      `browser=${browserAvailable} started=${started.state} render_ok=${render?.ok} verdict=${out.verdict} detail=${(render?.detail ?? '').slice(0, 80)}`,
    )
  } catch (error) {
    record('probe renders the dashboard in a headless browser', false, String(error?.message ?? error))
  } finally {
    try {
      await call('vizro_run', { action: 'stop', entry: path.join(demo, 'app.py') })
    } catch {
      // ignore
    }
  }

  console.log('> case 11 blank page must go red')
  let blankServer = null
  try {
    const http = await import('node:http')
    blankServer = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<!doctype html><html><head><title>Blank</title></head><body><div id="react-entry-point"></div></body></html>')
    })
    await new Promise((resolve) => blankServer.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${blankServer.address().port}/`
    const out = await call('vizro_probe', { url, render: 'require' })
    const render = (out.checks ?? []).find((check) => check.name === 'render')
    record(
      'a blank page fails the render check',
      out.verdict === 'fail' && render?.ok === false,
      `verdict=${out.verdict} detail=${(render?.detail ?? '').slice(0, 100)}`,
    )
  } catch (error) {
    record('a blank page fails the render check', false, String(error?.message ?? error))
  } finally {
    if (blankServer) {
      blankServer.closeAllConnections?.()
      await new Promise((resolve) => blankServer.close(resolve)).catch(() => {})
    }
  }

  console.log('> case 12 no browser means unknown, not pass')
  try {
    const previous = process.env.DSH_VIZRO_BROWSER
    process.env.DSH_VIZRO_BROWSER = 'none'
    const started = await call('vizro_run', { action: 'start', entry: path.join(demo, 'app.py') })
    const live = started.state === 'running' ? await call('vizro_probe', { entry: path.join(demo, 'app.py'), render: 'auto' }) : { checks: [], verdict: started.state }
    if (previous === undefined) delete process.env.DSH_VIZRO_BROWSER
    else process.env.DSH_VIZRO_BROWSER = previous
    const render = (live.checks ?? []).find((check) => check.name === 'render')
    record(
      'without a browser the verdict is unknown, not pass',
      live.ok === null && live.verdict === 'unknown' && render?.ok === null,
      `ok=${live.ok} verdict=${live.verdict} render=${render?.ok} started=${started.state}`,
    )
  } catch (error) {
    record('without a browser the verdict is unknown, not pass', false, String(error?.message ?? error))
  } finally {
    if (process.env.DSH_VIZRO_BROWSER === 'none') delete process.env.DSH_VIZRO_BROWSER
    try {
      await call('vizro_run', { action: 'stop', entry: path.join(demo, 'app.py') })
    } catch {
      // ignore
    }
  }

  console.log('> case 13 aggregate row is flagged by the profiler')
  try {
    const csv = path.join(WORK, 'totals.csv')
    await writeFile(csv, 'item,value\nA,3\nB,7\nTOTAL,10\n')
    const out = await call('vizro_data', { path: csv, name: 'totals' })
    const warning = (out.warnings ?? [])[0]
    record('profile flags a total row', out.warnings?.length === 1 && warning.code === 'aggregate_row_suspected', warning?.evidence?.reason ?? 'no warning')
  } catch (error) {
    record('profile flags a total row', false, String(error?.message ?? error))
  }

  console.log('> case 14 kpi_card on a total row warns at validation')
  try {
    const csv = path.join(WORK, 'totals.csv')
    const out = await call('vizro_validate', {
      config: {
        pages: [
          {
            title: 'KPI',
            components: [
              { type: 'figure', figure: { _target_: 'kpi_card', data_frame: 'totals', value_column: 'value', agg_func: 'sum' } },
            ],
          },
        ],
      },
      data: { totals: { path: csv } },
    })
    const warning = (out.warnings ?? [])[0]
    record(
      'validation warns that the KPI double-counts the total row',
      out.valid === true && warning?.code === 'kpi_card_double_counts_total',
      warning?.message?.slice(0, 90) ?? 'no warning',
    )
  } catch (error) {
    record('validation warns that the KPI double-counts the total row', false, String(error?.message ?? error))
  }

  console.log('> case 15 pinned front-end stack')
  try {
    const out = await call('vizro_doctor', { deep: true })
    const frontend = out.frontend ?? {}
    const dmcMajor = Number(String(frontend.dash_mantine_components ?? '0').split('.')[0])
    record(
      'dash-mantine-components stays below 3 and React is compatible',
      frontend.react_compatible === true && dmcMajor > 0 && dmcMajor < 3,
      `dash=${frontend.dash} dmc=${frontend.dash_mantine_components} react=${frontend.react} (${frontend.react_source})`,
    )
  } catch (error) {
    record('dash-mantine-components stays below 3 and React is compatible', false, String(error?.message ?? error))
  }

  sidecar.dispose('eval finished')
  servers.disposeAll()
  await rm(WORK, { recursive: true, force: true }).catch(() => {})

  const failed = results.filter((result) => !result.ok)
  console.log(`\n${results.length - failed.length}/${results.length} cases passed`)
  if (failed.length > 0) {
    console.log(`failed: ${failed.map((item) => item.name).join(' | ')}`)
    process.exitCode = 1
  }
  // Child stdio handles can outlive the assertions; the verdict is already known.
  setTimeout(() => process.exit(failed.length > 0 ? 1 : 0), 150)
}

main().catch((error) => {
  console.error('eval harness crashed:', error)
  process.exitCode = 1
  setTimeout(() => process.exit(1), 100)
})

