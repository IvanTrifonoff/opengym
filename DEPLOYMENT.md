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

## 12. Notification dispatcher (loyalty_outbox → web-push)

Rules with a `notification` action do NOT send push directly — they append a row to
`loyalty_outbox` (kind `loyalty`, payload `{ message, rule_id, event_id }`).

A dispatcher (`dispatchOutbox` in api/admin-db.js) claims undelivered rows
(`FOR UPDATE SKIP LOCKED`, so concurrent runs never double-send), hands each to
`sendPush` (api/server.js, web-push/VAPID, existing `db.subs` subscriptions), and
sets `delivered_at` only on success.

When it runs:

1. immediately after the loyalty/access webhooks apply rules (response includes
   `notified: <n>`);
2. every 30 s as a safety net for rows that failed or were queued while the API
   was down.

Subscription management is unchanged: the athlete enables push in Settings
(`/api/push/subscribe` with the browser PushSubscription); sw.js renders
`title`/`body`/`tag`. If a user has no subscriptions the row is still marked
delivered (sendPush no-ops) — best-effort delivery by design.

## 13. Marketing promo page (/promo)

`frontend/public/promo.html` is a standalone Russian-language landing page
targeting gym owners (sell the product: retention, loyalty, revenue growth).
Served as a static file:

- nginx vhost has `location = /promo { proxy_pass http://127.0.0.1:8180/promo.html; }`
  so it bypasses the SPA fallback.
- Vite copies it from `public/` into the web image at build time
  (`docker compose build web`).
- Features marked «в разработке» (analytics, member cards, referral links,
  challenges) are intentionally positioned as roadmap — they are NOT implemented
  yet; do not claim otherwise in marketing copy.
## 14. Athlete analytics (/admin/analytics)

Separate admin module with stats on athletes: discipline (attendance, streak,
frequency, churn risk), successes (leaderboards, records, points), and a
per-athlete drill-down card. Read-only against PostgreSQL + per-user JSON state.

### Access (role-based scope)

- `owner` — sees the whole network.
- `manager` — sees their branch only (`admin_users.branch_key`); `branch_key IS NULL`
  means the whole network.
- `trainer` — sees only athletes assigned to them (`trainer_assignments`).
- `operator` — statuses only: overview + the status list, no drill-down, no leaderboard.

### Files

- `api/analytics.js` (new) — aggregation: `collectAnalytics()` (summary + athlete
  rows + leaderboard) and `athleteDetail()` (weekly buckets, best lifts, recent
  workouts, ledger, redemptions, achievements). Formulas mirror the app's own
  stats: streak weeks, workout volume (Σ w×r of done sets), frequency
  (max(visits30, workouts30) / 4.33), status by last activity:
  active ≤14d, at_risk ≤30d, gone >30d, new = registered <90d with no activity.
- `api/admin-db.js` — schema additions: `admin_users.branch_key` (migration
  `ADMIN_MIGRATION`), `trainer_assignments(user_id PK, trainer_id)`,
  `setTrainerAssignment()` / `listTrainerAssignments()`.
- `api/server.js` — `analyticsScope(admin)` + six endpoints:
  `GET /api/admin/analytics/overview`, `/athletes`, `/athlete?id=`,
  `/leaderboard`, `/trainers`, `POST /api/admin/analytics/assign`
  (assign/unassign: empty `trainer_id` clears). Detail + leaderboard + trainers
  are gated to owner/manager; detail additionally allows a trainer for their own
  athletes.
- `frontend/src/views/Analytics.jsx` (new) — KPI tiles, athlete table with status
  chips and search/filters, leaderboard tab, drill-down card with trainer picker.
- `frontend/src/views/AdminApp.jsx` — routes `/admin/analytics` internally (login
  gate shared), entry button (chart icon) in the dashboard header.

### Branch/trainer setup

Branch keys are free-form strings (e.g. `branch-1`) and currently come from
`visits.branch_key` / `external_member_bindings.branch_key`. To scope a manager,
set `branch_key` directly in the DB:

```sql
UPDATE admin_users SET branch_key = 'branch-1' WHERE id = '<admin id>';
```

Athlete→trainer assignment is done in the drill-down card (owner/manager only).

### Vite base fix (subpath routes)

`frontend/vite.config.js` now builds with `base: '/'` for web and `base: './'`
for mobile (`VITE_MOBILE=1`). Without the absolute base, the SPA served at
subpaths like `/admin/analytics` resolves `./assets/*` to `/admin/assets/*`
(404) and the page renders empty — this also affected `/admin/register`.
### Athlete invites (admin UI)

Athlete registration is invite-gated (`INVITE_ONLY=1`). Codes are now issued
from the admin dashboard — tab **«Приглашения»** (owner/manager only):

- **Create** — `POST /api/admin/invites/new` with `{ note, short: true }`
  returns an 8-char code from a 32-char unambiguous alphabet (≈40 bits; the
  default no-flag path still returns the original 16-hex code). The UI shows
  the code and a ready link `https://<origin>/?invite=<CODE>` with copy buttons.
- **List** — `GET /api/admin/invites` returns all codes with `usedByName`
  resolved for display.
- **Revoke** — `POST /api/admin/invites/revoke` (unused codes only).
- The athlete opens the invite link → «Create new profile» → the invite field
  is prefilled from the `?invite=` URL param (`Login.jsx` / `Settings.jsx`),
  then they finish with their passkey as usual.
### Trainer portal (/trainer)

Separate route for coaches, gated to `role === 'trainer'` (owner/manager are
redirected to `/admin`). Login uses the same admin passkey.

- **Roster** — `GET /api/admin/analytics/athletes` returns only the caller's
  athletes (existing `analyticsScope`). Each row is clickable → the analytics
  drill-down card (trainer sees detail for own athletes).
- **Add a new athlete** — trainer creates an invite via
  `POST /api/admin/invites/new` (trainer role now allowed); the invite stores
  `trainerId`. When the athlete registers through the `/?invite=CODE` link,
  `/api/register/verify` auto-creates the `trainer_assignments` row, so the
  athlete lands in the trainer's roster.
- **Add an existing athlete** — `GET /api/admin/analytics/users?q=` searches
  registered non-admin athletes (with current trainer); trainer calls
  `POST /api/admin/analytics/assign` where `trainer_id` is forced to self —
  a trainer can only (un)assign their own roster. Owner/manager keep the
  full picker in the analytics drill-down.
- Athletes can belong to one trainer at a time (`trainer_assignments.user_id` PK).

Frontend: `frontend/src/views/Trainer.jsx` (new); `App.jsx` treats `/trainer`
as an admin route; `AdminApp.jsx` routes it through the same login gate.
### Trainer program view/edit + exercise stats

From an athlete's drill-down card (both `/trainer` and `/admin/analytics`) the
«Программа» button opens the athlete's training program:

- **GET `/api/admin/trainer/athlete/program?id=`** — owner/manager any athlete;
  a trainer only their assigned athletes (`requireProgramAccess`). Returns
  `{ unit, routines, week, dayPlan, customEx, workouts }` — workouts are
  included so per-exercise history can be rendered client-side.
- **PUT `/api/admin/trainer/athlete/program?id=`** — merges only `routines`
  into the athlete's state file (`state-<uid>.json`): workouts and everything
  else stay untouched, so a stale trainer copy can never clobber the athlete's
  logs. Sanitised server-side (name/emoji/prog whitelisted, sets/reps/weight
  clamped, caps on counts). Sets `_ts` so the athlete app picks the change up
  on next sync.
- **`frontend/src/views/TrainerProgram.jsx`** (new) — two tabs:
  - «Программа»: weekly day mapping, create/rename/delete routines, add
    exercises (shared `exercisePicker` sheet), inline sets × reps × weight
    editing, reorder/remove, save button.
  - «Прогресс»: per-exercise history from the athlete's logged workouts —
    best weight, done/total sets, and per-date sets like `60 × 8, 62,5 × 6`.
- `AdminApp.jsx` now renders `<Modals />`/`<Toast />` in the admin route —
  without this, sheets (e.g. the exercise picker) never appeared outside the
  athlete app.
### Trainer calendar / athlete bookings

Trainers get a «Календарь» tab (in `/trainer`); athletes get a «Мой тренер»
card on Home with a booking sheet.

- **DB**: `trainer_availability(trainer_id, weekday, time_start, time_end)`
  — working hours; `coach_bookings(id, trainer_id, athlete_id, date, time,
  status, note)` — status ∈ `pending | confirmed | rejected | cancelled`.
  Both created by the schema bootstrap in `api/admin-db.js`, no manual
  migration needed.
- **Athlete side** (`/api/trainer/*`, signed-in athlete session):
  - `GET /api/trainer/me` — assigned trainer (`trainer_assignments`).
  - `GET /api/trainer/availability` — trainer's working hours + already-taken
    upcoming slots.
  - `POST /api/trainer/book` — request a slot (`status=pending`). Validates:
    slot inside working hours, not in the past, no conflict (409), trainer
    assigned (403).
  - `GET /api/trainer/my-bookings`, `POST /api/trainer/bookings/cancel`.
- **Trainer side** (`/api/admin/trainer/*`, admin session):
  - `GET/POST /api/admin/trainer/availability` — `{ slots: [{weekday,
    time_start, time_end}] }`; trainer edits own, owner/manager any
    (`trainer_id` param).
  - `GET /api/admin/trainer/bookings` — list (filter `?status=`);
    `POST /api/admin/trainer/bookings/status` — confirm/reject;
    `POST /api/admin/trainer/bookings` — direct booking (status=confirmed).
    A trainer can only book for their own athletes (403 otherwise);
    operator has no access (403).
- **Frontend**: `frontend/src/views/TrainerBookings.jsx` (new tab: working
  hours editor, week grid, pending requests, «Записать»);
  `frontend/src/components/CoachSheet.jsx` (new athlete sheet: free slots by
  weekday, send request, my bookings + cancel). Home shows the «Мой тренер»
  card only when the athlete has an assigned trainer; strings are in
  `locales/ru.js` / `en.js`.
## Войти как пользователь (имперсонация)

Владелец может посмотреть интерфейс глазами любого спортсмена или сотрудника —
полезно для проверки, что видит клиент/тренер, и для поддержки.

- **API** (`POST /api/admin/impersonate`, только `owner`):
  - `{ kind: 'athlete', id }` — выдаёт свежую `gymsid`-сессию спортсмена
    (admin-сессия владельца не трогается, `redirect: '/'`).
  - `{ kind: 'staff', id }` — заменяет `adminsid` на сессию с меткой
    `impersonate:` (все admin-эндпоинты работают как обычно), исходная сессия
    владельца паркуется в куке `adminsid_orig`, `redirect: '/trainer'` для
    тренеров и `'/admin'` для остальных ролей.
  - Нельзя имперсонатировать отключённые аккаунты (400) и несуществующие (404);
    вложенная имперсонация заблокирована (400/403).
- **Возврат** (`POST /api/admin/impersonate/back`): разрешён только пока активна
  `impersonate:`-сессия — обычная сессия сотрудника «вернуться» не может
  (нет роста привилегий). Восстанавливает `adminsid` из `adminsid_orig`
  и чистит её.
- **Фронтенд**: `GET /api/admin/auth/me` возвращает `impersonated: true`;
  в `/admin` и `/trainer` показывается баннер «Вы смотрите интерфейс от имени
  …» с кнопкой «Вернуться» (полный reload, чтобы стор перечитал сессию).
  Кнопка «Войти как» появляется в списке сотрудников и в списке спортсменов
  аналитики только у владельца.
- **Примечание**: для спортсмена возврат не нужен — `gymsid` и `adminsid`
  независимы, владелец просто возвращается на `/admin`.
## Часы работы тренера: разрывной график и выходные

Тренер может задавать **несколько интервалов в один день** (например
09:00–12:00 и 16:00–21:00) и **свободные дни** (день без интервалов —
выходной). Редактор «Часы работы» в `/trainer` → «Календарь»:

- у каждого дня (Вс–Сб) свои интервалы `время начала — время конца`;
- «+ Интервал» добавляет ещё один интервал в день, «×» убирает — пустой день
  помечается «выходной»;
- сохранение отправляет плоский список интервалов
  `[{weekday, time_start, time_end}, …]`.

- **Миграция БД**: у `trainer_availability` был `PRIMARY KEY (trainer_id,
  weekday)` — не позволял хранить больше одной записи на день. Миграция
  `AVAILABILITY_MIGRATION` снимает этот ключ и ставит обычный индекс
  `(trainer_id, weekday)`; `setTrainerAvailability` пишет без `ON CONFLICT`.
- **Слияние интервалов**: `daySlots()` (общий для сервера и фронтенда) теперь
  собирает часовые слоты из **всех** интервалов дня (без дублей, по порядку) —
  спортсмен в шите «Запись к тренеру» видит 09,10,11,16,17,…20, а в разрыве
  12–15 слотов нет.
- **Валидация записи**: `POST /api/trainer/book` проверяет время по любому
  интервалу дня (`availability.some(...)`), а не по первому — запись во второй
  интервал проходит, в разрыв и в выходной — `400`.
## Инструкция по программе лояльности (встроенная)

В админке (`/admin`) во вкладках **Loyalty** и **Награды** появилась кнопка
**«Инструкция»** — открывает нижний шит с подробным руководством по
конструктору: как работает схема (событие → правило → награда), назначение
каждого поля правила (событие, филиал, баллы, лимит день/неделя/месяц, ключи
достижения и награды, push-уведомление), устройство каталога наград (виды,
стоимость, запас, способы выдачи: подтверждение сотрудником / авто-код),
работа с заявками на выдачу (выдать / отклонить с возвратом баллов), откуда
берутся события, и готовые сценарии (ежедневное посещение, регулярность,
серия недели, реферал, мотивация).

- `frontend/src/components/LoyaltyHelp.jsx` — компонент шита
  (`loyaltyHelpSheet()` открывает через `useUI.openSheet`), рендерится
  штатным `<Modals />` админ-роута.
- Кнопка добавлена в оба заголовка — видна всем ролям, не только редакторам.
## Страница справки (FAQ) по всей системе

Добавлена страница **/admin/help** — справка-аккордеон с поиском по всей
системе: роли и доступ, сотрудники и приглашения, программа лояльности,
аналитика спортсменов, тренерский портал, режим «Войти как», приложение
спортсмена. 25 вопросов-ответов.

- `frontend/src/views/AdminHelp.jsx` — страница (раскрывающиеся пункты +
  фильтр по ключевым словам по тексту вопроса и ответа).
- Входы: иконка «Справка» (info) в шапке админки (`/admin`) и в шапке
  тренерского портала (`/trainer`); роут `/admin/help` доступен всем ролям,
  кнопка «Назад» возвращает на `/admin`.
