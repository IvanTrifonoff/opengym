# openGym network deployment — dev branch notes

This branch extends the openGym fork (github.com/IvanTrifonoff/opengym) with a
multi-branch gym-network layer: an admin panel, configurable loyalty rules, and
external-system integrations (access control / CRM) on top of PostgreSQL.

Live instance: **https://gym.trfnv.ru** (VPS 82.202.141.81, /opt/opengym).

## Table of contents

1. Architecture overview
2. New files
3. Environment variables (.env)
4. PostgreSQL setup
5. Admin panel (/admin)
6. Loyalty rule engine
7. Webhook endpoints
8. Wallet & rewards
9. Backups
10. Known issues & conventions
11. Useful commands

---

## 1. Architecture overview

The stock openGym stores everything in JSON files under ./data (users, passkeys,
per-user training state). This fork keeps that storage intact for athlete data and
adds a **PostgreSQL layer** for everything network-related:

- admin accounts, staff roles, invite codes
- access-control events (SCUD / turnstile webhooks)
- loyalty rules (configurable without code)
- immutable points ledger
- rewards catalog & redemptions
- notification outbox

Containers (docker compose, name: opengym):

| service | image / build | role |
|---|---|---|
| api | build ./api | Node server, passkeys + all new endpoints |
| web | build web/Dockerfile | Vite-built React SPA + nginx (serves /api proxy) |
| media | alpine/git | one-time download of exercise media (already present) |

The api container is attached to an **external docker network** of an existing
Postgres container (`retail_db`, network `retail-execution_default`) — see
docker-compose.override.yml. Postgres is NOT exposed to the internet.

## 2. New files

Backend (api/):

- **access-db.js** — Postgres pool + schema for access_events,
  external_member_bindings, visits. Creates tables automatically on boot.
- **admin-db.js** — schema + queries for admin_users, admin_credentials,
  admin_invites, loyalty_rules, loyalty_ledger, achievements, rewards,
  redemptions, loyalty_outbox, plus rule-application engine.
- **server.js** — heavily extended: admin auth (separate adminsid cookie),
  staff invites, rule CRUD, webhooks, wallet/rewards endpoints, legacy admin
  endpoints switched to admin auth.

Frontend (frontend/src/):

- **views/AdminApp.jsx** — separate admin SPA at /admin (NOT /#/admin):
  passkey login, staff registration via invite code, tabs Overview / Loyalty /
  Rewards / Staff, table-style rule editor with templates, rewards catalog.
  Also exports AdminBoundary (error boundary) used in App.jsx.
- **views/Settings.jsx** — LoyaltyCard: wallet balance, rewards catalog, redeem,
  transaction history (Settings tab of the athlete app).
- **lib/api.js** — added passkeyAdminLogin / passkeyAdminRegister helpers.
- **App.jsx** — routes /admin to AdminApp wrapped in AdminBoundary.

Config:

- docker-compose.override.yml — attaches api to the external retail-db network.
- .env.example — documented env vars (copy to .env, never commit .env).
- backup.sh — daily tarball backup of data/ + deploy config (see Backups).

## 3. Environment variables (.env)

See .env.example. Key additions over stock openGym:

- DATABASE_URL — postgres://opengym:...@retail_db:5432/opengym
- ACCESS_WEBHOOK_SECRET — shared secret for webhook endpoints

## 4. PostgreSQL setup

Done once on the VPS (not in this repo): created DB `opengym` and role
`opengym` inside the existing `retail_db` Postgres container. The API connects
over the docker network; schema is created automatically on boot (CREATE TABLE IF
NOT EXISTS). No migrations framework — table changes must be additive or written
as idempotent DDL.

## 5. Admin panel (/admin)

- Real URL /admin served by the SPA (nginx fallback already in place).
- Separate passkey accounts for staff; athlete cookies (gymsid) do NOT grant
  admin access, and legacy admin endpoints now require the admin cookie
  (adminsid).
- The first existing athlete profile with the admin flag is bootstrapped
  automatically into admin_users with role `owner` on first boot.
- Roles: owner > manager > trainer > operator (see roleAllowed in server.js).
- Staff registration: owner/manager creates an invite code; the staff member
  opens /admin/register?code=... and creates their own passkey.

## 6. Loyalty rule engine

Rules are stored as data (not code) in loyalty_rules and applied when events
arrive. Each rule: event_type, enabled, conditions (branch_key), actions
(points / achievement / reward / notification), limits (period + max per period).

Event types: visit, workout_completed, streak, referral, manual.

Editable in /admin → Loyalty without rebuilding or touching code. Templates
provided (visit, workout, streak, referral).

## 7. Webhook endpoints

Both require header `X-OpenGym-Webhook-Secret: <ACCESS_WEBHOOK_SECRET>`.
Missing/bad secret → 401.

- POST /api/integrations/access/events — SCUD/turnstile/CRM access events.
  Body: event_id, member_key (or card_id/external_member_id/athlete_id),
  branch_key (or branch_id/club_id), direction, occurred_at (or timestamp/time),
  metadata. Idempotent on event_id. Unmatched member_key → stored with status
  "unmatched" (no points). Bind a member_key to an athlete via
  POST /api/admin/integrations/access/bind (admin auth).
- POST /api/integrations/loyalty/events — other loyalty events:
  event_id, user_id, event_type (workout_completed/streak/referral/manual),
  branch_key, occurred_at. Applies active rules with limits; idempotent on
  event_id; double-send never awards twice.

## 8. Wallet & rewards

- Balance = sum(loyalty_ledger) per user; every award/redemption is an immutable
  ledger row. Insufficient balance blocks redemption.
- Rewards catalog (admin): kind discount/training/merch/guest_pass/custom,
  cost, stock (empty = unlimited), delivery_mode staff | auto_code.
- Redemption: staff-mode creates a pending request (staff confirms/rejects in
  /admin → Rewards; rejection refunds points); auto_code mints a one-time code
  shown immediately to the athlete.
- Athlete UI: Settings → loyalty card (balance, catalog, redeem, history).

## 9. Backups

backup.sh (root cron, daily) tars /opt/opengym/data + compose files + frontend
sources + api sources into /opt/backups/opengym, keeps 14 rotations, perms 600.
Restore = untar and docker compose up -d.

## 10. Known issues & conventions

- **React 19 + useEffect**: never pass an async function directly to useEffect
  (e.g. useEffect(load, [])). The returned Promise is treated as the cleanup
  function and crashes on unmount with "l is not a function" (white screen).
  Always wrap: useEffect(() => { load() }, []). This bug hit /admin tabs
  (Loyalty/Rewards/Staff) and the Settings wallet; fixed on the dev branch.
- Session cookies are signed with data/secret (HMAC-SHA256, base64url). The
  admin cookie payload is `admin:<admin_id>:<exp>`. When minting test cookies,
  sign with data/secret — NOT the webhook secret.
- /admin UI text is Russian; the athlete app keeps its own i18n.
- Build context quirk: docker-compose.override.yml sets web build dockerfile to
  "Dockerfile" which resolves to web/Dockerfile (context is repo root). When
  iterating, always rebuild web from /opt/opengym with
  `docker compose build web && docker compose up -d web`; stale browser bundles
  are the most common "bug" — hard-refresh / close the tab (Safari service worker).

## 11. Useful commands

    cd /opt/opengym
    docker compose ps
    docker compose logs -f api
    docker compose build api && docker compose up -d api
    docker compose build web && docker compose up -d web
    # webhook secret (owner only):
    sudo grep ACCESS_WEBHOOK_SECRET /opt/opengym/.env
    # quick API check:
    curl -s https://gym.trfnv.ru/api/config
