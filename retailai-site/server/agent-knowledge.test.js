import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_ASSIGNMENTS,
  fileSearchUploadName,
  MASTER_DATA_REPOSITORY,
  UNASSIGNED_DATASETS,
  validateKnowledgeAssignments,
} from "./agent-knowledge.config.js";

test("maps every business dataset to exactly one specialist", () => {
  const files = Object.values(AGENT_ASSIGNMENTS).flatMap((assignment) => assignment.files);
  assert.equal(files.length, 14);
  assert.equal(new Set(files).size, files.length);
  assert.deepEqual(validateKnowledgeAssignments(), []);
});

test("keeps Concierge and the master workbook out of specialist knowledge", () => {
  const files = Object.values(AGENT_ASSIGNMENTS).flatMap((assignment) => assignment.files);
  assert.deepEqual(AGENT_ASSIGNMENTS.concierge.files, []);
  assert.deepEqual(
    UNASSIGNED_DATASETS,
    [MASTER_DATA_REPOSITORY, "CompetitorSignals.json", "sentiment_taxonomy.csv"]
  );
  assert.equal(UNASSIGNED_DATASETS.some((file) => files.includes(file)), false);
});

test("stages every CSV as supported text without renaming JSON", () => {
  const files = Object.values(AGENT_ASSIGNMENTS).flatMap((assignment) => assignment.files);
  const uploadNames = files.map(fileSearchUploadName);

  assert.equal(uploadNames.every((file) => file.endsWith(".txt") || file.endsWith(".json")), true);
  assert.equal(fileSearchUploadName("campaign_briefs.csv"), "campaign_briefs.csv.txt");
  assert.equal(fileSearchUploadName("reference.json"), "reference.json");
});

test("assigns the requested sentiment, analytics, and portfolio sources", () => {
  assert.deepEqual(AGENT_ASSIGNMENTS.sentiment.files, ["customer_sentiment_signals.csv"]);
  assert.deepEqual(AGENT_ASSIGNMENTS.analytics.files, [
    "trend_signals.csv",
    "seasonal_calendar.csv",
    "product_catalogue.csv",
    "kpi_targets.csv",
    "customer_intelligence.csv",
  ]);
  assert.deepEqual(AGENT_ASSIGNMENTS.portfolio.files, [
    "growth_opportunity_register.csv",
    "portfolio_applications.csv",
    "portfolio_scoring_rubric.csv",
  ]);
});

test("defines explicit Concierge routes for all specialist domains", () => {
  const instructions = AGENT_ASSIGNMENTS.concierge.instructions;
  for (const label of ["Campaign Intelligence", "Sentiment Analysis", "Performance", "Portfolio Intelligence"]) {
    assert.match(instructions, new RegExp(label));
  }
});