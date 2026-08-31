// api/routes/webhook.js — внешние интеграции (турникет/лояльность вебхуки).
//
// Фабрика: принимает зависимости (хелперы + хендлеры БД) и возвращает массив
// роутов [{ method, path, handler }]. server.js регистрирует их в общем роутере.
// Это вынесено из монолита server.js — поведение идентично, код единый (импорт,
// не копия). Тесты на чистую логику нормализации: api/logic.test.js.
export function createWebhookRoutes(deps) {
  const {
    json, readBody, webhookSecretMatches, LOYALTY_EVENT_TYPES,
    adminDbReady, acceptLoyaltyEvent, langOf, dispatchOutbox, sendPush,
    normaliseAccessEvent, integrationDbReady, integrationDbStatus,
    acceptAccessEvent, applyLoyaltyRules
  } = deps;

  return [
    {
      method: 'POST',
      path: '/api/integrations/loyalty/events',
      handler: async (req, res) => {
        if (!webhookSecretMatches(req)) return json(res, 401, { error: 'invalid webhook secret' });
        const body = await readBody(req);
        const eventId = String(body.event_id || body.id || '').trim().slice(0, 200);
        const userId = String(body.user_id || '').trim();
        const eventType = String(body.event_type || '').trim();
        const branchKey = String(body.branch_key || body.branch_id || '').trim().slice(0, 100) || null;
        const occurredAt = new Date(body.occurred_at || body.timestamp || Date.now());
        if (!eventId || !userId || !LOYALTY_EVENT_TYPES.has(eventType) || Number.isNaN(occurredAt.getTime()))
          return json(res, 400, { error: 'event_id, user_id, valid event_type and occurred_at are required' });
        await adminDbReady;
        try {
          const result = await acceptLoyaltyEvent({ eventId, userId, eventType, branchKey, occurredAt: occurredAt.toISOString(), payload: body, lang: langOf(userId) });
          const notified = await dispatchOutbox({ send: sendPush }).catch(e => { console.error('outbox dispatch failed:', e.message); return 0; });
          json(res, 200, { ok: true, ...result, notified });
        } catch (error) {
          console.error('loyalty event failed:', error.message);
          json(res, 503, { error: 'loyalty database unavailable' });
        }
      }
    },

    {
      method: 'POST',
      path: '/api/integrations/access/events',
      handler: async (req, res) => {
        if (!webhookSecretMatches(req)) return json(res, 401, { error: 'invalid webhook secret' });
        const body = await readBody(req);
        let event;
        try { event = normaliseAccessEvent(body); }
        catch (error) { return json(res, 400, { error: error.message }); }
        await integrationDbReady;
        if (integrationDbStatus() !== 'configured') return json(res, 503, { error: 'integration database unavailable' });
        try {
          const result = await acceptAccessEvent(event);
          const loyalty = result.matched && result.userId
            ? await applyLoyaltyRules({ userId: result.userId, eventId: event.eventId, eventType: 'visit', branchKey: event.branchKey, occurredAt: event.occurredAt, lang: langOf(result.userId) })
            : null;
          const notified = await dispatchOutbox({ send: sendPush }).catch(e => { console.error('outbox dispatch failed:', e.message); return 0; });
          json(res, 200, { ok: true, ...result, loyalty, notified });
        } catch (error) {
          console.error('access webhook failed:', error.message);
          json(res, 503, { error: 'integration database unavailable' });
        }
      }
    }
  ];
}