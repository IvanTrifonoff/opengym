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
//   2. POST /api/demo/enter  — расходует токен и создаёт клон клуба
//      на одну сессию (реализуется в фазе клона — Ф3).
//   3. POST /api/demo/end    — явный выход: клон полностью удаляется.
// Фоновый cleaner по TTL (60 мин) убирает забытые клоны (Ф3).
import crypto from 'node:crypto';

// Чистые хелперы вынесены наверх, чтобы их можно было тестировать без БД
// (admin-db.test.js, секция чистых функций).

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
    getDemoSession, createDemoSession
  } = deps;

  const HOUR = 60 * 60 * 1000;
  const TOKEN_TTL_MS = 15 * 60 * 1000;
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
    }
  ];
}
