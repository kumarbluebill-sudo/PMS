# MK Solutions Hotel PMS

Multi-tenant cloud PMS for hotels and resorts. Phase 1 (core PMS) is built; billing/GST, reporting and channel management are planned. See [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md) for what works and what does not, and [docs/](docs/) for architecture and security notes.

## Local setup
```bash
npm install
cp .env.example .env            # fill AUTH_SECRET and APP_ENCRYPTION_KEY (openssl rand -base64 32)
npm run db:start                # local Postgres via embedded-postgres (or: docker compose up -d)
npx prisma migrate dev          # create schema
# create the restricted runtime role used by the app (see tests/integration/global-setup.ts)
npm run dev
```
The app must connect through `APP_DATABASE_URL` (role without BYPASSRLS) so tenant isolation policies apply; `DATABASE_URL` is for migrations.

## Checks
```bash
npm run lint && npm run typecheck
npm test                        # unit + integration (needs the local database running)
npm run build && npm run test:e2e   # Playwright, uses installed Edge (PW_CHANNEL=chrome to change)
```
Dev emails (reset/invite/verify links) are stored in the `email_outbox` table until a mail provider is configured.
