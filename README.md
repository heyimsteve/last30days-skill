# last30days Next.js

A full end-to-end Next.js app that researches a topic from the last 1-30 days across **Reddit**, **X**, and/or the **Web**, then automatically synthesizes findings using a **Claude model**.

## What changed

- Migrated from CLI flow to frontend + API route architecture.
- Added multi-choice source selection (`Reddit`, `X`, `Web`) in UI.
- Removed interactive synth question flow; synthesis now runs automatically after search.
- Ported core normalization, date filtering, scoring, sorting, and dedupe behavior into TypeScript server modules.
- Upgraded UX with source chips, depth controls, examples, loading states, synthesis panel, tabs, and responsive layout.

## Stack

- Next.js App Router
- TypeScript
- OpenRouter APIs (`/responses`, `/chat/completions`)

## Environment

Copy `.env.example` to `.env.local` and set at minimum:

```bash
OPENROUTER_API_KEY=or-...
```

Optional model overrides:

```bash
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

## API

`POST /api/research`

Request:

```json
{
  "topic": "latest Claude Code workflows",
  "days": 30,
  "depth": "default",
  "sources": ["reddit", "x", "web"]
}
```

Response includes per-source results, synthesis, stats, and partial source errors.

`POST /api/research/stream`

- SSE stream for real progress updates:
  - source search start/completion/failure
  - processing stage
  - synthesis stage
  - elapsed timer + ETA
- Final event includes the same report payload as `/api/research`, plus token/cost usage totals and per-operation usage.

## Notes

- Existing Python CLI sources are still in `scripts/` for reference.
- The Next.js app is now the primary end-to-end experience.
