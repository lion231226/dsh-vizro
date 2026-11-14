# Evals

Two layers, deliberately separated.

## 1. Deterministic harness — `node evals/run.mjs`

Fifteen environment-level cases that need no LLM and run in a few minutes
(sidecar cold start plus a handful of headless-browser launches):

| # | Case |
| --- | --- |
| 1 | scaffold writes `app.py` + three specs and self-validates |
| 2 | code validation accepts the scaffolded app |
| 3 | config validation rejects an unknown component type with a precise `loc` |
| 4 | config + registered data validates and renders Python |
| 5 | code validation refuses an import-time `app.run()` |
| 6 | data profile is deterministic and reports the fields chart choice needs |
| 7 | `vizro_run` starts a server and `vizro_probe` verifies it (server checks) |
| 8 | a broken app reports `failed` fast and the probe refuses it |
| 9 | seven tools exist with descriptions and output renderers |
| 10 | the probe renders the dashboard in a headless browser (`pass`), or reports `unknown` when none exists |
| 11 | a blank page fails the render check — the case that cannot be caught server-side |
| 12 | without a browser `ok` is `null` and the verdict is `unknown`, never `pass` |
| 13 | `vizro_data` flags a frame whose last row is a total |
| 14 | `vizro_validate` warns when a `kpi_card` aggregates that frame |
| 15 | the pinned front-end stack keeps dash-mantine-components below 3 with a compatible React |

A failure exits with code 1 and prints the failing case names.

Case 11 is the regression that matters: it serves a valid HTML shell with an
empty `#react-entry-point`, which used to pass every server-side check. Case 12
pins the `unknown` semantics so a machine without a browser cannot silently
claim a pass.

## 2. Agent-behaviour expectations — ported from vizro-e2e-flow

The original repo keeps these as `evals.json` (prompt + expectations). They
need a real agent run and are not executed by `run.mjs`. They stay here as the
checklist an evaluation run should assert:

1. All five spec files exist and explain the business questions.
2. The app uses `vizro.plotly.express`, not `plotly.express`.
3. Bar/line charts pre-aggregate via `@capture("graph")`.
4. KPI cards use `kpi_card` / `kpi_card_reference`, not a rebuilt chart, and read
   a detail-only frame (no aggregate row) — see case 14 for the static half.
5. No hardcoded colours when the spec does not ask for a palette.
6. Interactions use `va.set_controls`, never the removed `filter_interaction`.
7. A custom chart used as a cross-filter source accepts `custom_data` as a
   parameter (hardcoding it raises at click time).
8. Every `actions=` source was clicked and produced no callback 500.
9. The finished app passes `vizro_validate` and `vizro_probe` with a `pass`
   verdict (not `unknown`).

Source: `mckinsey/vizro`, `vizro-e2e-flow/evals/*/evals.json` (7 cases, 81
expectations). The upstream runner is external and not part of this package.
