// api/routes/leads.js — публичные заявки с промо-страницы (купить / спросить КП).
//
// Единственный открытый роут (без сессии): любой посетитель gym.trfnv.ru/promo
// может оставить заявку. Защита — валидация полей + простой rate-limit по IP.
// Принятая заявка: (1) пишется в журнал promo_leads, (2) создаёт уведомление
// владельцу (роль owner) в общий центр уведомлений (app_notifications),
// (3) дублируется push, если у владельца есть подписка.
//
// Фабрика: принимает зависимости и возвращает [{ method, path, handler }].
import crypto from 'node:crypto';
import { sendEmail } from '../email.js';
import { verifyPow } from '../demo-pow.js';
import { requestTrialClub } from '../trial-club.js';

export function createLeadsRoutes(deps) {
  const {
    json, readBody, adminDbReady, insertLead, findOwnerId, saveNotification, sendPush,
    requireAdminAccount, getSetting, setSetting, deleteSetting,
    listLeads, markLeadsViewed, countUnreadLeads,
    db, saveDb, dataDir, clientIpOf
  } = deps;

  // PoW для публичного trial-эндпоинта (как на демо-стенде): challenge
  // выдаёт GET /api/trial/challenge, клиент считает nonce, одноразово тратит.
  const trialChallenges = new Map();
  const TRIAL_CHALLENGE_TTL_MS = 5 * 60 * 1000;
  const trialPowDifficulty = Math.max(0, Math.min(8, +(process.env.TRIAL_POW_DIFFICULTY || 3)));
  // Дополнительный in-memory предохранитель (основной лимит — в БД, trialRateLimited):
  // не больше 3 попыток trial-запроса с IP в час, чтобы не молотить MX/DNS.
  const trialAttempts = new Map();
  const trialAttemptLimited = (ip) => {
    const now = Date.now();
    const arr = (trialAttempts.get(ip) || []).filter(ts => now - ts < 3600e3);
    if (arr.length >= 3) return true;
    arr.push(now);
    trialAttempts.set(ip, arr);
    return false;
  };

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
        const company = String(body.company || '').trim();
        const inn = String(body.inn || '').trim();
        const payment = String(body.payment || '').trim().slice(0, 40);

        // Обязательны имя и контакт; всё остальное опционально и обрезается.
        if (!name || !contact) {
          return json(res, 400, { error: 'name and contact are required' });
        }
        if (name.length > 120 || contact.length > 200 || gym.length > 200 || message.length > 2000 || company.length > 200 || inn.length > 20) {
          return json(res, 400, { error: 'field too long' });
        }

        try {
          await adminDbReady;
          const id = 'lead-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
          await insertLead({ id, name, contact, gym, message, plan, company, inn, payment });

          const ownerId = await findOwnerId();
          if (ownerId) {
            const title = 'Новый запрос с сайта 💼';
            const kindLabel = payment === 'invoice' ? 'Заказ: счёт для юрлица' : payment === 'sbp' ? 'Заказ: оплата по СБП' : 'Заявка на коммерческое предложение'
            const detail = [
              kindLabel,
              name + (gym ? ` · ${gym}` : ''),
              'Контакт: ' + contact,
              plan ? 'Тариф: ' + plan : null,
              company ? 'Компания: ' + company + (inn ? ` (ИНН ${inn})` : '') : null,
              message ? 'Сообщение: ' + message : null
            ].filter(Boolean).join('\n');
            const created = await saveNotification({
              id: 'promo-' + id, userId: ownerId, title,
              body: detail,
              payload: { kind: 'promo_lead', lead_id: id, contact, payment }
            });
            if (created) {
              await sendPush(ownerId, { title, body: detail, tag: 'promo-' + id, url: '/admin/notifications' })
                .catch(() => {});
              // Email-уведомление владельцу (ivan@trfnv.ru) — не блокирует ответ,
              // если почта не настроена (RESEND_API_KEY пуст) или сервис недоступен.
              await sendEmail({
                subject: 'Новая заявка: ' + name + (plan ? ' · ' + plan : ''),
                text: detail,
                html: '<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto">'
                  + '<h2 style="margin:0 0 12px">' + title + '</h2>'
                  + '<p style="color:#444;line-height:1.5;white-space:pre-line;margin:0">'
                  + detail.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                  + '</p><p style="color:#888;font-size:13px;margin:16px 0 0">Отправлено с gym.trfnv.ru · ИмпульС</p></div>'
              }).catch(e => console.error('lead email failed:', e.message));
            }
          }
          json(res, 200, { ok: true });
        } catch (error) {
          console.error('lead save failed:', error.message);
          json(res, 503, { error: 'service unavailable' });
        }
      }
    },

    // PoW-challenge для /api/trial (антибот перед дорогим спавном + MX-проверкой).
    {
      method: 'GET',
      path: '/api/trial/challenge',
      handler: async (req, res) => {
        const challenge = crypto.randomBytes(18).toString('base64url');
        trialChallenges.set(challenge, Date.now() + TRIAL_CHALLENGE_TTL_MS);
        json(res, 200, { challenge, difficulty: trialPowDifficulty, ttl_s: TRIAL_CHALLENGE_TTL_MS / 1000 });
      }
    },

    // Публичная заявка Trial-клуба (промо-страница, «Создать мой клуб»).
    // Многослойная защита от спама/разорения Resend (docs/design-step4-5.md):
    //  1) PoW (challenge выше);  2) лимит попыток с IP (in-memory + БД);
    //  3) email: синтаксис + блок-лист + MX-проверка с таймаутом;
    //  4) месячный бюджет писем (app_settings, сбрасывается супер-админом).
    {
      method: 'POST',
      path: '/api/trial',
      handler: async (req, res) => {
        const ip = clientIpOf ? clientIpOf(req) : ((req.socket && req.socket.remoteAddress) || 'unknown');
        try {
          const body = await readBody(req);
          const challenge = String(body.challenge || '').trim();
          const nonce = String(body.nonce || '').trim();
          const exp = trialChallenges.get(challenge);
          if (!exp || exp < Date.now() || !verifyPow({ challenge, nonce, difficulty: trialPowDifficulty })) {
            return json(res, 403, { error: 'proof-of-work required or expired' });
          }
          trialChallenges.delete(challenge);   // одноразовое решение
          if (trialAttemptLimited(ip)) {
            return json(res, 429, { error: 'too many attempts — try again in an hour' });
          }
          await adminDbReady;
          const result = await requestTrialClub({
            email: String(body.email || ''), gymName: String(body.gym || ''),
            ip, db, saveDb, dataDir,
            origin: (req.headers['x-forwarded-proto'] || 'https') + '://' + (req.headers.host || 'gym.trfnv.ru')
          });
          const status = result.status || (result.ok ? 200 : 400);
          json(res, status, result.ok ? { ok: true, email: result.email_sent } : { error: result.error });
        } catch (error) {
          console.error('trial request failed:', error.message);
          json(res, 503, { error: 'service unavailable' });
        }
      }
    },

    // Публичный СБП-QR (показывается в модалке оплаты на /pricing). Без авторизации:
    // data-URL картинки или ссылка на изображение. Пусто — клиент видит
    // «пришлём ссылку на контакт».
    {
      method: 'GET',
      path: '/api/sbp-qr',
      handler: async (req, res) => {
        try {
          await adminDbReady;
          json(res, 200, { qr: await getSetting('sbp_qr') });
        } catch (error) { json(res, 503, { error: 'service unavailable' }); }
      }
    },

    // Админ: список заявок с сайта (владелец/менеджер) + счётчик непрочитанного.
    {
      method: 'GET',
      path: '/api/admin/leads',
      handler: async (req, res) => {
        const admin = await requireAdminAccount(req, res, ['owner', 'manager']);
        if (!admin) return;
        try {
          await adminDbReady;
          json(res, 200, { leads: await listLeads(), unread: await countUnreadLeads() });
        } catch (error) { json(res, 503, { error: 'service unavailable' }); }
      }
    },

    // Админ: отметить все заявки прочитанными (открыл вкладку «Заявки»).
    {
      method: 'POST',
      path: '/api/admin/leads/viewed',
      handler: async (req, res) => {
        const admin = await requireAdminAccount(req, res, ['owner', 'manager']);
        if (!admin) return;
        try {
          await adminDbReady;
          await markLeadsViewed();
          json(res, 200, { ok: true, unread: await countUnreadLeads() });
        } catch (error) { json(res, 503, { error: 'service unavailable' }); }
      }
    },

    // Админ: сохранить СБП-QR (data-URL или ссылка). Ограничение ~250 КБ.
    {
      method: 'POST',
      path: '/api/admin/sbp-qr',
      handler: async (req, res) => {
        const admin = await requireAdminAccount(req, res, ['owner', 'manager']);
        if (!admin) return;
        let body = {};
        try { body = await readBody(req); } catch { /* validation below */ }
        const qr = String(body.qr || '').trim();
        const b64body = qr.indexOf(',') >= 0 ? qr.slice(qr.indexOf(',') + 1) : ''
        const okDataUrl = /^data:image\/[a-z+]+;base64,/i.test(qr) && qr.length <= 260000 && /^[a-z0-9+/=]+$/i.test(b64body) && b64body.length > 32
        const okUrl = /^https?:\/\//.test(qr) && qr.length <= 1000;
        if (!okDataUrl && !okUrl) {
          return json(res, 400, { error: 'qr must be a data:image URL or http(s) link (max 250KB)' });
        }
        try {
          await adminDbReady;
          await setSetting('sbp_qr', qr);
          json(res, 200, { ok: true });
        } catch (error) { json(res, 503, { error: 'service unavailable' }); }
      }
    },

    // Админ: удалить СБП-QR.
    {
      method: 'DELETE',
      path: '/api/admin/sbp-qr',
      handler: async (req, res) => {
        const admin = await requireAdminAccount(req, res, ['owner', 'manager']);
        if (!admin) return;
        try {
          await adminDbReady;
          await deleteSetting('sbp_qr');
          json(res, 200, { ok: true });
        } catch (error) { json(res, 503, { error: 'service unavailable' }); }
      }
    }
  ];
}