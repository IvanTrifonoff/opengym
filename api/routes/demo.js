// api/routes/demo.js — «Демо-клуб» (demo.gym.trfnv.ru, DEMO_MODE=1).
//
// Фабрика: принимает зависимости и возвращает [{ method, path, handler }].
// Регистрируется в server.js ТОЛЬКО при DEMO_MODE=1 — на проде этих
// эндпоинтов физически нет (404), поэтому ни создать токен, ни спавнить
// клон на боевом инстансе нельзя.
//
// Поток посетителя с /promo4gym:
//   1. POST /api/demo/token  — сервер выдаёт одноразовый токен (антибот:
//      не больше DEMO_TOKENS_PER_IP_PER_HOUR штук в час с одного IP).
//   2. POST /api/demo/enter  — расходует токен, спавнит клон клуба на одну
//      сессию и выдаёт админ-куку демо-владельца (вход без passkey).
//      Дальше посетитель переключает роли штатным impersonate'ом владельца
//      (тренер/атлет) — нового UI не нужно.
//   3. POST /api/demo/end    — явный выход: клон полностью удаляется.
// Фоновый cleaner по TTL (60 мин, demo-club.js) убирает забытые клоны.
import crypto from 'node:crypto';
import { demoIds, ownerIdToSession } from '../demo-club.js';

// Чистые хелперы вынесены наверх, чтобы их можно было тестировать без БД
// (demo-club.test.js / admin-db.test.js, секция чистых функций).

// Клиентский IP: nginx подставляет X-Forwarded-For (первый хоп — реальный
// клиент, дальше — цепочка прокси). Прямое соединение — remoteAddress.
export function clientIpOf(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || (req.socket && req.socket.remoteAddress) || 'unknown';
}

// Лимит исчерпан? Строгое сравнение, чтобы при нулевом лимите всё падало
// в 429 (защита от «лимит 0 = бесконечно» из-за <=).
export const demoQuotaReached = (issued, limit) => issued >= limit;

export function createDemoRoutes(deps) {
  const {
    json, readBody,
    createDemoToken, countDemoTokensSince, takeDemoToken,
    createDemoSession, adminSessionCookie, clearAdminCookie, adminSessionPayload,
    spawnDemoClub, destroyDemoClub,
    db, saveDb, dataDir
  } = deps;

  const HOUR = 60 * 60 * 1000;
  const TOKEN_TTL_MS = 15 * 60 * 1000;
  const SESSION_TTL_MS = 60 * 60 * 1000;   // клон живёт час; cleaner добьёт по TTL
  const limit = Math.max(0, +(process.env.DEMO_TOKENS_PER_IP_PER_HOUR || 5));

  return [
    // Выдача одноразового токена для входа в демо. Антибот: IP-лимит
    // (считаем по demo_tokens за последний час), сам токен живёт 15 минут.
    {
      method: 'POST',
      path: '/api/demo/token',
      handler: async (req, res) => {
        const ip = clientIpOf(req);
        try {
          const issued = await countDemoTokensSince(ip, HOUR);
          if (demoQuotaReached(issued, limit)) {
            return json(res, 429, { error: 'too many demo requests from this address — try again in an hour' });
          }
          const token = crypto.randomBytes(18).toString('base64url');
          await createDemoToken({ token, ip, ttlMs: TOKEN_TTL_MS });
          json(res, 200, { token, ttl_min: TOKEN_TTL_MS / 60000 });
        } catch (error) {
          console.error('demo token failed:', error.message);
          json(res, 503, { error: 'service unavailable' });
        }
      }
    },

    // Вход в демо: расходует токен (одноразовый, привязан к IP), спавнит
    // изолированный клон клуба и выдаёт админ-куку демо-владельца — дальше
    // посетитель гуляет по ролям через штатный impersonate владельца.
    {
      method: 'POST',
      path: '/api/demo/enter',
      handler: async (req, res) => {
        const ip = clientIpOf(req);
        const body = await readBody(req);
        const token = String(body.token || '').trim();
        if (!token) return json(res, 400, { error: 'token is required' });
        try {
          const hit = await takeDemoToken(token, ip);
          if (!hit) return json(res, 403, { error: 'invalid, expired or already used demo token' });
          const sessionId = 'ds_' + crypto.randomBytes(9).toString('hex');
          await spawnDemoClub({ sessionId, db, saveDb, dataDir });
          await createDemoSession({ id: sessionId, token, ip, ttlMs: SESSION_TTL_MS });
          const { ownerId } = demoIds(sessionId);
          const session = { id: ownerId, isDemo: true };
          json(res, 200, { ok: true, redirect: '/admin', session: sessionId },
            { 'Set-Cookie': adminSessionCookie(session) });
        } catch (error) {
          console.error('demo enter failed:', error.message);
          json(res, 503, { error: 'could not start a demo session' });
        }
      }
    },

    // Явный выход: если админ-сессия принадлежит демо-владельцу — клон
    // полностью удаляется (state-файлы, профили, правила, метрики).
    {
      method: 'POST',
      path: '/api/demo/end',
      handler: async (req, res) => {
        const p = adminSessionPayload(req);
        const sessionId = (p && p.kind === 'admin') ? ownerIdToSession(p.id) : null;
        if (sessionId) {
          try { await destroyDemoClub({ sessionId, db, saveDb, dataDir }); }
          catch (error) { console.error('demo end failed:', error.message); }
        }
        json(res, 200, { ok: true }, { 'Set-Cookie': clearAdminCookie });
      }
    }
  ];
}