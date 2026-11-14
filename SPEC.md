# SPEC — dsh-vizro

Status: 0.4.0. This document is the design record: what the plugin is, what it
deliberately is not, and the evidence that the acceptance criteria hold.

## 1. Objective

Make the agent able to take a business question and end with a working Vizro
dashboard, inside DeepSeek Harness, without an MCP server:

1. know the model contract (`vizro_schema`),
2. profile the real data before choosing charts (`vizro_data`),
3. write or generate a dashboard and prove it builds (`vizro_validate`),
4. start it and check it answers (`vizro_run`, `vizro_probe`),
5. hand over a URL the user can open, and a spec trail for the next session.

## 2. Non-goals

- Re-implementing Vizro in JavaScript. `vizro-core` stays the runtime; the
  plugin is an orchestrator.
- `vizro-ai` (deprecated upstream, 0.4.2 final) and `vizro-dash-components`
  (an internal React build) are not exposed.
- An in-dashboard chat agent (`vizro-experimental`). It is a property of the
  generated app, not of the authoring workflow.
- A hosted service. Everything runs locally under the user's account.

## 3. Shape

Dual-face bundle, one row in the profile patch.

| Face | Entry | Registers |
| --- | --- | --- |
| Host | `lib/host/index.js` (`apply(ctx)`) | 7 tools, 6 skills, 3 routes, sidecar + server ownership |
| Client | `lib/client/index.js` (`__ModuleLoader__.load`) | `settings.section` → id `vizro`, order 60 |

Python lives in `sidecar/` as three PEP 723 scripts:

| Script | Role | Lifetime |
| --- | --- | --- |
| `worker.py` | JSON-lines sidecar: `ping`, `models`, `schema`, `validate`, `profile` | long-lived, lazy, idle 10 min |
| `check_app.py` | child harness for `vizro_validate {code_path}` — import, never serve | one per validation |
| `serve.py` | child harness for `vizro_run` — import, then `run(host, port)` | one per app |

## 4. Contracts

### Tools

| Tool | Input | Output |
| --- | --- | --- |
| `vizro_schema` | `{model?}` | model index, or `{json_schema}` with `figure` re-attached |
| `vizro_validate` | `{config?, format?, data?, allow_undefined?}` or `{code_path?, workdir?}` | `{valid, errors[{loc,type,msg}], python_code?, stats?}` or `{valid, found, warnings}` |
| `vizro_data` | `{path, name?, sample_rows?, top_k?}` | profile + `data_argument` |
| `vizro_scaffold` | `{dir, title?, overwrite?}` | `{files, entry, scaffold_validates, scaffold_errors}` |
| `vizro_run` | `{action, entry?, port?}` | server snapshot `{entry,url,port,state,logs}` |
| `vizro_probe` | `{url?}` or `{entry?}`, `render?: auto\|require\|off` | `{ok: true\|false\|null, verdict: pass\|fail\|unknown, render?, checks[{name,ok,detail}], logs}` |
| `vizro_doctor` | `{deep?}` | `{uv, uvOk, skillsService, skillsVisible, skillsMissing, servers, runtime?}` |

Every output is lossless JSON; `undefined` fields are omitted rather than
serialized.

### Routes

`GET /api/vizro/status` → servers, workspace apps, skills.
`POST /api/vizro/run` → `{action, entry, port?}`.
`GET /api/vizro/health` → liveness.

All three sit behind the harness peer admission (same-origin authenticated
fetch from the panel).

## 5. Key decisions

1. **Sidecar instead of per-call `python -c`.** Importing vizro plus Dash costs
   seconds; a warm worker makes validation interactive. Cost: one child process
   to supervise, reaped on idle and on unload.
2. **Validation uses Vizro's own `model_validate`.** No second validator means
   no drift between "validates here" and "builds there".
3. **`figure` re-attached to the schema.** Vizro omits callable fields from its
   JSON Schema; the plugin restores them with a description of the
   captured-callable form (`_target_` is a plotly.express short name,
   `data_frame` is a registered name). Without this an agent writing JSON has
   no contract at all.
4. **Code validation imports, never serves.** `dash.Dash.run` is patched to
   raise in the child, so `app.run()` at import time becomes a readable error
   instead of a hung tool call.
5. **HTTP readiness, not just a marker.** `serve.py` announces readiness before
   Flask binds; `vizro_run` therefore polls the URL until it answers (30 s) and
   reports `failed` otherwise.
6. **The panel reads the plugin's own state.** Routes never call Python, so the
   UI stays responsive while the sidecar is cold.
7. **"Running" is not "rendered".** Every server-side signal can be green while
   the browser paints nothing, so `vizro_probe` drives a headless Chromium/Edge
   over CDP and reads `document.body.innerText` plus console errors. The browser
   is discovered, never bundled; when absent the check is `skipped` and the
   verdict is `unknown` rather than a pass. Click-level interaction is still out
   of scope.
8. **The React constraint lives outside the dependency graph.** dmc 3's metadata
   only asks for `dash>=4.5.0` while it needs React 19, and dash 4.5 serves
   18.3.1 by default: the resolver succeeds and the page is blank. The plugin
   pins `dash-mantine-components<3` in every PEP 723 header and checks the pair
   before announcing readiness, so a mismatched environment fails with an
   actionable message instead of a green "running".
9. **Silence on a data-semantics trap is the bug.** `kpi_card` aggregates the
   whole frame, so a `合计/TOTAL` row is counted twice while charts that filter it
   stay right. The plugin does not rewrite the user's data: it detects an
   aggregate-looking row in `vizro_data` and `vizro_validate` and returns a
   warning the agent must resolve.

## 6. Acceptance (verified 2026-11-14)

| # | Criterion | Evidence |
| --- | --- | --- |
| A1 | Bundle installs and applies | `install_bundle` → `application: applied` |
| A2 | Seven tools registered with schemas | live tool list + `test/plugin.test.mjs` |
| A3 | Schema: index + enhanced model schema | `vizro_schema` → 31 models; `Graph` includes `figure` |
| A4 | Profile deterministic and decision-grade | two calls byte-identical; min/max/nunique/top/head |
| A5 | Scaffold writes app + specs and self-validates | `scaffold_validates: true`, 4 files |
| A6 | Run starts, stops, reports logs | `vizro_run` → `state: running`, `stop` → `stopped` |
| A7 | Probe passes a good app, detects a broken one | server checks 6/6 plus a headless render; broken app → `state: failed`, probe refuses |
| A8 | Six skills register | `skills.register` at apply; frontmatter parsed by tests |
| A9 | Workbench panel registered | `settings.section` occupants include `id: vizro` |
| A10 | Deterministic evals | `node evals/run.mjs` — 15 cases |
| A11 | Repo is a complete open-source package | README/zh, SPEC, NOTICE, LICENSE, tests, release tarball |
| A12 | Submitted to the community catalog | [`awesome-dsh-plugin#15133`](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/15133); CI blocked only by the repo-age gate, which the catalog's `regate` workflow re-runs every 6 h |
| A13 | A blank page cannot pass the probe | blank HTML fixture → `render` check fails, `verdict: fail`; no browser → `ok: null`, `verdict: unknown` |
| A14 | The blank-page class of bug fails before serving | `serve.py` compares dmc major with the effective React version and refuses to emit the ready marker on a mismatch; `dash-mantine-components<3` is pinned in every PEP 723 header |
| A15 | A KPI over a total row is not silent | `vizro_data` and `vizro_validate` return `aggregate_row_suspected` / `kpi_card_double_counts_total` warnings |

## 7. Market note

`dsh-market/dsh-market` is the market **app**, not the catalog. Its own README
and the catalog's contributing guide both say entries belong in
`awesome-dsh-plugin/awesome-dsh-plugin` (`data/plugins/<owner>__<repo>.yml`),
from which the market reads. This plugin follows that path.

## 8. Risks

| Risk | Mitigation |
| --- | --- |
| `uv` missing on a GUI-launched host (PATH not inherited) | three-tier resolution (`subprocess` provider → PATH scan → conventional locations) and an actionable error |
| Vizro API drift | pinned `vizro==1.0.0`; schema is reflected from the installed version |
| Sidecar crash | rejection of pending calls with stderr tail; next call restarts it |
| A blank page that still answers 200 | headless DOM render in `vizro_probe`; `ok: null` when no browser, never a silent pass |
| dmc ≥ 3 with dash's default React 18 | `dash-mantine-components<3` pinned in the PEP 723 headers, plus a pre-ready front-end compatibility check in `serve.py` |
| A dashboard file doing something unexpected | runs as the user; documented in README |
| Probe blind to click-time errors | documented; browser-level probing is future work |

## 9. Roadmap

- CDP-based probe: connect to an existing Chromium endpoint, click every
  `actions=` source, collect console errors and `_dash-update-component` 500s.
- Proxy preview under `/api/vizro/preview/:port` with
  `requests_pathname_prefix`, so the panel works behind stricter CSP.
- A sidebar entry (icon + panel) beside the settings section.








