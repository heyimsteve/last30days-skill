# Niche Validator Studio

Niche Validator Studio helps you find buildable AI product opportunities and move directly into execution docs.

## What It Does

- Searches across **Reddit + X + Web** every run
- Uses a fixed **rolling last 30 days** window
- Supports optional niche input:
  - If niche is provided: validates that market and sub-niches
  - If niche is blank: discovers niches from broad multi-source signals
- Validates each candidate with 3 checks:
  1. **Spending** (>= $500/year signal)
  2. **Pain** (recurring complaint signal, 3+)
  3. **Room** (active launch community, under ~50k members)
- Lets you select a validated candidate and click one **Proceed** button to generate:
  - **PRD** and
  - **Execution Plan**
- Shows each output in a separate card with separate **Copy** and **Export `.md`** actions

## UX Features

- Streaming research progress with ETA + elapsed time
- Plan generation progress (for PRD + Execution Plan) with ETA + elapsed time
- Research usage display:
  - total tokens
  - total cost
  - total model calls
- Research session portability:
  - **Export Results** to JSON
  - **Import Results** later and continue without re-running research

## Runtime Expectations

Typical research runtime:

- `quick`: ~8 minutes
- `default`: ~10 minutes
- `deep`: ~11 minutes

Plan generation is a second stage and usually takes ~1-2 minutes per output.

## Stack

- Next.js App Router
- TypeScript
- OpenRouter
  - `/responses` for source search
  - `/chat/completions` for candidate validation + document generation

## Environment

Copy `.env.example` to `.env.local` and set:

```bash
OPENROUTER_API_KEY=or-...
```

Optional model overrides:

```bash
OPENROUTER_NICHE_MODEL=openai/gpt-5.2:online
OPENROUTER_PLAN_MODEL=anthropic/claude-sonnet-4.5
OPENROUTER_REDDIT_MODEL=openai/gpt-5.2:online
OPENROUTER_X_MODEL=x-ai/grok-4.1-fast:online
OPENROUTER_WEB_MODEL=openai/gpt-5.2:online
```

## Run

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## API

### `POST /api/research`
Run niche validation (non-streaming).

Request:

```json
{
  "niche": "insurance",
  "depth": "default"
}
```

Notes:

- `niche` is optional
- `depth`: `quick | default | deep`
- Always uses last-30-days window

---

### `POST /api/research/stream`
Run niche validation with SSE progress updates.

Event types:

- `ready`
- `progress`
- `result`
- `error`

`result.report` includes:

- `range` (`from`, `to`)
- `stats` (candidate count, runtime)
- `usage` (tokens/cost/calls)
- validated candidates

---

### `POST /api/research/plan`
Generate one markdown output for a selected validated candidate.

Request:

```json
{
  "candidate": { "id": "...", "name": "...", "checks": {} },
  "type": "prd"
}
```

- `type`: `prd | plan`
- The UI calls this twice (first `prd`, then `plan`) when user clicks Proceed.

## Research Export Format

Exported research files are JSON with this envelope:

```json
{
  "app": "niche-validator-studio",
  "version": 1,
  "exportedAt": "ISO_DATE",
  "report": { "...full research report..." }
}
```

You can import this file later to continue from prior results.
