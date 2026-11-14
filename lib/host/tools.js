/**
 * dsh-vizro — the six native tools.
 *
 * Each tool is a plain ToolDefinition ({name, description, parameters, output,
 * execute}) registered through `ctx.tools.register`. No MCP server, no stdio
 * protocol, no host config file: the model sees them like any other DSH tool.
 */

import path from 'node:path'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'

/** Text renderer shared by every tool: the value is the model's evidence. */
const jsonOutput = (limit = 24_000) => ({
  schema: {},
  render: (_args, value) => {
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
    return [{ type: 'text', text: text.length > limit ? `${text.slice(0, limit)}\n… truncated` : text }]
  },
})

const APP_TEMPLATE = (title) => `"""${title} — Vizro dashboard.

Edit the DATA SETUP, COMPONENTS and CONTROLS sections. Keep the structure:
Vizro 1.0 needs a module-level \`app\` (or \`dashboard\`) for validation and serving.
"""

import vizro.models as vm
import vizro.plotly.express as px
from vizro import Vizro
from vizro.managers import data_manager

#### DATA SETUP ############################################################
# Replace this with your own data. Any pandas DataFrame works; the string key
# is what \`data_frame: <key>\` refers to in JSON/YAML configs.
data_manager["sales"] = px.data.iris()

#### COMPONENTS ############################################################
page = vm.Page(
    title="${title}",
    components=[
        vm.Graph(
            id="scatter",
            figure=px.scatter("sales", x="sepal_length", y="sepal_width", color="species"),
        ),
        vm.Graph(
            id="histogram",
            figure=px.histogram("sales", x="sepal_width", color="species", marginal="box"),
        ),
    ],
    controls=[
        vm.Filter(column="species"),
        vm.Parameter(targets=["histogram.marginal"], selector=vm.RadioItems(options=["box", "violin"], value="box")),
    ],
)

dashboard = vm.Dashboard(pages=[page])
app = Vizro().build(dashboard)

if __name__ == "__main__":
    app.run(port=8050, debug=False)
`

const SPEC_FILES = {
  'spec/1_information_architecture.md': `# 1 · Information architecture

- Audience:
- Decisions this dashboard supports:
- Questions, in priority order:
  1.
  2.
- Pages and the question each one answers:
- Data sources and the columns that answer each question:
`,
  'spec/2_interaction_ux.md': `# 2 · Interaction and UX

- Filters (column → widget → which components):
- Parameters (argument overrides):
- Click interactions (cross-filter, cross-highlight, drill-through, export):
- Default state / empty state:
`,
  'spec/3_visual_design.md': `# 3 · Visual design

- Layout grid (columns per row, component spans):
- Chart type per question, and why:
- Colours: rely on Vizro defaults unless a palette is required
- KPI cards:
- Any deviation from the defaults:
`,
}

export function createTools({ runtime }) {
  const { sidecar, servers, log } = runtime

  const tools = []

  // ---- 1. schema ---------------------------------------------------------
  tools.push({
    name: 'vizro_schema',
    description:
      'Read the Vizro model contract before writing a dashboard config. With no `model`, returns the index of every public model (Dashboard, Page, Graph, Table, Filter, ...). With `model`, returns that model JSON Schema, including the captured-callable form of `figure` that JSON/YAML needs. Use this instead of guessing field names.',
    parameters: {
      type: 'object',
      properties: {
        model: {
          type: 'string',
          description: 'Exact model name from the index, e.g. Page, Graph, Table, Filter, Parameter, Grid, Flex.',
        },
      },
      additionalProperties: false,
    },
    output: jsonOutput(),
    async execute(args) {
      const model = typeof args?.model === 'string' ? args.model.trim() : ''
      return model === '' ? sidecar.request('models') : sidecar.request('schema', { model })
    },
  })

  // ---- 2. validate -------------------------------------------------------
  tools.push({
    name: 'vizro_validate',
    description:
      'Validate a Vizro dashboard before claiming it works. Two modes: pass `config` (JSON/YAML dict of models) and it runs the production Pydantic path, returning structured errors plus the rendered Python code; pass `code_path` (an app.py) and it imports the file in a child process and checks it builds a Dash app without serving. Always validate after generating or editing, then fix every reported error before serving.',
    parameters: {
      type: 'object',
      properties: {
        config: {
          type: 'object',
          description: 'Dashboard config as an object. Mutually exclusive with code_path.',
          additionalProperties: true,
        },
        format: { type: 'string', enum: ['python-dict', 'yaml', 'json'], description: 'How to read a string `config`. Default python-dict.' },
        data: {
          type: 'object',
          description:
            'Named data sources to register before validation, e.g. {"iris":{"builtin":"iris"}} or {"sales":{"path":"data/sales.csv"}}. Required for JSON/YAML configs that reference a data_frame.',
          additionalProperties: true,
        },
        allow_undefined: {
          type: 'array',
          items: { type: 'string' },
          description: 'Custom chart/table function names that are allowed to be undefined at validation time.',
        },
        code_path: { type: 'string', description: 'Path to a Python app file to import and check. Mutually exclusive with config.' },
        workdir: { type: 'string', description: 'Working directory for code_path (defaults to the file directory).' },
      },
      additionalProperties: false,
    },
    output: jsonOutput(),
    async execute(args) {
      if (typeof args?.code_path === 'string' && args.code_path.trim() !== '') {
        return sidecar.request('validate', { code_path: path.resolve(args.code_path), workdir: args.workdir })
      }
      if (args?.config === undefined) throw new Error('vizro_validate needs either `config` or `code_path`')
      return sidecar.request('validate', {
        config: args.config,
        format: args.format,
        data: args.data,
        allow_undefined: args.allow_undefined,
      })
    },
  })

  // ---- 3. data -----------------------------------------------------------
  tools.push({
    name: 'vizro_data',
    description:
      'Profile a data file before choosing charts: row/column counts, dtype, null rate, cardinality, numeric ranges, time span, and a deterministic head sample. Returns a `data` entry you can pass to vizro_validate so the config can reference the source by name. Use it instead of reading the CSV yourself: the shape decides chart type, filter widget and whether bar/line need pre-aggregation.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Local CSV/TSV/JSON/JSONL/XLSX/PARQUET file.' },
        name: { type: 'string', description: 'Data source name to register; defaults to the file stem.' },
        sample_rows: { type: 'integer', description: 'Deterministic head rows to include (default 5).' },
        top_k: { type: 'integer', description: 'Top values per column (default 8).' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    output: jsonOutput(),
    async execute(args) {
      const filePath = path.resolve(String(args?.path ?? ''))
      if (!existsSync(filePath)) throw new Error(`vizro_data: file not found: ${filePath}`)
      const profile = await sidecar.request('profile', {
        path: filePath,
        sample_rows: args?.sample_rows ?? 5,
        top_k: args?.top_k ?? 8,
      })
      const name = (typeof args?.name === 'string' && args.name.trim()) || path.basename(filePath).replace(/\.[^.]+$/, '')
      return { ...profile, suggested_name: name, data_argument: { [name]: { path: filePath } } }
    },
  })

  // ---- 4. scaffold -------------------------------------------------------
  tools.push({
    name: 'vizro_scaffold',
    description:
      'Create the starting files for a dashboard in one step: a runnable app.py (data setup, two graphs, a filter and a parameter) plus spec/1-3 markdown files. Copy-then-edit is measurably more reliable than writing an app from scratch, so scaffold first and then replace the data and components.',
    parameters: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: 'Target directory (created if missing).' },
        title: { type: 'string', description: 'Dashboard title, also used in the page title.' },
        overwrite: { type: 'boolean', description: 'Overwrite app.py if it already exists. Default false.' },
      },
      required: ['dir'],
      additionalProperties: false,
    },
    output: jsonOutput(),
    async execute(args) {
      const dir = path.resolve(String(args?.dir ?? ''))
      const title = (typeof args?.title === 'string' && args.title.trim()) || 'Dashboard'
      const appPath = path.join(dir, 'app.py')
      if (existsSync(appPath) && args?.overwrite !== true) {
        throw new Error(`vizro_scaffold: ${appPath} already exists. Pass overwrite: true to replace it.`)
      }
      await mkdir(dir, { recursive: true })
      await writeFile(appPath, APP_TEMPLATE(title), 'utf8')
      const written = [appPath]
      for (const [rel, content] of Object.entries(SPEC_FILES)) {
        const target = path.join(dir, rel)
        if (existsSync(target)) continue
        await mkdir(path.dirname(target), { recursive: true })
        await writeFile(target, content, 'utf8')
        written.push(target)
      }
      const check = await sidecar.request('validate', { code_path: appPath, workdir: dir }).catch((error) => ({ valid: false, errors: [{ msg: String(error?.message ?? error) }] }))
      return {
        dir,
        files: written,
        entry: appPath,
        next_step: 'Replace the DATA SETUP and COMPONENTS sections, then run vizro_run to preview.',
        scaffold_validates: check.valid === true,
        scaffold_errors: check.valid === true ? [] : check.errors,
      }
    },
  })

  // ---- 5. run ------------------------------------------------------------
  tools.push({
    name: 'vizro_run',
    description:
      'Start, stop or inspect a local Vizro dev server for an app file. Returns the URL to preview. Call with action=start after a passing vizro_validate, and action=stop when the user is done — an unattended server holds a port and a Python process. Action=logs returns the tail of the server output (where Dash callback tracebacks appear).',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start', 'stop', 'status', 'logs', 'list'], description: 'Lifecycle action. Default start.' },
        entry: { type: 'string', description: 'Path to the app.py to serve (required for start/stop/status/logs).' },
        port: { type: 'integer', description: 'Preferred port; a free one is picked when it is taken.' },
      },
      additionalProperties: false,
    },
    output: jsonOutput(),
    async execute(args) {
      const action = typeof args?.action === 'string' ? args.action : 'start'
      if (action === 'list') return { servers: servers.list() }
      const entry = typeof args?.entry === 'string' ? args.entry : ''
      if (entry === '') throw new Error(`vizro_run action=${action} needs \`entry\``)
      if (action === 'start') {
        const started = await servers.start(entry, { port: args?.port })
        log(`vizro_run start ${entry} → ${started.state} ${started.url ?? ''}`)
        return started
      }
      if (action === 'stop') return servers.stop(entry)
      if (action === 'logs') {
        const status = servers.status(entry)
        return { entry: status.entry, state: status.state, url: status.url, logs: status.logs ?? [] }
      }
      return servers.status(entry)
    },
  })

  // ---- 6. probe ----------------------------------------------------------
  tools.push({
    name: 'vizro_probe',
    description:
      'Check a running dashboard the way a user would first encounter it: HTTP status, rendered HTML, Dash layout/dependencies endpoints, and the server log for tracebacks. Use it after vizro_run instead of assuming the app is fine; first-load errors and 500s in the log are exactly what code review misses. Pass `url` for any running app or `entry` for one started through vizro_run.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Base URL of the dashboard, e.g. http://127.0.0.1:8501/' },
        entry: { type: 'string', description: 'App file whose server was started by vizro_run (used to look up the URL and logs).' },
      },
      additionalProperties: false,
    },
    output: jsonOutput(),
    async execute(args) {
      let url = typeof args?.url === 'string' ? args.url : ''
      let logs = []
      if (typeof args?.entry === 'string' && args.entry !== '') {
        const status = servers.status(args.entry)
        if (status.state !== 'running' && status.state !== 'starting') {
          return { ok: false, checks: [], reason: `vizro_run reports state=${status.state}; start the server first`, url: status.url }
        }
        url = url || status.url
        logs = status.logs ?? []
      }
      if (url === '') throw new Error('vizro_probe needs `url` or `entry`')
      const base = url.endsWith('/') ? url : `${url}/`
      const checks = []
      const timeout = AbortSignal.timeout(15_000)

      const record = (name, ok, detail) => checks.push({ name, ok, detail })

      try {
        let res
        try {
          res = await fetch(base, { signal: timeout })
        } catch {
          // a just-started server may need one more moment to accept connections
          await new Promise((resolve) => setTimeout(resolve, 800))
          res = await fetch(base, { signal: AbortSignal.timeout(15_000) })
        }
        const html = await res.text()
        record('http', res.ok, `status ${res.status}, ${html.length} bytes`)
        record('html-marker', /vizro|dash|plotly/i.test(html), 'page contains a Vizro/Dash marker')
        record('size', html.length > 2_000, `document is ${html.length} bytes`)
      } catch (error) {
        record('http', false, String(error?.message ?? error))
        return { ok: false, url: base, checks, logs: logs.slice(-40) }
      }

      try {
        const res = await fetch(new URL('_dash-layout', base), { signal: timeout })
        const payload = await res.json()
        record('dash-layout', res.ok && payload !== null && payload !== undefined, `status ${res.status}, keys=${Object.keys(payload ?? {}).slice(0, 6).join(',')}`)
      } catch (error) {
        record('dash-layout', false, String(error?.message ?? error))
      }

      try {
        const res = await fetch(new URL('_dash-dependencies', base), { signal: timeout })
        const payload = await res.json()
        record('dash-dependencies', res.ok && Array.isArray(payload), `status ${res.status}, ${Array.isArray(payload) ? payload.length : 0} callbacks`)
      } catch (error) {
        record('dash-dependencies', false, String(error?.message ?? error))
      }

      const tracebacks = logs.filter((line) => /Traceback|Error:|Exception/i.test(line)).slice(-10)
      record('server-log', tracebacks.length === 0, tracebacks.length === 0 ? 'no traceback lines in the tail' : tracebacks.join(' | '))

      return { ok: checks.every((check) => check.ok), url: base, checks, logs: logs.slice(-40) }
    },
  })

  return tools
}

export async function readSkillFile(filePath) {
  return readFile(filePath, 'utf8')
}
