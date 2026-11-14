---
name: vizro-layouts
description: Vizro 1.0 layout reference — Grid vs Flex, the rectangular-span rule, component sizing, filter placement and container nesting. Use when placing components on a page or debugging a layout that renders wrong.
when_to_use: Choosing a page layout, or a component renders squashed/overlapping.
---

# Vizro layouts

`vm.Page(layout=...)` picks one of two layouts. Default (no `layout`) is a
vertical stack — fine for one column, wrong for a dashboard.

## Grid — the default choice for dashboards

```python
page = vm.Page(
    title="Sales",
    layout=vm.Grid(grid=[[0, 1], [0, 2]]),
    components=[vm.Card(text="KPI"), vm.Graph(id="trend", figure=...), vm.Graph(id="mix", figure=...)],
)
```

- `grid` is a list of rows; each row is a list of **component indexes**.
- An index repeated in a row means that component spans those columns — this is
  how a hero chart gets two columns.
- **Rectangular rule**: a component's spans must describe a rectangle across
  rows. `[[0,1],[0,2]]` is legal (0 spans both rows in column 0); `[[0,1],[1,2]]`
  is not (1 appears in different columns).
- Every component on the page must appear in the grid exactly once, or it will
  not render.

Common shapes:

| Shape | Grid |
| --- | --- |
| one component | `[[0]]` |
| KPI row + chart | `[[0, 1, 2], [3, 3, 3]]` |
| hero + sidebar | `[[0, 0, 1], [2, 2, 1]]` |
| 2×2 | `[[0, 1], [2, 3]]` |

## Flex — for one-axis stacks

```python
layout=vm.Flex(direction="row")   # column is the default
layout=vm.Flex(direction="row", gap="16px", wrap=True)
```

Use Flex when components should keep their natural width and wrap, and Grid
when the page needs an explicit visual hierarchy. Mixing both is fine: a
Container can carry its own `layout=vm.Flex(...)`.

## Component sizing

- `vm.Graph(..., height=320)` sets a fixed chart height; without it the grid row
  height is derived and charts can look squashed.
- `vm.Graph(..., width=...)` is rarely needed — the grid decides width.
- KPI cards (`vm.Figure`) are short; put them in one row at the top.
- A `vm.Table` with many columns needs a full-width row, not a 1/3 column.

## Filters and parameters

- Filters render in the page's control panel (left side by default). They are
  not page components and do not take grid slots.
- Group related controls with `vm.ControlGroup(components=[...])` when a page
  has more than four.
- A filter placed in a `Container` scopes to that container's children, which
  is how you build two independently filtered halves.

## Containers, Tabs, Cards

- `vm.Container(title=..., components=[...])` — a section with its own title,
  layout and controls. Nesting is allowed; two levels are usually enough.
- `vm.Tabs(tabs=[vm.Container(...), ...])` — same screen space, mutual
  exclusion. Good for alternate views of one question; bad for hiding pages
  the user must compare.
- `vm.Card(text="**Label**", ...)` — markdown callout or KPI-free explanation.

## Failure modes

| Symptom | Cause | Fix |
| --- | --- | --- |
| component missing from the page | not referenced in `grid` | add its index |
| `Grid must be rectangular` style error | spans are not a rectangle | make each index occupy one contiguous column block across rows |
| chart is squashed | fixed small row + tall content | set `height=` and give it a full-width row |
| filter does nothing | filter placed outside the container that holds its targets, or column dtype mismatch | move it or set explicit `targets=` |
| two charts overlap on narrow screens | Grid with too many columns | reduce columns per row or switch to Flex with wrap |
