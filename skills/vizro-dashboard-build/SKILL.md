---
name: vizro-dashboard-build
description: Phase 2 of building a Vizro dashboard — scaffold, implement, validate through the production Pydantic path, then start and probe the app. Use when the spec files exist (or the user accepts skipping design) and the task is to produce a working Vizro app.py.
when_to_use: spec/1-3 exist, or "just build it" after design is waived.
---

# Vizro dashboard — phase 2: build

Do these steps in order. Do not claim the dashboard works before `vizro_probe`
reports `ok: true`.

## Step 1 — scaffold, do not start from a blank file

Call `vizro_scaffold` with the target directory:

- it writes a runnable `app.py` (data setup, two graphs, one filter, one
  parameter) plus `spec/1-3` templates;
- copy-then-edit is measurably more reliable than writing a Vizro app from
  scratch: the imports, the `data_manager` registration and the
  `app = Vizro().build(dashboard)` tail are the parts most often wrong.

If `spec/1-3` are missing, run the design pass first (or ask).

## Step 2 — implement against the real API

Rules that prevent most failures:

- `import vizro.plotly.express as px` — not `plotly.express`, or filters will
  not reach the chart.
- Data goes through `data_manager["name"] = df` once; then
  `px.scatter("name", x=..., y=...)` passes the name, not the frame.
- KPI: `vm.Figure(figure=vf.kpi_card(data_frame="name", value_column="rev", ...))`.
  Title lives inside the card arguments; `vm.Figure` has no `title` field.
- Table: `vm.Table(figure=dash_ag_grid(data_frame="name"))`. Dash DataTable is
  gone in 1.0.
- Bar/line charts must aggregate first with `@capture("graph")`; passing raw
  detail rows to `px.bar` renders an unreadable comb.
- Do not hardcode colours — the Vizro theme handles them. If the spec demands a
  palette, import it from `vizro.themes`.
- Actions only when the spec's `## Interactions` section asks for them; load
  the `vizro-actions` skill then. `filter_interaction` and `set_control` were
  removed — use `va.set_controls`.

## Step 3 — validate, fix, repeat

Call `vizro_validate { code_path: "<dir>/app.py" }`.

- On success it returns `valid: true` and `found: app`.
- On failure it returns `errors[{loc,type,msg}]`; fix by `loc`, then validate
  again. One error at a time is fine; skipping validation is not.
- Validation imports the file in a child process. A module-level `app.run()`
  is an error: keep serving under `if __name__ == "__main__":`.

For a JSON/YAML config instead of a file: `vizro_validate { config, data }`,
where `data` registers the sources the config references by name.

## Step 4 — run and probe

1. `vizro_run { action: "start", entry: "<dir>/app.py" }` → returns `url`.
2. `vizro_probe { entry: "<dir>/app.py" }` → checks HTTP, HTML, Dash layout,
   dependencies, and the server log for tracebacks.
3. Any failing check: read the detail, `vizro_run { action: "logs" }` for the
   traceback, fix, restart, probe again.
4. When the user is done: `vizro_run { action: "stop" }`. An unattended server
   holds a port and a Python process.

## Common errors

| Error | Cause | Fix |
| --- | --- | --- |
| `DuplicateIDError ... id already exists` | re-running a notebook/script without clearing the model registry | restart the kernel, or `from vizro import Vizro; Vizro._reset()` |
| `union_tag_invalid ... does not match any of the expected tags` | a component dict has an unknown or missing `type` | use one of the tags the message lists, quoted lowercase |
| `KeyError: Data source "<name>" does not exist` | JSON/YAML references a data name that was never registered | register it first (`data_manager[...]`) or pass `data` to `vizro_validate` |
| `app.run() was called while importing the file` | serving at import time | wrap it in `if __name__ == "__main__":` |
| `AttributeError: 'DataFrame' object has no attribute 'cache_arguments'` | cache-only call on a static frame | register data as a callable for dynamic data, or drop the cache call |
| blank chart, no error | `data_frame` re-looked-up inside a `@capture` function | the captured function already receives a DataFrame — use it directly |
| callback 500 on click only | action wiring, often `custom_data` hardcoded | load `vizro-actions`; `custom_data` must be a function parameter |
| `Failed to import function 'px.scatter'` | `_target_` written as a dotted path in YAML | use the short express name: `scatter` |

## Done when

- [ ] `vizro_validate` returns `valid: true` on the entry file.
- [ ] `vizro_run` reports `running` and returns a URL.
- [ ] `vizro_probe` reports `ok: true` (all checks), with no traceback in logs.
- [ ] Every interaction the spec asks for has been exercised at least once.
- [ ] Specs updated with any deviation.
- [ ] The user has the URL (and knows the server can be stopped).
