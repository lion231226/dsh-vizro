---
name: vizro-dashboard-design
description: Phase 1 of building a Vizro dashboard — turn a business question into three spec files (information architecture, interaction/UX, visual design) before any code. Use when the user wants a dashboard, report, or data app, and the requirements are still prose.
when_to_use: The user asks for a dashboard/dashboard-like report; no spec/ directory exists yet.
---

# Vizro dashboard — phase 1: design

A dashboard is an answer to questions, not a pile of charts. This phase produces
three files that phase 2 (`vizro-dashboard-build`) implements literally. Do not
write code here, do not start a server.

## Contract with phase 2

- You produce `spec/1_information_architecture.md`, `spec/2_interaction_ux.md`,
  `spec/3_visual_design.md` in the project directory.
- Phase 2 reads them; deviations must be written back into the spec.
- If the user says "just build it", write the three specs first anyway — they
  take minutes and prevent a rebuild later.

## Step 0 — find the data shape before designing

Call `vizro_data` on the real file(s) — never guess column names:

- dtype decides the filter widget and the chart (numeric → range slider,
  categorical → dropdown, datetime → date picker);
- cardinality decides whether a filter is usable (a 500-value category is a
  table, not a dropdown);
- null rate and ranges decide whether a KPI needs a caveat.

Record the result in spec 1 under "Data sources".

## Step 1 — information architecture

Answer in this order, one short line each:

1. **Audience** — who reads this and what decision do they make with it?
2. **Five-second answer** — the 1–3 numbers that must be visible without
   scrolling (these become KPI cards).
3. **Questions, ranked** — at most 5. Each becomes one component, or one page.
4. **Pages** — if there is more than one question family, split into pages:
   one page = one question family. A page is not a scroll container.
5. **Data mapping** — for every question, the exact columns and aggregation
   that answer it (sum/mean/count by what).

Write it as bullets, no prose paragraphs.

## Step 2 — interaction and UX

Decide deliberately, then justify:

- **Filters** — only for dimensions the audience actually re-slices. Every
  filter costs a re-render; three is usually enough.
- **Parameters** — only when a function argument should be user-switchable
  (e.g. a chart's aggregation or a marginal plot type).
- **Click interactions** — only if the user must move between two views of the
  same data (cross-filter, cross-highlight, drill-through) or export data.
  If standard filters are enough, say so explicitly in the spec — that sentence
  is what keeps phase 2 from over-engineering.
- **Default state** — what the page shows on first load, and what "no data"
  looks like.
- **Empty / error state** — one line each.

## Step 3 — visual design

- **Grid** — page columns (12 is the default), how many components per row, and
  which component is the hero. Keep rows rectangular: the same row must span
  the same columns.
- **Chart type per question** — line for trend, bar for comparison, histogram
  for distribution, scatter for correlation, KPI card for a single number,
  table (AG Grid) for detail. If the answer needs aggregation first, say so:
  bar/line on raw rows is a phase-2 defect.
- **Colours** — default to the Vizro theme. Only specify a palette when the
  brand requires it, and then name the source (`vizro.themes`).
- **Text** — page title, component titles, axis labels. Titles carry the
  insight, not the column name ("Revenue by region", not "revenue").

## Review before handing over

- [ ] Every question in spec 1 maps to a component in spec 3.
- [ ] Every filter in spec 2 targets something in spec 3.
- [ ] No chart requires a column that is not in the data profile.
- [ ] The five-second answer is possible from the top row alone.
- [ ] The user has confirmed the specs (or explicitly waived confirmation).

## Anti-patterns

- A page with ten charts and no question.
- A filter on a column with hundreds of values.
- A pie chart with more than five slices.
- "Make it look nice" with no information architecture — that is a redesign,
  not a design.
- Designing around data you have not profiled.
