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
  syncAdminOwners, updateAdmin, updateAdminCounter, getWallet, listRewards, saveReward, deleteReward, redeemReward, listRedemptions, updateRedemption,
  setTrainerAssignment, listTrainerAssignments,
  getTrainerAvailability, setTrainerAvailability, listBookings, createBooking,
  findBookingConflict, getBooking, updateBookingStatus
} from './admin-db.js';
import { collectAnalytics, athleteDetail } from './analytics.js';

const PORT = +(process.env.PORT || 3000);
const DATA = process.env.DATA_DIR || '/data';
const RP_ID = process.env.RP_ID || 'localhost';
const ORIGIN = process.env.ORIGIN || 'http://localhost:8080';
const RP_NAME = process.env.RP_NAME || 'openGym';
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
function effectiveRoutineId(S, iso) {
  const ov = S.dayPlan?.[iso];
  if (ov === 'rest') return null;
  if (ov && S.routines?.some(r => r.id === ov)) return ov;
  const wd = new Date(iso + 'T12:00:00').getDay();
  return S.week?.[wd] || null;
}
// Computes "now" in an arbitrary IANA zone (e.g. "Europe/Lisbon") instead of the server's own —
// each user's reminder fires by their own clock, wherever they and their phone actually are.
function userNow(tz) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
    }).formatToParts(new Date());
    const g = t => parts.find(p => p.type === t)?.value;
    return { date: `${g('year')}-${g('month')}-${g('day')}`, hhmm: `${g('hour')}:${g('minute')}` };
  } catch { return null; } // unknown/invalid tz string — skip this user rather than guess
}
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
  if (user.disabled) return null;           // disabled accounts are locked out everywhere
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

const timeInRange = (t, start, end) => t >= start && t < end;
const validTime = t => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(t));
const BOOKING_TRANSITIONS = {
  pending: new Set(['confirmed', 'rejected', 'cancelled']),
  confirmed: new Set(['cancelled', 'done']),
  rejected: new Set(), cancelled: new Set(), done: new Set()
};
function bookingTransitionAllowed(from, to) { return from === to || !!BOOKING_TRANSITIONS[from]?.has(to); }
function validateAvailabilitySlots(slots) {
  if (!Array.isArray(slots) || slots.length > 14) throw new Error('invalid availability');
  const seen = new Set();
  for (const s of slots) {
    const weekday = Number(s.weekday);
    const start = String(s.time_start || ''); const end = String(s.time_end || '');
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6 || !validTime(start) || !validTime(end) || start >= end) throw new Error('invalid availability interval');
    const key = weekday + ':' + start + '-' + end;
    if (seen.has(key)) throw new Error('duplicate availability interval');
    seen.add(key);
  }
  for (const a of slots) for (const b of slots) if (a !== b && Number(a.weekday) === Number(b.weekday) && String(a.time_start) < String(b.time_end) && String(b.time_start) < String(a.time_end)) throw new Error('overlapping availability intervals');
}
function bookingNotification(booking, admin, status) {
  const lang = langOf(booking.athlete_id);
  const who = admin?.name ? admin.name + ' · ' : '';
  const when = String(booking.date || '').slice(8, 10) + '.' + String(booking.date || '').slice(5, 7) + ' · ' + (booking.time || '');
  const text = { confirmed: {en:'Trainer confirmed your session: ',ru:'Тренер подтвердил запись: '}, rejected:{en:'Trainer declined your request: ',ru:'Тренер отклонил заявку: '}, cancelled:{en:'Your session was cancelled: ',ru:'Запись отменена: '}, done:{en:'Session completed: ',ru:'Тренировка отмечена выполненной: '} }[status];
  const body = who + (text?.[lang] || text?.en || '') + when;
  return { title: lang === 'ru' ? 'Запись к тренеру' : 'Trainer booking', body };
}
function nextHour(t) { const [h, m] = t.split(':').map(Number); return String(h + 1).padStart(2, '0') + ':00'; }
function daySlots(availability, weekday) {
  // Split shifts: merge every interval for this weekday (e.g. 09-12 and 16-21).
  const out = [];
  for (const a of (availability || [])) {
    if (a.weekday !== weekday) continue;
    let t = a.time_start;
    while (t < a.time_end) { if (!out.includes(t)) out.push(t); t = nextHour(t); }
  }
  return out.sort();
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

function normaliseAccessEvent(body) {
  const eventId = String(body.event_id || body.id || '').trim().slice(0, 200);
  const memberKey = String(
    body.member_key || body.external_member_id || body.card_id || body.athlete_id || ''
  ).trim().slice(0, 200);
  const branchKey = String(body.branch_key || body.branch_id || body.club_id || '').trim().slice(0, 100) || null;
  const directionValue = String(body.direction || body.type || 'in').trim().toLowerCase();
  const direction = ['out', 'exit', 'leave', 'checkout'].includes(directionValue) ? 'out'
    : ['unknown', 'test'].includes(directionValue) ? 'unknown' : 'in';
  const rawDate = body.occurred_at || body.timestamp || body.time || Date.now();
  const occurredAt = new Date(rawDate);
  if (!eventId) throw new Error('event_id is required');
  if (!memberKey) throw new Error('member_key is required');
  if (Number.isNaN(occurredAt.getTime())) throw new Error('occurred_at is invalid');
  return { eventId, memberKey, branchKey, direction, occurredAt: occurredAt.toISOString(), payload: body };
}


async function adminAuthOptions(req, res) {
  await adminDbReady;
  const options = await generateAuthenticationOptions({ rpID: RP_ID, userVerification: 'preferred', allowCredentials: [] });
  const cid = putChallenge({ challenge: options.challenge, adminAuth: true });
  json(res, 200, { cid, options });
}

/* ---------- routes ---------- */
const routes = {
  'GET /api/health': async (req, res) => json(res, 200, { ok: true, users: db.users.length }),

  /* ---------- trainer booking (athlete side) ---------- */

  // My assigned trainer.
  'GET /api/trainer/me': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    try {
      await adminDbReady;
      const ta = await listTrainerAssignments();
      const row = ta.find(x => x.user_id === user.id);
      if (!row) return json(res, 200, { trainer: null });
      const admins = await listAdmins();
      const trainer = admins.find(a => a.id === row.trainer_id);
      json(res, 200, { trainer: trainer ? { id: trainer.id, name: trainer.name } : null });
    } catch (error) {
      console.error('trainer/me failed:', error.message);
      json(res, 503, { error: 'service unavailable' });
    }
  },

  // My trainer's working hours + already-taken upcoming slots.
  'GET /api/trainer/availability': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    try {
      await adminDbReady;
      const ta = await listTrainerAssignments();
      const row = ta.find(x => x.user_id === user.id);
      if (!row) return json(res, 200, { availability: [], taken: [] });
      const availability = await getTrainerAvailability(row.trainer_id);
      const bookings = await listBookings({ trainerId: row.trainer_id, from: localToday() });
      const taken = bookings.filter(b => b.status === 'pending' || b.status === 'confirmed')
        .map(b => ({ date: b.date, time: b.time }));
      json(res, 200, { availability, taken });
    } catch (error) {
      console.error('trainer availability failed:', error.message);
      json(res, 503, { error: 'service unavailable' });
    }
  },

  // Request a session (status = pending until the trainer confirms).
  'POST /api/trainer/book': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    const date = String(body.date || '');
    const time = String(body.time || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time))
      return json(res, 400, { error: 'date and time required' });
    try {
      await adminDbReady;
      const ta = await listTrainerAssignments();
      const row = ta.find(x => x.user_id === user.id);
      if (!row) return json(res, 403, { error: 'no trainer assigned' });
      if (date < localToday()) return json(res, 400, { error: 'date is in the past' });
      const availability = await getTrainerAvailability(row.trainer_id);
      const wd = new Date(date + 'T12:00:00').getDay();
      const inHours = availability.some(a => a.weekday === wd && timeInRange(time, a.time_start, a.time_end));
      if (!inHours) return json(res, 400, { error: 'time outside working hours' });
      const conflict = await findBookingConflict(row.trainer_id, date, time);
      if (conflict) return json(res, 409, { error: 'this slot is already booked' });
      const booking = await createBooking({ trainerId: row.trainer_id, athleteId: user.id, date, time, note: body.note, status: 'pending' });
      // the request lands in the trainer's notification center (same table as athletes)
      try {
        await saveNotification({
          id: 'tbk-' + booking.id, userId: 'admin:' + row.trainer_id,
          title: 'Новая заявка на тренировку',
          body: (user.name || 'Спортсмен') + ' · ' + String(booking.date).slice(8, 10) + '.' + String(booking.date).slice(5, 7) + ' · ' + booking.time
            + (body.note ? ' — ' + String(body.note).slice(0, 120) : ''),
          payload: { booking_id: booking.id, status: 'pending', date: booking.date, time: booking.time, kind: 'booking' }
        });
      } catch (e) { console.error('trainer booking notif save failed:', e.message); }
      // push alert to the trainer (no-op if they haven't subscribed from the portal)
      await sendPush('admin:' + row.trainer_id, {
        title: 'Новая заявка на тренировку',
        body: user.name + ' · ' + date + ' ' + time + (body.note ? ' — ' + String(body.note).slice(0, 120) : ''),
        tag: 'booking-' + booking.id,
        data: { booking_id: booking.id }
      }).catch(e => console.error('trainer booking push failed:', e.message));
      json(res, 200, { ok: true, booking });
    } catch (error) {
      console.error('trainer book failed:', error.message);
      json(res, 503, { error: 'service unavailable' });
    }
  },

  // My own bookings.
  'GET /api/trainer/my-bookings': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    try {
      await adminDbReady;
      const bookings = await listBookings({ athleteId: user.id });
      json(res, 200, { bookings });
    } catch (error) {
      console.error('trainer my-bookings failed:', error.message);
      json(res, 503, { error: 'service unavailable' });
    }
  },

  // Athlete cancels one of their own pending/confirmed bookings.
  'POST /api/trainer/bookings/cancel': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    try {
      await adminDbReady;
      const booking = await getBooking(String(body.id || ''));
      if (!booking || booking.athlete_id !== user.id) return json(res, 404, { error: 'no such booking' });
      if (booking.status !== 'pending' && booking.status !== 'confirmed')
        return json(res, 400, { error: 'booking cannot be cancelled' });
      const updated = await updateBookingStatus({ id: booking.id, status: 'cancelled' });
      json(res, 200, { ok: true, booking: updated });
    } catch (error) {
      console.error('trainer cancel failed:', error.message);
      json(res, 503, { error: 'service unavailable' });
    }
  },

  // Public config the login screen needs before anyone is signed in.
  'GET /api/config': async (req, res) => json(res, 200, { invite_only: INVITE_ONLY }),

  'GET /api/loyalty/wallet': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    try { json(res, 200, await getWallet(user.id)); }
    catch (error) { console.error('wallet failed:', error.message); json(res, 503, { error: 'loyalty database unavailable' }); }
  },

  'GET /api/loyalty/rewards': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    try { json(res, 200, { rewards: await listRewards(true) }); }
    catch (error) { console.error('rewards failed:', error.message); json(res, 503, { error: 'loyalty database unavailable' }); }
  },

  'GET /api/notifications': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    try {
      await adminDbReady;
      json(res, 200, { notifications: await listNotifications(user.id) });
    } catch (error) { json(res, 503, { error: 'service unavailable' }); }
  },

  'POST /api/badge/seen': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    try {
      await adminDbReady;
      await markBadgeSeen(user.id);
      json(res, 200, { ok: true });
    } catch (error) { json(res, 503, { error: 'service unavailable' }); }
  },

  // Trainer notification center: same app_notifications table, scoped to the admin session.
  'GET /api/admin/notifications': async (req, res) => {
    const admin = await requireAdminAccount(req, res); if (!admin) return;
    try {
      await adminDbReady;
      json(res, 200, { notifications: await listNotifications('admin:' + admin.id) });
    } catch (error) { json(res, 503, { error: 'service unavailable' }); }
  },

  'POST /api/admin/notifications/read': async (req, res) => {
    const admin = await requireAdminAccount(req, res); if (!admin) return;
    const body = await readBody(req);
    try {
      await adminDbReady;
      await markNotificationsRead('admin:' + admin.id, body.id ? String(body.id) : null);
      json(res, 200, { ok: true, unread: await countUnreadNotifications('admin:' + admin.id) });
    } catch (error) { json(res, 503, { error: 'service unavailable' }); }
  },

  'POST /api/notifications/read': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    try {
      await adminDbReady;
      await markNotificationsRead(user.id, body.id ? String(body.id) : null);
      json(res, 200, { ok: true, unread: await countUnreadNotifications(user.id) });
    } catch (error) { json(res, 503, { error: 'service unavailable' }); }
  },

  'POST /api/loyalty/redeem': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    try { json(res, 200, { ok: true, redemption: await redeemReward({ userId: user.id, rewardId: String(body.reward_id || '') }) }); }
    catch (error) { json(res, 400, { error: error.message }); }
  },

  'GET /api/me': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    json(res, 200, { user: { id: user.id, name: user.name, admin: isAdmin(user) } });
  },

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

  'POST /api/login/options': async (req, res) => {
    const options = await generateAuthenticationOptions({
      rpID: RP_ID, userVerification: 'preferred', allowCredentials: []
    });
    const cid = putChallenge({ challenge: options.challenge });
    json(res, 200, { cid, options });
  },

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
    if (user.disabled) return json(res, 403, { error: 'this account has been disabled' });
    json(res, 200, { user: { id: user.id, name: user.name, admin: isAdmin(user) } }, { 'Set-Cookie': sessionCookie(user) });
  },

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

  'GET /api/data': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    try {
      const state = JSON.parse(fs.readFileSync(stateFile(user.id), 'utf8'));
      json(res, 200, { state });
    } catch { json(res, 200, { state: null }); }
  },

  'PUT /api/data': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    if (!body.state || typeof body.state !== 'object') return json(res, 400, { error: 'state required' });
    delete body.state.active;              // in-progress workouts stay device-local
    atomicWrite(stateFile(user.id), JSON.stringify(body.state));
    json(res, 200, { ok: true, ts: body.state._ts || null });
  },

  'GET /api/push/public-key': async (req, res) => json(res, 200, { key: vapid.publicKey }),

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

  'POST /api/push/test': async (req, res) => {
    const user = readSession(req);
    const adminId = user ? null : adminSessionId(req);
    if (!user && !adminId) return json(res, 401, { error: 'not signed in' });
    await sendPush(user ? user.id : 'admin:' + adminId, { title: 'openGym', body: 'Test notification ✅ — this is what alerts look like.', tag: 'test' });
    json(res, 200, { ok: true });
  },
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

  'GET /api/admin/push/status': async (req, res) => {
    const admin = await requireAdminAccount(req, res); if (!admin) return;
    json(res, 200, {
      stats: pushStats,
      degraded: pushStats.failed > 0 && Date.now() - pushStats.lastFailedAt < 24 * 3600000,
      webhookConfigured: !!PUSH_ALERT_WEBHOOK
    });
  },

  'POST /api/admin/push/status/reset': async (req, res) => {
    const admin = await requireAdminAccount(req, res, ['owner', 'manager']); if (!admin) return;
    pushStats.sent = 0; pushStats.failed = 0; pushStats.expired = 0;
    pushStats.failures = []; pushStats.lastFailedAt = 0; pushStats.lastAlertAt = 0; pushStats.recoverySent = false;
    json(res, 200, { ok: true });
  },

  'POST /api/push/rest-timer': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    const sec = Math.max(1, Math.min(3600, Math.round(+body.seconds || 0)));
    if (!sec) return json(res, 400, { error: 'seconds required' });
    scheduleRestTimer(user.id, sec);
    json(res, 200, { ok: true });
  },

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


  'POST /api/integrations/loyalty/events': async (req, res) => {
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
  },

  'POST /api/integrations/access/events': async (req, res) => {
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
  },


  'POST /api/admin/auth/options': async (req, res) => adminAuthOptions(req, res),

  'POST /api/admin/auth/verify': async (req, res) => {
    const body = await readBody(req);
    const challenge = takeChallenge(body.cid);
    if (!challenge?.adminAuth) return json(res, 400, { error: 'challenge expired — try again' });
    await adminDbReady;
    const credential = await getAdminCredential(body.credential?.id);
    if (!credential) return json(res, 404, { error: 'unknown admin passkey' });
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response: body.credential, expectedChallenge: challenge.challenge,
        expectedOrigin: ORIGIN, expectedRPID: RP_ID, requireUserVerification: false,
        credential: {
          id: credential.id, publicKey: b64uToBuf(credential.public_key), counter: credential.counter,
          transports: credential.transports || []
        }
      });
    } catch (error) { return json(res, 400, { error: 'verification failed: ' + error.message }); }
    if (!verification.verified) return json(res, 400, { error: 'not verified' });
    await updateAdminCounter(credential.id, verification.authenticationInfo.newCounter);
    if (credential.disabled) return json(res, 403, { error: 'admin account disabled' });
    json(res, 200, { admin: { id: credential.admin_id, name: credential.name, role: credential.role } }, { 'Set-Cookie': adminSessionCookie({ id: credential.admin_id }) });
  },

  'GET /api/admin/auth/me': async (req, res) => {
    const admin = await requireAdminAccount(req, res);
    if (admin) {
      const p = adminSessionPayload(req);
      json(res, 200, { admin: { ...admin, impersonated: !!(p && p.kind === 'impersonate') } });
    }
  },

  'POST /api/admin/auth/logout': async (req, res) => json(res, 200, { ok: true }, { 'Set-Cookie': [clearAdminCookie, clearOrigCookie] }),

  // Owner-only: sign in as any athlete (a fresh `gymsid` cookie — the owner's admin session is
  // untouched) or as any staff account (`adminsid` is replaced by an `impersonate:` session; the
  // original session is parked in `adminsid_orig` so it can be restored). The impersonated staff
  // account behaves exactly as if they signed in themselves.
  'POST /api/admin/impersonate': async (req, res) => {
    const owner = await requireAdminAccount(req, res, ['owner']); if (!owner) return;
    const body = await readBody(req);
    const id = String(body.id || '');
    if (!id) return json(res, 400, { error: 'missing target id' });
    const kind = body.kind === 'staff' ? 'staff' : 'athlete';
    const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map(c => {
      const i = c.indexOf('='); return i < 0 ? ['', ''] : [c.slice(0, i).trim(), c.slice(i + 1).trim()];
    }));
    const cur = cookies.adminsid && verifySig(cookies.adminsid);
    if (cur && cur.startsWith('impersonate:')) return json(res, 400, { error: 'сначала вернитесь из текущего режима просмотра' });
    if (kind === 'athlete') {
      const u = db.users.find(x => x.id === id);
      if (!u) return json(res, 404, { error: 'no such athlete' });
      if (u.disabled) return json(res, 400, { error: 'athlete disabled' });
      return json(res, 200, { ok: true, kind, redirect: '/', target: { name: u.name } }, { 'Set-Cookie': sessionCookie(u) });
    }
    try {
      const target = await getAdmin(id);
      if (!target) return json(res, 404, { error: 'no such staff account' });
      if (target.disabled) return json(res, 400, { error: 'staff account disabled' });
      const headers = { 'Set-Cookie': [impersonateSessionCookie(target)] };
      if (cookies.adminsid) headers['Set-Cookie'].push(`adminsid_orig=${cookies.adminsid}; Path=/; Max-Age=86400; HttpOnly;${SECURE} SameSite=Lax`);
      json(res, 200, { ok: true, kind, redirect: target.role === 'trainer' ? '/trainer' : '/admin', target: { name: target.name, role: target.role } }, headers);
    } catch (error) { json(res, 503, { error: error.message }); }
  },

  // Restore the owner's own session after impersonating a staff account. Allowed only while an
  // `impersonate:` session is active — a normal staff session can't "go back" (no privilege gain).
  'POST /api/admin/impersonate/back': async (req, res) => {
    const p = adminSessionPayload(req);
    if (!p) return json(res, 401, { error: 'admin sign-in required' });
    if (p.kind !== 'impersonate') return json(res, 400, { error: 'нет активного режима просмотра' });
    const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map(c => {
      const i = c.indexOf('='); return i < 0 ? ['', ''] : [c.slice(0, i).trim(), c.slice(i + 1).trim()];
    }));
    const payload = cookies.adminsid_orig && verifySig(cookies.adminsid_orig);
    if (!payload) return json(res, 400, { error: 'исходная сессия устарела — войдите заново' });
    const [kind, id] = payload.split(':');
    if (kind !== 'admin' || !id) return json(res, 400, { error: 'исходная сессия повреждена' });
    try {
      const owner = await getAdmin(id);
      if (!owner || owner.disabled) return json(res, 403, { error: 'исходный аккаунт недоступен' });
      json(res, 200, { ok: true, redirect: '/admin' }, { 'Set-Cookie': [adminSessionCookie({ id }), clearOrigCookie] });
    } catch (error) { json(res, 503, { error: error.message }); }
  },

  'POST /api/admin/staff/invite': async (req, res) => {
    const admin = await requireAdminAccount(req, res, ['owner', 'manager']); if (!admin) return;
    const body = await readBody(req);
    try {
      const invite = await createAdminInvite({ name: body.name, role: body.role, createdBy: admin.id });
      json(res, 200, { ok: true, invite });
    } catch (error) { json(res, 400, { error: error.message }); }
  },

  'GET /api/admin/staff': async (req, res) => {
    const admin = await requireAdminAccount(req, res); if (!admin) return;
    json(res, 200, { admins: await listAdmins() });
  },

  'POST /api/admin/staff/update': async (req, res) => {
    const admin = await requireAdminAccount(req, res, ['owner']); if (!admin) return;
    const body = await readBody(req);
    if (body.id === admin.id && body.disabled) return json(res, 400, { error: 'cannot disable yourself' });
    try {
      const updated = await updateAdmin({ id: String(body.id || ''), role: body.role, disabled: body.disabled });
      if (!updated) return json(res, 404, { error: 'admin not found' });
      json(res, 200, { ok: true, admin: updated });
    } catch (error) { json(res, 400, { error: error.message }); }
  },

  'POST /api/admin/staff/register/options': async (req, res) => {
    const body = await readBody(req);
    const rawCode = String(body.code || '').trim().toUpperCase();
    const invite = await getAdminInvite(rawCode);
    if (!invite) {
      const used = await findUsedAdminInvite(rawCode);
      if (used) return json(res, 400, { error: 'код уже использован — сотрудник уже зарегистрирован. Вход: /admin → «Войти как сотрудник» (или попросите новый код)' });
      return json(res, 400, { error: 'invalid or used staff invite' });
    }
    const id = crypto.randomBytes(12).toString('base64url');
    const options = await generateRegistrationOptions({
      rpName: RP_NAME + ' Admin', rpID: RP_ID, userID: Buffer.from(id),
      userName: invite.name, userDisplayName: invite.name, attestationType: 'none',
      authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' }, excludeCredentials: []
    });
    const cid = putChallenge({ challenge: options.challenge, adminRegister: true, adminId: id, inviteCode: invite.code, name: invite.name, role: invite.role });
    json(res, 200, { cid, options });
  },

  'POST /api/admin/staff/register/verify': async (req, res) => {
    const body = await readBody(req);
    const challenge = takeChallenge(body.cid);
    if (!challenge?.adminRegister) return json(res, 400, { error: 'challenge expired — try again' });
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: body.credential, expectedChallenge: challenge.challenge,
        expectedOrigin: ORIGIN, expectedRPID: RP_ID, requireUserVerification: false
      });
    } catch (error) { return json(res, 400, { error: 'verification failed: ' + error.message }); }
    if (!verification.verified) return json(res, 400, { error: 'not verified' });
    const { credential } = verification.registrationInfo;
    try {
      const admin = await registerAdmin({
        id: challenge.adminId, name: challenge.name, role: challenge.role, inviteCode: challenge.inviteCode,
        credentialId: credential.id, publicKey: Buffer.from(credential.publicKey).toString('base64url'),
        counter: credential.counter, transports: body.credential?.response?.transports || []
      });
      json(res, 200, { admin }, { 'Set-Cookie': adminSessionCookie(admin) });
    } catch (error) { json(res, 400, { error: error.message }); }
  },

  'GET /api/admin/loyalty/rewards': async (req, res) => {
    const admin = await requireAdminAccount(req, res); if (!admin) return;
    json(res, 200, { rewards: await listRewards(false) });
  },

  'POST /api/admin/loyalty/rewards/save': async (req, res) => {
    const admin = await requireAdminAccount(req, res, ['owner', 'manager']); if (!admin) return;
    const body = await readBody(req);
    try {
      const reward = await saveReward({ id: body.id, name: body.name, description: body.description, kind: body.kind,
        cost: body.cost, deliveryMode: body.delivery_mode, active: body.active, stock: body.stock, createdBy: admin.id });
      json(res, 200, { ok: true, reward });
    } catch (error) { json(res, 400, { error: error.message }); }
  },

  'POST /api/admin/loyalty/rewards/delete': async (req, res) => {
    const admin = await requireAdminAccount(req, res, ['owner', 'manager']); if (!admin) return;
    try { await deleteReward(String((await readBody(req)).id || '')); json(res, 200, { ok: true }); }
    catch (error) { json(res, 400, { error: error.message }); }
  },

  'GET /api/admin/loyalty/redemptions': async (req, res) => {
    const admin = await requireAdminAccount(req, res); if (!admin) return;
    try { json(res, 200, { redemptions: await listRedemptions() }); }
    catch (error) { json(res, 503, { error: 'loyalty database unavailable' }); }
  },

  'POST /api/admin/loyalty/redemptions/update': async (req, res) => {
    const admin = await requireAdminAccount(req, res); if (!admin) return;
    const body = await readBody(req);
    try { json(res, 200, { ok: true, redemption: await updateRedemption({ id: body.id, status: body.status, adminId: admin.id, note: body.note }) }); }
    catch (error) { json(res, 400, { error: error.message }); }
  },

  'GET /api/admin/loyalty/rules': async (req, res) => {
    const admin = await requireAdminAccount(req, res); if (!admin) return;
    json(res, 200, { rules: await listLoyaltyRules() });
  },

  'POST /api/admin/loyalty/rules/save': async (req, res) => {
    const admin = await requireAdminAccount(req, res, ['owner', 'manager']); if (!admin) return;
    const body = await readBody(req);
    try {
      const rule = await saveLoyaltyRule({ id: body.id, name: body.name, eventType: body.event_type, enabled: body.enabled, conditions: body.conditions, actions: body.actions, limits: body.limits, createdBy: admin.id });
      json(res, 200, { ok: true, rule });
    } catch (error) { json(res, 400, { error: error.message }); }
  },

  'POST /api/admin/loyalty/rules/delete': async (req, res) => {
    const admin = await requireAdminAccount(req, res, ['owner', 'manager']); if (!admin) return;
    const body = await readBody(req);
    try { await deleteLoyaltyRule(String(body.id || '')); json(res, 200, { ok: true }); }
    catch (error) { json(res, 400, { error: error.message }); }
  },

  /* ---------- admin dashboard ---------- */
  // One row per user, cheap enough for a personal instance (reads each state file once).
  'GET /api/admin/users': async (req, res) => {
    const admin = await requireAdminAccount(req, res); if (!admin) return;
    const users = db.users.map(u => {
      const S = readState(u.id) || {};
      const workouts = S.workouts || [];
      const last = workouts[workouts.length - 1];
      return {
        id: u.id, name: u.name, created: u.created || null,
        disabled: !!u.disabled, admin: isAdmin(u), invitedBy: u.invitedBy || null,
        workouts: workouts.length,
        lastWorkout: last ? last.d : null,
        lastSync: S._ts || null,
        hasPush: db.subs.some(s => s.userId === u.id),
        live: livePresence(u.id)
      };
    });
    json(res, 200, { users, invite_only: INVITE_ONLY, now: Date.now() });
  },

  // Drill-down: full workout history + body-weight log for one user.
  'GET /api/admin/user': async (req, res) => {
    const admin = await requireAdminAccount(req, res); if (!admin) return;
    const id = new URL(req.url, 'http://x').searchParams.get('id');
    const u = db.users.find(x => x.id === id);
    if (!u) return json(res, 404, { error: 'no such user' });
    const S = readState(u.id) || {};
    json(res, 200, {
      user: { id: u.id, name: u.name, created: u.created || null, disabled: !!u.disabled, admin: isAdmin(u), invitedBy: u.invitedBy || null },
      unit: S.unit || 'kg',
      lastSync: S._ts || null,
      routines: (S.routines || []).map(r => ({ id: r.id, name: r.name, emoji: r.emoji, count: (r.ex || []).length })),
      bodyweight: S.bodyweight || [],
      workouts: (S.workouts || []).slice().reverse()   // newest first for display
    });
  },

  'POST /api/admin/user/disable': async (req, res) => {
    const admin = await requireAdminAccount(req, res); if (!admin) return;
    const body = await readBody(req);
    const u = db.users.find(x => x.id === body.id);
    if (!u) return json(res, 404, { error: 'no such user' });
    if (isAdmin(u)) return json(res, 400, { error: 'cannot disable an admin' });
    u.disabled = !!body.disabled;
    if (u.disabled) presence.delete(u.id);   // drop them off "training now" at once
    saveDb();
    json(res, 200, { ok: true, id: u.id, disabled: u.disabled });
  },

  /* ---------- analytics: athlete stats, discipline, leaderboard ---------- */
  // Overview: KPI tiles. Every admin role can read it (operator sees the same numbers).
  'GET /api/admin/analytics/overview': async (req, res) => {
    const admin = await requireAdminAccount(req, res); if (!admin) return;
    try {
      const { summary } = await collectAnalytics({ users: db.users, stateOf: readState, scope: analyticsScope(admin) });
      json(res, 200, { summary, scope: analyticsScope(admin) });
    } catch (error) {
      console.error('analytics overview failed:', error.message);
      json(res, 503, { error: 'analytics unavailable' });
    }
  },

  // Athlete table: one row per athlete, scoped to the caller. Frontend renders statuses
  // for an operator and full rows for everyone else.
  'GET /api/admin/analytics/athletes': async (req, res) => {
    const admin = await requireAdminAccount(req, res); if (!admin) return;
    try {
      const { athletes } = await collectAnalytics({ users: db.users, stateOf: readState, scope: analyticsScope(admin) });
      json(res, 200, { athletes, scope: analyticsScope(admin) });
    } catch (error) {
      console.error('analytics athletes failed:', error.message);
      json(res, 503, { error: 'analytics unavailable' });
    }
  },

  // Drill-down: one athlete. Owner/manager (branch-scoped), trainer (own athletes only).
  // Operator has no drill-down.
  'GET /api/admin/analytics/athlete': async (req, res) => {
    const admin = await requireAdminAccount(req, res, ['owner', 'manager', 'trainer']); if (!admin) return;
    const id = new URL(req.url, 'http://x').searchParams.get('id');
    const u = db.users.find(x => x.id === id);
    if (!u) return json(res, 404, { error: 'no such user' });
    try {
      const detail = await athleteDetail({ user: u, stateOf: readState, scope: analyticsScope(admin) });
      json(res, 200, detail);
    } catch (error) {
      if (error.status === 403) return json(res, 403, { error: 'no access to this athlete' });
      console.error('analytics athlete detail failed:', error.message);
      json(res, 503, { error: 'analytics unavailable' });
    }
  },

  // Leaderboard: points / volume / streak. Owner + manager only.
  'GET /api/admin/analytics/leaderboard': async (req, res) => {
    const admin = await requireAdminAccount(req, res, ['owner', 'manager']); if (!admin) return;
    try {
      const { leaderboard } = await collectAnalytics({ users: db.users, stateOf: readState, scope: analyticsScope(admin) });
      json(res, 200, leaderboard);
    } catch (error) {
      console.error('analytics leaderboard failed:', error.message);
      json(res, 503, { error: 'analytics unavailable' });
    }
  },

  // Trainer list for the assignment picker. Owner + manager only.
  'GET /api/admin/analytics/trainers': async (req, res) => {
    const admin = await requireAdminAccount(req, res, ['owner', 'manager']); if (!admin) return;
    try {
      const admins = await listAdmins();
      json(res, 200, { trainers: admins.filter(a => a.role === 'trainer' && !a.disabled).map(a => ({ id: a.id, name: a.name })) });
    } catch (error) {
      console.error('analytics trainers failed:', error.message);
      json(res, 503, { error: 'analytics unavailable' });
    }
  },

  // Assign (or unassign) an athlete to a trainer. Owner/manager pick any trainer;
  // a trainer can only manage their own roster (trainer_id is forced to self).
  'POST /api/admin/analytics/assign': async (req, res) => {
    const admin = await requireAdminAccount(req, res, ['owner', 'manager', 'trainer']); if (!admin) return;
    const body = await readBody(req);
    const userId = String(body.user_id || '').trim();
    let trainerId = String(body.trainer_id || '').trim() || null;
    if (admin.role === 'trainer') trainerId = trainerId ? admin.id : null;
    if (!userId) return json(res, 400, { error: 'user_id required' });
    const u = db.users.find(x => x.id === userId);
    if (!u) return json(res, 404, { error: 'no such user' });
    if (trainerId) {
      const admins = await listAdmins();
      if (!admins.some(a => a.id === trainerId && a.role === 'trainer' && !a.disabled))
        return json(res, 400, { error: 'not a trainer' });
    }
    try {
      const assignment = await setTrainerAssignment({ userId, trainerId });
      json(res, 200, { ok: true, assignment });
    } catch (error) {
      console.error('analytics assign failed:', error.message);
      json(res, 503, { error: 'analytics unavailable' });
    }
  },

  // Athlete search for the trainer portal ("add an existing athlete").
  'GET /api/admin/analytics/users': async (req, res) => {
    const admin = await requireAdminAccount(req, res, ['owner', 'manager', 'trainer']); if (!admin) return;
    const q = String(new URL(req.url, 'http://x').searchParams.get('q') || '').trim().toLowerCase();
    try {
      const [assignments, admins] = await Promise.all([listTrainerAssignments(), listAdmins()]);
      const nameOf = new Map(admins.map(a => [a.id, a.name]));
      const rows = db.users
        .filter(u => !u.admin && (!q || (u.name || '').toLowerCase().includes(q)))
        .slice(0, 25)
        .map(u => {
          const ta = assignments.find(x => x.user_id === u.id);
          return { id: u.id, name: u.name, created: u.created || null, trainerId: ta ? ta.trainer_id : null, trainerName: ta ? (nameOf.get(ta.trainer_id) || null) : null };
        });
      json(res, 200, { users: rows });
    } catch (error) {
      console.error('analytics users failed:', error.message);
      json(res, 503, { error: 'analytics unavailable' });
    }
  },

  // View an athlete's training program + workout history (for per-exercise stats).
  'GET /api/admin/trainer/athlete/program': async (req, res) => {
    const admin = await requireAdminAccount(req, res, ['owner', 'manager', 'trainer']); if (!admin) return;
    const id = String(new URL(req.url, 'http://x').searchParams.get('id') || '');
    const u = db.users.find(x => x.id === id);
    if (!u) return json(res, 404, { error: 'no such user' });
    if (!(await requireProgramAccess(admin, id))) return json(res, 403, { error: 'no access to this athlete' });
    const S = readState(id) || {};
    json(res, 200, {
      unit: S.unit || 'kg',
      routines: S.routines || [],
      week: S.week || {},
      dayPlan: S.dayPlan || {},
      customEx: S.customEx || [],
      workouts: S.workouts || []
    });
  },

  // Save a trainer's edits to the athlete's routines. Merges only `routines` into
  // the athlete's state — workouts and everything else stay untouched, so a stale
  // trainer copy can never clobber the athlete's logs. Sanitised server-side.
  'PUT /api/admin/trainer/athlete/program': async (req, res) => {
    const admin = await requireAdminAccount(req, res, ['owner', 'manager', 'trainer']); if (!admin) return;
    const id = String(new URL(req.url, 'http://x').searchParams.get('id') || '');
    const u = db.users.find(x => x.id === id);
    if (!u) return json(res, 404, { error: 'no such user' });
    if (!(await requireProgramAccess(admin, id))) return json(res, 403, { error: 'no access to this athlete' });
    const body = await readBody(req);
    if (!Array.isArray(body.routines)) return json(res, 400, { error: 'routines required' });
    if (body.routines.length > 20) return json(res, 400, { error: 'too many routines' });
    const routines = body.routines.map(r => {
      const id2 = String(r.id || '').slice(0, 64) || ('r' + crypto.randomBytes(6).toString('base64url'));
      const ex = (Array.isArray(r.ex) ? r.ex : []).slice(0, 60).map(e => ({
        id: String(e.id || '').slice(0, 32),
        sets: Math.max(1, Math.min(20, +e.sets || 3)),
        reps: Math.max(1, Math.min(200, +e.reps || 10)),
        weight: Math.max(0, Math.min(10000, +e.weight || 0))
      }));
      return {
        id: id2,
        name: String(r.name || '').trim().slice(0, 60) || 'Программа',
        emoji: /^[a-zA-Z]{1,24}$/.test(String(r.emoji || '')) ? String(r.emoji) : 'dumbbell',
        prog: /^[a-z_]*$/.test(String(r.prog || '')) ? String(r.prog || '') : '',
        ex
      };
    });
    const S = readState(id) || {};
    S.routines = routines;
    S._ts = Date.now();
    atomicWrite(stateFile(id), JSON.stringify(S));
    json(res, 200, { ok: true, routines });
  },

  /* ---------- trainer calendar (admin side) ---------- */

  // Bookings in a date range. Trainer sees their own; owner/manager see everyone.
  'GET /api/admin/trainer/bookings': async (req, res) => {
    const admin = await requireAdminAccount(req, res, ['owner', 'manager', 'trainer']); if (!admin) return;
    const from = String(new URL(req.url, 'http://x').searchParams.get('from') || '');
    const to = String(new URL(req.url, 'http://x').searchParams.get('to') || '');
    try {
      const trainerId = admin.role === 'trainer' ? admin.id : null;
      const bookings = await listBookings({ trainerId, from: from || undefined, to: to || undefined });
      const [admins, ta] = await Promise.all([listAdmins(), listTrainerAssignments()]);
      const trainerName = new Map(admins.map(a => [a.id, a.name]));
      const rows = bookings.map(b => ({
        ...b,
        trainerName: trainerName.get(b.trainer_id) || null,
        athleteName: (db.users.find(u => u.id === b.athlete_id) || {}).name || null
      }));
      json(res, 200, { bookings: rows });
    } catch (error) {
      console.error('trainer bookings failed:', error.message);
      json(res, 503, { error: 'service unavailable' });
    }
  },

  // Change a booking's status (confirm / reject / cancel / done).
  'POST /api/admin/trainer/bookings/status': async (req, res) => {
    const admin = await requireAdminAccount(req, res, ['owner', 'manager', 'trainer']); if (!admin) return;
    const body = await readBody(req);
    const status = String(body.status || '');
    if (!['pending', 'confirmed', 'rejected', 'cancelled', 'done'].includes(status))
      return json(res, 400, { error: 'bad status' });
    try {
      const booking = await getBooking(String(body.id || ''));
      if (!booking) return json(res, 404, { error: 'no such booking' });
      if (admin.role === 'trainer' && booking.trainer_id !== admin.id)
        return json(res, 403, { error: 'no access to this booking' });
      if (!bookingTransitionAllowed(booking.status, status))
        return json(res, 409, { error: 'invalid booking status transition' });
      const updated = await updateBookingStatus({ id: booking.id, status });
      // let the athlete know their request was answered (confirmed / rejected / cancelled / done)
      if (['confirmed', 'rejected', 'cancelled', 'done'].includes(status)) {
        const lang = langOf(booking.athlete_id);
        const who = admin.name || '';
        const d = String(booking.date || '').slice(8, 10) + '.' + String(booking.date || '').slice(5, 7);
        const when = d + ' · ' + (booking.time || '');
        const texts = {
          confirmed: { en: 'Trainer confirmed your session: ' + when, ru: 'Тренер подтвердил запись: ' + when },
          rejected: { en: 'Trainer declined your request: ' + when, ru: 'Тренер отклонил заявку: ' + when },
          cancelled: { en: 'Your session was cancelled: ' + when, ru: 'Запись отменена: ' + when },
          done: { en: 'Session completed: ' + when, ru: 'Тренировка отмечена выполненной: ' + when }
        }[status] || {};
        const body = (who ? who + ' · ' : '') + (texts[lang] || texts.en);
        const title = lang === 'ru' ? 'Запись к тренеру' : 'Trainer booking';
        // keep it in the in-app notification center too (same idempotent pattern as loyalty)
        try {
          await saveNotification({ id: 'bk-' + booking.id, userId: booking.athlete_id, title, body,
            payload: { booking_id: booking.id, status, date: booking.date, time: booking.time } });
        } catch (e) { console.error('booking notif persist failed:', e.message); }
        await sendPush(booking.athlete_id, {
          title, body,
          tag: 'booking-' + booking.id,
          data: { booking_id: booking.id, status }
        }).catch(e => console.error('athlete booking push failed:', e.message));
      }
      json(res, 200, { ok: true, booking: updated });
    } catch (error) {
      console.error('trainer booking status failed:', error.message);
      json(res, 503, { error: 'service unavailable' });
    }
  },

  // Trainer creates a session directly (status = confirmed).
  'POST /api/admin/trainer/bookings': async (req, res) => {
    const admin = await requireAdminAccount(req, res, ['owner', 'manager', 'trainer']); if (!admin) return;
    const body = await readBody(req);
    const athleteId = String(body.athlete_id || '');
    const date = String(body.date || '');
    const time = String(body.time || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time))
      return json(res, 400, { error: 'date and time required' });
    const u = db.users.find(x => x.id === athleteId);
    if (!u) return json(res, 404, { error: 'no such athlete' });
    try {
      if (admin.role === 'trainer' && !(await requireProgramAccess(admin, athleteId)))
        return json(res, 403, { error: 'no access to this athlete' });
      const conflict = await findBookingConflict(admin.role === 'trainer' ? admin.id : String(body.trainer_id || admin.id), date, time);
      if (conflict) return json(res, 409, { error: 'this slot is already booked' });
      const trainerId = admin.role === 'trainer' ? admin.id : String(body.trainer_id || admin.id);
      const booking = await createBooking({ trainerId, athleteId, date, time, note: body.note, status: 'confirmed' });
      const notice = bookingNotification(booking, admin, 'confirmed');
      try { await saveNotification({ id: 'bk-' + booking.id, userId: athleteId, title: notice.title, body: notice.body, payload: { booking_id: booking.id, status: 'confirmed', date, time } }); } catch (e) { console.error('manual booking notif persist failed:', e.message); }
      await sendPush(athleteId, { title: notice.title, body: notice.body, tag: 'booking-' + booking.id, data: { booking_id: booking.id, status: 'confirmed' } }).catch(e => console.error('manual booking push failed:', e.message));
      json(res, 200, { ok: true, booking });
    } catch (error) {
      console.error('trainer booking create failed:', error.message);
      json(res, 503, { error: 'service unavailable' });
    }
  },

  // Working hours. Trainer edits their own; owner/manager can set any trainer's.
  'GET /api/admin/trainer/availability': async (req, res) => {
    const admin = await requireAdminAccount(req, res, ['owner', 'manager', 'trainer']); if (!admin) return;
    try {
      const trainerId = admin.role === 'trainer' ? admin.id : String(new URL(req.url, 'http://x').searchParams.get('trainer_id') || admin.id);
      json(res, 200, { availability: await getTrainerAvailability(trainerId) });
    } catch (error) {
      console.error('trainer availability get failed:', error.message);
      json(res, 503, { error: 'service unavailable' });
    }
  },
  'POST /api/admin/trainer/availability': async (req, res) => {
    const admin = await requireAdminAccount(req, res, ['owner', 'manager', 'trainer']); if (!admin) return;
    const body = await readBody(req);
    try {
      const trainerId = admin.role === 'trainer' ? admin.id : String(body.trainer_id || admin.id);
      if (!Array.isArray(body.slots)) return json(res, 400, { error: 'slots required' });
      validateAvailabilitySlots(body.slots);
      const availability = await setTrainerAvailability(trainerId, body.slots);
      json(res, 200, { ok: true, availability });
    } catch (error) {
      console.error('trainer availability set failed:', error.message);
      json(res, 503, { error: 'service unavailable' });
    }
  },


  'GET /api/admin/integrations/access/bindings': async (req, res) => {
    const admin = await requireAdminAccount(req, res); if (!admin) return;
    try {
      await integrationDbReady;
      const bindings = await listExternalMembers();
      json(res, 200, { bindings });
    } catch (error) {
      console.error('access bindings list failed:', error.message);
      json(res, 503, { error: 'integration database unavailable' });
    }
  },

  'POST /api/admin/integrations/access/bind': async (req, res) => {
    const admin = await requireAdminAccount(req, res, ['owner', 'manager']); if (!admin) return;
    const body = await readBody(req);
    const memberKey = String(body.member_key || '').trim().slice(0, 200);
    const userId = String(body.user_id || '').trim();
    const branchKey = String(body.branch_key || '').trim().slice(0, 100) || null;
    if (!memberKey || !userId) return json(res, 400, { error: 'member_key and user_id are required' });
    if (!db.users.some(user => user.id === userId)) return json(res, 404, { error: 'user not found' });
    try {
      await integrationDbReady;
      const binding = await bindExternalMember({ memberKey, userId, branchKey });
      json(res, 200, { ok: true, binding });
    } catch (error) {
      console.error('access binding failed:', error.message);
      json(res, 503, { error: 'integration database unavailable' });
    }
  },

  'GET /api/admin/invites': async (req, res) => {
    const admin = await requireAdminAccount(req, res); if (!admin) return;
    // resolve usedBy uid → name for display
    const invites = db.invites.map(i => ({
      ...i, usedByName: i.usedBy ? (db.users.find(u => u.id === i.usedBy) || {}).name || null : null
    }));
    json(res, 200, { invites, invite_only: INVITE_ONLY });
  },

  'POST /api/admin/invites/new': async (req, res) => {
    const admin = await requireAdminAccount(req, res, ['owner', 'manager', 'trainer']); if (!admin) return;
    const body = await readBody(req);
    let code;
    // Default: 16 hex chars = 64 bits. The app has no rate limiting by design (that's the reverse
    // proxy's job) and /api/register/options tells a caller whether a code is good, so the code
    // itself has to be the thing that isn't worth guessing. `short: true` (used by the admin UI)
    // emits 8 chars from a 32-char unambiguous alphabet ≈ 40 bits — still unguessable, but short
    // enough to dictate over the phone. Validation is an exact string compare, never a format check.
    const SAFE32 = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    if (body.short) {
      do { code = Array.from(crypto.randomBytes(8), b => SAFE32[b & 31]).join(''); } while (db.invites.some(i => i.code === code));
    } else {
      do { code = crypto.randomBytes(8).toString('hex').toUpperCase(); } while (db.invites.some(i => i.code === code));
    }
    // A trainer-created invite binds the registering athlete to that trainer.
    let trainerId = admin.role === 'trainer' ? admin.id : String(body.trainer_id || '').trim() || null;
    if (trainerId) {
      const admins = await listAdmins();
      if (!admins.some(a => a.id === trainerId && a.role === 'trainer' && !a.disabled))
        return json(res, 400, { error: 'not a trainer' });
    }
    const invite = { code, note: String(body.note || '').slice(0, 60), createdBy: admin.id, created: new Date().toISOString(), trainerId };
    db.invites.push(invite);
    saveDb();
    json(res, 200, { invite });
  },

  'POST /api/admin/invites/revoke': async (req, res) => {
    const admin = await requireAdminAccount(req, res); if (!admin) return;
    const body = await readBody(req);
    const inv = db.invites.find(i => i.code === String(body.code || '').toUpperCase());
    if (!inv) return json(res, 404, { error: 'no such code' });
    if (inv.usedBy) return json(res, 400, { error: 'already used — cannot revoke' });
    db.invites = db.invites.filter(i => i.code !== inv.code);
    saveDb();
    json(res, 200, { ok: true });
  }
};

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
});
