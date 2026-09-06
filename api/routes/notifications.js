// ============================================================================
// ПРАВИЛО УВЕДОМЛЕНИЙ — читать всем агентам и разработчикам, кто добавляет
// или меняет уведомления. Нарушение правила = дефект, а не «мелочь».
// ----------------------------------------------------------------------------
// Каждое уведомление ОБЯЗАНО вести к своему источнику: получатель должен
// одним тапом отреагировать на событие (подтвердить заявку, посмотреть баллы,
// открыть спортсмена в «Удержании» и т.п.). Уведомление без перехода — баг.
//
// Требования при добавлении нового вида уведомления:
//   1. Backend (api/*): заполни `payload.kind` — машинное имя источника — и
//      все id, нужные для перехода (booking_id, athlete_id, goal_id, lead_id…).
//   2. Frontend: добавь этот kind в центр уведомлений получателя:
//        - атлет:   frontend/src/views/Notifications.jsx
//        - тренер/админ: frontend/src/views/TrainerNotifications.jsx
//      и сопоставь kind → маршрут + состояние, куда ведёт тап.
//   3. Тап должен не просто открывать раздел, а доводить до конкретного
//      объекта (подсветка/фильтр/фокус), чтобы человек сразу мог отреагировать.
//
// Карта «kind → куда ведёт тап» (актуально на v1.2.63):
//   атлет:
//     booking / reminder / recurring  → «Мои записи» (Home → CoachSheet)
//     goal                            → /stats (прогресс по целям)
//     loyalty (outbox ob-*)           → /settings (баллы и награды)
//   тренер:
//     booking                         → /trainer → календарь + подсветка заявки
//     retention                       → /admin/analytics → «Удержание» + фокус на спортсмене
//   админ / владелец:
//     retention-net                   → /admin/analytics → «Удержание»
//     promo_lead                      → /admin?tab=leads + фокус на заявке
// ============================================================================

// api/routes/notifications.js — центр уведомлений (спортсмен + тренер/админ).
//
// Фабрика: принимает зависимости и возвращает [{ method, path, handler }].
// Вынесено из монолита server.js — поведение идентично (импорт, не копия).
export function createNotificationsRoutes(deps) {
  const {
    json, readBody, readSession, requireAdminAccount,
    adminDbReady, listNotifications, markBadgeSeen,
    markNotificationsRead, countUnreadNotifications
  } = deps;

  return [
    // Спортсмен: свой центр уведомлений (то же, что видит тренер в /trainer).
    {
      method: 'GET',
      path: '/api/notifications',
      handler: async (req, res) => {
        const user = readSession(req);
        if (!user) return json(res, 401, { error: 'not signed in' });
        try {
          await adminDbReady;
          json(res, 200, { notifications: await listNotifications(user.id) });
        } catch (error) { json(res, 503, { error: 'service unavailable' }); }
      }
    },

    // Пометить прочитанными: без id — все сразу, с id — одно.
    {
      method: 'POST',
      path: '/api/notifications/read',
      handler: async (req, res) => {
        const user = readSession(req);
        if (!user) return json(res, 401, { error: 'not signed in' });
        const body = await readBody(req);
        try {
          await adminDbReady;
          await markNotificationsRead(user.id, body.id ? String(body.id) : null);
          json(res, 200, { ok: true, unread: await countUnreadNotifications(user.id) });
        } catch (error) { json(res, 503, { error: 'service unavailable' }); }
      }
    },

    // Сброс счётчика бейджа при открытии приложения (после просмотра).
    {
      method: 'POST',
      path: '/api/badge/seen',
      handler: async (req, res) => {
        const user = readSession(req);
        if (!user) return json(res, 401, { error: 'not signed in' });
        try {
          await adminDbReady;
          await markBadgeSeen(user.id);
          json(res, 200, { ok: true });
        } catch (error) { json(res, 503, { error: 'service unavailable' }); }
      }
    },

    // Trainer notification center: same app_notifications table, scoped to the admin session.
    {
      method: 'GET',
      path: '/api/admin/notifications',
      handler: async (req, res) => {
        const admin = await requireAdminAccount(req, res); if (!admin) return;
        try {
          await adminDbReady;
          json(res, 200, { notifications: await listNotifications('admin:' + admin.id) });
        } catch (error) { json(res, 503, { error: 'service unavailable' }); }
      }
    },

    // Пометить прочитанными уведомления тренера/админа.
    {
      method: 'POST',
      path: '/api/admin/notifications/read',
      handler: async (req, res) => {
        const admin = await requireAdminAccount(req, res); if (!admin) return;
        const body = await readBody(req);
        try {
          await adminDbReady;
          await markNotificationsRead('admin:' + admin.id, body.id ? String(body.id) : null);
          json(res, 200, { ok: true, unread: await countUnreadNotifications('admin:' + admin.id) });
        } catch (error) { json(res, 503, { error: 'service unavailable' }); }
      }
    }
  ];
}