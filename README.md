# dsh-vizro

Build, validate, run and probe [Vizro](https://github.com/mckinsey/vizro) dashboards inside [DeepSeek Harness](https://github.com/deepseek-ai) — as native tools and skills, **not** through an MCP server.

Vizro is McKinsey's low-code toolkit for data apps: a dashboard is a tree of Pydantic models rendered with Dash/Plotly. This plugin gives the agent the four things it needs to use that toolkit without guessing: the model contract, a validator that runs the production Pydantic path, a profile of the real data, and a way to start the app and check that it actually serves.

## What you get

| Surface | Count | What |
| --- | --- | --- |
| Tools | 7 | `vizro_schema`, `vizro_validate`, `vizro_data`, `vizro_scaffold`, `vizro_run`, `vizro_probe`, `vizro_doctor` |
| Skills | 6 | `vizro-dashboard-design`, `vizro-dashboard-build`, `vizro-layouts`, `vizro-charts`, `vizro-actions`, `vizro-yaml` |
| UI | 1 | a **Vizro** panel in Settings: workspace apps, start/stop, embedded preview, logs |

### Tools

| Tool | Does |
| --- | --- |
| `vizro_schema` | 31-model index, or one model's JSON Schema (including the captured-callable `figure` form that JSON/YAML needs) |
| `vizro_validate` | `config` → production `model_validate`, structured `{loc,msg,type}` errors, rendered Python; `code_path` → import the app in a child process and check it builds |
| `vizro_data` | deterministic profile: dtype, null rate, cardinality, numeric range, time span, head sample; returns the `data` argument to pass to validation |
| `vizro_scaffold` | writes a runnable `app.py` + `spec/1-3` templates, then validates the scaffold |
| `vizro_run` | `start`/`stop`/`status`/`logs`/`list` for the local Dash server, with port allocation and log ring |
| `vizro_probe` | health incl. a real DOM render: HTTP, HTML, `_dash-layout`, `_dash-dependencies`, server-log tracebacks, and headless-browser text/console checks (`verdict: pass / fail / unknown`) |
| `vizro_doctor` | environment diagnosis: uv resolution, sidecar answer, skill visibility, running servers |

## Install

```bash
# from a profile (the plugin is a bundle; a restart or HMR recompose applies it)
dsh plugin --profile <profile> add dsh-vizro
```

From source, or through the Plugin Market once listed, the same one-file bundle manifest is used (`dsh.bundle.patch` + a `cordis.patch.yml` row).

### Requirements

- DeepSeek Harness with plugin bundles (any recent 0.2.x).
- [`uv`](https://docs.astral.sh/uv/) on `PATH`. It is the only runtime dependency: the sidecar is a PEP 723 script that pins `vizro==1.0.0`, so `uv` provisions Python 3.11+ and the wheel set on first use and caches it afterwards.
- Windows, macOS or Linux. The sidecar and dev server run as your user; a dashboard is a local Python process.
- Optional: Chrome, Edge or Chromium for the DOM render check inside `vizro_probe`. Without one that check reports `skipped` and the verdict stays `unknown`.

The first tool call installs Vizro through `uv` (30–60 s); later calls are milliseconds because the worker stays warm and is reaped after 10 idle minutes.

## How it works

```
DSH Host process
└─ dsh-vizro (host half)
   ├─ ctx.tools.register      → the seven tools
   ├─ ctx.skills.register     → the six skills
   ├─ ctx.webServer.register  → /api/vizro/{status,run,health}
   ├─ ctx.subprocess.spawn    → uv run sidecar/worker.py   (JSON lines: schema/validate/profile)
   └─ ctx.subprocess.spawn    → uv run sidecar/serve.py    (one Dash server per app)
Web GUI
└─ client half → Settings → Vizro (apps, start/stop, iframe preview, logs)
```

- **No MCP.** The tools are registered into the same registry as every other DSH tool; the Python side is a child process speaking JSON lines, so there is no MCP host config, no stdio handshake and no second server to supervise.
- **Validation is the production path.** `vizro_validate` calls `vm.Dashboard.model_validate` with the same context Vizro itself uses, so a config that validates is a config that builds.
- **Nothing is executed at import.** Code validation imports the file as a module in a child process; `app.run()` is patched to raise, so serving at import time is reported instead of hanging.
- **Servers are owned.** Every Dash process belongs to the plugin fiber and is terminated on unload.

## Skills

The two workflow skills are a two-phase contract: `vizro-dashboard-design` produces `spec/1-3`, `vizro-dashboard-build` implements them and must finish with a passing `vizro_validate` and `vizro_probe`. The four reference skills are loaded on demand: layouts, charts, actions, YAML.

They are ports of the upstream `vizro-e2e-flow` skills (Apache-2.0), rewritten for DSH's native tools: no terminal commands, no Playwright MCP, no Claude-specific environment assumptions.

## Evals

`node evals/run.mjs` runs fifteen deterministic cases (scaffold, config validation, code validation, profile determinism, serve+probe, failure detection, tool surface, DOM render pass/blank/unknown, aggregate-row and KPI warnings, pinned front-end stack). `evals/README.md` also lists the nine agent-behaviour expectations ported from upstream, which need a real agent run.

## Limits (read before relying on it)

- `vizro_probe` now renders the page in a headless Chromium/Edge when one is installed, so a blank dashboard cannot pass. Without a browser the render check reports `skipped` and `ok` is `null` (verdict `unknown`) — it never silently passes. It still does **not** click every interactive component.
- The plugin runs Python as your user. A dashboard file can do what any local script can do.
- Vizro 1.0.0 is pinned on purpose; a different Vizro version is not tested.
- The settings panel is the only UI surface: no dedicated sidebar icon yet.

## License

MIT. The bundled skills derive from McKinsey's `vizro` repository (`vizro-e2e-flow`, Apache-2.0); see `NOTICE`.




