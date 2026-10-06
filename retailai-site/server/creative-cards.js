// retailai-site/server/creative-cards.js
// The Portfolio agent answers creative shortlist questions with profile cards.
// Every card is checked against portfolio_applications.csv, so the agent cannot
// invent an applicant, a score, or a portfolio link.

import { getRecordsBy } from "./local-knowledge.js";

const SOURCE_FILE = "portfolio_applications.csv";
const MAX_CARDS = 6;
const CARD_BLOCK = /\[\[CREATIVE\]\]([\s\S]*?)\[\[\/CREATIVE\]\]/g;

export const CREATIVE_DIRECTIVE = [
  "CREATIVE SHORTLIST CARDS",
  "When the question asks which creatives, applicants, or collaborators to work with, always present each recommended person as a card before your written recommendation.",
  "Emit one block per person, exactly in this form:",
  "[[CREATIVE]]{\"applicationId\":\"APP-00001\",\"why\":\"Strongest campus reach for the youth denim brief.\"}[[/CREATIVE]]",
  "Use only application_id values shown in portfolio_applications.csv in LOCAL KNOWLEDGE.",
  "The person's headshot and profile (name, category, location, bio, audience, experience, campaign fit, scores, rate, availability, portfolio link, and handle) are filled in automatically from that record, so do not invent or restate them.",
  "The why line is your own judgement in one short sentence, tied to the brief.",
  "Show at most six people, ranked best fit first, then explain the ranking, the trade-offs, and the recommended next step in prose.",
].join("\n");

function safeUrl(value) {
  if (typeof value !== "string" || !value.trim()) return "";
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : "";
  } catch {
    return "";
  }
}

// Sample headshots are served from the site itself, so a leading-slash path is valid here.
function safeImage(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (/^\/[A-Za-z0-9._~\-/]+$/.test(raw)) return raw;
  return safeUrl(raw);
}

function toScore(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildCard(record, why) {
  const name = (record.applicant_name || "").trim();
  if (!name) return null;

  return {
    applicationId: (record.application_id || "").trim(),
    name,
    category: (record.creative_category || "").trim(),
    location: (record.location || "").trim(),
    bio: (record.bio_summary || "").trim().slice(0, 220),
    audience: (record.audience_type || "").trim(),
    experience: (record.campaign_experience || "").trim(),
    campaignFit: (record.recommended_campaign_fit || "").trim(),
    portfolioLink: safeUrl(record.portfolio_link),
    handle: (record.social_handle || "").trim(),
    imageUrl: safeImage(record.image_url),
    brandFit: toScore(record.ai_brand_fit_score),
    readiness: toScore(record.ai_campaign_readiness_score),
    rateBand: (record.rate_band_zar || "").trim(),
    availability: (record.availability || "").trim(),
    shortlistStatus: (record.shortlist_status || "").trim(),
    why: typeof why === "string" ? why.trim().replace(/\s+/g, " ").slice(0, 160) : "",
  };
}

/** Pulls creative cards out of a reply, resolving each one against the source records. */
export function extractCreatives(text) {
  if (typeof text !== "string" || !text) return { text: "", creatives: [] };

  const byId = getRecordsBy(SOURCE_FILE, "application_id");
  const byName = getRecordsBy(SOURCE_FILE, "applicant_name");
  const creatives = [];
  const seen = new Set();

  const remaining = text.replace(CARD_BLOCK, (_match, payload) => {
    if (creatives.length >= MAX_CARDS) return "";

    let spec;
    try {
      spec = JSON.parse(payload.trim());
    } catch {
      return "";
    }

    const key = String(spec?.applicationId || spec?.name || "").trim().toLowerCase();
    const record = byId.get(key) || byName.get(key);
    if (!record || seen.has(key)) return "";

    const card = buildCard(record, spec?.why);
    if (card) {
      seen.add(key);
      creatives.push(card);
    }
    return "";
  });

  return { text: remaining, creatives };
}
