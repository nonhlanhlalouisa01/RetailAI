import assert from "node:assert/strict";
import test from "node:test";

import { extractVisuals, VISUAL_DIRECTIVE } from "./analytics-visuals.js";

const chartBlock = (spec) => `[[VISUAL]]${JSON.stringify(spec)}[[/VISUAL]]`;

test("pulls a chart out of the reply and leaves the narrative behind", () => {
  const reply = `${chartBlock({
    kind: "chart",
    type: "bar",
    title: "Revenue by campaign",
    labels: ["Denim Revival", "Winter Streetwear"],
    series: [{ label: "Revenue (R m)", data: [9.55, 6.87] }],
    insight: "Denim leads on revenue.",
  })}\nDenim should take the extra budget.`;

  const { text, visuals } = extractVisuals(reply);

  assert.equal(visuals.length, 1);
  assert.equal(visuals[0].type, "bar");
  assert.deepEqual(visuals[0].series[0].data, [9.55, 6.87]);
  assert.match(text.trim(), /^Denim should take the extra budget\.$/);
});

test("keeps KPI scorecards", () => {
  const { visuals } = extractVisuals(
    chartBlock({ kind: "kpi", title: "Headline", items: [{ label: "ROI", value: "1276.3%", note: "target 123%" }] })
  );
  assert.equal(visuals[0].kind, "kpi");
  assert.equal(visuals[0].items[0].value, "1276.3%");
});

test("maps chart types Chart.js cannot draw onto the closest supported type", () => {
  const { visuals } = extractVisuals(
    chartBlock({ kind: "chart", type: "heatmap", labels: ["A"], series: [{ label: "x", data: [1] }] })
  );
  assert.equal(visuals[0].type, "bar");
});

test("drops malformed, empty, or non-numeric visuals", () => {
  const cases = [
    "[[VISUAL]]not json[[/VISUAL]]",
    chartBlock({ kind: "chart", type: "bar", labels: [], series: [{ label: "x", data: [] }] }),
    chartBlock({ kind: "chart", type: "bar", labels: ["A", "B"], series: [{ label: "x", data: [1] }] }),
    chartBlock({ kind: "kpi", items: [] }),
  ];
  for (const reply of cases) {
    const { visuals, text } = extractVisuals(reply);
    assert.equal(visuals.length, 0, `expected no visual for: ${reply}`);
    assert.equal(text.trim(), "");
  }
});

test("caps the number of visuals returned", () => {
  const one = chartBlock({ kind: "chart", type: "bar", labels: ["A"], series: [{ label: "x", data: [1] }] });
  const { visuals } = extractVisuals(one.repeat(9));
  assert.equal(visuals.length, 4);
});

test("directs the analytics agent to lead with visuals", () => {
  assert.match(VISUAL_DIRECTIVE, /executive retail analyst/);
  assert.match(VISUAL_DIRECTIVE, /\[\[VISUAL\]\]/);
  assert.match(VISUAL_DIRECTIVE, /never invented/);
});
