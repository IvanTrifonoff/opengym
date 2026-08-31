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