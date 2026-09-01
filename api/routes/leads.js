// api/routes/leads.js — публичные заявки с промо-страницы (купить / спросить КП).
//
// Единственный открытый роут (без сессии): любой посетитель gym.trfnv.ru/promo
// может оставить заявку. Защита — валидация полей + простой rate-limit по IP.
// Принятая заявка: (1) пишется в журнал promo_leads, (2) создаёт уведомление
// владельцу (роль owner) в общий центр уведомлений (app_notifications),
// (3) дублируется push, если у владельца есть подписка.
//
// Фабрика: принимает зависимости и возвращает [{ method, path, handler }].
export function createLeadsRoutes(deps) {
  const {
    json, readBody, adminDbReady, insertLead, findOwnerId, saveNotification, sendPush
  } = deps;

  // Простейший per-IP лимит: не больше 5 заявок с одного адреса в час.
  const hits = new Map();
  const rateLimit = (ip) => {
    const now = Date.now();
    if (hits.size > 1000) { // ленивая подчистка при переполнении
      for (const [k, arr] of hits) {
        const live = arr.filter(ts => now - ts < 3600e3);
        if (live.length) hits.set(k, live); else hits.delete(k);
      }
    }
    const live = (hits.get(ip) || []).filter(ts => now - ts < 3600e3);
    if (live.length >= 5) return true;
    live.push(now);
    hits.set(ip, live);
    return false;
  };

  return [
    {
      method: 'POST',
      path: '/api/lead',
      handler: async (req, res) => {
        const ip = (req.socket && req.socket.remoteAddress) || 'unknown';
        if (rateLimit(ip)) return json(res, 429, { error: 'too many requests' });

        let body = {};
        try { body = await readBody(req); } catch { /* пусто — упадём на валидации */ }
        const name = String(body.name || '').trim();
        const contact = String(body.contact || '').trim();
        const gym = String(body.gym || '').trim();
        const message = String(body.message || '').trim();
        const plan = String(body.plan || '').trim().slice(0, 80);

        // Обязательны имя и контакт; всё остальное опционально и обрезается.
        if (!name || !contact) {
          return json(res, 400, { error: 'name and contact are required' });
        }
        if (name.length > 120 || contact.length > 200 || gym.length > 200 || message.length > 2000) {
          return json(res, 400, { error: 'field too long' });
        }

        try {
          await adminDbReady;
          const id = 'lead-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
          await insertLead({ id, name, contact, gym, message, plan });

          const ownerId = await findOwnerId();
          if (ownerId) {
            const title = 'Новый запрос с сайта 💼';
            const detail = [
              name + (gym ? ` · ${gym}` : ''),
              'Контакт: ' + contact,
              plan ? 'Тариф: ' + plan : null,
              message ? 'Сообщение: ' + message : null
            ].filter(Boolean).join('\n');
            const created = await saveNotification({
              id: 'promo-' + id, userId: ownerId, title,
              body: 'Заявка на коммерческое предложение.\n' + detail,
              payload: { kind: 'promo_lead', lead_id: id, contact }
            });
            if (created) {
              await sendPush(ownerId, { title, body: detail, tag: 'promo-' + id, url: '/trainer/notifications' })
                .catch(() => {});
            }
          }
          json(res, 200, { ok: true });
        } catch (error) {
          console.error('lead save failed:', error.message);
          json(res, 503, { error: 'service unavailable' });
        }
      }
    }
  ];
}