# Last30Days Opportunity Studio

Last30Days Opportunity Studio helps you find buildable AI product opportunities from recent market evidence, then move directly into execution docs.

## What It Does

- Researches only **Reddit + X + Web**
- Uses a fixed **rolling last 30 days** window on every run
- Uses a fixed **trend-first 3-query strategy** per niche:
  1. Latest news, updates, regulatory/product changes
  2. Emerging trends, adoption, winning patterns
  3. Unresolved complaints, failures, requests for better tools
- Runs synthesis before candidate generation
- Returns proof-backed opportunities with citations
- Supports:
  - focused niche research
  - blank-input auto-discovery mode

## Candidate Outputs

Each candidate includes:

- proof points (`claim`, `sourceUrl`, `date`, `sourceType`)
- demand, landscape, business model, GTM, execution, outcomes
- spending/pain/room checks
- risks, kill criteria, validation plan

## Post-Research Actions

- **Market Analysis**: on-demand market-fit scoring out of 100 with rationale, risks, and sources
- **Promo Pack**: on-demand marketing assets (positioning, funnels, scripts, schedules, FAQs, interview prep, CTAs)
- **Proceed** sequence always available:
  1. `PRD`
  2. `Market Plan`
  3. `Execution Plan`

## Recovery and Portability

- checkpointed runs with resume support
- recovery artifact exports for degraded runs (`output/recovery/`)
- import support for:
  - exported reports
  - recovery snapshots
- legacy recovery payloads containing `allRaw.youtube` are accepted and ignored

## Runtime Notes

- Runtimes vary by provider/model latency and network conditions.
- `quick` is tuned for lower cost and faster response, but may still vary based on live search/tool delays.
- Streaming endpoint duration in logs reflects full research time, not page render time.

## Stack

- Next.js App Router
- TypeScript
- OpenRouter APIs:
  - `/responses` for search/enrichment tasks
  - `/chat/completions` for synthesis/candidate/plan generation

## Environment

Copy `.env.example` to `.env.local` and set:

```bash
OPENROUTER_API_KEY=or-...
```

Optional model overrides:

```bash
OPENROUTER_NICHE_MODEL=anthropic/claude-sonnet-4.5
OPENROUTER_PLAN_MODEL=anthropic/claude-sonnet-4.5
OPENROUTER_REDDIT_MODEL=openai/gpt-5.2:online
OPENROUTER_X_MODEL=x-ai/grok-4.1-fast:online
OPENROUTER_WEB_MODEL=openai/gpt-5.2:online
OPENROUTER_SYNTH_MODEL=anthropic/claude-sonnet-4.5
```

## Run

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## API Endpoints

### `POST /api/research`
Non-streaming research request.

```json
{
  "niche": "insurance",
  "depth": "default"
}
```

`niche` is optional. `depth` is `quick | default | deep`.

### `POST /api/research/stream`
SSE research with progress events:

- `ready`
- `progress`
- `result`
- `error`

### `POST /api/research/plan`
Generate one output for a selected candidate.

```json
{
  "candidate": { "id": "...", "name": "...", "checks": {} },
  "type": "prd"
}
```

`type` is `prd | market | plan`.

### `POST /api/research/market-analysis`
Generate scored market analysis for a selected candidate.

### `POST /api/research/promo-pack`
Generate promo and launch assets for a selected candidate.

### `POST /api/research/recovery/import`
Import checkpoint payload and resume a run.

## Export Format

Research export files use this envelope:

```json
{
  "app": "last30days-opportunity-studio",
  "version": 1,
  "exportedAt": "ISO_DATE",
  "report": { "...full research report..." }
}
```

Legacy imports with `"app": "niche-validator-studio"` are still supported.
