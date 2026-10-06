import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AGENT_ASSIGNMENTS } from "./agent-knowledge.config.js";

const DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "Data");

const STOP_WORDS = new Set([
  "the", "and", "for", "are", "with", "that", "this", "from", "have", "has", "had",
  "was", "were", "what", "which", "who", "whom", "how", "why", "when", "where",
  "our", "your", "their", "its", "into", "over", "under", "than", "then", "them",
  "they", "you", "can", "could", "should", "would", "will", "shall", "may", "might",
  "must", "not", "but", "all", "any", "some", "most", "more", "less", "give", "show",
  "tell", "list", "find", "need", "want", "please", "use", "using", "based", "about",
  "data", "file", "files", "agent", "retailai",
]);

const MAX_ROW_CHARS = 600;

const datasetCache = new Map();

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (quoted) {
      if (char !== '"') {
        field += char;
      } else if (text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = false;
      }
      continue;
    }

    if (char === '"') quoted = true;
    else if (char === ",") { row.push(field); field = ""; }
    else if (char === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (char !== "\r") field += char;
  }

  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function loadDataset(file) {
  const filePath = path.join(DATA_DIR, file);
  const mtimeMs = fs.statSync(filePath).mtimeMs;
  const cached = datasetCache.get(file);
  if (cached?.mtimeMs === mtimeMs) return cached;

  const raw = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  const table = parseCsv(raw).filter((row) => row.some((value) => value.trim() !== ""));
  const headers = (table.shift() || []).map((header) => header.trim());

  const rows = table.map((values) => {
    const record = headers
      .map((header, position) => [header, (values[position] ?? "").trim()])
      .filter(([, value]) => value !== "");
    return {
      text: record.map(([header, value]) => `${header}=${value}`).join(" | "),
      searchable: record.map(([, value]) => value).join(" ").toLowerCase(),
      cells: Object.fromEntries(record),
    };
  });

  const dataset = { file, headers, rows, mtimeMs };
  datasetCache.set(file, dataset);
  return dataset;
}

function extractTerms(question) {
  return [
    ...new Set(
      String(question || "")
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((term) => term.length > 2 && !STOP_WORDS.has(term))
    ),
  ];
}

// Record IDs such as CAMP-0001 or SENT-00001 must match exactly, not by keyword overlap.
function extractIds(question) {
  const found = String(question || "").match(/\b[a-z]{2,}-\d{2,}\b/gi) || [];
  return [...new Set(found.map((id) => id.toLowerCase()))];
}

function matchesId(row, id) {
  const at = row.searchable.indexOf(id);
  if (at === -1) return false;
  const after = row.searchable[at + id.length];
  return after === undefined || !/[a-z0-9-]/.test(after);
}

function selectRows(dataset, terms, ids, maxRows) {
  if (ids.length) {
    const exact = dataset.rows.filter((row) => ids.some((id) => matchesId(row, id)));
    if (exact.length) {
      return { rows: exact.slice(0, maxRows), matched: exact.length, mode: "id" };
    }
  }

  if (terms.length) {
    const scored = dataset.rows
      .map((row, position) => ({
        row,
        position,
        score: terms.reduce((total, term) => total + (row.searchable.includes(term) ? 1 : 0), 0),
      }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.position - b.position);

    if (scored.length) {
      return {
        rows: scored.slice(0, maxRows).map((entry) => entry.row),
        matched: scored.length,
        mode: "keyword",
      };
    }
  }
  return { rows: dataset.rows.slice(0, maxRows), matched: 0, mode: "sample" };
}

function renderDataset(dataset, terms, ids, maxRows, charBudget) {
  const { rows, matched, mode } = selectRows(dataset, terms, ids, maxRows);
  let summary;
  if (mode === "id") {
    summary = `${matched} of ${dataset.rows.length} rows carry the exact record ID from the question (${ids.join(", ")}); showing up to ${rows.length}. Use only these rows for that record.`;
  } else if (mode === "keyword") {
    summary = ids.length
      ? `No row in this file carries ${ids.join(", ")}; showing ${rows.length} of ${matched} keyword matches, which describe other records.`
      : `${matched} of ${dataset.rows.length} rows match the question; showing up to ${rows.length}.`;
  } else {
    summary = `No row matched the question keywords; showing the first ${rows.length} of ${dataset.rows.length} rows as a sample.`;
  }

  const lines = [
    `FILE: ${dataset.file} (${dataset.rows.length} rows)`,
    `COLUMNS: ${dataset.headers.join(", ")}`,
    summary,
  ];

  let used = lines.join("\n").length;
  for (const row of rows) {
    const line = row.text.length > MAX_ROW_CHARS ? `${row.text.slice(0, MAX_ROW_CHARS)}…` : row.text;
    if (used + line.length + 3 > charBudget) break;
    lines.push(`- ${line}`);
    used += line.length + 3;
  }

  return lines.join("\n");
}

export function buildKnowledgeContext(role, question, options = {}) {
  const { maxRowsPerFile = 12, maxChars = 24_000 } = options;
  const assignment = AGENT_ASSIGNMENTS[role];
  if (!assignment?.files?.length) return "";

  const terms = extractTerms(question);
  const ids = extractIds(question);
  const budgetPerFile = Math.floor(maxChars / assignment.files.length);
  const sections = assignment.files.map((file) =>
    renderDataset(loadDataset(file), terms, ids, maxRowsPerFile, budgetPerFile)
  );

  return [
    `LOCAL KNOWLEDGE FOR ${assignment.displayName}`,
    "The records below are read live from this agent's assigned files in the RetailAI Data folder. They are your data access; do not say you cannot read files.",
    "Answer from these records, name the source file for each fact, and state the gap if the shown rows do not cover the question.",
    "When the question names a record ID, use only the rows carrying that exact ID and ignore rows for other records.",
    "",
    sections.join("\n\n"),
  ].join("\n");
}

/** Distinct non-empty values of one column, used to validate agent output against the source data. */
export function getColumnValues(file, column) {
  return new Set(
    loadDataset(file)
      .rows.map((row) => (row.cells[column] || "").trim())
      .filter(Boolean)
  );
}

/** Rows of one file keyed by a column value, for looking a record up by ID or name. */
export function getRecordsBy(file, column) {
  const index = new Map();
  for (const row of loadDataset(file).rows) {
    const key = (row.cells[column] || "").trim().toLowerCase();
    if (key && !index.has(key)) index.set(key, row.cells);
  }
  return index;
}

export function warmLocalKnowledge() {
  const loaded = [];
  for (const [role, assignment] of Object.entries(AGENT_ASSIGNMENTS)) {
    for (const file of assignment.files || []) {
      loaded.push({ role, file, rows: loadDataset(file).rows.length });
    }
  }
  return loaded;
}
