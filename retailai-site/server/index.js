// retailai-site/server/index.js
// Minimal Express proxy that:
//   • Serves the static site from ../ (so index.html and /api/* share one origin)
//   • Forwards chat requests to the Azure AI Foundry Agents REST API
//   • Handles auth via DefaultAzureCredential (Entra ID) or an API key
//
// Never expose AZURE_AI_API_KEY or an Entra token to the browser.

import "dotenv/config";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { AgentsClient } from "@azure/ai-agents";
import express from "express";
import { DefaultAzureCredential } from "@azure/identity";
import {
  formatSignalsForAgent,
  generateSyntheticSignals,
  normalizeMetaWebhook,
  normalizeProviderSignals,
  SocialSignalStore,
  verifyMetaSignature,
} from "./social-signals.js";
import { buildKnowledgeContext, warmLocalKnowledge } from "./local-knowledge.js";
import { normalizeReply, RESPONSE_STYLE } from "./response-style.js";
import { extractVisuals, fallbackVisual, VISUAL_DIRECTIVE } from "./analytics-visuals.js";
import { CREATIVE_DIRECTIVE, extractCreatives } from "./creative-cards.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITE_DIR = path.resolve(__dirname, "..");

const {
  AZURE_AI_PROJECT_ENDPOINT,
  AZURE_AI_API_VERSION = "v1",
  AZURE_AI_API_KEY,
  META_APP_SECRET,
  META_WEBHOOK_VERIFY_TOKEN,
  SOCIAL_INGEST_TOKEN,
  SOCIAL_SIGNAL_LIMIT = 500,
  SYNTHETIC_SOCIAL_ENABLED = "false",
  SYNTHETIC_SOCIAL_INITIAL_COUNT = 18,
  SYNTHETIC_SOCIAL_INTERVAL_MS = 10_000,
  SYNTHETIC_SOCIAL_BATCH_SIZE = 2,
  PORT = 3000,
} = process.env;

if (!AZURE_AI_PROJECT_ENDPOINT) {
  console.error("Missing AZURE_AI_PROJECT_ENDPOINT — copy .env.example to .env and fill it in.");
  process.exit(1);
}

// Map front-end agent keys → Azure AI Foundry agent (assistant) IDs.
const AGENTS = {
  concierge: process.env.AGENT_CONCIERGE || "",
  campaign:  process.env.AGENT_CAMPAIGN  || "",
  sentiment: process.env.AGENT_SENTIMENT || "",
  analytics: process.env.AGENT_ANALYTICS || "",
  portfolio: process.env.AGENT_PORTFOLIO || "",
};

function resolveAgentId(key) {
  return AGENTS[key] || "";
}

// ---------------------------------------------------------------
// Auth: prefer Entra ID (DefaultAzureCredential). Fall back to an API key.
// ---------------------------------------------------------------
const credential = new DefaultAzureCredential();
const agentsClient = new AgentsClient(AZURE_AI_PROJECT_ENDPOINT, credential);
// Foundry / Azure AI resource audience:
const TOKEN_SCOPE = "https://ai.azure.com/.default";

let cachedToken = null; // { token, expiresOnTimestamp }
async function getAuthHeader() {
  if (AZURE_AI_API_KEY) return { "api-key": AZURE_AI_API_KEY };
  const now = Date.now();
  if (!cachedToken || cachedToken.expiresOnTimestamp - now < 60_000) {
    cachedToken = await credential.getToken(TOKEN_SCOPE);
    if (!cachedToken) throw new Error("Failed to acquire Entra ID token for " + TOKEN_SCOPE);
  }
  return { Authorization: `Bearer ${cachedToken.token}` };
}

// ---------------------------------------------------------------
// Foundry REST helpers
// ---------------------------------------------------------------
function url(pathSuffix) {
  const sep = pathSuffix.includes("?") ? "&" : "?";
  return `${AZURE_AI_PROJECT_ENDPOINT}${pathSuffix}${sep}api-version=${AZURE_AI_API_VERSION}`;
}

async function foundry(method, pathSuffix, body) {
  const auth = await getAuthHeader();
  const res = await fetch(url(pathSuffix), {
    method,
    headers: {
      "Content-Type": "application/json",
      ...auth,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) {
    const bodySnippet = typeof json === "string" ? json : JSON.stringify(json);
    const err = new Error(`Foundry ${method} ${pathSuffix} → ${res.status}: ${bodySnippet}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

// ---------------------------------------------------------------
// Foundry runtime resolution.
//
// The five RetailAI agents are Foundry Prompt Agents. Their runtime is
// the Responses API at  {resource}/openai/v1/responses  — NOT the classic
// Assistants (/threads/runs) or non-existent /agents/{name}/threads paths.
//
// We fetch each agent's definition (instructions + model) from
//   GET /api/projects/{proj}/agents/{name}?api-version=v1
// then invoke it via
//   POST /openai/v1/responses  { model, instructions, input, previous_response_id? }
// which is exactly what the Foundry Agent Service does under the hood.
// ---------------------------------------------------------------
const RESOURCE_BASE = AZURE_AI_PROJECT_ENDPOINT.replace(/\/api\/projects\/[^/]+\/?$/, "");
const RESPONSES_URL = `${RESOURCE_BASE}/openai/v1/responses`;

function bareAgentName(agentName) {
  return String(agentName || "").split(":")[0];
}

// In-memory cache keyed by bare agent name.
const agentDefs = new Map(); // name -> { model, instructions, version }

async function loadAgentDefinition(agentRef) {
  const name = bareAgentName(agentRef);
  if (agentDefs.has(name)) return agentDefs.get(name);

  const requestedVersion = agentRef.includes(":") ? agentRef.split(":")[1] : undefined;
  const data = await foundry("GET", `/agents/${name}`);

  // The Foundry GET /agents/{name} response is a wrapper:
  //   { object:"agent", id, name, versions: { latest: {..., definition: {...}}, "2": {...}, ... } }
  // We first try the requested version, then latest, then the top-level definition.
  const versions = data.versions || {};
  const chosen =
    (requestedVersion && versions[requestedVersion]) ||
    versions.latest ||
    data;

  const def = chosen.definition || {};
  const model = def.model || "gpt-4o";
  const instructions = def.instructions || "";
  const cached = {
    model,
    instructions,
    version: chosen.version || requestedVersion || "latest",
  };
  agentDefs.set(name, cached);
  return cached;
}

async function runAgentResponse(agentRef, userMessage, previousResponseId) {
  const { model, instructions } = await loadAgentDefinition(agentRef);
  const body = {
    model,
    input: userMessage,
  };
  if (instructions) body.instructions = instructions;
  if (previousResponseId) body.previous_response_id = previousResponseId;

  const auth = await getAuthHeader();
  const r = await fetch(RESPONSES_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!r.ok) {
    const bodySnippet = typeof json === "string" ? json : JSON.stringify(json);
    const err = new Error(`Responses ${r.status}: ${bodySnippet}`);
    err.status = r.status;
    err.body = json;
    throw err;
  }
  // Extract text from either the flat output_text or the structured output[] items.
  let reply = json.output_text;
  if (!reply && Array.isArray(json.output)) {
    reply = json.output
      .filter((o) => o.type === "message")
      .flatMap((o) => (Array.isArray(o.content) ? o.content : []))
      .filter((c) => c && (c.type === "output_text" || typeof c.text === "string"))
      .map((c) => (typeof c.text === "string" ? c.text : c.text?.value || ""))
      .filter(Boolean)
      .join("\n\n")
      .trim();
  }
  return { reply: reply || "", responseId: json.id || null, raw: json };
}

async function runPersistentAgent(agentId, userMessage, existingThreadId) {
  const threadId = existingThreadId || (await agentsClient.threads.create()).id;
  await agentsClient.messages.create(threadId, "user", userMessage);
  const run = await agentsClient.runs.createAndPoll(threadId, agentId, {
    pollingOptions: { intervalInMs: 1000 },
  });

  if (run.status !== "completed") {
    const err = new Error(`Agent run ended with status '${run.status}'.`);
    err.body = run.lastError || run;
    throw err;
  }

  for await (const message of agentsClient.messages.list(threadId, { order: "desc" })) {
    if (message.role !== "assistant") continue;
    const reply = message.content
      .filter((item) => item.type === "text" && item.text?.value)
      .map((item) => item.text.value)
      .join("\n\n")
      .trim();
    if (reply) return { reply, conversationId: threadId };
  }

  return { reply: "", conversationId: threadId };
}

async function invokeAgent(agentRef, userMessage, conversationId) {
  if (agentRef.startsWith("asst_")) {
    const threadId = conversationId?.startsWith("thread_") ? conversationId : undefined;
    return runPersistentAgent(agentRef, userMessage, threadId);
  }

  const responseId = conversationId?.startsWith("resp_") ? conversationId : undefined;
  const result = await runAgentResponse(agentRef, userMessage, responseId);
  return { reply: result.reply, conversationId: result.responseId };
}

// ---------------------------------------------------------------
// App
// ---------------------------------------------------------------
const app = express();
app.use(express.json({
  limit: "1mb",
  verify: (req, _res, buffer) => {
    req.rawBody = Buffer.from(buffer);
  },
}));

const socialSignals = new SocialSignalStore(SOCIAL_SIGNAL_LIMIT);
const syntheticSocialEnabled = /^(1|true|yes)$/i.test(SYNTHETIC_SOCIAL_ENABLED);
const syntheticInitialCount = Math.max(0, Math.min(Number(SYNTHETIC_SOCIAL_INITIAL_COUNT) || 0, 50));
const syntheticIntervalMs = Math.max(1_000, Math.min(Number(SYNTHETIC_SOCIAL_INTERVAL_MS) || 10_000, 3_600_000));
const syntheticBatchSize = Math.max(1, Math.min(Number(SYNTHETIC_SOCIAL_BATCH_SIZE) || 2, 10));
let syntheticSignalIndex = 0;

function addSyntheticSignals(count) {
  const signals = generateSyntheticSignals({ count, startIndex: syntheticSignalIndex });
  syntheticSignalIndex += signals.length;
  return socialSignals.addMany(signals);
}

if (syntheticSocialEnabled) {
  addSyntheticSignals(syntheticInitialCount);
  setInterval(() => addSyntheticSignals(syntheticBatchSize), syntheticIntervalMs).unref();
}

function hasValidIngestToken(req) {
  const supplied = req.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
  if (!SOCIAL_INGEST_TOKEN || !supplied) return false;
  const expectedBuffer = Buffer.from(SOCIAL_INGEST_TOKEN);
  const suppliedBuffer = Buffer.from(supplied);
  return expectedBuffer.length === suppliedBuffer.length &&
    timingSafeEqual(expectedBuffer, suppliedBuffer);
}

app.get("/api/social/meta/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && META_WEBHOOK_VERIFY_TOKEN &&
      token === META_WEBHOOK_VERIFY_TOKEN) {
    return res.status(200).send(String(challenge || ""));
  }
  return res.sendStatus(403);
});

app.post("/api/social/meta/webhook", (req, res) => {
  if (!META_APP_SECRET) {
    return res.status(503).json({ error: "Meta webhook is not configured." });
  }
  if (!verifyMetaSignature(req.rawBody, req.get("x-hub-signature-256"), META_APP_SECRET)) {
    return res.status(401).json({ error: "Invalid Meta webhook signature." });
  }

  const signals = normalizeMetaWebhook(req.body);
  const accepted = socialSignals.addMany(signals);
  return res.status(200).json({ received: signals.length, accepted });
});

// Connector contract for approved TikTok access or a licensed listening provider.
// Body: { signals: [{ platform, sourceType, text, publishedAt }] }
app.post("/api/social/signals", (req, res) => {
  if (!hasValidIngestToken(req)) {
    return res.status(401).json({ error: "Invalid social ingest token." });
  }

  const signals = normalizeProviderSignals(req.body);
  if (!signals.length) {
    return res.status(400).json({ error: "No valid social signals supplied." });
  }
  const accepted = socialSignals.addMany(signals);
  return res.status(202).json({ received: signals.length, accepted });
});

app.get("/api/social/status", (_req, res) => {
  res.json({
    ok: true,
    ...socialSignals.summary(),
    connectors: {
      meta: Boolean(META_APP_SECRET && META_WEBHOOK_VERIFY_TOKEN),
      provider: Boolean(SOCIAL_INGEST_TOKEN),
      synthetic: syntheticSocialEnabled,
    },
    syntheticFeed: syntheticSocialEnabled ? {
      initialCount: syntheticInitialCount,
      batchSize: syntheticBatchSize,
      intervalMs: syntheticIntervalMs,
    } : null,
    storage: "memory",
  });
});

// Health check
app.get("/api/health", (_req, res) => {
  const currentLocalKnowledge = warmLocalKnowledge();
  const localKnowledgeByAgent = currentLocalKnowledge.reduce((groups, item) => {
    (groups[item.role] ||= []).push(item);
    return groups;
  }, {});
  res.json({
    ok: true,
    endpoint: AZURE_AI_PROJECT_ENDPOINT,
    apiVersion: AZURE_AI_API_VERSION,
    agentsConfigured: Object.fromEntries(
      Object.entries(AGENTS).map(([k, v]) => [k, Boolean(v)])
    ),
    authMode: Object.values(AGENTS).some((agent) => agent.startsWith("asst_"))
      ? "entra-id"
      : (AZURE_AI_API_KEY ? "api-key" : "entra-id"),
    localKnowledge: {
      mode: "local-prompt-grounding",
      files: currentLocalKnowledge.length,
      rows: currentLocalKnowledge.reduce((total, item) => total + item.rows, 0),
      byAgent: Object.fromEntries(
        Object.entries(localKnowledgeByAgent).map(([role, items]) => [
          role,
          items.map(({ file, rows }) => ({ file, rows })),
        ])
      ),
    },
    socialSignals: socialSignals.summary(),
  });
});

// Probe: verifies auth + agent id + api-version by fetching the agent via both
// possible path shapes (`/assistants/{id}` and `/agents/{id}`) and reporting
// what each returned. Hit: GET /api/probe/concierge
app.get("/api/probe/:agent", async (req, res) => {
  const key = req.params.agent;
  const id = resolveAgentId(key);
  if (!id) return res.status(400).json({ error: `No id configured for agent '${key}'.` });

  async function tryPath(p) {
    try {
      const auth = await getAuthHeader();
      const r = await fetch(url(p), { headers: { "Content-Type": "application/json", ...auth } });
      const t = await r.text();
      let b; try { b = t ? JSON.parse(t) : {}; } catch { b = { raw: t }; }
      return { status: r.status, body: b };
    } catch (e) {
      return { status: 0, error: e.message };
    }
  }

  const [assistants, agents] = await Promise.all([
    tryPath(`/assistants/${id}`),
    tryPath(`/agents/${id}`),
  ]);

  res.json({
    agent: key,
    id,
    endpoint: AZURE_AI_PROJECT_ENDPOINT,
    apiVersion: AZURE_AI_API_VERSION,
    tried: { "/assistants/{id}": assistants, "/agents/{id}": agents },
  });
});

// Lists every agent on the Foundry project (Agent Service). Use this to
// confirm the AGENT_* names in .env are correct.
app.get("/api/list-agents", async (_req, res) => {
  try {
    const data = await foundry("GET", "/agents?limit=100");
    const items = data.data || data.value || [];
    res.json({
      count: items.length,
      agents: items.map((a) => ({
        id: a.id,
        name: a.name || a.display_name || "(no name)",
        version: a.version,
        versioned_id: a.version ? `${a.name || a.id}:${a.version}` : (a.id || null),
        model: a.model,
        description: a.description,
      })),
      raw: items,
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, detail: err.body });
  }
});

// End-to-end run test against one agent. Proves auth + agent definition
// fetch + Responses API round-trip. Hit: GET /api/run-test/portfolio
app.get("/api/run-test/:agent", async (req, res) => {
  const key = req.params.agent;
  const agentRef = resolveAgentId(key);
  if (!agentRef) return res.status(400).json({ error: `No id configured for agent '${key}'.` });

  const trace = { agent: key, agentRef, steps: [] };
  const step = (name, ok, detail) => trace.steps.push({ name, ok, ...detail });

  try {
    const def = await loadAgentDefinition(agentRef);
    step("loadAgentDefinition", true, {
      model: def.model,
      instructionsChars: def.instructions.length,
      version: def.version,
    });

    const { reply, responseId } = await runAgentResponse(
      agentRef,
      "Hello — short reply please, one sentence only."
    );
    step("runAgentResponse", true, { responseId, chars: reply.length });

    res.json({ ok: true, reply, responseId, trace });
  } catch (err) {
    step("error", false, { message: err.message, detail: err.body });
    res.status(err.status || 500).json({ ok: false, error: err.message, detail: err.body, trace });
  }
});

// Runtime probe: tries every plausible invocation pattern against one agent so
// we can see which one this Foundry project supports. Hit: GET /api/invoke-probe/portfolio
app.get("/api/invoke-probe/:agent", async (req, res) => {
  const key = req.params.agent;
  const raw = resolveAgentId(key);
  if (!raw) return res.status(400).json({ error: `No id configured for agent '${key}'.` });
  const name = String(raw).split(":")[0];
  const version = raw.includes(":") ? raw.split(":")[1] : "2";
  const versioned = raw.includes(":") ? raw : `${raw}:${version}`;

  // Foundry endpoint is like: https://<res>.services.ai.azure.com/api/projects/<proj>
  // The Responses API is served at:  https://<res>.services.ai.azure.com/openai/v1
  const resourceBase = AZURE_AI_PROJECT_ENDPOINT.replace(/\/api\/projects\/[^/]+\/?$/, "");
  const responsesBase = `${resourceBase}/openai/v1`;

  const cases = [
    // ---- Responses API (Foundry Prompt Agent invocation) ----
    // With model + prompt reference
    { label: "POST /openai/v1/responses (model + prompt.id/version, input)",
      base: responsesBase, method: "POST", path: `/responses`, noApiVersion: true,
      body: { model: "gpt-4o", prompt: { id: name, version }, input: "Hello" } },
    { label: "POST /openai/v1/responses (model + prompt.name/version, input)",
      base: responsesBase, method: "POST", path: `/responses`, noApiVersion: true,
      body: { model: "gpt-4o", prompt: { name, version }, input: "Hello" } },
    { label: "POST /openai/v1/responses (model + prompt=versioned string, input)",
      base: responsesBase, method: "POST", path: `/responses`, noApiVersion: true,
      body: { model: "gpt-4o", prompt: versioned, input: "Hello" } },
    { label: "POST /openai/v1/responses (model + agent.name, input)",
      base: responsesBase, method: "POST", path: `/responses`, noApiVersion: true,
      body: { model: "gpt-4o", agent: { name, version }, input: "Hello" } },
    { label: "POST /openai/v1/responses (model + agent=name, input)",
      base: responsesBase, method: "POST", path: `/responses`, noApiVersion: true,
      body: { model: "gpt-4o", agent: name, input: "Hello" } },
    // Without model (baseline — expected to fail with 'Missed model deployment')
    { label: "POST /openai/v1/responses (prompt.id/version, input)",
      base: responsesBase, method: "POST", path: `/responses`, noApiVersion: true,
      body: { prompt: { id: name, version }, input: "Hello" } },
    // Confirmed-working baseline: plain model call
    { label: "POST /openai/v1/responses (model=gpt-4o, no agent) [known-good]",
      base: responsesBase, method: "POST", path: `/responses`, noApiVersion: true,
      body: { model: "gpt-4o", input: "Hello" } },
  ];

  async function tryOne(c) {
    try {
      const auth = await getAuthHeader();
      const base = c.base || AZURE_AI_PROJECT_ENDPOINT;
      const qs = c.noApiVersion ? "" : `?api-version=${AZURE_AI_API_VERSION}`;
      const u = `${base}${c.path}${qs}`;
      const r = await fetch(u, {
        method: c.method,
        headers: { "Content-Type": "application/json", ...auth },
        body: c.body ? JSON.stringify(c.body) : undefined,
      });
      const t = await r.text();
      let b; try { b = t ? JSON.parse(t) : {}; } catch { b = { raw: t?.slice(0, 400) }; }
      return {
        status: r.status,
        ok: r.ok,
        url: u,
        errorMessage: !r.ok ? (b?.error?.message || b?.message || undefined) : undefined,
        bodyPreview: r.ok ? b : undefined,
      };
    } catch (e) {
      return { status: 0, ok: false, error: e.message };
    }
  }

  const results = {};
  for (const c of cases) {
    results[c.label] = await tryOne(c);
  }

  res.json({
    endpoint: AZURE_AI_PROJECT_ENDPOINT,
    responsesBase,
    apiVersion: AZURE_AI_API_VERSION,
    agent: key,
    name,
    version,
    hint:
      "Look for the first row with ok:true. Its path+body is the invocation " +
      "shape this project expects. Rows with detailed error messages are also useful.",
    results,
  });
});

// Discovery: probes several {path, api-version} combinations with the current
// auth to find where the Persistent Agents actually live on this project.
// Hit: GET /api/discover
app.get("/api/discover", async (_req, res) => {
  const versions = [
    "v1",
    "2025-05-15-preview",
    "2025-05-01",
    "2025-05-01-preview",
    "2025-01-01-preview",
    "2024-12-01-preview",
  ];
  const paths = ["/assistants", "/agents"];

  async function tryOne(path, version) {
    try {
      const auth = await getAuthHeader();
      const u = `${AZURE_AI_PROJECT_ENDPOINT}${path}?api-version=${version}&limit=50`;
      const r = await fetch(u, { headers: { "Content-Type": "application/json", ...auth } });
      const t = await r.text();
      let b; try { b = t ? JSON.parse(t) : {}; } catch { b = { raw: t?.slice(0, 400) }; }
      const items = b?.data || b?.value || [];
      return {
        status: r.status,
        count: Array.isArray(items) ? items.length : 0,
        firstItem: Array.isArray(items) && items[0]
          ? { id: items[0].id, name: items[0].name || items[0].display_name }
          : null,
        error: r.ok ? undefined : (b?.error?.message || b?.message || undefined),
      };
    } catch (e) {
      return { status: 0, error: e.message };
    }
  }

  const results = {};
  for (const p of paths) {
    for (const v of versions) {
      results[`GET ${p} ?api-version=${v}`] = await tryOne(p, v);
    }
  }
  res.json({
    endpoint: AZURE_AI_PROJECT_ENDPOINT,
    hint:
      "Look for rows with status:200 and count>0. The path (/assistants vs /agents) " +
      "and api-version that returns your agents is the runtime we need to use.",
    results,
  });
});

// POST /api/chat  { agent, message, threadId? }  →  { reply, threadId, agent }
app.post("/api/chat", async (req, res) => {
  try {
    const { agent = "concierge", message, threadId: conversationId } = req.body || {};
    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "Field 'message' is required." });
    }
    const agentRef = resolveAgentId(agent);
    if (!agentRef) {
      return res.status(500).json({
        error: `No agent ID configured for '${agent}'. Each specialist requires its own AGENT_* setting.`,
      });
    }

    const socialContext = agent === "sentiment"
      ? formatSignalsForAgent(socialSignals.list(25))
      : "";
    const knowledgeContext = buildKnowledgeContext(agent, message);
    const visualDirective = agent === "analytics" ? VISUAL_DIRECTIVE : "";
    const creativeDirective = agent === "portfolio" ? CREATIVE_DIRECTIVE : "";
    const agentMessage = [
      RESPONSE_STYLE,
      visualDirective,
      creativeDirective,
      knowledgeContext,
      socialContext,
      `USER QUESTION\n${message}`,
    ]
      .filter(Boolean)
      .join("\n\n");

    const { reply, conversationId: nextConversationId } = await invokeAgent(
      agentRef,
      agentMessage,
      conversationId || undefined
    );

    const { text: withoutVisuals, visuals } = extractVisuals(reply);
    const { text, creatives } = extractCreatives(withoutVisuals);

    if (agent === "analytics" && !visuals.length) {
      const salvaged = fallbackVisual(text);
      if (salvaged) visuals.push(salvaged);
    }

    res.json({
      reply: normalizeReply(text) || "(The agent returned no text.)",
      visuals,
      creatives,
      threadId: nextConversationId,
      agent,
      socialSignalCount: agent === "sentiment" ? socialSignals.summary().total : undefined,
    });
  } catch (err) {
    const status = err.status && Number.isInteger(err.status) ? err.status : 500;
    console.error("[/api/chat] error:", err.message, err.body || "");
    res.status(status).json({
      error: err.message || "Unexpected server error.",
      detail: err.body || undefined,
    });
  }
});

// Allow Teams to embed the page in an iframe.
app.use((_req, res, next) => {
  res.set(
    "Content-Security-Policy",
    "frame-ancestors 'self' https://*.teams.microsoft.com https://teams.microsoft.com https://*.teams.cloud.microsoft https://teams.cloud.microsoft https://*.skype.com"
  );
  next();
});

// The page is a hash router, so a cached document would never re-fetch on navigation.
app.use((req, res, next) => {
  if (req.path === "/" || req.path.endsWith(".html")) {
    res.set("Cache-Control", "no-store, must-revalidate");
  }
  next();
});

// Serve the static site (index.html, assets) from the parent folder.
app.use(express.static(SITE_DIR, { extensions: ["html"] }));

let localKnowledge;
try {
  localKnowledge = warmLocalKnowledge();
} catch (err) {
  console.error(`Failed to load local knowledge from the Data folder: ${err.message}`);
  process.exit(1);
}

app.listen(PORT, () => {
  console.log(`RetailAI proxy listening on http://localhost:${PORT}`);
  console.log(`  Foundry endpoint : ${AZURE_AI_PROJECT_ENDPOINT}`);
  console.log(`  API version      : ${AZURE_AI_API_VERSION}`);
  console.log(`  Auth mode        : ${AZURE_AI_API_KEY ? "api-key" : "Entra ID (DefaultAzureCredential)"}`);
  console.log(`  Social signals   : ${syntheticSocialEnabled ? `synthetic demo feed (${socialSignals.summary().total} seeded)` : "external connectors only"}`);
  console.log(
    `  Local knowledge  : ${localKnowledge.length} files, ${localKnowledge.reduce((total, item) => total + item.rows, 0)} rows`
  );
  console.log(
    `  Agents configured: ${Object.entries(AGENTS)
      .filter(([, v]) => v)
      .map(([k]) => k)
      .join(", ") || "none — falling back to concierge"}`
  );
});
