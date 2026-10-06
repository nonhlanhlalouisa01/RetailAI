import assert from "node:assert/strict";
import test from "node:test";

import { buildKnowledgeContext, warmLocalKnowledge } from "./local-knowledge.js";

test("loads every assigned file with rows", () => {
  const loaded = warmLocalKnowledge();
  assert.equal(loaded.length, 14);
  assert.ok(loaded.every((item) => item.rows > 0));
});

test("grounds an agent only in its own files", () => {
  const context = buildKnowledgeContext("campaign", "Which campaigns target winter?");
  assert.match(context, /FILE: campaign_briefs\.csv/);
  assert.match(context, /FILE: creator_match_scores\.csv/);
  assert.doesNotMatch(context, /customer_sentiment_signals\.csv/);
  assert.doesNotMatch(context, /portfolio_applications\.csv/);
});

test("returns no knowledge block for the routing-only concierge", () => {
  assert.equal(buildKnowledgeContext("concierge", "Which campaigns target winter?"), "");
});

test("selects question-relevant rows and stays within the character budget", () => {
  const context = buildKnowledgeContext("analytics", "denim trend", { maxChars: 6000 });
  assert.ok(context.length <= 6500, `context was ${context.length} characters`);
  assert.match(context, /rows match the question/);
  assert.match(context.toLowerCase(), /denim/);
});

test("returns only the exact record when the question names an ID", () => {
  const context = buildKnowledgeContext("campaign", "Summarise campaign CAMP-0001 for the board.");
  const briefs = context.split("FILE: ").find((block) => block.startsWith("campaign_briefs.csv"));
  const rows = briefs.split("\n").filter((line) => line.startsWith("- "));

  assert.match(briefs, /carry the exact record ID/);
  assert.ok(rows.length > 0);
  assert.ok(rows.every((row) => /\bCAMP-0001\b/.test(row)), "a row for another campaign leaked in");
});

test("is stable across repeated asks for the same record", () => {
  const question = "What was the ROI on CAMP-0001?";
  assert.equal(buildKnowledgeContext("campaign", question), buildKnowledgeContext("campaign", question));
});
