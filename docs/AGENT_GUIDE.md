# AGENT GUIDE — карта всей системы «ИмпульС» (openGym fork)

> **Для следующих агентов и разработчиков.** Это главный документ проекта:
> здесь собрана **вся** работа, сделанная в сессии v1.2.7 → v1.2.53 (сентябрь
> 2026) — роли, поверхности, код, БД, механики и инфраструктура. Специализированные
> доки (`docs/*.md`, см. «Карта доков») раскрывают детали по одной теме; этот файл —
> чтобы понять систему целиком и найти, где что лежит.
>
> Свежие версии и детали каждого релиза — в [CHANGELOG.md](../CHANGELOG.md).

---

## 0. Что это за продукт

**«ИмпульС» / impulseGym** — PWA-экосистема сети фитнес-клубов на базе форка
`openGym`. Поверх оригинального персонального трекера (спортсмен + тренировки +
passkey) форк достраивает **сетевой слой бизнеса**: роли, филиалы, лояльность,
тренеров, аналитику, удержание, продажи (тарифы/заявки) и демо-витрину.

Три поверхности с единым стилем и одним SPA-бандлом:

| Поверхность | URL | Кто | Код |
|---|---|---|---|
| Приложение спортсмена | `/` (PWA) | атлеты клуба, гости, приватный режим | `frontend/src/App.jsx`, `views/*` |
| Панель управления | `/admin` | owner / manager / operator (и тренер-админ) | `views/AdminApp.jsx`, `views/Analytics.jsx`, `views/Retention.jsx` |
| Тренерский портал | `/trainer` | тренер (свои атлеты, расписание, программы) | `views/Trainer.jsx`, `TrainerBookings.jsx`, `TrainerProgram.jsx` |
| Приватный режим | `/private` | гость (локально, по коду) | `views/Private.jsx` |
| Маркетинг | `/promo`, `/promo4gym.html`, `/pricing` | любые посетители | `frontend/public/promo*`, `pricing.html` |
| Демо-клуб | `demo.gym.trfnv.ru` | потенциальные клиенты | см. `docs/demo-club.md` |

---

## 1. Карта доков (читай в этом порядке)

| Документ | О чём |
|---|---|
| **`AGENT_GUIDE.md` (этот)** | вся система целиком: роли, код, БД, механики, деплой |
| `docs/demo-club.md` | демо-клуб demo.gym.trfnv.ru: клон на сессию, антибот, TTL-очистка, Ф0–Ф6 |
| `docs/demo-branch.md` | ветка `demo`, политика «только стабильные релизы», deploy-demo.sh |
| `docs/demo-loyalty.md` | демо-сценарий лояльности для презентаций (Artem/Maxim/Testuser1) |
| `docs/analytics-metrics.md` | **почему** история в JSON-файлах, а агрегаты в PostgreSQL (`athlete_metrics`) |
| `docs/MOBILE.md` | нативная сборка (Capacitor), iOS/Android |
| `docs/SELF_HOSTING.md` | разворачивание для себя, HTTPS/passkey |
| `TESTING.md` | карта тестов и как их гонять |
| `VERSIONING.md` | семвер, ветки dev/main, release-скрипт |
| `DEPLOY.md` | разворачивание на новой VPS |
| `DEPLOYMENT.md` | **устаревающая** «dev branch notes»: ранние фичи сессии (пуши, бейджи, инструкции, имперсонация). Актуальные механики описаны ниже и в CHANGELOG — сверяйся с ними |
| `CHANGELOG.md` | журнал версий v1.2.7 … v1.2.53 (вся сессия) |

---

## 2. Роли и права

Роли живут в таблице `admin_users` (`role`). Атлеты — отдельная сущность
(`users` + `state-{uid}.json`), тренер/атлет связываются через `trainer_assignments`.

| Роль | Права | Поверхность |
|---|---|---|
| **owner** | всё: сотрудники, филиалы, аналитика всей сети, «войти как», приватные коды, удаление | `/admin` |
| **manager** | свой филиал: сотрудники (кроме owner-действий), лояльность, заявки | `/admin` (скоуп по `branch_key`) |
| **trainer** | свои атлеты: программы, расписание/брони, заявки на запись | `/trainer` |
| **operator** | чтение аналитики | `/admin` (read-only) |
| **athlete** | своё приложение: тренировки, цели, баллы/награды, запись к тренеру | `/` |

- **Имперсонация** («войти как»): только owner, через
  `POST /api/admin/impersonate` (+`/back`). Баннер «Вы смотрите от имени …».
  В демо — механизм переключения ролей витрины.
- **Демо-скоуп**: под `DEMO_MODE=1` владелец видит ТОЛЬКО свой `demo_session`
  (`api/demo-scope.js`), чужие клоны не видны вообще (см. `docs/demo-club.md`).

---

## 3. Где что лежит (карта кода)

### Backend — `api/`

| Файл | Роль |
|---|---|
| `server.js` | монолит: HTTP, сессии (куки), WebAuthn-регистрация/вход, файловое хранилище `data/`, push/VAPID, **корневые эндпоинты** (`/api/config|data|me|login|register|push/*|private/unlock|activity`), сборка роутов из модулей, демо-cleaner, retention-runner |
| `routes/admin.js` | админ-панель: auth, сотрудники, филиалы, приватные коды, аналитика, удержание, программы тренера |
| `routes/trainer.js` | тренерский портал: расписание, брони, мои атлеты |
| `routes/loyalty.js` | кошелёк/награды атлета + CRUD правил/наград админа |
| `routes/webhook.js` | внешние интеграции СКУД/турникет: `/api/integrations/*` |
| `routes/leads.js` | маркетинг: заявки с сайта, СБП-QR |
| `routes/notifications.js` | центр уведомлений (атлет + админ), бейдж |
| `routes/demo.js` | демо-клуб: token/enter/end (только `DEMO_MODE=1`) |
| `logic.js` | чистая бизнес-логика без I/O (валидация слотов, переходы брони, вебхук-парсинг, метрики) — импортируется server.js |
| `admin-db.js` | **вся** PostgreSQL-обвязка: таблицы/миграции/функции (лояльность, брони, расписание, метрики, демо, уведомления) |
| `access-db.js` | PostgreSQL интеграций СКУД: `access_events`, `visits`, `external_member_bindings` |
| `metrics.js` | расчёт агрегатов тренировок (volume и пр.) |
| `retention.js` | модель удержания (active/at_risk/gone) |
| `retention-runner.js` | ночной пересчёт снапшота удержания (04:00, `RETENTION_RUN_HOUR`) + алерты тренерам при ухудшении |
| `demo-club.js` | спавн/уничтожение изолированного демо-клона (филиал+владелец+тренер+3 атлета) |
| `demo-seed.js` | генератор состояний демо-персон (регулярный/средний/ушедший) |
| `demo-scope.js` | скоуп-хелперы демо-изоляции |
| `email.js` | email-уведомления владельцу о заявках (Resend) |

**Хранилища (важно!):**
- `data/state-{uid}.json` — **источник правды** спортсмена (workouts, bodyweight,
  routines, цели, unit, lang). `GET/PUT /api/data` — 1 файл на пользователя.
- `data/db.json` — профили `users` (id, name, admin-флаг, demo_session, …),
  creds, subs (push-подписки), invites. **В памяти сервера**, атомарно пишется.
- `data/retention-snapshot.json` — ночной снапшот удержания.
- `data/secret`, `data/vapid.json` — ключи сессий и Web-Push.
- **PostgreSQL** (`admin-db.js` + `access-db.js`) — бизнес-слой сети:
  лояльность, расписание, брони, метрики, уведомления, демо-токены, лиды.
- **Redis** — зарезервирован под кэш/рейт-лимиты/сессии (`REDIS_URL`), в стеке
  есть, код подключает постепенно.

### Frontend — `frontend/src/`

| Путь | Роль |
|---|---|
| `App.jsx` | роутер: `/home /plan /plan/r/:id /workout /stats /history /library /settings /notifications`; `/private` до входа; `/admin*`, `/trainer*` → `AdminApp` |
| `views/AdminApp.jsx` | каркас панели: роль-гейты, вкладки `overview/loyalty/rewards/staff/branches/invites/leads/private`, хедер с уведомлениями/аналитикой |
| `views/Trainer.jsx` | тренерский портал: вкладки Спортсмены/Календарь, invite/поиск атлетов |
| `views/TrainerBookings.jsx` | календарь тренера: часы работы (разрывной график!), заявки, брони, постоянные клиенты |
| `views/TrainerProgram.jsx` | просмотр/редактирование программ атлета |
| `views/Analytics.jsx` | аналитика: KPI, список атлетов, деталь спортсмена, лидерборд |
| `views/Retention.jsx` | вкладка «Удержание» (снапшот, уровни риска) |
| `views/AdminLeads.jsx` | заявки с маркетинга (колокольчик, ответы) |
| `views/Notifications.jsx` / `TrainerNotifications.jsx` | центры уведомлений |
| `views/Login.jsx` / `Private.jsx` | вход (passkey / invite / демо-кнопка) и приватный режим |
| `components/NavBar.jsx` | **единый адаптивный NavBar** для всех ролей (мобайл — нижний бар, десктоп — пилюля, центр-кнопка «Старт») |
| `components/GoalPoster.jsx` | вирусный постер достижения цели |
| `components/LoyaltyHelp.jsx`, `ProgressionInfo.jsx`, `TrainerHelp.jsx` | встроенные инструкции |
| `lib/i18n.js`, `locales/*.js` | переводы; `exName` — локализованные имена упражнений |
| `lib/demoSeed.js` | (клиентский) генератор демо-истории — зеркало `api/demo-seed.js` |
| `public/promo*.html`, `pricing.html` | маркетинговые страницы (статические, отдельные от SPA) |

---

## 4. Эндпоинты API (карта)

### Корневые (`server.js`)
`GET /api/config` · `GET /api/health` · `GET /api/me` · `GET/PUT /api/data` ·
`POST /api/register/options|verify` · `POST /api/login/options|verify` ·
`POST /api/logout(|/all)` · `POST /api/private/unlock` ·
`POST /api/activity` · push: `GET /api/push/public-key|health` ·
`POST /api/push/subscribe|unsubscribe|test|rest-timer(|/cancel)`

### Админ (`routes/admin.js`)
auth: `auth/options|verify|me|logout` · `staff/register/options|verify` ·
impersonation: `impersonate`, `impersonate/back` ·
сотрудники: `staff`, `staff/invite`, `staff/update`, `staff/delete`, `staff/restore` ·
филиалы: `branches`, `branches/save`, `branches/delete` ·
приватные коды: `private-codes`, `private-codes/new`, `private-codes/revoke` ·
атлеты: `users`, `user`, `user/disable`, `user/delete`, `user/restore` ·
аналитика: `analytics/overview|athletes|athlete|leaderboard|trainers|retention|assign|users` ·
программы: `trainer/athlete/program` · брони админа: `trainer/bookings(|/status)`, `trainer/availability` ·
пуши: `push/status`, `push/status/reset`

### Тренер (`routes/trainer.js`)
`GET /api/trainer/me` · `POST /api/trainer/availability` (разрывной график) ·
`POST /api/trainer/book` · `GET /api/trainer/my-bookings` · `POST /api/trainer/bookings/cancel`

### Лояльность (`routes/loyalty.js`)
атлет: `GET /api/loyalty/wallet` · `GET /api/loyalty/rewards` · `POST /api/loyalty/redeem` ·
админ: `admin/loyalty/rewards(|/save|/delete)`, `admin/loyalty/redemptions(|/update)`,
`admin/loyalty/rules(|/save|/delete)`

### Уведомления (`routes/notifications.js`)
`GET /api/notifications` · `POST /api/notifications/read` · `POST /api/badge/seen` ·
админ-версии: `admin/notifications`, `admin/notifications/read`

### Вебхуки (`routes/webhook.js`)
`POST /api/integrations/loyalty/events` · `POST /api/integrations/access/events`
(идентичны по секрету `*_WEBHOOK_SECRET`)

### Маркетинг (`routes/leads.js`)
`POST /api/lead` · `GET /api/sbp-qr` · админ: `admin/leads`, `admin/leads/viewed`, `admin/sbp-qr`

### Демо (`routes/demo.js`, только `DEMO_MODE=1`)
`POST /api/demo/token` (антибот, IP-лимит) · `POST /api/demo/enter` (клон+сессия) ·
`POST /api/demo/end`

---

## 5. База данных (PostgreSQL) — таблицы `admin-db.js`

**Персонал/организация:** `admin_users`, `admin_credentials`, `admin_invites`,
`branches` (филиалы, soft-delete `deleted_at`), `trainer_assignments` (тренер→атлеты),
`private_codes` (приватный режим), `promo_leads` (заявки с сайта).

**Расписание:** `trainer_availability` (часы тренера по дням, интервалы),
`coach_bookings` (брони: confirmed/pending/done/cancelled, `reminded_at`),
`recurring_bookings`, `recurring_skips` (постоянные клиенты с фиксированными слотами).

**Лояльность:** `loyalty_rules`, `loyalty_rewards`, `loyalty_accounts` (кошельки),
`loyalty_ledger` (иммутабельная история), `loyalty_events`, `loyalty_outbox`
(отложенные уведомления), `loyalty_achievements`, `loyalty_unlocks`,
`loyalty_redemptions`.

**Аналитика/метрики:** `athlete_metrics` (агрегаты по дням: volume/сеты/тренировки),
`visits`, `access_events`, `external_member_bindings` (СКУД), `app_settings`.

**Уведомления:** `app_notifications` (центр: уведомления и их прочтение).

**Демо:** `demo_tokens`, `demo_sessions` (TTL-сессии клонов).

> Все миграции идемпотентны (`ADD COLUMN IF NOT EXISTS`, `CREATE TABLE IF NOT
> EXISTS`) и исполняются при старте api. **Поля БД — snake_case.**

---

## 6. Механики сессии (что было построено и как устроено)

### 6.1 Декомпозиция монолита (v1.2.7 … v1.2.14)
Монолитный `server.js` (~2000 строк) нарезан на **роут-модули** `api/routes/*.js`:
каждый экспортирует фабрику `create*Routes(deps)` → `[{ method, path, handler }]`,
server.js собирает их в общий роутер. `logic.js` — чистая бизнес-логика (юнит-тесты
без БД). **Правило**: новый эндпоинт → в свой роут-модуль, новая логика → в
`logic.js`, всё БД → в `admin-db.js`. Комментарии в роутах — обязательно.

### 6.2 Единый адаптивный NavBar (v1.2.15)
`components/NavBar.jsx` для всех ролей: mobile — нижний бар (иконка+подпись,
бейджи, центральная круглая кнопка «Старт»), desktop ≥1000px — та же строка
пилюлей сверху. Центр вставляется ПОСЕРЕДИНЕ items (не в конец — иначе кнопка
уезжает в правый край).

### 6.3 Локализация упражнений (v1.2.10, v1.2.16, v1.2.30)
Имена упражнений переводятся через `exName(ex)` в `lib/i18n.js` — единая точка
перевода, работает везде: статистика, прогресс, тренерский интерфейс, программы,
лучшие результаты. Поиск по-русски — ищет и по переводу, и по оригиналу.

### 6.4 Метрики в PostgreSQL вместо чтения файлов (v1.2.19)
Детали в `docs/analytics-metrics.md`. Коротко: агрегаты по дням в `athlete_metrics`
считаются при записи тренировки (`replaceAthleteMetrics`), аналитика читает SQL
`GROUP BY`, а не N файлов. Ночной backfill — на всякий случай.

### 6.5 Цели по упражнениям + вирусный постер (v1.2.22 … v1.2.29)
Цели: по весу тела (всегда) и **по каждому упражнению** (жим лёжа и т.д.),
bodyweight-цели в повторениях. При достижении — праздник в приложении + push +
запись в центр уведомлений (v1.2.25). `GoalPoster.jsx` генерирует мотивационный
постер для соцсетей (спортивные шрифты, CTA «Установи бесплатно», QR). Цели
рисуются на графиках прогресса (v1.2.26).

### 6.6 Кэширование на устройстве и баннер обновления (v1.2.20, v1.2.23)
Service Worker + серверный `_ts`: при новой сборке PWA показывает баннер
«Обновить» (sw.js бампится при каждой сборке). Баннер срабатывает всегда.

### 6.7 Удержание (Retention) — ночной пересчёт
`retention-runner.js` ночью (04:00, `RETENTION_RUN_HOUR`) считает
`collectRetention` по ВСЕМ атлетам → `data/retention-snapshot.json`; днём вкладка
`/admin/analytics/retention` только фильтрует снапшот (БД/файлы днём не сканирует).
Уровни: **active / at_risk / gone** (+ new). Если за ночь атлет стал хуже
(active→at_risk/gone) — тренеру уходит алерт в центр уведомлений (+push).
Постоянные клиенты (recurring-слоты) помечаются как минимум at_risk.

### 6.8 Демо-данные для презентаций (v1.2.9, docs/demo-loyalty.md)
Персонажи Artem (активный лоялист), Maxim (новичок по рефералке), Testuser1
(угасший) + тренер Андрей — для показа лояльности владельцам залов.

### 6.9 Продажи: промо → тарифы → заявки → email (v1.2.31 … v1.2.38)
`frontend/public/promo.html` (переписан под реальный функционал), `promo4gym.html`
(конверсионный v2: hero → боли → ROI → владелец → путь клиента → тарифы → FAQ),
`pricing.html` с тарифами «Старт / Сеть / СелфХостед / Индивидуально» + форма
запроса КП. Заявки падают в `promo_leads` → колокольчик владельца в админке
(вкладка «Заявки», бейджи непрочитанного, быстрый ответ mailto/Telegram) →
email-уведомление на `ivan@trfnv.ru` через **Resend** (`email.js`). СБП-QR
загружается в админке и показывается в модалке оплаты.

### 6.10 Встроенные инструкции и справка (v1.2.39 + ранее)
`ProgressionInfo` («как работает прогрессия»), `LoyaltyHelp` (построитель программ
лояльности), `TrainerHelp` (тренерский портал), `/admin/help` FAQ, инструкция о
баллах/наградах для атлетов.

### 6.11 Мягкое удаление профилей (v1.2.43)
Все удаления — **мягкие** (закрытие доступа): `deleted_at`/`deleted`-флаг,
профиль скрывается из списков/аналитики, вход/синк блокируются, данные остаются.
Восстановление в 1 клик. Эндпоинты: `staff/delete|restore`, `user/delete|restore`,
`branches/delete`. Вкладка «Филиалы» (CRUD, owner). БД: `branches.deleted_at`,
`admin_users.deleted_at`. **Проверка скоупа restore идёт через `getAdmin`
(видит и скрытых), а не `listAdmins`** — иначе удалённого нельзя вернуть.

### 6.12 Приватный режим (v1.2.44)
Гостевой локальный режим спрятан на `/private`: ввод кода → `POST
/api/private/unlock` → гостевой профиль (данные только на устройстве, на сервер
не уходят). Коды генерирует владелец в админке (вкладка «Приватный»,
`private_codes`) и выдаёт после разовой оплаты (оплата пока ручная: СБП/счёт).
Вкладка «Приватный» скрыта на демо-домене (`!isDemo`).

### 6.13 Демо-клуб demo.gym.trfnv.ru (v1.2.45 … v1.2.51, ветка demo v1.2.53)
Полный **изолированный клон сети на каждую демо-сессию**: филиал, владелец,
тренер Андрей, 3 атлета с реалистичной историей (регулярный/средний/ушедший),
правила лояльности и кошельки. Вход — кнопка «Открыть демо-клуб» (одноразовый
токен с IP-лимитом → enter → /admin, роли через имперсонацию). TTL 60 мин →
cleaner полностью удаляет клон (state-файлы, профили, метрики). Подробно —
`docs/demo-club.md` и `docs/demo-branch.md`.

---

## 7. Инфраструктура и деплой (сервер 82.202.141.81)

| Что | Путь/URL | Ветка | Стек |
|---|---|---|---|
| Прод/рабочий | `gym.trfnv.ru` → nginx → 127.0.0.1:8180 | `dev` | `/opt/opengym`, `docker-compose.prod.yml` (db+redis+api+web) |
| Демо-клуб | `demo.gym.trfnv.ru` → 127.0.0.1:8181 | `demo` | `/opt/opengym-demo` (git-чекаут demo), `docker-compose.demo.yml`, `DEMO_MODE=1` |
| Будущий чистый прод | `impulse.trfnv.ru` | `main` (пока не создана релизами) | по `DEPLOY.md` |

- `.env` НЕ коммитится. Демо-`.env`: `DEMO_MODE=1`, `ORIGIN/RP_ID=demo.gym.trfnv.ru`,
  свой `WEB_PORT=127.0.0.1:8181`, свой пароль БД.
- **Бэкапы**: `sudo tar czf /opt/backups/... -C /opt opengym[-demo]` +
  `pg_dump` демо-БД + git-тег точки отката. Делай перед крупными изменениями.
- **media** (картинки/гифки упражнений, ~137M) закоммичены в репозиторий —
  внешний датасет не нужен.
- **Секреты на сервере**: gym — `/opt/opengym/.env`; demo — `/opt/opengym-demo/.env`
  (+ `data/secret`, `data/vapid.json`).

### Релизный цикл (как делали в сессии)
1. Фича доезжает в `dev`, тесты зелёные (см. TESTING.md), CHANGELOG пополнен,
   коммит + push в dev.
2. Прод gym.trfnv.ru = деплой dev: `cd /opt/opengym && docker compose -f
   docker-compose.prod.yml up -d --build api web`.
3. Ветка `demo` — только осознанные merge dev→demo (см. `docs/demo-branch.md`):
   `git checkout demo && git merge dev && git push origin demo`, затем
   `cd /opt/opengym-demo && ./deploy-demo.sh`.

---

## 8. Тесты (актуально на v1.2.53)

| Набор | Кол-во | Команда |
|---|---|---|
| frontend unit (vitest) | **206** | `cd frontend && npm test` |
| api unit (node:test) | 41 | `cd api && node --test logic.test.js` |
| api integration БД (нужна postgres) | 25 | `cd api && node --test admin-db.test.js demo-club.test.js` |
| **Итого api** | **66** | `node --test logic.test.js admin-db.test.js demo-club.test.js` |

Сборка фронта: `cd frontend && npm run build`. Детали и подводные камни — в
`TESTING.md` (там же правило `needDb(t)` и «после `t.skip()` обязателен return»).

---

## 9. Правила и подводные камни (собранные за сессию)

1. **Поля БД snake_case** (`trainer_id`, `demo_session`), поля JSON-файлов — как
   в состоянии приложения (`lang`, `unit`, `workouts`).
2. **`listAdmins` скрывает удалённых** (deleted_at). Если нужен и удалённый —
   используй `getAdmin(id)`. (Баг restore из v1.2.52 — именно поэтому.)
3. **Демо-изоляция**: любые списки/аналитика, которые видит демо-владелец, должны
   фильтроваться через `demo-scope.js`. Забыл — демо-посетители увидят чужие клоны.
4. **pg-плейсхолдеры**: `IN ($1,$2,$3)` рядом с повторным `$1` ломает pg
   («supplies N parameters, requires M») — нумеруй со смещением.
5. **Нет node на хосте** — синтаксис проверяй в контейнере:
   `docker exec opengym-api-1 node --check api/...`.
6. **Контейнеры двух стеков** (прод/демо) независимы; не путай compose-файлы:
   прод = `/opt/opengym/docker-compose.prod.yml`, демо =
   `/opt/opengym-demo/docker-compose.demo.yml`.
7. **`/api/demo/token` — POST**, не GET (легко забыть при curl-проверках).
8. **После правки state-файлов вручную** (db.json/data) — перезапусти api-контейнер:
   процесс держит db в памяти и перезапишет файл из неё при следующем saveDb.
9. Фронт-бандл один для всех поверхностей; `/admin*` и `/trainer*` рендерит
   `AdminApp` (роль-гейты внутри), `NavBar` — общий.
10. Переводы: все строки UI через `t()`, ключи в `locales/ru.js` и др. Новую
    строку без перевода добавь минимум в ru.js (остальные языки — фолбэк на en).

---

## 10. Полезные команды

```bash
# api-тесты (БД из .env)
cd /opt/opengym && docker exec opengym-api-1 node --test logic.test.js admin-db.test.js demo-club.test.js

# фронт: тесты + сборка
cd frontend && npm test && npm run build

# пересборка прод api+web
cd /opt/opengym && docker compose -f docker-compose.prod.yml up -d --build api web

# обновление демо (после merge dev→demo)
cd /opt/opengym-demo && ./deploy-demo.sh

# живая проверка демо
curl -s -X POST https://demo.gym.trfnv.ru/api/demo/token

# psql в БД прод/демо
docker exec opengym-db-1 psql -U opengym -d opengym
docker exec opengym-demo-db-1 psql -U opengym -d opengym
```
