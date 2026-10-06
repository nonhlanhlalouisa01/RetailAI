import assert from "node:assert/strict";
import test from "node:test";

import { normalizeReply, RESPONSE_STYLE } from "./response-style.js";

test("removes markdown emphasis and headings", () => {
  const reply = normalizeReply("## Campaign Summary\n**Budget:** R693,886\n*Denim Revival 001*");
  assert.equal(reply, "Campaign Summary\nBudget: R693,886\nDenim Revival 001");
});

test("replaces long dashes with executive punctuation", () => {
  assert.equal(normalizeReply("Budget — R693,886"), "Budget, R693,886");
  assert.equal(normalizeReply("2024–2025 outlook"), "2024, 2025 outlook");
});

test("normalizes bullet markers to plain hyphens", () => {
  assert.equal(normalizeReply("* Denim\n+ Knitwear"), "- Denim\n- Knitwear");
});

test("keeps figures, currency, and plain text intact", () => {
  const reply = normalizeReply("ROI potential: 197%. Forecast: ZAR 10.12 million.");
  assert.equal(reply, "ROI potential: 197%. Forecast: ZAR 10.12 million.");
});

test("instructs every agent to write for an executive audience", () => {
  assert.match(RESPONSE_STYLE, /CEO, CFO, or CIO/);
  assert.match(RESPONSE_STYLE, /no hash headings/);
  assert.match(RESPONSE_STYLE, /Never use the em dash/);
});

test("instructs every agent to reply in the user's language", () => {
  assert.match(RESPONSE_STYLE, /LANGUAGE/);
  assert.match(RESPONSE_STYLE, /reply in that same language/);
  for (const lang of ["Afrikaans", "isiZulu", "isiXhosa", "Sesotho", "Sepedi", "Setswana", "Xitsonga", "Tshivenda", "siSwati", "isiNdebele"]) {
    assert.match(RESPONSE_STYLE, new RegExp(lang), `RESPONSE_STYLE should name ${lang}`);
  }
  for (const lang of ["Swahili", "Yoruba", "Hausa", "Amharic"]) {
    assert.match(RESPONSE_STYLE, new RegExp(lang), `RESPONSE_STYLE should name ${lang}`);
  }
});
