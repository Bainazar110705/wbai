# WBai — Agent Guide

## Overview
Single-file Express server (`server.js`, 1113 lines) + PostgreSQL via `pg` + static HTML frontend in `public/`. A Wildberries seller assistant: AI copywriting (Claude Haiku), infographic generation (fal.ai), WB API analytics proxy, subscription management.

## Commands
```bash
npm start          # node server.js (PORT=3000)
npm install        # install deps (no lockfile in repo)
```

No test, lint, typecheck, or formatter infrastructure exists.

## Database
- `db.js` wraps `pg` Pool; **uses `?` placeholders** (SQLite-style) which are auto-converted to `$N` positional params.
- Tables auto-created via `init()` on startup (`users`, `ai_history`, `infographic_styles`, `templates`, `credit_transactions`). Migrations are additive `ALTER TABLE ADD COLUMN IF NOT EXISTS` — safe to re-run.
- Connects via `DATABASE_URL` env var.

## Required Env Vars
| Var | Purpose |
|-----|---------|
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_SECRET` | JWT signing key (32+ chars) |
| `ADMIN_KEY` | Admin auth for subscription activation |
| `CLAUDE_API_KEY` | Anthropic API key (Claude Haiku) |
| `FAL_KEY` | fal.ai API key for image gen |
| `APP_URL` | Public URL for self-ping (e.g. https://wbai.kz) |

## Deployment
- Self-ping via `GET /api/ping` every 10 min (controlled by `APP_URL` env var).
- Recommended stack: pm2 + Nginx reverse proxy + Certbot SSL.
- `app.set('trust proxy', 1)` required when behind Nginx.

## API Structure
- `POST /api/register`, `POST /api/login`, `GET /api/me` — JWT auth (30d expiry)
- `POST /api/ai` — Claude Haiku text generation (15 req/min rate limit)
- `POST /api/generate-image` — fal.ai infographic (6 req/min, requires credits)
- `POST /api/generate-series` — batch style transfer (up to 5 pages)
- `GET /api/wb/search`, `GET /api/wb/card` — WB product proxy
- `GET /api/wb-analytics` — WB statistics proxy (requires user's WB API token)
- `POST /api/admin/activate` — subscription activation

## Subscription Tiers
- **start**: reviews/questions only
- **pro**: +card/seo features, +templates
- **max**: +infographic generation (with photo_credits)

Info generated images cost 1 credit each. `max` plan grants 30 credits/month.

## Image Generation Flow
1. Claude analyzes style reference image → detailed style description
2. Specs parsed from user input, accessories detected from product name
3. Prompt built per model type (Nano Banana 2/Pro, FLUX Kontext, FLUX Dev)
4. fal.ai called with product images + style reference
5. Credits debited after successful generation

## Notable Quirks
- CORS allows `chrome-extension://*`, `wbai.kz`, and `localhost` origins.
- Static files served from `public/` with catch-all `*` route.
- `POST /api/generate-image` accepts up to 20MB JSON body.
- WB API proxies add browser-like User-Agent headers.
- `GET /api/wb/search` tries multiple WB API versions as fallback.
- `POST /api/wb-token` validates token against WB statistics API before saving.
- `require('dotenv').config()` on first line — `.env` loaded automatically.
