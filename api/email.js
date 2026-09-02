// api/email.js — email-уведомления владельцу (новые заявки с сайта).
//
// Транзакционный email через Resend REST API (https://api.resend.com/emails) —
// один fetch, без SDK и npm-зависимостей. Если RESEND_API_KEY не задан,
// отправка молча пропускается (фронт/заявки работают как раньше).
//
// Конфигурация (env):
//   RESEND_API_KEY — ключ из панели Resend (обязателен для реальной отправки)
//   EMAIL_TO       — кому слать (по умолчанию ivan@trfnv.ru)
//   EMAIL_FROM     — от кого; по умолчанию ИмпульС <noreply@send.trfnv.ru>
//                    (поддомен send.trfnv.ru проверен в Resend: SPF+DKIM,
//                    письма доставляются на любые адреса, не только на почту
//                    аккаунта Resend). Для другого домена переопределите в .env.
const API = 'https://api.resend.com/emails';
const KEY = process.env.RESEND_API_KEY || '';
const TO = process.env.EMAIL_TO || 'ivan@trfnv.ru';
const FROM = process.env.EMAIL_FROM || 'ИмпульС <noreply@send.trfnv.ru>';

export const emailEnabled = () => !!KEY;

export async function sendEmail({ to = TO, subject, html, text }) {
  if (!KEY) return { skipped: true };
  const r = await fetch(API, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM, to: [to], subject: String(subject).slice(0, 200), html, text })
  });
  if (!r.ok) {
    const err = await r.text().catch(() => '');
    throw new Error('resend ' + r.status + ': ' + String(err).slice(0, 200));
  }
  return r.json();
}