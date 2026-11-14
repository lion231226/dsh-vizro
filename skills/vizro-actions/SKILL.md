---
name: vizro-actions
description: Vizro 1.0 interaction reference — built-in actions (export, set_controls, notifications, update_targets) and custom @capture actions, with the four patterns that matter: cross-filter, cross-highlight, drill-through and export. Use when a dashboard must react to a click.
when_to_use: The spec's Interactions section asks for clicking, drill-through or export.
---

# Vizro actions

An action is a callback with a declaration. It attaches to the **source**
component (`actions=`) and writes to targets through callbacks. Everything that
is not needed is not written: prefer Filter/Parameter over an action.

## Built-in actions (import `vizro.actions as va`)

| Action | Use | Minimal |
| --- | --- | --- |
| `va.export_data(...)` | download filtered data | `vm.Button(text="Export", actions=va.export_data(targets=["table"], file_format="csv"))` |
| `va.set_controls(...)` | a click sets a Filter/Parameter | `vm.Graph(id="source", actions=va.set_controls(controls="my_filter", value="species"), figure=...)` |
| `va.update_targets()` | refresh figures on demand | `vm.Button(text="Refresh", actions=va.update_targets())` |
| `va.show_notification(...)` | toast | `vm.Button(text="Ping", actions=va.show_notification(message="done"))` |
| `va.update_notification(...)` | update an existing toast | used with `show_notification` for progress |

`filter_interaction` and `set_control` were removed in 1.0 — use `set_controls`.

## Pattern 1 — cross-filter (click a point, filter another chart)

```python
vm.Graph(
    id="scatter",
    figure=px.scatter("sales", x="units", y="revenue", color="region", custom_data=["region"]),
    actions=va.set_controls(controls="region_filter"),
),
vm.Filter(id="region_filter", column="region", targets=["detail_table"]),
vm.Table(id="detail_table", figure=dash_ag_grid("sales")),
```

`custom_data=[...]` must name the column the action should read. The filter must
exist in `controls` — 1.0 removed the implicit filter.

## Pattern 2 — drill-through (navigate to another page)

```python
vm.Graph(
    id="trend",
    figure=px.line("sales", x="month", y="revenue", custom_data=["month"]),
    actions=va.set_controls(controls="month_filter", value="month"),
),
# another page owns the filter and its own charts
```

State is written into the control, so page navigation keeps it.

## Pattern 3 — export

```python
vm.Button(text="Download CSV", actions=va.export_data(targets=["table", "scatter"], file_format="csv"))
```

Exports the **filtered** data of the targets, not the raw frame.

## Pattern 4 — custom action

```python
from vizro.models.types import capture

@capture("action")
def highlight_top(data_frame, n: int = 5):
    top = data_frame.nlargest(n, "revenue")
    return f"Top {n}: {', '.join(top['region'])}"

vm.Button(
    text="Show top",
    actions=vm.Action(function=highlight_top(), outputs=["caption.children"]),
),
vm.Card(id="caption", text="…"),
```

Rules: the first argument is the data of the source component; extra arguments
are runtime inputs referenced as `"component.property"`; `outputs` are
`"component.property"` strings; static values go in the function body, not the
declaration.

## Debugging actions

- A wrong action usually fails **only on click** — never on load. Load the
  dashboard, click the source, then read `vizro_run {action:"logs"}` for the
  traceback and `vizro_probe` for the HTTP result.
- 500 on `_dash-update-component` means a callback raised: the server log has
  the real cause.
- A custom chart used as a cross-filter source must accept `custom_data` as a
  **function parameter** — hardcoding it inside the body raises at click time.
- `outputs` naming a non-existent id/property raises at build time; check the
  component id spelling first.

## When not to use an action

- Simple re-slicing → `vm.Filter`.
- Switching a function argument → `vm.Parameter`.
- Showing detail on the same page → a table plus a filter is usually enough.
