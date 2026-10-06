// retailai-site/server/analytics-visuals.js
// The Analytics agent answers with visual specs first, narrative second. It emits
// [[VISUAL]]{json}[[/VISUAL]] blocks that the browser renders with Chart.js.

const MAX_VISUALS = 4;
const MAX_LABELS = 24;
const MAX_SERIES = 4;
const MAX_KPIS = 6;
const MAX_TEXT = 90;

const CHART_TYPES = new Set([
  "bar",
  "stackedBar",
  "horizontalBar",
  "line",
  "area",
  "pie",
  "doughnut",
  "radar",
  "scatter",
]);

// Types the model may reasonably ask for that Chart.js cannot draw unaided.
const TYPE_FALLBACKS = {
  heatmap: "bar",
  waterfall: "bar",
  funnel: "horizontalBar",
  map: "bar",
  column: "bar",
  histogram: "bar",
  donut: "doughnut",
  trend: "line",
  forecast: "line",
};

export const VISUAL_DIRECTIVE = [
  "VISUAL FIRST — MANDATORY",
  "You are an executive retail analyst. Lead with the picture, then the words.",
  "Every single answer must open with at least one visual, and at most four. There is no exception: never reply with prose alone.",
  "Emit each visual as its own block, exactly in this form and nothing else inside the block:",
  "[[VISUAL]]{\"kind\":\"chart\",\"type\":\"bar\",\"title\":\"Revenue by campaign\",\"labels\":[\"Denim Revival\",\"Winter Streetwear\"],\"series\":[{\"label\":\"Revenue (R m)\",\"data\":[9.55,6.87]}],\"insight\":\"Denim leads on revenue.\"}[[/VISUAL]]",
  "Use kind \"kpi\" for scorecards: [[VISUAL]]{\"kind\":\"kpi\",\"title\":\"Headline metrics\",\"items\":[{\"label\":\"ROI\",\"value\":\"1276.3%\",\"note\":\"target 123%\"}]}[[/VISUAL]]",
  "Chart types available: bar, stackedBar, horizontalBar, line, area, pie, doughnut, radar, scatter.",
  "Choose the type that fits the question: bar to compare, line or area for trend and forecast, pie or doughnut for share of mix, radar for multi-metric scoring, scatter for correlation, kpi for headline numbers.",
  "Vary the chart type across answers rather than defaulting to bar every time.",
  "Every data value must be a real number taken from the records, never invented or rounded away. Keep labels short.",
  "Do not describe the chart in the narrative. State what it proves, the commercial implication, and the recommended action.",
  "If the records only support a couple of numbers, still visualise them — use a kpi scorecard rather than dropping to prose.",
].join("\n");

const VISUAL_BLOCK = /\[\[VISUAL\]\]([\s\S]*?)\[\[\/VISUAL\]\]/g;

function cleanText(value, limit = MAX_TEXT) {
  if (typeof value !== "string") return "";
  return value.trim().replace(/\s+/g, " ").slice(0, limit);
}

function toNumber(value) {
  const parsed = typeof value === "string" ? Number(value.replace(/[^\d.-]/g, "")) : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeChart(spec) {
  const requested = String(spec.type || "bar");
  const type = CHART_TYPES.has(requested) ? requested : TYPE_FALLBACKS[requested.toLowerCase()];
  if (!type) return null;

  if (type === "scatter") {
    const points = (Array.isArray(spec.series?.[0]?.data) ? spec.series[0].data : [])
      .map((point) => ({ x: toNumber(point?.x), y: toNumber(point?.y) }))
      .filter((point) => point.x !== null && point.y !== null)
      .slice(0, MAX_LABELS);
    if (points.length < 2) return null;
    return {
      kind: "chart",
      type,
      title: cleanText(spec.title),
      insight: cleanText(spec.insight, 160),
      labels: [],
      series: [{ label: cleanText(spec.series?.[0]?.label) || "Observations", data: points }],
    };
  }

  const labels = (Array.isArray(spec.labels) ? spec.labels : [])
    .map((label) => cleanText(label, 40))
    .filter(Boolean)
    .slice(0, MAX_LABELS);
  if (!labels.length) return null;

  const series = (Array.isArray(spec.series) ? spec.series : [])
    .slice(0, MAX_SERIES)
    .map((entry) => ({
      label: cleanText(entry?.label, 60),
      data: (Array.isArray(entry?.data) ? entry.data : []).slice(0, labels.length).map(toNumber),
    }))
    .filter((entry) => entry.data.length === labels.length && entry.data.every((value) => value !== null));
  if (!series.length) return null;

  return {
    kind: "chart",
    type,
    title: cleanText(spec.title),
    insight: cleanText(spec.insight, 160),
    labels,
    series,
  };
}

function normalizeKpi(spec) {
  const items = (Array.isArray(spec.items) ? spec.items : [])
    .slice(0, MAX_KPIS)
    .map((item) => ({
      label: cleanText(item?.label, 40),
      value: cleanText(item?.value, 24),
      note: cleanText(item?.note, 48),
    }))
    .filter((item) => item.label && item.value);

  return items.length ? { kind: "kpi", title: cleanText(spec.title), items } : null;
}

/** Pulls visual blocks out of an agent reply, returning the remaining prose separately. */
export function extractVisuals(text) {
  if (typeof text !== "string" || !text) return { text: "", visuals: [] };

  const visuals = [];
  const remaining = text.replace(VISUAL_BLOCK, (_match, payload) => {
    if (visuals.length >= MAX_VISUALS) return "";
    let spec;
    try {
      spec = JSON.parse(payload.trim());
    } catch {
      return "";
    }
    const visual = spec?.kind === "kpi" ? normalizeKpi(spec) : normalizeChart(spec);
    if (visual) visuals.push(visual);
    return "";
  });

  return { text: remaining, visuals };
}

// "Label: 42.1%" or "Label - R 9.55m", the shape numbers usually take in the prose.
const METRIC_LINE = /^[\s\-*•]*([A-Za-z][A-Za-z0-9 ,/&()'%-]{2,40}?)\s*[:\-–]\s*((?:R\s?)?-?[\d][\d\s,.]*\s*(?:%|m|bn|k|x|pts)?)\s*$/i;

/**
 * The analytics agent is required to visualise every answer. When it replies in prose
 * anyway, salvage the numbers it quoted into a KPI card so the rule still holds.
 */
export function fallbackVisual(text) {
  if (typeof text !== "string" || !text) return null;

  const items = [];
  for (const line of text.split("\n")) {
    const match = line.match(METRIC_LINE);
    if (!match) continue;
    const label = cleanText(match[1], 40);
    const value = cleanText(match[2], 24);
    if (!label || !value) continue;
    if (items.some((item) => item.label.toLowerCase() === label.toLowerCase())) continue;
    items.push({ label, value, note: "" });
    if (items.length === MAX_KPIS) break;
  }

  return items.length ? { kind: "kpi", title: "Figures in this answer", items } : null;
}
