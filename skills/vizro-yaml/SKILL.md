---
name: vizro-yaml
description: Vizro JSON/YAML configuration reference — data_manager registration, figure _target_ forms, component/filter/parameter syntax, what only works in Python, and how to validate a config with vizro_validate. Use when the config is written as YAML or JSON rather than Python.
when_to_use: The user wants a config-first dashboard, or a YAML/JSON config must be validated or fixed.
---

# Vizro YAML / JSON configs

A config is a dict tree of Vizro models. Python (`vm.*`) is the full-power form;
YAML/JSON is a subset that references registered data and functions by name.

## 1. Register data first (Python side)

YAML/JSON cannot construct a DataFrame. The entry point registers it:

```python
from vizro.managers import data_manager
import pandas as pd

data_manager["sales"] = pd.read_csv("data/sales.csv")
Vizro().build(vm.Dashboard.model_validate(yaml.safe_load(open("dashboard.yaml")))).run()
```

When validating through the plugin, pass the sources instead:

```
vizro_validate { config: <yaml or dict>, data: {"sales": {"path": "data/sales.csv"}} }
```

`data` also accepts `{"builtin": "iris"}` and `{"records": [...]}`.

## 2. Figures use a captured-callable dict

```yaml
components:
  - type: graph
    id: trend
    figure:
      _target_: line            # plotly.express short name, no module prefix
      data_frame: sales         # a registered data_manager key
      x: month
      y: revenue
      color: region
```

- `_target_` values: `scatter`, `bar`, `line`, `area`, `histogram`, `box`,
  `violin`, `strip`, `pie`, `treemap`, `sunburst`, `density_heatmap`, `funnel`.
- KPI: `_target_: kpi_card` with `value_column`, `agg_func`, `value_format`.
- Table: `type: table` requires `_target_: dash_ag_grid`.
- Custom chart function: `_target_: custom_charts.my_chart` — **module prefix is
  required** for your own functions, and the module must be importable.

## 3. Structure

```yaml
pages:
  - title: Overview
    layout:
      type: grid
      grid: [[0, 1], [0, 2]]
    components:
      - type: card
        text: "# Revenue"
      - type: graph
        figure: {...}
      - type: table
        figure: {_target_: dash_ag_grid, data_frame: sales}
    controls:
      - type: filter
        column: region
        targets: [trend, detail]
      - type: parameter
        targets: [trend.opacity]
        selector: {type: slider, min: 0, max: 1, value: 0.8}
```

- Layout models: `type: grid` (with `grid:`) or `type: flex` (with `direction:`).
- Filters/parameters live in `controls`, not `components`.
- `targets` on a filter is optional; omit to target every component on the page
  whose data source contains that column.
- Actions in YAML must declare `type` explicitly, e.g. `{type: export_data}`.

## 4. Only possible in Python

These have no YAML/JSON form: custom components (`VizroBaseModel` subclasses),
`@capture("action")` actions, `Model.add_type(...)`, Dash objects as arguments,
and registering captured callables. If the task needs one, switch to Python.

## 5. YAML pitfalls

| Pitfall | Fix |
| --- | --- |
| description/value contains `: ` | quote it: `'Revenue: total'` |
| value contains `#` | quote it: `"Version #"` |
| `_target_: my_chart` | prefix the module: `custom_charts.my_chart` |
| filter column dtype differs per data source | cast before registering |
| unknown `type` value | validate; the error lists the accepted tags |

## 6. Validate before serving

```
vizro_validate { config, format: "yaml", data: {...} }
```

Success returns `valid: true` plus the rendered Python code — that code is the
most readable form to review or hand to the user. Failure returns
`errors[{loc,type,msg}]`; `loc` is the dotted path into the config
(`pages.0.components.1.figure`), so fix exactly that node.
