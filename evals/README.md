# Evals

Two layers, deliberately separated.

## 1. Deterministic harness — `node evals/run.mjs`

Nine environment-level cases that need no LLM and run in about a minute
(sidecar cold start included):

| # | Case |
| --- | --- |
| 1 | scaffold writes `app.py` + three specs and self-validates |
| 2 | code validation accepts the scaffolded app |
| 3 | config validation rejects an unknown component type with a precise `loc` |
| 4 | config + registered data validates and renders Python |
| 5 | code validation refuses an import-time `app.run()` |
| 6 | data profile is deterministic and reports the fields chart choice needs |
| 7 | `vizro_run` starts a server and `vizro_probe` verifies it |
| 8 | a broken app reports `failed` fast and the probe refuses it |
| 9 | six tools exist with descriptions and output renderers |

A failure exits with code 1 and prints the failing case names.

## 2. Agent-behaviour expectations — ported from vizro-e2e-flow

The original repo keeps these as `evals.json` (prompt + expectations). They
need a real agent run and are not executed by `run.mjs`. They stay here as the
checklist an evaluation run should assert:

1. All five spec files exist and explain the business questions.
2. The app uses `vizro.plotly.express`, not `plotly.express`.
3. Bar/line charts pre-aggregate via `@capture("graph")`.
4. KPI cards use `kpi_card` / `kpi_card_reference`, not a rebuilt chart.
5. No hardcoded colours when the spec does not ask for a palette.
6. Interactions use `va.set_controls`, never the removed `filter_interaction`.
7. A custom chart used as a cross-filter source accepts `custom_data` as a
   parameter (hardcoding it raises at click time).
8. Every `actions=` source was clicked and produced no callback 500.
9. The finished app passes `vizro_validate` and `vizro_probe`.

Source: `mckinsey/vizro`, `vizro-e2e-flow/evals/*/evals.json` (7 cases, 81
expectations). The upstream runner is external and not part of this package.
