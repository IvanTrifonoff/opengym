/* opengym-api — passkey (WebAuthn) auth + per-user state storage for openGym
   No framework, JSON-file storage, signed session cookies.               */
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse
} from '@simplewebauthn/server';
import webpush from 'web-push';
import {
  acceptAccessEvent, bindExternalMember, integrationDbReady, integrationDbStatus, listExternalMembers
} from './access-db.js';
import {
  acceptLoyaltyEvent, adminDbReady, applyLoyaltyRules, countUnreadNotifications, createAdminInvite, getAdmin, getAdminCredential, getAdminInvite, findUsedAdminInvite,
  listAdmins, listLoyaltyRules, listNotifications, markBadgeSeen, markNotificationsRead, registerAdmin, roleAllowed, saveLoyaltyRule, saveNotification, deleteLoyaltyRule, dispatchOutbox,
  softDeleteAdmin, restoreAdmin, listBranches, saveBranch, softDeleteBranch,
  syncAdminOwners, updateAdmin, updateAdminCounter, getWallet, listRewards, saveReward, deleteReward, redeemReward, listRedemptions, updateRedemption,
  setTrainerAssignment, listTrainerAssignments,
  getTrainerAvailability, setTrainerAvailability, listBookings, createBooking,
  findBookingConflict, getBooking, updateBookingStatus,
  listRecurringSeries, listRecurringSkips, listRecurringSummary, setRecurringSeries, deleteRecurringSeries, skipRecurringDate, unskipRecurringDate, rollRecurringForward,
  listDueReminders, markBookingReminded,
  insertLead, findOwnerId, getSetting, setSetting, deleteSetting,
  listLeads, markLeadsViewed, countUnreadLeads
} from './admin-db.js';
import { collectAnalytics, athleteDetail } from './analytics.js';
import { buildRetentionSnapshot, scheduleRetentionSnapshot } from './retention-runner.js';
import { createWebhookRoutes } from './routes/webhook.js';
import { createNotificationsRoutes } from './routes/notifications.js';
import { createLoyaltyRoutes } from './routes/loyalty.js';
import { createAdminRoutes } from './routes/admin.js';
import { createTrainerRoutes } from './routes/trainer.js';
import { createLeadsRoutes } from './routes/leads.js';
import { replaceAthleteMetrics, backfillAthleteMetrics } from './metrics.js';

import {
  validTime, timeInRange, bookingTransitionAllowed, validateAvailabilitySlots,
  effectiveRoutineId, nextHour, daySlots, userNow, normaliseAccessEvent
} from './logic.js';

const PORT = +(process.env.PORT || 3000);
const DATA = process.env.DATA_DIR || '/data';
const RP_ID = process.env.RP_ID || 'localhost';
const ORIGIN = process.env.ORIGIN || 'http://localhost:8080';
const RP_NAME = process.env.RP_NAME || 'ИмпульС';
// Admin dashboard (issue): admins are matched by uid; INVITE_ONLY gates new signups behind a
// code the admin generates. Both default off so a fresh self-hosted instance stays open.
const ADMIN_UIDS = (process.env.ADMIN_UIDS || '').split(',').map(s => s.trim()).filter(Boolean);
const INVITE_ONLY = /^(1|true|yes|on)$/i.test(process.env.INVITE_ONLY || '');
// 90 days keeps someone who trains a few times a week permanently signed in without a stolen
// cookie staying good for a year. Overridable because a family instance and one on the open
// internet don't want the same number. Only affects cookies minted from now on — the expiry is
// baked into each cookie when it's issued, so lowering this never cuts an existing session short.
const SESSION_DAYS = Math.max(1, +(process.env.SESSION_DAYS || 90) || 90);
const MAX_BODY = 5 * 1024 * 1024;
// Secure cookies require HTTPS; over plain http://localhost the flag would drop the cookie
const SECURE = /^https:/i.test(ORIGIN) ? ' Secure;' : '';
const ACCESS_WEBHOOK_SECRET = process.env.ACCESS_WEBHOOK_SECRET || '';
const LOYALTY_EVENT_TYPES = new Set(['visit', 'workout_completed', 'streak', 'referral', 'manual']);

fs.mkdirSync(DATA, { recursive: true });

/* ---------- secret + db ---------- */
const secretFile = path.join(DATA, 'secret');
if (!fs.existsSync(secretFile)) fs.writeFileSync(secretFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
const SECRET = fs.readFileSync(secretFile, 'utf8').trim();

const dbFile = path.join(DATA, 'db.json');
let db = { users: [], creds: [], subs: [], invites: [] };
try { db = JSON.parse(fs.readFileSync(dbFile, 'utf8')); } catch {}
db.subs = db.subs || [];
db.invites = db.invites || [];
const adminBootstrap = syncAdminOwners(db.users, db.creds, ADMIN_UIDS);
const isAdmin = user => !!user && (user.admin === true || ADMIN_UIDS.includes(user.id));
function saveDb() { atomicWrite(dbFile, JSON.stringify(db, null, 2)); }
function atomicWrite(file, content) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}
const stateFile = uid => path.join(DATA, 'state-' + uid.replace(/[^a-zA-Z0-9_-]/g, '') + '.json');
function readState(uid) {
  try { return JSON.parse(fs.readFileSync(stateFile(uid), 'utf8')); } catch { return null; }
}
// App language of an athlete (from their state file) — used to localize push messages.
const langOf = userId => { const S = readState(userId); return (S && S.lang) || 'en' }


/* ---------- push notifications (Web Push / VAPID) ---------- */
const vapidFile = path.join(DATA, 'vapid.json');
let vapid;
try { vapid = JSON.parse(fs.readFileSync(vapidFile, 'utf8')); }
catch { vapid = webpush.generateVAPIDKeys(); fs.writeFileSync(vapidFile, JSON.stringify(vapid), { mode: 0o600 }); }
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || (SECURE ? ORIGIN : 'mailto:admin@localhost');
webpush.setVapidDetails(VAPID_SUBJECT, vapid.publicKey, vapid.privateKey);

/* ---- push delivery monitoring ----
   Counts deliveries, keeps a ring buffer of alertable failures, and POSTs to an
   optional webhook (PUSH_ALERT_WEBHOOK) when delivery starts failing — debounced
   to one alert per 5 minutes, plus a single "recovered" notice once things are
   healthy again for 5 minutes. Dead subscriptions (404/410) are normal cleanup,
   counted separately and never alerted. */
const PUSH_ALERT_WEBHOOK = process.env.PUSH_ALERT_WEBHOOK || '';
const PUSH_ALERT_DEBOUNCE_MS = 5 * 60 * 1000;
const pushStats = {
  sent: 0, failed: 0, expired: 0,
  failures: [],                          // ring buffer of alertable failures
  lastFailedAt: 0, lastAlertAt: 0, recoverySent: false
};
const endpointHost = ep => { try { return new URL(ep).host; } catch { return '?'; } };
async function maybePushAlert() {
  if (!PUSH_ALERT_WEBHOOK) return;
  if (Date.now() - pushStats.lastAlertAt < PUSH_ALERT_DEBOUNCE_MS) return;
  pushStats.lastAlertAt = Date.now();
  pushStats.recoverySent = false;
  const last = pushStats.failures[pushStats.failures.length - 1];
  try {
    await fetch(PUSH_ALERT_WEBHOOK, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'push_delivery_alert', origin: ORIGIN, failed: pushStats.failed,
        last: last && { at: new Date(last.at).toISOString(), host: last.host, status: last.status, error: last.error }
      })
    });
  } catch (e) { console.error('push alert webhook failed:', e.message); }
}
async function maybePushRecovery() {
  if (!PUSH_ALERT_WEBHOOK) return;
  if (!pushStats.failed || pushStats.recoverySent) return;
  if (Date.now() - pushStats.lastFailedAt < PUSH_ALERT_DEBOUNCE_MS) return;
  pushStats.recoverySent = true;
  try {
    await fetch(PUSH_ALERT_WEBHOOK, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'push_delivery_recovered', origin: ORIGIN, sent: pushStats.sent, failed: pushStats.failed })
    });
  } catch (e) { console.error('push recovery webhook failed:', e.message); }
}

// Уведомления о достигнутых целях по упражнениям: для каждой цели, у которой
// фронт проставил reachedAt, доставляем ОДИНАКОВОЕ уведомление в центр
// (app_notifications, id 'goal-<goalId>' — ON CONFLICT DO NOTHING) и один push.
// rowCount=0 у saveNotification означает «уже уведомляли» — push не дублируем.
async function notifyReachedGoals(user, S) {
  const goals = ((S && S.goals) || []).filter(g => g && g.reachedAt)
  if (!goals.length) return
  const lang = langOf(user.id)
  const ru = lang === 'ru'
  for (const g of goals) {
    const byReps = g.reps != null
    const target = byReps ? g.reps : g.w
    const unit = byReps ? (ru ? 'повторений' : 'reps') : (g.unit || 'kg')
    const label = g.label || ''
    const title = ru ? 'Цель достигнута! 🏆' : 'Goal reached! 🏆'
    const body = ru
      ? `Поздравляем${user.name ? ' ' + user.name : ''}! Цель${label ? ' «' + label + '»' : ''} — ${target} ${unit} — достигнута. Поставь следующую и двигайся дальше!`
      : `Congrats${user.name ? ', ' + user.name : ''}! Your goal${label ? ' "' + label + '"' : ''} — ${target} ${unit} — is reached. Set a new one and keep going!`
    try {
      const created = await saveNotification({ id: 'goal-' + g.id, userId: user.id, title, body, payload: { kind: 'goal', goal_id: g.id } })
      if (!created) continue            // уже уведомляли — не шлём второй пуш
      await sendPush(user.id, { title, body, tag: 'goal-' + g.id, url: '/home' })
    } catch (e) { console.error('goal notify failed for ' + user.id + ':', e.message) }
  }
}

async function sendPush(userId, payload) {
  // Ensure push payload includes navigation URL for the service worker
  if (!payload.url) payload.url = '/notifications';
  const subs = db.subs.filter(s => s.userId === userId);
  if (!subs.length) return;
  const body = JSON.stringify(payload);
  let dirty = false;
  await Promise.all(subs.map(async sub => {
    // urgency 'high' is the one lever we have over delivery speed — iOS/Android throttle
    // low-urgency background push more aggressively under battery-saving modes. TTL is left
    // at the library default (long) so a briefly-offline device still gets it once reconnected,
    // rather than risking it being dropped for the sake of shaving off latency that TTL doesn't
    // actually control anyway.
    try { await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, body, { urgency: 'high' }); pushStats.sent++; }
    catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) {
        // subscription no longer valid — normal cleanup, not an alert
        pushStats.expired++;
        db.subs = db.subs.filter(s => s.endpoint !== sub.endpoint); dirty = true;
      } else {
        pushStats.failed++;
        pushStats.lastFailedAt = Date.now();
        pushStats.failures.push({ at: Date.now(), host: endpointHost(sub.endpoint), status: e.statusCode || null, error: String(e.body || e.message || '').slice(0, 200) });
        if (pushStats.failures.length > 50) pushStats.failures.shift();
        console.error('push send failed', userId, e.statusCode, e.body || e.message, endpointHost(sub.endpoint));
        maybePushAlert();
      }
    }
  }));
  if (dirty) saveDb();
  maybePushRecovery();
}

// Rest-timer alerts: client schedules on start/extend, cancels on skip or on-screen completion —
// this only fires when the tab was backgrounded/suspended and never got to cancel it itself.
const restTimers = new Map(); // userId -> Timeout
function scheduleRestTimer(userId, sec) {
  const t = restTimers.get(userId);
  if (t) clearTimeout(t);
  restTimers.set(userId, setTimeout(() => {
    restTimers.delete(userId);
    sendPush(userId, { title: 'Rest over 💪', body: 'Time for your next set.', tag: 'rest-timer' });
  }, sec * 1000));
}
function cancelRestTimer(userId) {
  const t = restTimers.get(userId);
  if (t) { clearTimeout(t); restTimers.delete(userId); }
}

// "Workout planned today" reminder — one per user per day, at their chosen time.
// Duplicated (not imported) from frontend/src/lib/history.js effectiveRoutineId — tiny pure helper, not worth sharing across the two runtimes.
// Computes "now" in an arbitrary IANA zone (e.g. "Europe/Lisbon") instead of the server's own —
// each user's reminder fires by their own clock, wherever they and their phone actually are.
setInterval(() => {
  for (const user of db.users) {
    if (!db.subs.some(s => s.userId === user.id)) continue;
    const S = readState(user.id);
    if (!S?.reminder?.on) continue;
    const now = userNow(S.reminder.tz || 'UTC');
    if (!now || S.reminder.time !== now.hhmm) continue;
    if (user.lastReminder === now.date) continue;
    if ((S.workouts || []).some(w => w.d === now.date)) continue;
    const rid = effectiveRoutineId(S, now.date);
    if (!rid) continue; // rest day — nothing planned
    const routine = (S.routines || []).find(r => r.id === rid);
    console.log('reminder firing', user.id, rid);
    user.lastReminder = now.date;
    saveDb();
    sendPush(user.id, {
      title: routine ? `${routine.emoji || '🏋️'} ${routine.name} today` : 'Workout planned today',
      body: "It's on your plan — let's go 💪",
      tag: 'day-reminder'
    });
  }
// Checked every 10s (not 60s) — ticks aren't aligned to the top of the minute, so a 60s
// interval could sit on your target minute for up to 59s before noticing. 10s caps that at ~9s.
}, 10000).unref();

/* ---------- sessions (signed cookie) ---------- */
function sign(payload) {
  const mac = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  return payload + '.' + mac;
}
function verifySig(token) {
  const i = token.lastIndexOf('.');
  if (i < 0) return null;
  const payload = token.slice(0, i), mac = token.slice(i + 1);
  const expect = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  try {
    if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) return null;
  } catch { return null; }
  return payload;
}
// Session payload is `<uid>:<expiry>:<version>`, where the version is the user's `sv` counter.
// Bumping `sv` (POST /api/logout/all) makes every cookie ever handed out for that account stop
// verifying, which is the only revocation there was before short of deleting ./data/secret and
// signing out the whole instance. Cookies minted before `sv` existed have no third field and are
// read as version 0, matching a user who has never bumped — they stay valid until they expire.
const sessionVersion = user => user.sv || 0;
function makeSession(user) {
  const exp = Date.now() + SESSION_DAYS * 86400000;
  return sign(user.id + ':' + exp + ':' + sessionVersion(user));
}
function readSession(req) {
  const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map(c => {
    const i = c.indexOf('='); return i < 0 ? ['', ''] : [c.slice(0, i).trim(), c.slice(i + 1).trim()];
  }));
  const tok = cookies.gymsid;
  if (!tok) return null;
  const payload = verifySig(tok);
  if (!payload) return null;
  const [uid, exp, ver] = payload.split(':');
  if (!uid || +exp < Date.now()) return null;
  const user = db.users.find(u => u.id === uid) || null;
  if (!user) return null;
  if (user.disabled || user.deleted) return null;  // disabled/deleted accounts are locked out everywhere
  // Missing third field = pre-versioning cookie = version 0. Anything non-numeric is a malformed
  // payload (it still had to pass the HMAC, so this is belt-and-braces) and is refused outright.
  const claimed = ver === undefined ? 0 : Number(ver);
  if (!Number.isInteger(claimed) || claimed !== sessionVersion(user)) return null;
  return user;
}
// Guard for /api/admin/* — resolves the caller and 401/403s if they aren't an admin.
function requireAdmin(req, res) {
  const user = readSession(req);
  if (!user) { json(res, 401, { error: 'not signed in' }); return null; }
  if (!isAdmin(user)) { json(res, 403, { error: 'forbidden' }); return null; }
  return user;
}
function adminSessionCookie(admin) {
  const exp = Date.now() + SESSION_DAYS * 86400000;
  const token = sign('admin:' + admin.id + ':' + exp);
  return `adminsid=${token}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly;${SECURE} SameSite=Lax`;
}
// Impersonation session: the same adminsid cookie, but signed with an `impersonate:` prefix so
// the server knows the session is a stand-in for the real account. Every admin endpoint works
// identically; the owner can restore their own session via POST /api/admin/impersonate/back.
function impersonateSessionCookie(admin) {
  const exp = Date.now() + SESSION_DAYS * 86400000;
  const token = sign('impersonate:' + admin.id + ':' + exp);
  return `adminsid=${token}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly;${SECURE} SameSite=Lax`;
}
const clearAdminCookie = `adminsid=; Path=/; Max-Age=0; HttpOnly;${SECURE} SameSite=Lax`;
const clearOrigCookie = `adminsid_orig=; Path=/; Max-Age=0; HttpOnly;${SECURE} SameSite=Lax`;
function adminSessionPayload(req) {
  const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map(c => {
    const i = c.indexOf('='); return i < 0 ? ['', ''] : [c.slice(0, i).trim(), c.slice(i + 1).trim()];
  }));
  const raw = cookies.adminsid;
  const payload = raw && verifySig(raw);
  if (!payload) return null;
  const [kind, id, exp] = payload.split(':');
  return (kind === 'admin' || kind === 'impersonate') && id && Number(exp) > Date.now() ? { kind, id } : null;
}
function adminSessionId(req) {
  const p = adminSessionPayload(req);
  return p ? p.id : null;
}
async function requireAdminAccount(req, res, roles = ['owner', 'manager', 'trainer', 'operator']) {
  const id = adminSessionId(req);
  if (!id) { json(res, 401, { error: 'admin sign-in required' }); return null; }
  try {
    await adminBootstrap;
    const admin = await getAdmin(id);
    if (!admin || admin.disabled) { json(res, 403, { error: 'admin account disabled' }); return null; }
    if (!roleAllowed(admin.role, roles)) { json(res, 403, { error: 'insufficient admin role' }); return null; }
    return admin;
  } catch (error) {
    console.error('admin auth failed:', error.message);
    json(res, 503, { error: 'admin database unavailable' });
    return null;
  }
}

// Which slice of the network an admin may see in analytics. Owner sees everything;
// a manager is scoped to their branch (null branch_key = whole network); a trainer sees
// only athletes assigned to them; an operator gets statuses only (frontend decides what
// to render — the data returned is the same list).
function analyticsScope(admin) {
  if (admin.role === 'owner') return { kind: 'all' };
  if (admin.role === 'manager') return { kind: 'branch', branch: admin.branch_key || null };
  if (admin.role === 'trainer') return { kind: 'trainer', trainerId: admin.id };
  return { kind: 'statuses' };
}

// Trainer program access: owner/manager see any athlete; a trainer only their
// own assigned athletes (trainer_assignments).
async function requireProgramAccess(admin, userId) {
  if (admin.role === 'owner' || admin.role === 'manager') return true;
  if (admin.role === 'trainer') {
    const ta = await listTrainerAssignments();
    return ta.some(x => x.user_id === userId && x.trainer_id === admin.id);
  }
  return false;
}

function bookingNotification(booking, admin, status) {
  const lang = langOf(booking.athlete_id);
  const who = admin?.name ? admin.name + ' · ' : '';
  const when = String(booking.date || '').slice(8, 10) + '.' + String(booking.date || '').slice(5, 7) + ' · ' + (booking.time || '');
  const text = { confirmed: {en:'Trainer confirmed your session: ',ru:'Тренер подтвердил запись: '}, rejected:{en:'Trainer declined your request: ',ru:'Тренер отклонил заявку: '}, cancelled:{en:'Your session was cancelled: ',ru:'Запись отменена: '}, done:{en:'Session completed: ',ru:'Тренировка отмечена выполненной: '} }[status];
  const body = who + (text?.[lang] || text?.en || '') + when;
  return { title: lang === 'ru' ? 'Запись к тренеру' : 'Trainer booking', body };
}
function localToday() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function sessionCookie(user) {
  return `gymsid=${makeSession(user)}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly;${SECURE} SameSite=Lax`;
}
const clearCookie = `gymsid=; Path=/; Max-Age=0; HttpOnly;${SECURE} SameSite=Lax`;

/* ---------- challenge store (in-memory, 5 min TTL) ---------- */
const challenges = new Map(); // cid -> {challenge, name?, uid?, exp}
function putChallenge(data) {
  const cid = crypto.randomBytes(16).toString('base64url');
  challenges.set(cid, { ...data, exp: Date.now() + 5 * 60000 });
  return cid;
}
function takeChallenge(cid) {
  const c = challenges.get(cid);
  challenges.delete(cid);
  if (!c || c.exp < Date.now()) return null;
  return c;
}
setInterval(() => { for (const [k, v] of challenges) if (v.exp < Date.now()) challenges.delete(k); }, 60000).unref();

/* ---------- helpers ---------- */
function json(res, code, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...(extraHeaders || {}) });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', d => {
      size += d.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(d);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}
const b64uToBuf = s => Buffer.from(s, 'base64url');

/* ---------- live presence (in-memory) ---------- */
// Clients heartbeat /api/activity while a workout is on screen; the admin dashboard reads who's
// live. Purely ephemeral — never persisted. Expires shortly after the last ping.
const presence = new Map();               // uid -> { name, exIdx, exTotal, setsDone, setsTotal, startedAt, updatedAt }
const PRESENCE_TTL = 70000;               // ~3.5× the 20s client heartbeat
function livePresence(uid) {
  const p = presence.get(uid);
  if (!p) return null;
  if (Date.now() - p.updatedAt > PRESENCE_TTL) { presence.delete(uid); return null; }
  return p;
}
setInterval(() => { for (const [k, v] of presence) if (Date.now() - v.updatedAt > PRESENCE_TTL) presence.delete(k); }, 30000).unref();


function webhookSecretMatches(req) {
  const supplied = String(req.headers['x-opengym-webhook-secret'] || '');
  if (!ACCESS_WEBHOOK_SECRET || !supplied) return false;
  const expected = Buffer.from(ACCESS_WEBHOOK_SECRET);
  const actual = Buffer.from(supplied);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}



async function adminAuthOptions(req, res) {
  await adminDbReady;
  const options = await generateAuthenticationOptions({ rpID: RP_ID, userVerification: 'preferred', allowCredentials: [] });
  const cid = putChallenge({ challenge: options.challenge, adminAuth: true });
  json(res, 200, { cid, options });
}

/* ---------- routes ---------- */
const routes = {
  // Liveness-проба (используется docker healthcheck и мониторингом).
  'GET /api/health': async (req, res) => json(res, 200, { ok: true, users: db.users.length }),

  // Public config the login screen needs before anyone is signed in.
  'GET /api/config': async (req, res) => json(res, 200, { invite_only: INVITE_ONLY }),

  // Текущий спортсмен: id/name/admin — для восстановления UI после перезагрузки.
  'GET /api/me': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    json(res, 200, { user: { id: user.id, name: user.name, admin: isAdmin(user) } });
  },

  // Регистрация (passkey): шаг 1 — проверить инвайт-код (если invite_only),
  // сгенерировать WebAuthn-челлендж. Спортсмен создаётся только в verify.
  'POST /api/register/options': async (req, res) => {
    const body = await readBody(req);
    const name = String(body.name || '').trim().slice(0, 40);
    if (!name) return json(res, 400, { error: 'name required' });
    const code = String(body.code || '').trim().toUpperCase();
    if (INVITE_ONLY && !db.invites.some(i => i.code === code && !i.usedBy && !i.revoked))
      return json(res, 403, { error: 'a valid invite code is required' });
    const uid = crypto.randomBytes(12).toString('base64url');
    const options = await generateRegistrationOptions({
      rpName: RP_NAME, rpID: RP_ID,
      userID: Buffer.from(uid), userName: name, userDisplayName: name,
      attestationType: 'none',
      authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
      excludeCredentials: []
    });
    const cid = putChallenge({ challenge: options.challenge, name, uid, code });
    json(res, 200, { cid, options });
  },

  // Регистрация (passkey): шаг 2 — проверить подпись, создать аккаунт,
  // погасить инвайт-код, выдать сессию (cookie gymsid).
  'POST /api/register/verify': async (req, res) => {
    const body = await readBody(req);
    const c = takeChallenge(body.cid);
    if (!c || !c.uid) return json(res, 400, { error: 'challenge expired — try again' });
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: body.credential,
        expectedChallenge: c.challenge,
        expectedOrigin: ORIGIN,
        expectedRPID: RP_ID,
        requireUserVerification: false
      });
    } catch (e) { return json(res, 400, { error: 'verification failed: ' + e.message }); }
    if (!verification.verified) return json(res, 400, { error: 'not verified' });
    const { credential } = verification.registrationInfo;
    if (db.creds.find(x => x.id === credential.id)) return json(res, 409, { error: 'credential already registered' });
    // Re-check the invite at the last moment (it may have been used/revoked since options), then burn it.
    let invite = null;
    if (INVITE_ONLY) {
      invite = db.invites.find(i => i.code === c.code && !i.usedBy && !i.revoked);
      if (!invite) return json(res, 403, { error: 'invite code is no longer valid — ask for a new one' });
    }
    const user = { id: c.uid, name: c.name, created: new Date().toISOString() };
    if (invite) { user.invitedBy = invite.code; invite.usedBy = user.id; invite.usedAt = user.created; }
    db.users.push(user);
    db.creds.push({
      id: credential.id, userId: user.id,
      publicKey: Buffer.from(credential.publicKey).toString('base64url'),
      counter: credential.counter || 0,
      transports: body.credential?.response?.transports || []
    });
    if (invite && invite.trainerId) {
      try { await setTrainerAssignment({ userId: user.id, trainerId: invite.trainerId }); }
      catch (e) { console.error('invite auto-assign failed:', e.message); }
    }
    saveDb();
    json(res, 200, { user: { id: user.id, name: user.name, admin: isAdmin(user) } }, { 'Set-Cookie': sessionCookie(user) });
  },

  // Вход (passkey): шаг 1 — WebAuthn-челлендж.
  'POST /api/login/options': async (req, res) => {
    const options = await generateAuthenticationOptions({
      rpID: RP_ID, userVerification: 'preferred', allowCredentials: []
    });
    const cid = putChallenge({ challenge: options.challenge });
    json(res, 200, { cid, options });
  },

  // Вход (passkey): шаг 2 — проверить подпись по сохранённому credential, выдать сессию.
  'POST /api/login/verify': async (req, res) => {
    const body = await readBody(req);
    const c = takeChallenge(body.cid);
    if (!c) return json(res, 400, { error: 'challenge expired — try again' });
    const cred = db.creds.find(x => x.id === body.credential?.id);
    if (!cred) return json(res, 404, { error: 'unknown passkey — create a profile first' });
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response: body.credential,
        expectedChallenge: c.challenge,
        expectedOrigin: ORIGIN,
        expectedRPID: RP_ID,
        requireUserVerification: false,
        credential: {
          id: cred.id,
          publicKey: b64uToBuf(cred.publicKey),
          counter: cred.counter,
          transports: cred.transports
        }
      });
    } catch (e) { return json(res, 400, { error: 'verification failed: ' + e.message }); }
    if (!verification.verified) return json(res, 400, { error: 'not verified' });
    cred.counter = verification.authenticationInfo.newCounter;
    saveDb();
    const user = db.users.find(u => u.id === cred.userId);
    if (!user) return json(res, 500, { error: 'user missing' });
    if (user.disabled || user.deleted) return json(res, 403, { error: 'this account has been closed' });
    json(res, 200, { user: { id: user.id, name: user.name, admin: isAdmin(user) } }, { 'Set-Cookie': sessionCookie(user) });
  },

  // Выход: очистить свою сессию (обычный logout, в отличие от logout/all).
  'POST /api/logout': async (req, res) => json(res, 200, { ok: true }, { 'Set-Cookie': clearCookie }),

  // "Sign out everywhere" — bumps this user's session version, which invalidates every cookie
  // ever issued for the account, on every device, including a copy someone else walked off with.
  // The caller's own cookie is cleared here too, so the browser doing it doesn't sit on a token
  // it no longer accepts. Passkeys are untouched: signing back in works immediately.
  'POST /api/logout/all': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    user.sv = sessionVersion(user) + 1;
    saveDb();
    json(res, 200, { ok: true }, { 'Set-Cookie': clearCookie });
  },

  // Полное состояние спортсмена (state-файл): тренировки, план, настройки.
  'GET /api/data': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    try {
      const state = JSON.parse(fs.readFileSync(stateFile(user.id), 'utf8'));
      json(res, 200, { state });
    } catch { json(res, 200, { state: null }); }
  },

  // Сохранить состояние спортсмена целиком. Ключ `active` (идущая тренировка)
  // намеренно удаляется — активную тренировку не переносим между устройствами.
  'PUT /api/data': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    if (!body.state || typeof body.state !== 'object') return json(res, 400, { error: 'state required' });
    delete body.state.active;              // in-progress workouts stay device-local
    // Версия state — серверные часы, а не клиентские: если у спортсмена время
    // на устройстве ушло вперёд/назад, сравнение версий в pullState остаётся
    // корректным (иначе локальный кэш с «убежавшими» часами всегда побеждал бы
    // и затирал правки тренера). Фронт выравнивает локальный _ts по этому ts.
    body.state._ts = Date.now();
    atomicWrite(stateFile(user.id), JSON.stringify(body.state));
    // Инкрементальные метрики для аналитики (athlete_metrics) — пересчитываются
    // из сохранённого state; сбой БД не должен ронять сохранение данных.
    try { await replaceAthleteMetrics(user.id, body.state); }
    catch (e) { console.error('metrics update failed for ' + user.id + ':', e.message); }
    // Достигнутые цели (reachedAt проставил фронт) → пуш + центр уведомлений.
    notifyReachedGoals(user, body.state).catch(e => console.error('goal notify:', e.message));
    json(res, 200, { ok: true, ts: body.state._ts });
  },

  // VAPID public key: браузер берёт его перед подпиской на пуши.
  'GET /api/push/public-key': async (req, res) => json(res, 200, { key: vapid.publicKey }),

  // Сохранить Web Push-подписку для спортсмена (gymsid) или тренера (adminsid).
  'POST /api/push/subscribe': async (req, res) => {
    // Athlete session (gymsid) or admin/trainer session (adminsid) — trainers subscribe
    // from the portal so they can get push alerts about new booking requests.
    const user = readSession(req);
    const adminId = user ? null : adminSessionId(req);
    if (!user && !adminId) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    const sub = body.subscription;
    if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) return json(res, 400, { error: 'invalid subscription' });
    const userId = user ? user.id : 'admin:' + adminId;
    db.subs = db.subs.filter(s => s.endpoint !== sub.endpoint);
    db.subs.push({ userId, endpoint: sub.endpoint, keys: sub.keys, created: new Date().toISOString() });
    saveDb();
    json(res, 200, { ok: true });
  },

  // Удалить подписку по endpoint.
  'POST /api/push/unsubscribe': async (req, res) => {
    const user = readSession(req);
    const adminId = user ? null : adminSessionId(req);
    if (!user && !adminId) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    const userId = user ? user.id : 'admin:' + adminId;
    db.subs = db.subs.filter(s => !(s.userId === userId && s.endpoint === body.endpoint));
    saveDb();
    json(res, 200, { ok: true });
  },

  // Отправить тестовое уведомление на все подписки текущего пользователя.
  'POST /api/push/test': async (req, res) => {
    const user = readSession(req);
    const adminId = user ? null : adminSessionId(req);
    if (!user && !adminId) return json(res, 401, { error: 'not signed in' });
    await sendPush(user ? user.id : 'admin:' + adminId, { title: 'ИмпульС', body: 'Test notification ✅ — this is what alerts look like.', tag: 'test' });
    json(res, 200, { ok: true });
  },
  // Диагностика пушей: свои подписки (хост), общее число, статистика доставки.
  'GET /api/push/health': async (req, res) => {
    const user = readSession(req);
    const adminId = user ? null : adminSessionId(req);
    if (!user && !adminId) return json(res, 401, { error: 'not signed in' });
    const userId = user ? user.id : 'admin:' + adminId;
    const mySubs = db.subs.filter(s => s.userId === userId);
    json(res, 200, {
      userId,
      subscriptionCount: mySubs.length,
      subscriptions: mySubs.map(s => ({ created: s.created, host: endpointHost(s.endpoint) })),
      globalSubCount: db.subs.length,
      pushStats
    });
  },



  // Таймер отдыха между подходами: сервер пришлёт пуш, когда время выйдет.
  'POST /api/push/rest-timer': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    const sec = Math.max(1, Math.min(3600, Math.round(+body.seconds || 0)));
    if (!sec) return json(res, 400, { error: 'seconds required' });
    scheduleRestTimer(user.id, sec);
    json(res, 200, { ok: true });
  },

  // Отменить активный таймер отдыха.
  'POST /api/push/rest-timer/cancel': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    cancelRestTimer(user.id);
    json(res, 200, { ok: true });
  },

  // Live-workout heartbeat: client pings while a workout is on screen; { active:false } drops it.
  'POST /api/activity': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    if (body.active) {
      presence.set(user.id, {
        name: String(body.name || '').slice(0, 60),
        exIdx: +body.exIdx || 0, exTotal: +body.exTotal || 0,
        setsDone: +body.setsDone || 0, setsTotal: +body.setsTotal || 0,
        startedAt: +body.startedAt || Date.now(),
        updatedAt: Date.now()
      });
    } else presence.delete(user.id);
    json(res, 200, { ok: true });
  },

};

/* Роут-модули (вынесены из монолита): внешние вебхуки + центр уведомлений.
   Каждая фабрика возвращает [{ method, path, handler }] — регистрируются в общий роутер. */
const routeModules = [
  ...createWebhookRoutes({
    json, readBody, webhookSecretMatches, LOYALTY_EVENT_TYPES,
    adminDbReady, acceptLoyaltyEvent, langOf, dispatchOutbox, sendPush,
    normaliseAccessEvent, integrationDbReady, integrationDbStatus,
    acceptAccessEvent, applyLoyaltyRules
  }),
  ...createLoyaltyRoutes({
    json, readBody, readSession, requireAdminAccount,
    getWallet, listRewards, redeemReward,
    saveReward, deleteReward, listRedemptions, updateRedemption,
    listLoyaltyRules, saveLoyaltyRule, deleteLoyaltyRule
  }),
  ...createAdminRoutes({
    json, readBody,
    requireAdminAccount, adminSessionCookie, impersonateSessionCookie,
    clearAdminCookie, clearOrigCookie, adminSessionPayload, adminAuthOptions,
    pushStats, PUSH_ALERT_WEBHOOK,
    db, saveDb, readState, stateFile, atomicWrite, livePresence, presence,
    isAdmin, INVITE_ONLY,
    langOf, sendPush, sessionCookie,
    integrationDbReady, listExternalMembers, bindExternalMember,
    putChallenge, takeChallenge,
    analyticsScope, requireProgramAccess, bookingNotification,
    adminDbReady, getAdmin, getAdminCredential, getAdminInvite, findUsedAdminInvite,
    listAdmins, registerAdmin, updateAdmin, updateAdminCounter, createAdminInvite,
    setTrainerAssignment, listTrainerAssignments,
    getTrainerAvailability, setTrainerAvailability, listBookings, createBooking,
    findBookingConflict, getBooking, updateBookingStatus,
    listRecurringSeries, listRecurringSkips, listRecurringSummary, setRecurringSeries,
    deleteRecurringSeries, skipRecurringDate, unskipRecurringDate, rollRecurringForward,
    saveNotification,
    collectAnalytics, athleteDetail, buildRetentionSnapshot,
    bookingTransitionAllowed, validateAvailabilitySlots,
    verifyAuthenticationResponse, verifyRegistrationResponse, generateRegistrationOptions,
    b64uToBuf, verifySig,
    crypto, ORIGIN, RP_ID, RP_NAME, SECURE, DATA, path, fs
  }),
  ...createTrainerRoutes({
    json, readBody, readSession,
    adminDbReady, listTrainerAssignments, listAdmins,
    getTrainerAvailability, rollRecurringForward, listBookings,
    findBookingConflict, createBooking, getBooking, updateBookingStatus,
    localToday, timeInRange,
    saveNotification, sendPush
  }),
  ...createNotificationsRoutes({
    json, readBody, readSession, requireAdminAccount,
    adminDbReady, listNotifications, markBadgeSeen,
    markNotificationsRead, countUnreadNotifications
  }),
  ...createLeadsRoutes({
    json, readBody, adminDbReady,
    insertLead, findOwnerId, saveNotification, sendPush,
    requireAdminAccount, getSetting, setSetting, deleteSetting,
    listLeads, markLeadsViewed, countUnreadLeads
  })
];
for (const r of routeModules) routes[r.method + ' ' + r.path] = r.handler;

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const key = req.method + ' ' + url.pathname;
  const handler = routes[key];
  if (!handler) return json(res, 404, { error: 'not found' });
  try { await handler(req, res); }
  catch (e) {
    console.error(key, e);
    if (!res.headersSent) json(res, 500, { error: 'server error' });
  }
}).listen(PORT, () => {
  console.log(`gym-api on :${PORT} (rpID=${RP_ID}, origin=${ORIGIN})`);
  // Loyalty outbox dispatcher: safety net for notifications that failed on the
  // first attempt (or were queued while the API was down). Runs every 30s.
  setInterval(() => dispatchOutbox({ send: sendPush }).catch(e => console.error('outbox tick failed:', e.message)), 30000);

/* Retention alerts: when the nightly snapshot shows an athlete got WORSE (active ->
   at_risk/gone, at_risk -> gone), notify their assigned trainer through the in-app
   notification center (and a push if the trainer is subscribed). The notification id
   carries the date, so an athlete whose risk stays high doesn't spam the trainer daily —
   one alert per athlete per day max, and only on a level change. */
const LEVEL_ORDER = { active: 0, at_risk: 1, gone: 2 };
async function notifyRetentionTrainers({ prev, next }) {
  try {
    const ta = await listTrainerAssignments();
    if (!ta.length) return;
    const byUser = new Map(ta.map(x => [x.user_id, x.trainer_id]));
    const prevByUser = new Map((prev && prev.athletes || []).map(a => [a.id, a.level]));
    const today = new Date().toISOString().slice(0, 10);
    for (const a of next.athletes || []) {
      const trainerId = byUser.get(a.id);
      if (!trainerId) continue;
      const prevLevel = prevByUser.get(a.id);
      const cur = LEVEL_ORDER[a.level] != null ? LEVEL_ORDER[a.level] : 0;
      const was = prevLevel && LEVEL_ORDER[prevLevel] != null ? LEVEL_ORDER[prevLevel] : 0;
      if (!prevLevel || cur <= was) continue;   // only on a real downgrade
      const label = a.level === 'gone' ? 'ушёл' : a.level === 'at_risk' ? 'в зоне риска' : 'активен';
      const reason = (a.reasons && a.reasons.length ? a.reasons.join('; ') : 'нет данных').slice(0, 180);
      const body = `${a.name} — ${label}. ${reason}`;
      const id = 'ret-' + today + '-' + a.id;
      await saveNotification({
        id, userId: 'admin:' + trainerId,
        title: 'Удержание: спортсмен ' + (a.level === 'gone' ? 'ушёл' : 'в зоне риска'),
        body, payload: { kind: 'retention', athleteId: a.id, level: a.level }
      });
      await sendPush('admin:' + trainerId, {
        title: 'Удержание', body, tag: 'retention', url: '/trainer/notifications'
      }).catch(() => {});
      console.log('[retention] alert trainer', trainerId, 'about', a.name, '->', a.level);
    }
  } catch (e) {
    console.error('[retention] trainer alerts failed:', e.message);
  }
}

/* Network-level retention alert for owners: when the nightly snapshot shows the number
   of athletes who are GONE or AT RISK grew overnight, notify every owner account via the
   notification center (and a push if subscribed). The id carries the date, so a network
   that keeps worsening doesn't spam owners daily — one alert per day max. */
async function notifyRetentionOwner({ prev, next }) {
  try {
    const s = next && next.summary, p = prev && prev.summary;
    if (!s) return;
    const dGone = (s.gone || 0) - (p ? (p.gone || 0) : 0);
    const dRisk = (s.atRisk || 0) - (p ? (p.atRisk || 0) : 0);
    if (dGone <= 0 && dRisk <= 0) return;   // no growth -> nothing to say
    const admins = await listAdmins();
    const owners = admins.filter(a => a.role === 'owner' && !a.disabled);
    if (!owners.length) return;
    const today = new Date().toISOString().slice(0, 10);
    const parts = [];
    if (dGone > 0) parts.push('ушли ' + s.gone + ' (+' + dGone + ' за сутки)');
    if (dRisk > 0) parts.push('в зоне риска ' + s.atRisk + ' (+' + dRisk + ')');
    const body = parts.join(', ') + '. Спортсмены теряют мотивацию — пора открыть вкладку «Удержание».';
    const id = 'ret-net-' + today;
    for (const o of owners) {
      await saveNotification({
        id, userId: 'admin:' + o.id,
        title: 'Удержание: отток растёт',
        body, payload: { kind: 'retention-net' }
      });
      await sendPush('admin:' + o.id, {
        title: 'Удержание: отток растёт', body, tag: 'retention-net', url: '/admin/analytics'
      }).catch(() => {});
      console.log('[retention] alert owner', o.id, 'network risk growth');
    }
  } catch (e) {
    console.error('[retention] owner alert failed:', e.message);
  }
}

/* Upcoming-session reminders: for every confirmed booking on the target date (default the
   day after tomorrow-lead) that hasn't been reminded yet, push + notify the athlete. Covers
   both one-off and «постоянные» (recurring) sessions. Idempotent via reminded_at. */
async function runReminders() {
  try {
    const lead = Math.max(0, parseInt(process.env.REMINDER_LEAD_DAYS || '1', 10));
    const d = new Date(); d.setDate(d.getDate() + lead);
    const target = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    const rows = await listDueReminders({ targetDate: target });
    if (!rows.length) return;
    const admins = await listAdmins();
    const tName = new Map(admins.map(a => [a.id, a.name]));
    for (const b of rows) {
      const lang = langOf(b.athlete_id);
      const ru = lang !== 'en';
      const title = ru ? 'Напоминаем про тренировку' : 'Upcoming session reminder';
      const when = b.time;
      const who = tName.get(b.trainer_id);
      const body = ru
        ? 'Завтра в ' + when + (who ? ' у вас тренировка с ' + who : ' у вас тренировка с тренером') + '.'
        : 'Tomorrow at ' + when + (who ? ' with ' + who + '.' : ' with your trainer.');
      try {
        await saveNotification({ id: 'rem-' + b.id, userId: b.athlete_id, title, body, payload: { kind: 'reminder', booking_id: b.id, date: b.date, time: b.time } });
        await sendPush(b.athlete_id, { title, body, tag: 'reminder-' + b.id, url: '/notifications', data: { booking_id: b.id, time: b.time } }).catch(() => {});
      } catch (e) { console.error('[reminder] notify failed for', b.id, e.message); }
      await markBookingReminded({ id: b.id });
    }
    console.log('[reminder] sent', rows.length, 'reminders for', target);
  } catch (e) {
    console.error('[reminder] run failed:', e.message);
  }
}



  // Retention: precompute the snapshot nightly (default 04:00, RETENTION_RUN_HOUR overrides).
  // Backfill метрик при старте: пересчитать athlete_metrics из всех state-файлов
  // (страховка для пользователей, сохранявшихся до появления таблицы).
  adminDbReady.then(() => backfillAthleteMetrics({ users: db.users, stateOf: readState }))
    .catch(e => console.error('metrics backfill failed:', e.message));
  scheduleRetentionSnapshot({ users: db.users, stateOf: readState, dataDir: DATA,
    hour: parseInt(process.env.RETENTION_RUN_HOUR || '4', 10),
    onSnapshot: async d => { await notifyRetentionTrainers(d); await notifyRetentionOwner(d); } });
  // Roll "постоянные" booking horizons forward daily (GET endpoints also roll lazily).
  setTimeout(() => rollRecurringForward().catch(() => {}), 10000);
  setInterval(() => rollRecurringForward().catch(() => {}), 24 * 60 * 60 * 1000);
  // Upcoming-session reminders: fire shortly after boot and every N minutes.
  setTimeout(() => runReminders(), 15000);
  setInterval(() => runReminders(), Math.max(5, parseInt(process.env.REMINDER_INTERVAL_MIN || '20', 10)) * 60000);
});
