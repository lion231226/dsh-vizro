---
name: vizro-charts
description: Vizro 1.0 chart reference — pick the chart for the question, use vizro.plotly.express, KPI cards, AG Grid tables, pre-aggregation with @capture, and the theme colour rules. Use when a chart type, KPI card or table needs to be written or fixed.
when_to_use: Writing components; a chart renders empty, unreadable or off-theme.
---

# Vizro charts

## First rule: import the wrapped express

```python
import vizro.plotly.express as px   # NOT plotly.express
```

Only `vizro.plotly.express` registers the figure so filters and parameters can
reach it. Plain `plotly.express` produces a chart that ignores every control.

## Second rule: data by name

```python
from vizro.managers import data_manager
data_manager["sales"] = df
vm.Graph(figure=px.bar("sales", x="region", y="revenue"))
```

The string is the data key. In a `@capture` function the argument is already a
DataFrame — never look it up again inside the function (that is the classic
blank-chart bug).

## Choose by question

| Question | Chart | Notes |
| --- | --- | --- |
| trend over time | `px.line` | aggregate first; time on x |
| compare categories | `px.bar` | sort by value; avoid > 12 bars |
| distribution | `px.histogram` / `px.box` | histogram for shape, box for outliers |
| relationship | `px.scatter` | one row = one point, no aggregation |
| composition | `px.treemap` / `px.sunburst` | not a pie with 12 slices |
| single number | KPI card | see below |
| detail rows | AG Grid table | see below |
| two dimensions | `px.density_heatmap` | for region × month patterns |

## Pre-aggregate bar and line

```python
from vizro.models.types import capture

@capture("graph")
def revenue_by_month(data_frame, **kwargs):
    grouped = data_frame.groupby("month", as_index=False)["revenue"].sum()
    return px.bar(grouped, x="month", y="revenue", **kwargs)

vm.Graph(figure=revenue_by_month("sales"))
```

Passing raw detail rows to `px.bar` renders one bar per row — unreadable, and
the most common review finding.

## KPI cards

```python
import vizro.figures as vf
vm.Figure(figure=vf.kpi_card(
    data_frame="sales",
    value_column="revenue",
    agg_func="sum",
    title="Total revenue",
    value_format="${value:,.0f}",
))
```

- Title lives **inside** the card arguments; `vm.Figure` has no `title`.
- `vf.kpi_card_reference(...)` adds a comparison value and delta.
- A dynamic KPI (text computed per interaction) is a `@capture("figure")`
  function, not a rebuilt chart.

### The KPI data source must be detail-only

`kpi_card` aggregates **the whole frame it receives** —
`df[value_column].agg(agg_func)`, with `agg_func="sum"` as the default. A source
that already ends with a `合计 / 总计 / TOTAL` row therefore gets counted twice:
`3 + 7 + 10 = 20` where the answer is `10`. The card is silently wrong, the
chart next to it is right, and readers trust the card. The plugin's
`vizro_validate` warns (`kpi_card_double_counts_total`) when it sees a
`kpi_card` bound to a frame with an aggregate-looking row — treat the warning as
a bug, not noise.

Register a detail-only frame for KPI components:

```python
from vizro.managers import data_manager

raw = pd.read_csv("data/sales.csv")
detail = raw[~raw["region"].isin(["合计", "总计", "TOTAL"])]  # or filter on the label column

data_manager["sales_detail"] = detail      # KPI cards read this
data_manager["sales"] = raw                # charts/tables may keep the total row
```

Then point every `kpi_card` at `data_frame="sales_detail"`. A filter does **not**
save you: Vizro passes the filtered *whole* frame, so the total row survives
filtering and the card stays wrong in a way that looks like it responded.

## Tables

```python
from vizro.tables import dash_ag_grid
vm.Table(figure=dash_ag_grid(data_frame="sales"))
```

`Table` renders only `dash_ag_grid` in 1.0. `dash_data_table` and the `AgGrid`
model were removed.

## Colours

- Default: add none. The Vizro theme supplies a colourblind-safe palette.
- Brand palette needed: `from vizro.themes import palettes, colors` and pass a
  named palette; never invent hex values.
- Conditional formatting on AG Grid cells: use `vizro.themes.colors`.

## Failure modes

| Symptom | Cause | Fix |
| --- | --- | --- |
| empty chart | data key not registered, or captured function re-looked-up the frame | register with `data_manager`, use the argument directly |
| filters do not affect the chart | imported `plotly.express` | switch to `vizro.plotly.express` |
| bar chart is a comb | raw detail rows | pre-aggregate with `@capture("graph")` |
| KPI shows weird text | `value_format` mismatch | `"${value:,.0f}"` for numbers, `"{value:.1f}%"` for percentages |
| theme ignored | hardcoded `color_discrete_map`/`plot_bgcolor` | remove, or take colours from `vizro.themes` |
