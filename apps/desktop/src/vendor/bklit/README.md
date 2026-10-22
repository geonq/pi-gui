# Vendored Bklit UI charts

Source: https://github.com/bklit/bklit-ui (registry `apps/web/public/r/*.json`, main at f952db1bb928fc66acb1de95c966f946669fc3a2, fetched 2026-10-20), MIT (see LICENSE).
Materialized like `shadcn add` for: area-chart, bar-chart, ring-chart, heatmap-chart and their registry dependencies (examples skipped; app code imports each chart module directly, no barrel).
`@/` resolves here (tsconfig.paths.json). Styling: src/styles/charts.css (Tailwind theme + utilities, no preflight).

Local patch: components/charts/chart-loading-label.tsx imports `@/components/shimmering-text`
(the registry's relative import matches Bklit's monorepo layout, not its install targets).
Local patch: heatmap-chart.tsx paints cells with a custom `colorScale` (upstream maps counts 0-4 to levels).
Local patch: heatmap-x-axis.tsx drops a leading month label that would collide with the next.
