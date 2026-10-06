# RetailAI backend proxy

Small Express server that bridges the browser to the Azure AI Foundry Agents
REST API. It:

- Holds all credentials on the server (never exposed to the browser).
- Authenticates persistent assistants with **Entra ID** via `DefaultAzureCredential`.
- Talks to the Foundry Agents API: create thread → add message → run → poll → return.
- Accepts signed Meta webhooks and protected approved-provider social signals.
- Serves the static site so `index.html` and `/api/chat` share one origin
  (no CORS headaches).

## 1. Configure

```powershell
cd retailai-site\server
copy .env.example .env
notepad .env
```

Fill in the agent IDs from your Foundry project. If you only have the
Concierge, leave the rest blank — the site will fall back to it.

Configure the five-agent routing and specialist knowledge stores after all five
agent IDs are present:

```powershell
npm run configure:knowledge:dry-run
npm run configure:knowledge
```

The command uses the declarative mapping in `agent-knowledge.config.js`.
Concierge receives connected-agent routing tools and no business files. Each
specialist receives one isolated file-search vector store. The master workbook
remains the source-of-truth repository and is not uploaded to any agent.

## 2. Sign in to Azure (Entra ID auth — recommended)

```powershell
az login
```

The signed-in identity needs the **Azure AI User** role (or higher) on the
`RetailAIProject` in Azure AI Foundry.

Persistent `asst_...` agents require Entra ID. `AZURE_AI_API_KEY` is used only
when a configured agent is a named Responses agent.

## 3. Install and run

```powershell
npm install
npm start
```

Open <http://localhost:3000> — the "Ask RetailAI" widget on the site is wired
to `/api/chat` and will call your real Foundry agents.

## 4. Quick health check

```powershell
curl http://localhost:3000/api/health
```

Returns which agents are configured and which auth mode is in use.

## 5. Social sentiment signals

### Synthetic demo feed

For local development without social-platform accounts, enable a generated feed:

```dotenv
SYNTHETIC_SOCIAL_ENABLED=true
SYNTHETIC_SOCIAL_INITIAL_COUNT=18
SYNTHETIC_SOCIAL_INTERVAL_MS=10000
SYNTHETIC_SOCIAL_BATCH_SIZE=2
```

The feed creates timestamped Instagram-, TikTok-, and Facebook-style retail
scenarios across positive, neutral, and negative themes. Every generated row is
marked as synthetic, and the Sentiment Agent is told that the rows are generated
demo data rather than real customer posts. The rolling feed uses the same bounded
in-memory store and safety boundary as connector data.

### Instagram and Facebook

1. Create a Business app in the [Meta app dashboard](https://developers.facebook.com/apps/).
2. Add the Webhooks product and the Instagram/Facebook products needed for the
  professional Instagram account and Facebook Pages you own or manage.
3. In `.env`, set `META_APP_SECRET` to the app secret and choose a long random
  `META_WEBHOOK_VERIFY_TOKEN`.
4. Register this HTTPS callback URL in Meta:
  `https://YOUR_HOST/api/social/meta/webhook`.
5. Enter the same verify token in Meta and subscribe the owned assets to the
  supported comment/mention fields. Request only the permissions required by
  those subscriptions, and complete Meta App Review or business verification
  when prompted.

Meta sends a verification request first. Every later event is checked using
`X-Hub-Signature-256` before it is accepted. Author identifiers are discarded.
Localhost is not a valid Meta callback, so local registration requires an HTTPS
development tunnel.

### TikTok and licensed listening providers

TikTok does not provide a general commercial API for scraping arbitrary public
comments. Use approved TikTok access or a licensed social-listening provider,
then have that connector send normalized events to:

```http
POST /api/social/signals
Authorization: Bearer <SOCIAL_INGEST_TOKEN>
Content-Type: application/json

{
  "signals": [{
   "platform": "tiktok",
   "sourceType": "comment",
   "text": "Love the summer range",
   "publishedAt": "2026-08-03T12:00:00.000Z"
  }]
}
```

Set a long random `SOCIAL_INGEST_TOKEN` in `.env`. `publishedAt` should be stable
so provider retries deduplicate correctly. Supported platforms are `facebook`,
`instagram`, and `tiktok`.

Check feed state and aggregate counts at `/api/social/status`. Signals are held
in a bounded in-memory window and are lost when the server restarts. The latest
25 are supplied only to the Sentiment Agent. Synthetic rows retain explicit demo
provenance, while connector rows are marked as untrusted user-generated content.

## 6. Test

```powershell
npm test
```

## Deploying

- **Azure App Service / Container Apps**: enable a **system-assigned managed identity**,
  give it the **Azure AI User** role on the Foundry project, and leave `AZURE_AI_API_KEY` unset.
  `DefaultAzureCredential` picks up the managed identity automatically.
- **Azure Static Web Apps**: put this Express app in the `api/` folder (or convert
  to Azure Functions) and use the same env vars.
