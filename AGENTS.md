# WBai — Agent Guide

## Overview
Single-file Express server (`server.js`, ~1113 lines) + PostgreSQL via `pg` + static HTML frontend in `public/`. A Wildberries seller assistant: AI copywriting (Claude Haiku), infographic generation (fal.ai), WB API analytics proxy, subscription management.

## Docker
- `docker compose up -d --build` — запуск (app + Caddy reverse proxy с авто-SSL)
- `.env` загружается через `env_file` в compose
- `require('dotenv').config()` на первой строке `server.js`

## Database
- `db.js` wraps `pg` Pool; **uses `?` placeholders** (SQLite-style) which are auto-converted to `$N` positional params.
- Tables auto-created via `init()` on startup (`users`, `ai_history`, `infographic_styles`, `templates`, `credit_transactions`). Migrations are additive `ALTER TABLE ADD COLUMN IF NOT EXISTS` — safe to re-run.
- Connects via `DATABASE_URL` env var. SSL: enabled for non-localhost hosts.

## Required Env Vars
| Var | Purpose |
|-----|---------|
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_SECRET` | JWT signing key (32+ chars) |
| `ADMIN_KEY` | Admin auth for subscription activation |
| `CLAUDE_API_KEY` | Anthropic API key (Claude Haiku) |
| `FAL_KEY` | fal.ai API key for image gen |
| `APP_URL` | Public URL for self-ping (e.g. https://wbai.kz) |

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

## Notable Quirks
- CORS allows `chrome-extension://*`, `wbai.kz`, and `localhost` origins.
- Static files served from `public/` with catch-all `*` route.
- `POST /api/generate-image` accepts up to 20MB JSON body.
- WB API proxies add browser-like User-Agent headers.
- `GET /api/wb/search` tries multiple WB API versions as fallback.
- `POST /api/wb-token` validates token against WB statistics API before saving.
