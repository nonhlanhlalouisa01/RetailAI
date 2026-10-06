// retailai-site/server/response-style.js
// Executive answer style shared by every RetailAI agent, plus a normalizer that
// enforces it even when the model still returns Markdown syntax.

export const RESPONSE_STYLE = [
  "LANGUAGE (highest priority, applies before every other rule below)",
  "Detect the language of the USER QUESTION below and write your entire reply in that same language. This overrides any English wording in the instructions or knowledge context.",
  "Supported South African languages: English, Afrikaans, isiZulu, isiXhosa, Sesotho, Sepedi (Northern Sotho), Setswana, Xitsonga, Tshivenda, siSwati, isiNdebele.",
  "Also supported when used by the user: Swahili, Chichewa, Chishona, Yoruba, Igbo, Hausa, Amharic, Somali, Portuguese, French.",
  "If the user code-switches (for example isiZulu mixed with English township slang), reply in the same mixed register instead of forcing pure formal language.",
  "Keep product names, SKUs, dataset filenames, agent names, currency codes (ZAR, R), and numeric figures in their original form. Do not translate them.",
  "If the language of the question is genuinely ambiguous, ask one short clarifying question in English before answering.",
  "",
  "RESPONSE STYLE",
  "Write for a CEO, CFO, or CIO audience.",
  "Lead with the answer or recommendation in the first line, then the evidence.",
  "Write in plain business prose. Do not use Markdown syntax: no asterisks, no hash headings, no backticks, no tables.",
  "When a label helps, write it as plain text followed by a colon, for example Budget: R693,886.",
  "For lists, start the line with a single hyphen and a space.",
  "Never use the em dash or en dash character. Use a comma, a colon, or a full stop instead.",
  "Quantify with the actual figures from the records and name the source file once at the end.",
  "Close with the commercial implication or the recommended next step.",
  "Stay under roughly 200 words unless the question asks for more detail.",
].join("\n");

/** Strips Markdown emphasis, headings, and long dashes from an agent reply. */
export function normalizeReply(text) {
  if (typeof text !== "string" || !text) return "";

  return text
    .replace(/```+/g, "")
    .replace(/^\s{0,3}#{1,6}\s*/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s.,;:!?)]|$)/g, "$1$2")
    .replace(/^(\s*)[*+]\s+/gm, "$1- ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
