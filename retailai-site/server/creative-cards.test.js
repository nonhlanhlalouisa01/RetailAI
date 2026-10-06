import assert from "node:assert/strict";
import test from "node:test";

import { CREATIVE_DIRECTIVE, extractCreatives } from "./creative-cards.js";

const block = (spec) => `[[CREATIVE]]${JSON.stringify(spec)}[[/CREATIVE]]`;

test("resolves a card from the application record", () => {
  const { text, creatives } = extractCreatives(
    `${block({ applicationId: "APP-00001", why: "Strongest campus reach." })}\nShortlist the top two.`
  );

  assert.equal(creatives.length, 1);
  assert.equal(creatives[0].name, "Karabo Mthembu");
  assert.equal(creatives[0].location, "Durban");
  assert.match(creatives[0].bio, /Campus ambassador based in Durban/);
  assert.equal(creatives[0].audience, "Young professionals");
  assert.equal(creatives[0].experience, "1-2 local campaigns");
  assert.equal(creatives[0].campaignFit, "Denim Revival 010");
  assert.equal(creatives[0].why, "Strongest campus reach.");
  assert.match(creatives[0].portfolioLink, /^https:\/\//);
  assert.match(creatives[0].imageUrl, /^\/assets\/creatives\//);
  assert.equal(creatives[0].handle, "@karabo.mthembu");
  assert.equal(typeof creatives[0].brandFit, "number");
  assert.equal(creatives[0].availability, "Within 2 weeks");
  assert.equal(text.trim(), "Shortlist the top two.");
});

test("resolves by applicant name as well as ID", () => {
  const { creatives } = extractCreatives(block({ applicationId: "Karabo Mthembu" }));
  assert.equal(creatives[0].applicationId, "APP-00001");
});

test("drops applicants that do not exist in the data", () => {
  const { creatives } = extractCreatives(block({ applicationId: "APP-99999", why: "Invented." }));
  assert.equal(creatives.length, 0);
});

test("does not repeat the same person", () => {
  const { creatives } = extractCreatives(block({ applicationId: "APP-00001" }).repeat(3));
  assert.equal(creatives.length, 1);
});

test("caps the shortlist at six", () => {
  const ids = ["APP-00001", "APP-00002", "APP-00003", "APP-00004", "APP-00005", "APP-00006", "APP-00007", "APP-00008"];
  const { creatives } = extractCreatives(ids.map((id) => block({ applicationId: id })).join("\n"));
  assert.equal(creatives.length, 6);
});

test("directs the portfolio agent to use real application IDs", () => {
  assert.match(CREATIVE_DIRECTIVE, /portfolio_applications\.csv/);
  assert.match(CREATIVE_DIRECTIVE, /headshot and profile/);
  assert.match(CREATIVE_DIRECTIVE, /\[\[CREATIVE\]\]/);
});
