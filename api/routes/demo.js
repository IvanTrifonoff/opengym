// api/routes/demo.js — «Демо-клуб» (demo.gym.trfnv.ru, DEMO_MODE=1).
//
// Фабрика: принимает зависимости и возвращает [{ method, path, handler }].
// Регистрируется в server.js ТОЛЬКО при DEMO_MODE=1 — на проде этих
// эндпоинтов физически нет (404), поэтому ни создать токен, ни спавнить
// клон на боевом инстансе нельзя.
//
// Поток посетителя с /promo4gym:
//   1. POST /api/demo/challenge — сервер выдаёт случайный challenge + сложность
//      (PoW, см. demo-pow.js). Клиент тратит ~2^16 sha256-операций и приносит
//      nonce — человек этого не замечает, а бот, плодящий сессии, платит CPU.
//   2. POST /api/demo/token  — требует решение PoW (challenge+nonce), проверяет
//      Origin (только demo.gym.trfnv.ru), выдаёт одноразовый токен (антибот:
//      не больше DEMO_TOKENS_PER_IP_PER_HOUR штук в час с одного IP).
//   3. POST /api/demo/enter  — расходует токен, проверяет лимиты одновременных
//      сессий (на IP и глобально), спавнит клон клуба на одну сессию и выдаёт
//      админ-куку демо-владельца (вход без passkey). Дальше посетитель
//      переключает роли штатным impersonate'ом владельца (тренер/атлет).
//   4. POST /api/demo/end    — явный выход: клон полностью удаляется.
// Фоновый cleaner по TTL (60 мин, demo-club.js) убирает забытые клоны.
//
// Защита кнопки (слоями, каждый включается только на демо):
//   PoW            — демо-запросы стоят CPU (DEMO_POW_DIFFICULTY, по умолч. 4);
//   Origin         — токен/enter принимаются только с разрешённых origins
//                    (DEMO_ALLOWED_ORIGINS, по умолч. https://demo.gym.trfnv.ru);
//   Лимиты сессий  — DEMO_MAX_SESSIONS_PER_IP (2) и DEMO_MAX_SESSIONS_TOTAL (5):
//                    бот не может занять все клоны и ресурсы демо-сервера.
import crypto from 'node:crypto';
import { demoIds, ownerIdToSession } from '../demo-club.js';
import { verifyPow, originAllowed } from '../demo-pow.js';

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
    createDemoSession, countActiveDemoSessions, countAllActiveDemoSessions,
    adminSessionCookie, clearAdminCookie, adminSessionPayload,
    spawnDemoClub, destroyDemoClub,
    db, saveDb, dataDir
  } = deps;

  const HOUR = 60 * 60 * 1000;
  const TOKEN_TTL_MS = 15 * 60 * 1000;
  const SESSION_TTL_MS = 60 * 60 * 1000;   // клон живёт час; cleaner добьёт по TTL
  const limit = Math.max(0, +(process.env.DEMO_TOKENS_PER_IP_PER_HOUR || 5));
  const powDifficulty = Math.max(0, Math.min(8, +(process.env.DEMO_POW_DIFFICULTY || 4)));
  const allowedOrigins = (process.env.DEMO_ALLOWED_ORIGINS || 'https://demo.gym.trfnv.ru').split(',').map(s => s.trim());
  const maxSessionsPerIp = Math.max(1, +(process.env.DEMO_MAX_SESSIONS_PER_IP || 2));
  const maxSessionsTotal = Math.max(1, +(process.env.DEMO_MAX_SESSIONS_TOTAL || 5));
  // Хранилище выданных challenge (одноразовые, живут CHALLENGE_TTL). В памяти —
  // демо-стек один процесс; при рестарте старые challenge просто не сработают.
  const challenges = new Map();
  const CHALLENGE_TTL_MS = 5 * 60 * 1000;
  const challengeOf = challenge => challenges.get(challenge);
  const dropChallenge = challenge => { challenges.delete(challenge); };

  return [
    // Выдача PoW-задания: случайный challenge + сложность. Решение одноразовое:
    // challenge удаляется после проверки (нельзя переиспользовать).
    {
      method: 'POST',
      path: '/api/demo/challenge',
      handler: async (req, res) => {
        const challenge = crypto.randomBytes(18).toString('base64url');
        challenges.set(challenge, Date.now() + CHALLENGE_TTL_MS);
        json(res, 200, { challenge, difficulty: powDifficulty, ttl_s: CHALLENGE_TTL_MS / 1000 });
      }
    },

    // Выдача одноразового токена для входа в демо. Антибот (три слоя):
    //  1) PoW: клиент обязан предъявить nonce под заданный challenge;
    //  2) Origin: запрос только с разрешённых страниц (demo.gym.trfnv.ru);
    //  3) IP-лимит токенов в час. Сам токен живёт 15 минут.
    {
      method: 'POST',
      path: '/api/demo/token',
      handler: async (req, res) => {
        const ip = clientIpOf(req);
        try {
          if (!originAllowed(req.headers['origin'], allowedOrigins)) {
            return json(res, 403, { error: 'forbidden origin' });
          }
          const body = await readBody(req);
          const challenge = String(body.challenge || '').trim();
          const nonce = String(body.nonce || '').trim();
          const exp = challengeOf(challenge);
          if (!exp || exp < Date.now() || !verifyPow({ challenge, nonce, difficulty: powDifficulty })) {
            return json(res, 403, { error: 'proof-of-work required or expired' });
          }
          dropChallenge(challenge);   // одноразовое решение
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
          if (!originAllowed(req.headers['origin'], allowedOrigins)) {
            return json(res, 403, { error: 'forbidden origin' });
          }
          // Лимиты одновременных клонов: не больше N на IP и M на весь стек,
          // чтобы бот не занял все ресурсы демо-сервера.
          const perIp = await countActiveDemoSessions(ip);
          if (perIp >= maxSessionsPerIp) {
            return json(res, 429, { error: 'too many active demo sessions from this address — close one and retry' });
          }
          const total = await countAllActiveDemoSessions();
          if (total >= maxSessionsTotal) {
            return json(res, 429, { error: 'demo club is full right now — try again in a few minutes' });
          }
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