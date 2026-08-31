# Changelog

## 1.2.11 — декомпозиция: админ-панель вынесена в роут-модуль

### Changed
- `server.js` (-692 строки, 1727→1035): все 41 хендлера `/api/admin/*` вынесены
  в `api/routes/admin.js` — фабрика `createAdminRoutes(deps)`. Домены: passkey-вход
  и выход, имперсонация (owner), сотрудники (invite/register/update), пользователи,
  аналитика (overview/athletes/athlete/leaderboard/trainers/retention/assign/users),
  календарь тренера (брони, статусы, часы работы, постоянные клиенты с skip/unskip),
  интеграции турникета (bindings/bind), инвайты.
- Поведение идентично — импорт, не копия; зависимости передаются через `deps`.

### Verified
- Синтаксис всех роут-модулей; health 200; смоук: 41 admin-роут из модуля
  (без сессии → 401, logout/options → 200); неизвестный роут → 404.
- Тесты: 233 green (192 frontend + 41 api с postgres).

### Cleanup (в рамках v1.2.11)
- `server.js` 1035→959: удалены 76 осиротевших строк комментариев, оставшихся
  от вынесенных роутов (разделители секций, описания хендлеров).
- `admin.js`: возвращены потерянные при выносе пояснения бизнес-логики
  (Owner-only имперсонация, drill-down аналитики, scope прав owner/manager/
  trainer, мерж routines у тренера) + добавлены разделители 12 секций для
  навигации. Все admin-комментарии оригинала теперь на месте; серверные
  таймерные комментарии остались в server.js (целы).

## 1.2.10 — локализация названий упражнений в статистике + фикс Dockerfile

### Changed
- `Stats.jsx`: имена упражнений в разделе «Прогресс упражнений» теперь берутся из
  `exName()` (словарь `names/ru.js`) вместо сырых английских `EXIDX[id].n` —
  селектор упражнения и сортировка списка переводятся при русском интерфейсе
  (например, «тяга штанги в наклоне» вместо «Bent-over barbell row»).
- `api/Dockerfile`: добавлены `logic.js` и папка `routes/` в копируемые файлы —
  без этого пересобранный контейнер падал (`Cannot find module '/app/routes/webhook.js'`),
  а прод-деплой на impulse упал бы при первом же `up --build`.
- `ru.js`: добавлен недостающий ключ `Exercise` → «Упражнение» (+15 демо-строк),
  удалены дубликаты ключей (`Save`, `Finish workout`).

### Verified
- Frontend-тесты: 192 passed; сборка web прошла; names-чанк содержит переводы
  («жим штанги лёжа», «тяга штанги в наклоне»); web-контейнер отдаёт свежий бандл.

## 1.2.9 — демо-данные программы лояльности для презентации

### Added
- `scripts/seed-loyalty-demo.sh` — идемпотентный сидер (повторный запуск не дублирует баллы).
- `docs/demo-loyalty.md` — сценарий презентации: персонажи, механика, где смотреть в UI.

### Changed
- Тестовые спортсмены: Artem (активный лоялист: заработал 275, погасил футболку 200),
  Maxim (новичок по рефералке: 125, копит), Testuser1 (угасший: 30) — все привязаны
  к тренеру Андрею (3 подопечных в ростере).
- Правила: визит +10, тренировка +15, стрик +25, реферал +50. Награды: скидка 10%
  (150, авто-код), футболка (200, вручную), персональная тренировка (300, вручную).
- Наполнение шло через честный поток: вебхук `/api/integrations/loyalty/events`
  (правила + уведомления в outbox) и транзакция `redeemReward`.

### Verified
- Ростер Андрея: 3 спортсмена; кошельки 125/75/30; редемпшн Artem в БД;
  уведомления о начислении в outbox.

## 1.2.8 — декомпозиция: лояльность вынесена в роут-модуль

### Changed
- `server.js` (-70 строк, 1797→1727): 11 хендлеров программы лояльности вынесены
  в `api/routes/loyalty.js` — фабрика `createLoyaltyRoutes(deps)`. Два контура:
  спортсмен (кошелёк/награды/погашение) и админ (награды/редемпшны/правила,
  owner/manager для записи).

### Verified
- Синтаксис; health 200; все роуты лояльности без сессии → 401 (защита на месте);
  все 233 теста green (192 frontend + 41 api с postgres).
- Бекап: git-tag `backup-before-loyalty-route-20260831-1307`.
## 1.2.7 — декомпозиция монолита: роут-модули (пилот)

### Changed
- `server.js` (-133 строки): обработчики вебхуков и центра уведомлений вынесены
  в `api/routes/webhook.js` и `api/routes/notifications.js` — фабрики, возвращающие
  `[{ method, path, handler }]`, регистрируемые в общем роутере.
- Паттерн пилотный и безопасный: поведение идентично (импорт, не копия), каждый
  домен теперь можно править и тестировать изолированно.

### Verified
- Синтаксис всех модулей; старт api + health `{"ok":true}`.
- Новые роуты реально зарегистрированы: webhook без секрета → 401, notifications
  без сессии → 401, неизвестный роут → 404.
- Все тесты: 192 frontend (vitest) + 41 api (unit + интеграционные с postgres) = 233 green.
- Бекап перед рефакторингом: git-tag `backup-before-route-split-20260831-2254` +
  bundle/tar в `/home/admssh/backups/`.
## v1.10.5 — 2026-08-31

Напоминания о предстоящей тренировке (за день).

- ⏰ **Upcoming-session reminders**: the night runner now pushes + notifies the athlete for
  every confirmed booking on the target date (default lead = 1 day, `REMINDER_LEAD_DAYS`
  overrides). Covers both one-off and «постоянные» (recurring) sessions.
- 🔁 **Idempotent via `reminded_at`** on `coach_bookings`: each booking is reminded at most
  once, no duplicates across boot-fires or interval runs (`REMINDER_INTERVAL_MIN`, default
  20 min).
- 🌍 Bilingual messages (ru/en by athlete language), tap-through to `/notifications`.
- 🧹 Fixed `OUTBOX_MIGRATION` executed 7× at startup (now once).

### Verified
- Booking tomorrow (2026-09-01) for Artem: boot-fire sent 1 reminder, notification
  `rem-<booking>` created, `reminded_at` stamped; second run produced no duplicates.
  Test data cleaned afterwards. Tests: 192 passed.


## v1.10.4 — 2026-08-31

Постоянные серии учтены в модели удержания.

- 🧷 **A client with a locked recurring («постоянная») slot is never labelled «ушёл».** If the
  risk model would mark them `gone`, it caps them to `at_risk` (score 4.4) — because the
  trainer is still holding their standing reservation, so writing them off is premature.
- 🏷 The retention snapshot now carries `recurring` + `recurringTime` per athlete; the
  «Удержание» tab shows a «постоянник» badge and the standing schedule
  («постоянные слоты: Пн 18:00») so a trainer/owner sees why a seemingly-idle client is
  only at risk.
- Built nightly as part of the same snapshot (DB recurring rules read once at build time,
  no extra load during the day).

### Verified
- With a series on the `gone` athlete Testuser1: level changes gone → at_risk, badge +
  schedule shown; reasons still describe the real workout slack (no new activity). After
  removing the series and rebuilding, Testuser1 returns to `gone` (no recurring). Tests: 192 passed.

## v1.10.3 — 2026-08-31

«Постоянные клиенты» видны в аналитике.

- 🏷 **«Постоянник» badge** on an athlete in the trainer roster (`/trainer`) and the admin
  analytics list (`/admin/analytics`), so a trainer instantly sees which clients have locked
  recurring slots.
- 📋 The badge row also shows the standing schedule: «постоянные слоты: Пн 18:00, Ср 17:00».
- Backend `/api/admin/analytics/athletes` now annotates each athlete with `recurring` +
  `recurringTime`, scoped correctly (a trainer sees only their own recurring clients).
- Verified: Artem (with a series) shows the badge + schedule in both views; Testuser1 (no
  series) doesn't. Test series cleaned up after. Tests: 192 passed.

## v1.10.2 — 2026-08-31

«Постоянные клиенты»: спортсмен теперь узнаёт о закреплённых слотах.

- 🔔 **On series creation** the athlete gets a notification-center entry + push:
  «Artem! Тренер закрепил за вами слоты: Пн 18:00. Они бронируются вперёд на 8 недель —
  эти времена больше не сможет занять другой спортсмен.» (tap → /notifications).
- 🔕 **On series deletion** a short notice: «Постоянные тренировки отменены».
- Idempotent ids (`rec-<series>` / `rec-del-<series>`), so re-saving the same series never
  duplicates the notification.

### Verified
- End-to-end: created a series → row `rec-<series>` appeared for the athlete with the exact
  Russian text; deleted it → `rec-del-<series>` row + all recurring rows removed. Tests: 192 passed.

## v1.10.1 — 2026-08-31

«Постоянные клиенты»: понятные подсказки, когда время не входит в часы работы тренера.

### Before
Choosing a recurring slot outside the trainer's working hours just showed a raw English
message («recurring time outside working hours») with no idea which day/time was the problem
or what hours are actually available — the trainer had to guess.

### Now
- ✅ **Live hints inside the form.** Each weekday row shows its status as you pick a time:
  «✓ в работе», «✗ вне часов — доступно 09:00–18:00», or «✗ нет часов в этот день (выходной)»
  — computed from the trainer's actual (incl. split-shift) working hours.
- 🚫 **Save is blocked while any picked slot is outside hours**, with a plain-Russian summary:
  «Не получится сохранить: эти дни/время не входят в рабочие часы (Чт 18:00, Пт 18:00, Сб 18:00)».
- 💡 **Guidance line** in the form: adjust working hours («Часы работы») or pick another time.
- 🔁 **Structured backend error** as a fallback: `400` returns `error` + `details[]` (per-day
  `available` intervals), and the API client now exposes the full body on thrown errors
  (`e.data`) so any view can use it.

### Verified
- Backend: requesting rules {Пн 18:00 ✓, Сб 18:00, Чт 08:00} returns all conflicts with
  per-day `available` (day-off → empty, outside-hours → «09:00–18:00»).
- Frontend (headless Chrome as trainer): Вт/Ср 18:00 → «✓ в работе», Чт/Пт 18:00 → «✗ вне
  часов — доступно 09:00–18:00», Сб → «✗ выходной»; save disabled; summary shown. Tests: 192 passed.

## v1.10.0 — 2026-08-31

Recurring trainer bookings («постоянные клиенты»): fixed weekly slots locked for regular athletes.

### What it does

- 🗓 **Trainers can assign a recurring series to an athlete** — several days of the week, each with a time (e.g. Пн 18:00 и Ср 17:00). The slots are reserved **8 weeks ahead and roll forward automatically**.
- 🔒 **Those slots can't be taken by others.** Recurring rows are materialized as confirmed bookings, so they appear in the trainer's occupied slots and in the athlete-facing free-slot view — any attempt to book into one returns `409 this slot is already booked`. The rest of the booking flow stays untouched.
- ✅ **Immediately confirmed** — no per-date request/confirmation; the client just sees their standing slots in «My bookings», marked «Постоянная».
- 🕐 **Tied to working hours** — a rule is only accepted (and only materialized) while the time stays inside the trainer's availability for that weekday; if hours shorten, future recurrences go dormant instead of ghosting.
- ➖ **Per-day skip** and **unskip** — the trainer can drop or restore a single occurrence; deleting a series removes all its future bookings.

### Details

- New tables `recurring_bookings` (rules) and `recurring_skips` (per-date skips); `coach_bookings` gains `series_id` to mark materialized rows.
- `materializeRecurringSeries` fills the rolling 56-day horizon (respecting availability, skips and existing conflicts); `rollRecurringForward` rolls it forward on bookings access and once a day.
- Trainer portal: «Постоянные клиенты» panel (list, add/edit form per weekday, delete series, per-day skip/undo). Athlete sheet: recurring bookings are marked «Постоянная».
- Verified end-to-end on production: series with two rules materialized 16 bookings over 8 weeks; booking into a slot → 409; skip removed one occurrence, unskip restored it; delete cleared rules + future rows. Tests: 192 passed.

## v1.9.1 — 2026-08-31

Fixed the trainer hours editor: the split-schedule UI (multiple intervals per day) was accidentally reverted.

### What broke

- Commit f9ab448 (trainer badge counter) rewrote `TrainerBookings.jsx` from an older baseline, silently dropping the split-shift editor added in 64837ed. Trainers were back to the old single-interval-per-day UI — no «+ Интервал» button, no per-day interval lists, no day-off marking beyond clearing the time fields.
- The backend and the athlete-facing booking sheet (`CoachSheet.jsx`) never lost multi-interval support, so data written before the revert still worked — only the trainer's editor UI regressed.

### Fixed

- 🕐 **Split-shift editor restored** in the «Календарь → Часы работы» panel: each day shows its own interval list with «+ Интервал» / delete buttons and a рабочий/выходной marker; a day without intervals is a day off. Help text explains the pattern (e.g. 09:00–12:00 и 16:00–21:00).
- Hours state is again grouped per weekday (`weekday → intervals[]`), `saveHours` flattens it into slots, and slot generation merges every interval of a day — exactly as in 64837ed.
- Kept the badge-event dispatch (`trainer-bookings-changed`) and the merged `daySlots` from the later fixes.

### Verified

- End-to-end in headless Chrome as the trainer: set Пн to 09:00–12:00 + 16:00–21:00, saved, and the calendar showed free slots 09:00, 10:00, 16:00, 17:00, 18:00, 19:00, 20:00. Overlapping intervals are correctly rejected by server validation (no data corruption). Original schedule restored afterwards. Tests: 192 passed.

## v1.9.0 — 2026-08-31

Retention analytics: why athletes leave, computed at night, shown to the gym owner and trainers.

### «Удержание» tab in /admin/analytics

- 🎯 **Risk model per athlete.** Nightly snapshot (`data/retention-snapshot.json`) with level (active / at_risk / gone), gap since last workout, frequency/volume/sets trend (last 4 weeks vs previous 4), stalled-progress detection and a weighted risk score with plain-Russian reasons — «нет активности 30+ дней», «снижение частоты», «прогресс остановился», «меньше подходов».
- 🌙 **Nightly recompute only.** The heavy math runs once at night (04:00 by default, `RETENTION_RUN_HOUR` to override); the tab reads the ready snapshot all day and never touches state/PG at request time. First boot builds on demand so the tab is never empty.
- 📉 **Honest retention funnel.** Of those who ever trained, how many held on to 4 and 8 weeks — a monotone chain (trained ≥ week4 ≥ week8) that never reads backwards.
- 🔎 **Role-scoped numbers.** A trainer sees only their own athletes: summary, funnel and list are recomputed from the filtered rows, not from the whole network's cached snapshot.
- 🔔 **Trainer alerts on downgrade.** The nightly runner diffs the previous snapshot against the new one; when an athlete's level worsens (active → at_risk/gone, at_risk → gone), the assigned trainer gets a notification-center entry plus a push — one per day per athlete, idempotent, no spam.
- 📣 **Owner alert on network-wide outflow.** When the number of gone/at_risk athletes grows overnight, every owner account gets a notification-center entry plus a push («Удержание: отток растёт — ушли N (+X за сутки)…») with a link straight to the «Удержание» tab — one per day, idempotent.

### Verification

- End-to-end on production data: Testuser1 → gone (score 10, all four reasons), Artem → active (12/12 sessions, stable volume). Owner sees the whole network, trainer Andrey sees only his two athletes. UI checked in headless Chrome for both roles — no JS errors, funnel and risk tiles render correctly.

## v1.8.1 — 2026-08-27

Stability and hardening of the push and booking flows, so the notifications from v1.7.0 stay reliable in production.

### Hardened booking flows (#45)

- 🔒 **Booking and loyalty cash-out are now safe against retries and concurrent runs.** The booking state machine validates transitions before persisting, and claiming a reward from the loyalty outbox is made idempotent — a repeated claim cannot double-apply points or hand out the same reward twice.
- 🧩 **Notification click lands on the right screen.** Clicking a push now navigates to the in-app notification center (`/notifications`), and push payloads carry a `url` field so the target destination is explicit per notification.
- 🩺 **Diagnostics.** Added a push/health debug endpoint so delivery can be checked directly.

### Docs

- 📘 DEPLOYMENT.md gained a dedicated section on fixing push notifications (DNS resolver fix and verification steps from v1.7.0).

## v1.8.0 — 2026-08-26

Data isolation and startup performance for the athlete app.

### Data stays per user

- 🧷 **Cache, custom exercises and all state are isolated per user.** `localStorage` was shared across every account on a device (`gym_state_v1`): switching accounts leaked another user's state (including custom exercises) into their account. The cache is now keyed by `userId` (`gym_state_<id>`, guests get `gym_state_guest`), `setUser()` reloads the new user's state, and the dirty flag is per-user. Registering from guest mode transfers data via `keepLocal`. Verified end-to-end: one user's custom exercise is invisible to another in the same browser and on the server.

### Faster startup

- ⚡ **Interface renders before history loads.** `ready` is set as soon as `/api/me` returns; history (`pullState`) loads in the background and updates the store as it arrives, so the first screen no longer blocks on the full training history.
- 🧠 **Exercise instructions load lazily.** Switching language no longer pulls a ~1 MB instruction pack at startup — only UI strings and exercise names. Instructions are fetched via `ensureInstr()` when an exercise card is opened and re-render in the chosen language, with the English steps as an instant fallback.

## v1.7.0 — 2026-08-26

Push notifications done end-to-end: delivery to athletes about points and bookings, badges, and a shared notification center with monitoring.

### Loyalty points, pushed (#44)

- 🔔 **Automatic push when points land.** When an athlete earns points they get a localized push ("+15 баллов — Ежедневное посещение") with correct case declension, queued through the `loyalty_outbox` and delivered via the existing web-push/VAPID stack. A rule's own *(!!)* custom notification overrides the automatic one. Verified end-to-end: rule → event → outbox → push on a real FCM subscription.

### A notification center for everyone

- 📬 **In-app notification center.** Every loyalty message is also stored in `app_notifications`. A bell in the app header shows unread count; the `/notifications` page marks everything read when opened.
- 👤 **One badge, three sources.** The icon badge now counts unread notifications + pending rewards + pending trainer bookings; the service worker keeps it in sync on push events.
- 🧽 **Badge resets once you've looked.** Pending rewards and bookings get a `viewed_at` when their section is opened (Settings → Loyalty, trainer sheet), and the badge recomputes to 0.
- 🏋️ **Trainer badges too.** The trainer portal's bell and the Calendar tab count pending booking requests (30 s polling + instant after any action). The install-icon badge mirrors the same pending count and clears on sign-out.

### Delivery that works

- 📲 **Real end-to-end sends.** Trainers get a push when an athlete books through the portal (with the athlete's name, date and time); athletes get one when a booking is confirmed/rejected/cancelled/completed (trainer name + date, in the athlete's language, also saved to the center).
- ⚠️ **Delivery monitoring and alerts.** In-memory sent/failed/expired counters and a failure buffer, a failure banner on the admin Overview with a reset button, and an optional webhook alert (`PUSH_ALERT_WEBHOOK`, 5 min debounce + recovery notification). Dead subscriptions (404/410) are ordinary cleanup, not alerts.
- 🔧 **Safari install prompts.** On iOS/iPadOS outside PWA mode the app shows "Установите приложение на главный экран" instead of a broken toggle; on macOS Safari a footer note explains "Добавить в Dock".
- 🌐 **Fix: pushes failed on the VPS.** `8.8.8.8` is unreachable from the VPS, so Docker forwarded external DNS to a dead resolver and every push died with `EAI_AGAIN`/`ESERVFAIL`. The API container now uses a working DNS (8.8.4.4, 1.1.1.1); the internal network is untouched.

## v1.6.0 — 2026-08-26

Built-in help: every surface now explains itself, no external docs required.

- 🎁 **Loyalty program builder.** An "Инструкция" button in the Loyalty and Rewards tabs opens a guided sheet: the event → rule → reward flow, every rule/reward field, redemption requests, event sources, and ready-made scenarios.
- ❓ **Admin FAQ.** A new `/admin/help` page — accordion with search across roles and access, staff and invitations, loyalty, analytics, trainer portal, "Войти как", and the athlete app. A "Справка" icon was added to the admin and trainer headers.
- 📋 **Trainer portal guide.** An "Инструкция" button opens a sheet covering the athlete list and statuses, adding athletes (invite/search), programs and progress, the calendar with working hours and requests, plus tips and access notes.
- 🤔 **Athlete "Points & rewards" explainer.** A "?" on the balance card opens "Баллы и награды": how points accrue, what rewards are, how to redeem them and request statuses. The whole loyalty section in the app was also translated into Russian.

## v1.5.0 — 2026-08-26

The trainer and owner experience: split schedules, and the owner can see any account from the inside.

### Split working hours (#46)

- 🗓️ **Non-contiguous schedules.** The Calendar editor lets you add/remove intervals per day; a day with no intervals becomes a rest day. The migration drops the `(trainer_id, weekday)` primary key, `daySlots()` merges a day's intervals, and booking validation accepts any interval's time.

### Owner sees it as you do

- 🕵️ **"Войти как" — impersonation.** The owner can view the interface as any athlete or staff member: buttons in staff/athlete lists, plus an "от имени …" banner with "Вернуться" in `/admin` and `/trainer`. Athletes get a separate `gymsid` session (admin session untouched); staff get `adminsid` flagged `impersonate:` with the original session parked in `adminsid_orig`. Owner-only, no nested impersonation.

## v1.4.0 — 2026-08-26

Trainer portal: programs, calendars and bookings with confirmation.

- 🏋️ **View and edit athlete programs.** A "Программа" button in an athlete card (`/trainer` and `/admin/analytics`) opens their training plan: create/rename/delete programs, add exercises from the shared catalog, edit sets × reps × weight, reorder, save. A "Прогресс" tab shows per-exercise history — best weight and sets/weights by date from the athlete's logs. `GET/PUT /api/admin/trainer/athlete/program` (owner/manager see anyone; trainer only their own via `trainer_assignments`, otherwise 403). PUT merges only routines into the state file — logs and other data are never overwritten.
- 📅 **Trainer calendar with bookings.** `trainer_availability` + `coach_bookings` tables; athlete API for their trainer (`/api/trainer/me`, `/availability`, `/book` → pending, `/my-bookings`, `/bookings/cancel`); trainer API to manage hours and bookings (`/api/admin/trainer/availability`, `/bookings` — list, status, direct create). Trainer portal gains a Calendar tab: hours editor, week grid, requests, "Записать". The athlete app shows a "Мой тренер" card on Home with a booking modal. Scoping enforced: trainer = own athletes only, operator denied, schedule conflicts → 409, outside hours → 400.
- 📇 **Invite codes for athletes.** Admins (owner/manager) get an "Приглашения" screen that creates short 8-character codes (~40 bits, safe alphabet), ready links `?invite=CODE` with copy, a list with free/used status, and the ability to revoke unused codes.
- 🩹 **Clear "code already used" message.** Reopening a one-time staff link now explains in Russian that the code is already used (invite already registered) and offers "Войти как сотрудник" via passkey, instead of the opaque "invalid or used staff invite".

## v1.3.0 — 2026-08-21

Analytics for the network, and a marketing page written in the app's own design language.

### Athlete analytics module (#42)

- 📊 **New `/admin/analytics` module**, read-only, role-scoped: owner sees the whole network, manager their branch (`admin_users.branch_key`), trainer only athletes assigned via `trainer_assignments`, operator statuses only. Endpoints: overview, athletes, athlete drill-down, leaderboard, trainers, assign. KPI tiles, status chips (active/at-risk/gone/new), weekly activity, best lifts, points ledger and rewards in the drill-down card. Also fixed SPA subpath rendering — Vite base is now absolute for web builds (mobile keeps relative via `VITE_MOBILE`).

### Promo page (#41)

- 💼 **A Russian landing page at `/promo`** selling the platform to fitness-club owners: retention problem, loyalty engine, rewards, access-control integration, push, passkey login, staff roles, pricing tiers, FAQ. Served as a static file via a dedicated nginx location (bypassing the SPA fallback); roadmap features are explicitly marked as not yet implemented.
- 🎨 **Built with the app's own design tokens** instead of generic marketing styling: SF Pro type scale with tight tracking, black background with iOS-style surfaces, the green accent, hairline separators, and real app components (cards, list rows, chips, tiles, primary/tinted/ghost buttons).

## v1.2.5 — 2026-08-21

Network, loyalty and localization foundations.

### Admin panel, loyalty engine and access-control (#40)

- 🛂 **A `/admin` SPA** with separate passkey accounts and staff roles (owner/manager/trainer/operator) and invite-code registration.
- 🎯 **Configurable loyalty programs** (points / achievements / rewards / notifications with per-period limits) stored as data and applied without code changes.
- 🔌 **Webhook endpoints** for access control (SCUD/turnstile) and loyalty events, idempotent on `event_id`, guarded by a shared secret.
- 🎁 **Rewards catalog** with staff-confirmed and auto-code redemptions backed by an immutable points ledger, and a **wallet UI** inside Settings for balance, rewards and history.
- 🔔 **Loyalty notification dispatcher**: rules with a notification action queue a row in `loyalty_outbox`; the dispatcher sends it via the existing web-push/VAPID stack. Rows are claimed with `FOR UPDATE SKIP LOCKED` so concurrent runs never double-send; `delivered_at` is set only on success. It runs after webhook rule application (response includes the notified count) and every 30 s as a retry safety net.
- 🐛 **Fixed the React 19 `useEffect(load, [])` crash** that white-screened admin tabs and the Settings wallet (wrap in `() => { load() }`), and added an AdminBoundary error boundary.
- 📝 **Docs**: DEPLOYMENT.md for future agents, `.env.example`, `.gitignore`.

### Exercise translations

- 🌍 **All 1,324 exercise names translated into Russian** (lazy-loaded via i18n, applied on language switch). Search now matches Russian names, and a semantic generator composes correct Russian word order and cases instead of word-by-word concatenation:
  - "тяга со штангой" → **"тяга штанги в наклоне"** (bent-over row)
  - "тяга штанги со стоек" / "тяга штанги на задние дельты" / "тяга штанги к подбородку"
  - "румынская становая тяга со штангой"
  - one-arm exercises keep "одной рукой" in the right place.
  - 1062 entries changed versus the previous file; 0 untranslated.
- 🎞️ **Fixed GIF animations in the Plan tab**: media base now uses absolute `/gif/ /img/` so animations load (they previously resolved relative to `/plan/r/` → 404).

## v1.2.4 — 2026-08-01

The effort ratings you have been recording since v1.2.3 now answer questions, and bodyweight
training stops being treated as barbell training with the weight left at zero. Plus: creating a
profile from Settings works on an invite-only instance, which it never has.

### The effort ratings, read back as statistics

v1.2.3 let you rate how hard a set was. Nothing then read that rating back — it lived in the set
label and nowhere else. Stats now answers the question the number was recorded for.

- 📊 **An Effort card in Stats** over 30d / 90d / 1Y / all time: average effort, the share of sets
  taken close to failure, and — always alongside them — how much of your training was rated at
  all. Rating is optional and off by default, so a partly rated history is normal; an average
  without its denominator would quietly speak for sets you never rated.
- **Week by week.** The weekly average with that week's set count in the tooltip, because the
  pair is the reading: volume up with effort up is fatigue accumulating, volume up with effort
  flat is the adaptation you were training for. Weeks resting on a single rated set are dropped
  rather than drawn.
- **Where the sets land.** The spread across the scale, not just the middle of it. Half your sets
  at failure and half in warm-up territory average out to a healthy-looking number; this is the
  chart that shows it.
- 🔥 **Hard-sets mode on the muscle map.** The same body diagram, counting only sets taken near
  failure — "where did the stimulus go" rather than "where did the volume go". A muscle can lead
  on set count and still never be trained hard.
- **Effort on the exercise curve.** Each session's dot on the top-set chart fills in as less is
  left in the tank, so the same weight moved with more in reserve stops reading as a flat line.
  Exercises with enough ratings also get an Effort curve of their own.
- **One history, whichever scale you use.** Everything aggregates internally in RIR and converts
  back for display, so a history that mixes your own RIR logs with imported RPE averages as one
  series instead of two half-empty ones. RIR charts count downward on the axis, so harder sets
  sit higher.
- Translated into all 12 UI languages.

### Bodyweight training, logged the way it is done

A push-up has no weight to type, and the app asked for one anyway — every set, on a quarter of
the catalogue. Three reports (#31, #32, #33) turned out to be the same gap: the app assumed
progress lived in the load. It doesn't, for the exercises most people actually start with.

- 💪 **Exercises know they are bodyweight.** Seeded from the equipment the dataset already
  records, so push-ups, pull-ups, dips and 300-odd others arrive marked. The weight column is
  not shown, the set row is one stepper instead of two, and the "confirm your working weight"
  prompt at the end of an exercise stops asking about a weight that was never there. (#32)
- **Added weight when there is any.** A dip belt or a weighted vest is entered once in the
  exercise settings and reads as an addition — "+10 × 8", not "10×8" — everywhere it is shown
  back. With load on the belt the normal progression rules take over again, because now there
  is something to add.
- 📈 **Reps and sets are the progression.** Clean session, one more rep. Set a top of the range
  and reaching it adds a set and starts the reps over instead of climbing forever; at six sets
  it says what it should have said all along, which is that it is time for weight or a harder
  variation. No ceiling set keeps the old behaviour exactly. (#33)
- ↔️ **Reps per side.** For lunges, single-arm rows and every other unilateral movement. You
  log what you did — 16, the total — and the app shows the split, "8 per side", so the set in
  front of you is unambiguous without the rep count meaning one thing here and another there.
  The target steps in twos, 16 → 18 → 20, because half of an odd total is a rep one side never
  gets. (#31)
- Both settings travel with a shared plan, and are written to a plan file only when they
  disagree with the catalogue — every existing plan, workout and backup is read unchanged and
  none of it needs migrating.
- Translated into all 12 UI languages.

### Fixed

- **Creating a profile from Settings on an invite-only instance.** The sign-in screen asks for
  the invite code when the server needs one; the same registration reached from Settings never
  did, so it was refused with nothing on screen explaining why. It now asks on the same terms.
- **A long value no longer runs through its own label** in a settings row — "Follow the routine
  (Linear progression)" overlapped "Rule" rather than shortening itself.

## v1.2.3 — 2026-07-31

How hard a set was, in whichever of the two scales you already think in — and the ratings your
old app recorded come across with the rest of your history. Plus: the phone stops locking itself
mid-workout, the rest timer can hand time back as well as take it, and Settings is grouped by
what each thing actually affects.

### The screen stays on while you train

- ☀️ **Keep screen awake — Settings → *During a workout*, on by default.** Locking, unlocking
  and finding your place again between every set was the single most annoying thing about
  logging on a phone. The screen now stays lit for as long as a workout is running and lets go
  the moment you finish it, so nothing is held while you are not training.
- **It survives a tab switch.** Browsers release the lock whenever the page stops being visible,
  which is exactly what happens when you glance at a message. The lock is taken again each time
  the app comes back, rather than dying the first time you look away.
- **It follows the workout, not the screen you are on.** Checking Stats mid-session keeps the
  screen awake.
- **Where it isn't available, it says so.** iOS grants no wake lock in Low Power Mode, and older
  browsers have no Wake Lock API at all — the first is silent, the second shows the row disabled
  rather than offering a switch that does nothing. Needs HTTPS, like every other modern browser
  capability.

### Rest timer: take 15 seconds off, too

- ⏳ **A −15s button next to +15s.** The timer could only ever be extended or skipped outright;
  now it goes both ways. Taking off more than is left finishes the rest rather than counting
  into the negative — the same thing Skip does.
- **Rearranged so three controls fit.** The clock and the progress bar take the top row and the
  controls sit underneath: −15 and +15 together in number-line order, Skip pushed to the far
  edge so the button that ends the rest is not next to the one you tap to buy more time. On a
  wide screen it stays on one line. Tap targets are bigger than they were.
- **The bar is nearly opaque.** The set rows underneath were reading through it and making the
  clock hard to pick out.

### Settings, grouped by what it affects

- **General** (language, units) · **During a workout** (rest timer, keep screen awake, sounds,
  effort per set) · **Notifications** · **Appearance** (theme, body diagram, accent) · **Data**.
- The old grouping mixed axes: "Units & timer" put a display preference next to two workout
  behaviours, language sat under Appearance, and *Load starter plan* was buried between the
  backup actions and the destructive reset. Data now reads in the order you would use it — fill
  the plan, bring history over from another app, restore a backup, export one, wipe everything.
- Nothing was removed and no setting changed its meaning.

### Effort per set: RIR or RPE (#21)

- 🎯 **A third column on a working set, off by default.** Settings → *Effort per set* switches
  it between **Off**, **RIR** and **RPE**. It only appears on weighted rep sets: a plank or a
  treadmill row has nowhere to put it.
- **Two names for the same judgement.** RIR counts the reps you left in the tank; RPE reads the
  same effort off a 10-point scale, so RPE ≈ 10 − RIR. The setting has an (i) that lays the two
  scales side by side in a conversion table rather than explaining them in a paragraph.
- **Each set keeps the scale it was logged with.** Switching the setting changes what new sets
  ask for and nothing else — history is never silently rewritten, and a set logged as RIR 2
  still reads back as RIR 2 years later.
- **An unrated set stays unrated.** Blank and 0 are different things: RIR 0 says the set went to
  failure. So `−` on an untouched cell leaves it empty, `+` starts at the bottom of the scale
  and walks up in even steps, and stepping back off the bottom clears the cell again — a mistap
  is always undoable.
- **Nothing else reads the value.** Progression rules and estimated 1RM are unaffected; the
  rating is yours to look at, not an input to the maths.
- Upgrading keeps the column you had: a profile still carrying the old `showRir` flag — from
  this device, a sync, or a backup restored later — comes across as RIR.

### Import brings your ratings with it

- 📥 **The RPE Hevy and Strong export is no longer dropped.** An `RPE` column is read into the
  set, as is an `RIR` column if a file has one, and the import summary says how many sets
  arrived with a rating — plus where to switch the column on if it's off.
- A blank cell stays unrated rather than becoming 0. A written-out `0` counts as a rating on the
  RIR scale (a set to failure) but not on RPE, which starts at 1 — apps write 0 there to mean
  "nothing here", and reading it as an effort would stamp one on every unrated set in the file.
- Ratings above the scale are capped instead of thrown away, and junk in the column is ignored
  without losing the set.
- Backups already carried both fields and the setting, since a backup is the whole state — there
  are now tests pinning that, so it can't quietly stop being true.

## v1.2.2 — 2026-07-25

Training that moves on its own: an exercise can now be logged by time instead of reps, the
next weight follows a progression rule you choose rather than a single hard-coded hint, and
every lift carries an estimated 1RM. Plus a standalone mobile app, a shareable plan, and an
importer for your history from other apps.

### Timed sets and a timer for the set itself (#16)

- ⏱️ **Reps or time, per exercise.** Planks, hangs, wall sits, dead hangs and loaded
  carries no longer have to be filed under cardio to be timed. Each exercise in a routine
  picks its own mode, and a timed set can still carry weight for a weighted plank or a
  farmer's walk.
- ▶️ **A work timer, separate from the rest timer.** Start a timed set and it counts the
  hold down, beeping and buzzing at zero exactly as the rest timer does, then checks the
  set off itself. The two timers can never run at once — they mean opposite things.
- Finishing a hold early logs **the time you actually held**, not the target. A 38-second
  hold against a 45-second target is recorded as 38 seconds.
- The mode travels everywhere it should: routine editor, workout, history, exercise
  statistics (timed exercises chart their longest hold), the printable plan and the shared
  plan file.
- Plans made before this release are read exactly as they always were — nothing to migrate.

### Progression rules you can read (#17)

- 📈 **Pick a rule per routine, override it per exercise.** Linear progression, **Greyskull
  LP** (two straight sets plus an AMRAP final set, with double jumps and a 10 % reset),
  double progression through a rep range, or adding time for timed work. Or none at all.
- 🧾 **Every target explains itself.** "Every rep last time — 2.5 kg more." "Missed reps
  3 sessions running — reset to 55 kg and work back up." The rule is visible before you
  train, not after.
- The session opens with the right weights already in the rows, instead of suggesting them
  once you are standing at the bar.
- 🚫 **A bad session can't look like a good one.** Short reps count as a miss even when you
  checked the set off; a set you never checked counts as a miss because you did not do it.
  Nothing advances the load on a session that fell apart.
- Stalls and deloads are worked out from your log every time they are needed. Nothing is
  written back into a finished workout and no counters are stored, so fixing a mistyped set
  immediately produces the right next target.
- Lower-body lifts step up in larger jumps than upper-body ones by default, and any
  exercise can set its own step.
- Bodyweight exercises progress in **reps**, because there is no load to add to a push-up
  and no load to take off it either.

### Estimated 1RM (#18)

- 💪 **An estimated one-rep max for every lift**, in the exercise progress card (with its
  own curve you can switch to) and in the exercise detail sheet.
- It always names the set it came from — "from 90 kg × 5 on 15 Jul" — because an estimate
  off a heavy triple and one off a set of ten are very different claims.
- 🧮 **A calculator** for a set you have not done yet, so the number is reachable before
  there is any history.
- Epley by default, and it **refuses to guess above 12 reps**, where the common formulas
  disagree by double digits.
- A new best estimate is reported at the end of a workout separately from a weight PR —
  same weight for more reps is real progress, but it is not a heavier lift.

### Share a plan

- 📤 **Send someone your plan.** Plan → *Share your plan* writes a small file with your
  routines, the week schedule and any custom exercises they use — and nothing else. No
  workouts, no weigh-ins, no settings.
- Importing **merges**: shared routines arrive as new ones with fresh ids, custom exercises
  are matched by name so they are not duplicated, and your own plan is never overwritten.
  Taking the week schedule with it is optional.
- 🖨️ **A printable plan** (Save as PDF) laid out so a single exercise never breaks across
  a page.

### Fixes

- A shared plan file naming an exercise this build doesn't have can no longer take the app
  down. Unknown ids are dropped on import, anything that slips through renders as a
  placeholder you can delete, and an error boundary around the screens means a bad state is
  recoverable by switching tabs instead of reloading.
- Importing from another app converts weights **per row**, not per file. FitNotes writes the
  unit on each set, so a mixed export used to land 185 lb as 185 kg.
- Numbers follow the UI language instead of a hardcoded locale, which was putting Swiss
  apostrophes ("7'535 kg") in front of everyone. Volume stays in your own unit rather than
  switching to tonnes, which was wrong for pound profiles.
- Taking over a week schedule from a shared plan now really replaces Monday–Sunday instead
  of only the days the shared file happened to fill.
- The body-weight slider's ceiling follows your unit (300 kg / 660 lb).
- "Best: 85 Kg" is capitalised correctly again.

### One codebase, two flavors

openGym is also a standalone mobile app — and it ships as a direct APK download, not
through app stores.

- 📱 **Standalone mobile app.** The same frontend now also builds as a native iPhone /
  Android app (Capacitor) — the install-and-done flavor of openGym: no account, no server,
  no sync. Everything stays on the phone.
  - State is mirrored into a file in the app's private storage on every change, so your
    log survives even when the OS evicts WebView storage (iOS does).
  - The workout-day reminder becomes a **native notification** scheduled on the weekdays
    your plan actually has a routine — no push server involved.
  - Backups go out through the OS **share sheet** (Files, AirDrop, mail…).
  - Exercise images/animations load from the same CDN as the live demo.
  - `npm run build:mobile`, then open `android/` in Android Studio or `ios/` in Xcode —
    see **docs/MOBILE.md**. `NOTICE.md` now carries an AGPL §7 app-store exception.
- 🤖 **Android APK, no Play Store.** The official build is a signed, sideloadable APK
  (~4.5 MB) from [opengym.duarte-santos.ch](https://opengym.duarte-santos.ch) — deliberately
  store-free. docs/MOBILE.md covers building and signing your own.
- 🍎 **iOS reality check.** Apple permits no installs outside the App Store, so there is no
  iOS download; the docs explain the free options (self-hosted PWA on the home screen, or
  running the native app onto your own iPhone from Xcode).

- 📥 **Import your history from another app.** Settings → Data → *Import from another app*
  reads an export from **FitNotes** (both the Android and the FitNotes 2 iOS format),
  **Strong** and **Hevy**, and pulls body-weight history out of an **Apple Health** export.
  Anything else with a date, an exercise name and weight/reps columns is read too.
  - Every row becomes a set, grouped into workouts by date, so your history arrives with
    its real dates rather than as one lump. Hevy and Strong also carry session length, so
    the activity heatmap fills in properly.
  - Exercise names are matched against the 1,324-exercise library — parenthetical
    qualifiers like "(Barbell)" and shorthand like BB/DB are normalised, and a curated
    table covers the plain names people actually log ("Bench Press", "Squat", "RDL").
    Where a name is genuinely ambiguous it is *not* guessed at: it becomes one of your own
    exercises instead, because filing years of training under the wrong lift is worse than
    an unmatched name you can see and fix.
  - A summary shows what will happen — workouts, sets, how many exercises matched, which
    ones didn't, and whether weights need converting — before anything is written.
  - Importing is idempotent: days you already have data for are left alone, so running it
    twice, or importing from two apps, never duplicates a workout.

## v1.2.1 — 2026-07-23

A muscle map across the app, and a live demo you can try without installing anything.

- 💪 **Muscle map.** Three places now show which muscles your training actually reaches, drawn on a
  front-and-back body diagram shaded like the activity heatmap — more accent means more work.
  - **Stats → Muscle balance** aggregates a week, 30 days, 90 days or everything, lists your
    hardest-worked muscles with their set counts, and names the ones that got *nothing* in that
    period. That last list is the point of the card: the gaps are what you'd otherwise never notice.
    Tap any muscle to read its name and volume.
  - **Routine editor** previews what a session hits as you build it, so a hole in the plan shows up
    before you train around it for a month.
  - **The finish screen** shows what you just trained.
  - Load is counted in *effective sets* — a set counts fully for the exercise's target muscle and
    partially for its supporting ones — not in kilograms, because 100 kg of leg press and 12 kg of
    lateral raise say nothing about which muscle worked harder. Shading is relative within the
    period you're looking at, so the map always reads as a balance rather than an absolute.
  - Settings → Appearance → **Body diagram** switches between a male and female figure.
  - The exercise dataset spells muscles inconsistently ("delts", "deltoids" and "shoulders" are one
    muscle); all 50 spellings it uses are normalised onto the 18 the diagram can draw. Custom
    exercises, which only carry a body part, fall back to it. The geometry is ~90 kB and loads on
    demand, so the initial bundle is unchanged.
- 🐛 **Fixed: finishing a workout from its last exercise could blank the whole app.** The
  per-exercise weight sheet read the running workout without checking it was still there, and
  finishing clears it while that sheet is still on screen.
- ▶️ **Live demo** at [duartesantos8.github.io/openGym](https://duartesantos8.github.io/openGym/) —
  a browser-only build (`VITE_DEMO=1`) published to GitHub Pages on every push to `main`. It boots
  into guest mode with a seeded example profile (12 weeks of Push/Pull/Legs, weigh-ins, PRs) so
  every screen has something to show, and it never talks to a server. Passkeys, sync and the admin
  dashboard stay exclusive to self-hosted instances, which is where the backend lives.
- 🖼️ Builds can point the exercise media elsewhere via `VITE_IMG_BASE` / `VITE_GIF_BASE` — the demo
  serves the ~140 MB dataset from a CDN instead of shipping it. The default (`img/` and `gif/` next
  to the app) is unchanged.

## v1.2.0 — 2026-07-23

A complete visual redesign. Same app, same data — every screen redrawn.

### A designed interface, not an assembled one

- 🎨 **Rebuilt design system.** One type scale carrying hierarchy through size instead of making
  everything bold, a neutral surface ramp instead of saturated blue-greys, hairline separators
  instead of outlined boxes, and motion that acknowledges a press rather than animating for
  decoration. Light and dark are both first-class, and the eight accent colours now pick their
  label colour by measured contrast — the default green in light mode was failing WCAG AA on
  every primary button before.
- ✏️ **A hand-drawn icon set** (77 icons, single stroke weight, drawn on one 24×24 grid) replaces
  every emoji in the interface. Emoji render differently on each platform, sit on their own
  baseline and can't take a theme colour, which is what made the old UI feel stitched together.
  Icons inherit the surrounding text colour and optical size.
- 🏋️ **Routine icons.** Picking an icon for a routine now offers a grouped set — strength,
  equipment, cardio, recovery — instead of an emoji keyboard. Routines you already made keep
  their look: the old emoji are mapped forward automatically, so nothing to migrate and nothing
  to redo.
- ▶️ **New tab bar** with a raised Start button that turns into a pulsing orange Resume while a
  workout is running.
- 🏠 **Home reads as a plan for today** — week strip, today's session as one tappable row, body
  weight, and your streak.

### Charts

- 📈 **Axis labels, gridlines and the target-weight line are visible again** in dark mode. They
  were painted with colour variables that no longer existed, which silently fell back to black
  on black — and to no stroke at all for the lines.
- 💬 **The hover readout stays on screen.** It used to be positioned with a fixed offset that
  assumed one label width, so the first and last point pushed it under the chart's clip; it's now
  placed from its measured size and kept inside the frame, dropping below the point when the
  point sits high enough that the label would cover the value it reports.
- 🖱️ **It also goes away again** — moving off the chart now clears the readout, crosshair and
  marker, which previously stayed until you hovered somewhere else.

## v1.1.3 — 2026-07-22

Admin dashboard for self-hosters (opt-in — off by default), equipment filtering, and
workout-screen fixes.

### Admin dashboard

- 🛠️ **Admin dashboard** (Settings → Admin dashboard) for whoever runs the instance: a users
  overview with workout counts and last-active times, plus a per-user drill-down into their full
  workout history and body-weight log.
- 🟢 **Live "training now"** — see who's mid-workout in real time, with their current exercise and
  set progress, updated by a lightweight heartbeat while a workout is on screen.
- 🚫 **Disable / enable accounts** — a disabled account is signed out and locked out everywhere
  until you re-enable it.
- 🔑 **Invite-only signup** (optional) — require an invite code to create a profile; generate and
  revoke codes from the dashboard. Existing accounts are unaffected.
- ⚙️ Configured via environment: `ADMIN_UIDS` (comma-separated user ids who are admins) and
  `INVITE_ONLY=1`; both default off, so a fresh instance stays open with no admin. See
  `.env.example`. Admin access is gated by your passkey and enforced server-side.

### Exercises & workout

- 🏋️ **Filter exercises by equipment** (#6). A second filter row under the body parts lets you
  narrow the list to what you actually have — body weight, dumbbell, barbell, cable, band, and so
  on — in both the Exercises library and the exercise picker. The options adapt to what you've
  already selected and are ordered by how many exercises use them, so every combination on screen
  has results behind it and the row stays short. Building a bodyweight-only plan is now two taps
  per body part.
- 🔎 **Minimize the exercise animation during a workout** (#12). A ⤡ Minimize / ⤢ Expand button
  on the animation shrinks it to a thin strip so the set rows sit right under your thumb — no more
  scrolling past a big GIF to tick off a set. Your choice is remembered and applied to every
  exercise and future workout until you change it, so you set it once. Tapping the animation still
  pauses/plays it as before.
- ⏱️ **Fixed: the rest timer froze at 0:01** (#14) instead of counting down to the end. It also
  meant the timer could only be cleared with Skip, and a redundant "rest over" push notification
  could still fire.

## v1.1.2 — 2026-07-22

Custom exercises, full localization, and input fixes.

### Custom exercises (#11)

- ✨ **Create your own exercise** from the exercise picker or the Exercises tab: a name and a
  body part is all it takes. Your search text is pre-filled as the name, so "no match" flows
  straight into "create it".
- 📝 **Optional description** — setup, cues, anything you want to remember. It shows on the
  exercise's detail and config sheets (where a built-in exercise would show its animation),
  and it's searchable, so you can find your own exercises by their cues too.
- 🏋️ Custom exercises behave like built-in ones everywhere — routines, supersets, workout
  logging, weight suggestions, PRs, stats and history. The animation stays blank by design.
- 🏃 Pick the *cardio* body part and it logs time + speed instead of weight × reps, like the
  built-in cardio exercises.
- ✏️ Edit (rename, change body part or description) or delete your custom exercises — from
  their detail sheet in the Exercises tab, or straight from the exercise inside a routine via
  "Edit or delete this exercise". Deleting removes them from your routines; already-logged
  workouts keep their sets and still show the exercise name. (The routine sheet's old "Remove
  exercise" button is now labelled "Remove from routine", so the two are no longer confusable.)

### Localization (#7)

- 🌍 **12 UI languages**: English, Deutsch, Español, Français, Italiano, Português, Polski,
  Türkçe, Русский, 中文, 한국어, हिन्दी. Pick yours under Settings → Appearance → Language;
  the choice syncs with your profile like the theme does.
- 📖 **Localized exercise instructions** for 10 of those languages (all except German and
  Portuguese, which the upstream dataset doesn't cover yet — those fall back to English),
  covering all 1,324 exercises. Body-part filters, equipment and muscle tags are translated
  too; exercise *names* stay English (upstream limitation). Custom exercises are translated too.
- 📅 Dates, weekday and month labels follow the selected language.
- ⚡ Zero cost when unused: the app still ships English-only by default. Each UI language is a
  ~7 kB chunk and each instruction pack ~80–120 kB (gzipped), downloaded only when you switch —
  the initial bundle size is unchanged.
- 🛠️ New `scripts/build-instructions.mjs` regenerates the instruction packs from the upstream
  dataset; translations live in `frontend/src/locales/` (PRs welcome — it's one flat
  English-string → translation map per language).
- Known gaps: push notification texts (sent by the server) and plural forms in some languages
  are approximated; happy to take corrections from native speakers.

### Fixes

- ⌨️ Weight and other numeric fields now accept a comma as decimal separator ("33,5") — iOS
  decimal keyboards in many locales only offer a comma, which previously reset the field to 0.
  Partial input like "33," no longer snaps to 0 while typing. (#13)
- 📱 Fixed the exercise-config sheet (Sets / Reps / Weight, and the cardio variant) overflowing the
  screen edge on narrow phones — the Weight stepper was clipped and could make the whole page pan
  sideways in iOS Safari. Steppers now shrink to fit the viewport. (#10)
- 🛡️ Added a global horizontal-overflow guard so a single too-wide element can no longer knock the
  page layout off-scale.

## v1.1.1 — 2026-07-21

Reliability fixes for the push notifications shipped in v1.1.0, found through live testing:

- 🌍 Workout day reminder now fires by each user's own browser-detected timezone instead of a
  single server-wide one — works correctly regardless of where the server runs, and follows you
  automatically if you travel.
- 💾 Settings changes (like the reminder time) are flushed to the server immediately when the tab
  backgrounds or closes, instead of relying solely on a 1.5s debounce that could get cut short.
- ⏱️ Reminder check tightened from a 60s to a 10s interval, and pushes are now marked
  `urgency: 'high'` — cuts avoidable delay on top of it, though delivery time is ultimately up to
  Apple/Google's push relay.
- 🪵 Push send failures are now logged instead of silently swallowed.

## v1.1.0 — 2026-07-21

- 🐳 Prebuilt Docker images published to `ghcr.io/duartesantos8/opengym-{api,web}` (amd64 + arm64)
  via GitHub Actions, so self-hosting no longer requires building from source. `docker compose pull`
  grabs them; `docker compose up -d --build` still builds locally if you'd rather.
- 🔔 Push notifications: rest-timer-over alert (fires even if the app is closed) and an optional
  daily reminder on days you have a workout planned but haven't logged one yet. Opt in per-profile
  in Settings — requires a signed-in passkey profile. Backend gains one dependency (`web-push`);
  VAPID keys are generated on first run.
- 🐛 Fixed the rest timer stalling when the tab/app is backgrounded — it's now anchored to a real
  timestamp instead of a plain per-second counter, so it stays accurate after you come back.

## v1.0.0 — 2026-07-20

First public release. A complete, self-hostable gym & body-weight tracker.

**Highlights**
- ⚖️ Body-weight tracking with an interactive chart + goal line
- 🏋️ Weekly routine planner over 1,324 exercises with animated demos
- ▶️ Guided workouts: body-weight check-in, pre-filled weights, rest timer, PR detection, per-exercise weight tracking
- 🔗 Supersets and 🏃 cardio (time + speed) logging
- 🗓️ Per-day rescheduling without touching your weekly plan
- 🟩 GitHub-style activity heatmap (by time trained)
- 🔑 Passkey (WebAuthn) login with per-profile data that syncs across devices
- 🎨 Light/dark themes + 8 accent colors, synced to your profile
- 📦 JSON export/import, guest mode, PWA install, no telemetry

**Stack**
- React 19 + Vite (React Router, Zustand)
- Node backend, no framework, single dependency (`@simplewebauthn/server`), JSON-file storage
- nginx + multi-stage Docker so `docker compose up` builds and serves everything

**Notes**
- Exercise media (~140 MB) is fetched from [hasaneyldrm/exercises-dataset](https://github.com/hasaneyldrm/exercises-dataset) on first run.
- Licensed under GNU AGPL v3.0.

## 1.0.6 — Redis container in compose

### Added
- `redis` service in `docker-compose.yml` (redis:7-alpine, named volume `redisdata`,
  AOF on, `maxmemory 128mb` + `allkeys-lru`) — reserved backend for sessions,
  cache and rate-limit. Container healthchecked; the api adopts it via `REDIS_URL`
  incrementally, so the stack is prod-ready even before that wiring.

### Changed
- Comment on `media`: clarified that exercise media is already committed in the
  repo, so a dead upstream dataset cannot break a fresh deploy.

## 1.0.6 — единая семвер-версионность и выпуск в прод

### Added
- `scripts/release.sh` — единственная точка прод-релиза: авто-бамп версии
  (или явный semver), build+тесты, синхронная правка `frontend/package.json`,
  `api/package.json`, блок `CHANGELOG.md`, тег `vX.Y.Z`, вливание в `main` и push.
  В `main` код попадает только этим путём.
- `VERSIONING.md` — политика: один источник истины (git-tag), правила
  patch/minor/major, схема веток dev→main, релизный цикл.

### Notes
- Устранено расхождение старых шкал: CHANGELOG был `1.10.x`, package.json — `1.2.x`.
  Теперь одна семвер-шкала; прод `impulse.trfnv.ru` стартует с `v1.0.0`.
- Redis-контейнер из предыдущего шага включён в тот же деплой-комплект.

## 1.2.6 — автотесты api (unit + интеграционные) + тестовая документация

### Added
- `api/logic.js` — чистая бизнес-логика, извлечённая из `server.js` (без побочных
  эффектов). `server.js` теперь импортирует её — единый код, не копия.
- `api/logic.test.js` — 33 unit-теста (node:test): валидация расписания, переходы
  статусов брони, разрывной график `daySlots`, `effectiveRoutineId`, вебхук-нормализация.
- `api/admin-db.test.js` — 8 интеграционных тестов слоя БД против реального postgres:
  лояльность (начисление/идемпотентность), брони/конфликты, инвайты, назначение
  тренера. Без `DATABASE_URL` скипаются (изоляция: уникальные id + подчистка).
- `npm test` в api (node:test logic + admin-db); CI (`ci.yml`) теперь поднимает
  postgres-сервис и гоняет api-тесты + frontend (vitest 192) + build.
- `TESTING.md` — карта тестов, архитектура (logic.js/server.js/admin-db), как
  запускать локально и в CI, подводные камни. README получил раздел Docs.

### Changed
- Итог по тестам: **192 фронт + 41 api = 233** (из них 8 требуют postgres).
  Раньше бэкенд не был покрыт автотестами вообще.

### Verified
- `node --test logic.test.js admin-db.test.js` с поднятым postgres:16 → **41/41 passed**.
- Старт api без БД не сломан: `/api/health` → `{"ok":true}`.
- 3 первичных fейла юнит-тестов были ошибками в тест-кейсах (не в коде) —
  исправлены; пограничное поведение `nextHour('23:45')='24:00'` задокументировано.

## 1.2.8 — демо-данные лояльности для презентации

### Added
- `scripts/seed-loyalty-demo.sh` — воспроизводимый сидер: 3 спортсмена
  (Artem — активный лоялист, Maxim — новичок с реферальным бонусом,
  Testuser1 — угасший), правила (visit/workout/streak/referral), награды
  (скидка/футболка/персональная тренировка) и события через честный
  API-вебхук с уведомлениями. Идемпотентен.
- `docs/demo-loyalty.md` — сценарий презентации: персонажи, механика, где смотреть в UI.
- Новый спортсмен Maxim привязан к тренеру Андрею (3 подопечных).

### Note
- Демо-данные живут в БД дев-стенда (gym.trfnv.ru), не в проде.
