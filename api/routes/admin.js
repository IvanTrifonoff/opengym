// api/routes/admin.js — админ-панель: все роуты /api/admin/*.
//
// Фабрика: принимает зависимости и возвращает [{ method, path, handler }].
// Вынесено из монолита server.js — поведение идентично (импорт, не копия).
// Контуры:
//   - auth/impersonation: passkey-вход, «войти как» (owner), восстановление сессии
//   - staff/users: инвайты/регистрация сотрудников, список и блокировка спортсменов
//   - analytics: KPI, спортсмены (drill-down), лидерборд, тренеры, удержание
//   - trainer calendar: брони, статусы, часы работы, постоянные клиенты
//   - integrations/invites: привязка турникета, коды приглашений
export function createAdminRoutes(deps) {
  const {
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
  } = deps;

  return [

  /* ---------- push monitor: статус доставки + алерты ---------- */
  // Монитор доставки пушей: счётчики sent/failed, деградация за 24ч, есть ли webhook-алерт.
  { method: 'GET', path: '/api/admin/push/status', handler: async (req, res) => {
    const admin = await requireAdminAccount(req, res); if (!admin) return;
    json(res, 200, {
      stats: pushStats,
      degraded: pushStats.failed > 0 && Date.now() - pushStats.lastFailedAt < 24 * 3600000,
      webhookConfigured: !!PUSH_ALERT_WEBHOOK
    });
  } },
  // Owner/manager: сбросить счётчики доставки (после разбора алерта).
  { method: 'POST', path: '/api/admin/push/status/reset', handler: async (req, res) => {
    const admin = await requireAdminAccount(req, res, ['owner', 'manager']); if (!admin) return;
    pushStats.sent = 0; pushStats.failed = 0; pushStats.expired = 0;
    pushStats.failures = []; pushStats.lastFailedAt = 0; pushStats.lastAlertAt = 0; pushStats.recoverySent = false;
    json(res, 200, { ok: true });
  } },

  /* ---------- admin auth (passkey) ---------- */
  { method: 'POST', path: '/api/admin/auth/options', handler: async (req, res) => adminAuthOptions(req, res) },
  // Завершение passkey-входа: проверка подписи WebAuthn, выдача админ-сессии (cookie adminsid).
  { method: 'POST', path: '/api/admin/auth/verify', handler: async (req, res) => {
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
  } },
  // Текущая админ-сессия (с флагом impersonated — «вошёл как» чужой аккаунт).
  { method: 'GET', path: '/api/admin/auth/me', handler: async (req, res) => {
    const admin = await requireAdminAccount(req, res);
    if (admin) {
      const p = adminSessionPayload(req);
      json(res, 200, { admin: { ...admin, impersonated: !!(p && p.kind === 'impersonate') } });
    }
  } },
  // Выход: сброс adminsid и adminsid_orig (оба cookie).
  { method: 'POST', path: '/api/admin/auth/logout', handler: async (req, res) => json(res, 200, { ok: true }, { 'Set-Cookie': [clearAdminCookie, clearOrigCookie] }) },

  // Owner-only: sign in as any athlete (a fresh `gymsid` cookie — the owner's admin session is
  // untouched) or as any staff account (`adminsid` is replaced by an `impersonate:` session; the
  // original session is parked in `adminsid_orig` so it can be restored). The impersonated staff
  // account behaves exactly as if they signed in themselves.
  { method: 'POST', path: '/api/admin/impersonate', handler: async (req, res) => {
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
  } },
  // Restore the owner's own session after impersonating a staff account. Allowed only while an
  // `impersonate:` session is active — a normal staff session can't "go back" (no privilege gain).
  { method: 'POST', path: '/api/admin/impersonate/back', handler: async (req, res) => {
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
  } },

  /* ---------- staff: invite / register / update ---------- */
  // Owner/manager: создать инвайт-код для нового сотрудника (с ролью).
  { method: 'POST', path: '/api/admin/staff/invite', handler: async (req, res) => {
    const admin = await requireAdminAccount(req, res, ['owner', 'manager']); if (!admin) return;
    const body = await readBody(req);
    try {
      const invite = await createAdminInvite({ name: body.name, role: body.role, createdBy: admin.id });
      json(res, 200, { ok: true, invite });
    } catch (error) { json(res, 400, { error: error.message }); }
  } },
  // Список сотрудников (админ-аккаунты с ролями owner/manager/trainer/operator).
  { method: 'GET', path: '/api/admin/staff', handler: async (req, res) => {
    const admin = await requireAdminAccount(req, res); if (!admin) return;
    json(res, 200, { admins: await listAdmins() });
  } },
  // Owner: сменить роль / отключить сотрудника (нельзя отключить самого себя).
  { method: 'POST', path: '/api/admin/staff/update', handler: async (req, res) => {
    const admin = await requireAdminAccount(req, res, ['owner']); if (!admin) return;
    const body = await readBody(req);
    if (body.id === admin.id && body.disabled) return json(res, 400, { error: 'cannot disable yourself' });
    try {
      const updated = await updateAdmin({ id: String(body.id || ''), role: body.role, disabled: body.disabled });
      if (!updated) return json(res, 404, { error: 'admin not found' });
      json(res, 200, { ok: true, admin: updated });
    } catch (error) { json(res, 400, { error: error.message }); }
  } },
  // Начало регистрации сотрудника по инвайт-коду: генерация WebAuthn-челленджа.
  { method: 'POST', path: '/api/admin/staff/register/options', handler: async (req, res) => {
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
  } },
  // Завершение регистрации: погашение кода, создание passkey-аккаунта, авто-вход.
  { method: 'POST', path: '/api/admin/staff/register/verify', handler: async (req, res) => {
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
  } },

  /* ---------- users dashboard ---------- */
  // One row per user, cheap enough for a personal instance (reads each state file once).
  { method: 'GET', path: '/api/admin/users', handler: async (req, res) => {
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
  } },
  // Drill-down: full workout history + body-weight log for one user.
  { method: 'GET', path: '/api/admin/user', handler: async (req, res) => {
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
  } },
  // Заблокировать/разблокировать спортсмена (админа блокировать нельзя).
  { method: 'POST', path: '/api/admin/user/disable', handler: async (req, res) => {
    const admin = await requireAdminAccount(req, res); if (!admin) return;
    const body = await readBody(req);
    const u = db.users.find(x => x.id === body.id);
    if (!u) return json(res, 404, { error: 'no such user' });
    if (isAdmin(u)) return json(res, 400, { error: 'cannot disable an admin' });
    u.disabled = !!body.disabled;
    if (u.disabled) presence.delete(u.id);   // drop them off "training now" at once
    saveDb();
    json(res, 200, { ok: true, id: u.id, disabled: u.disabled });
  } },

  /* ---------- analytics: athlete stats, discipline, leaderboard, retention ---------- */
  // Analytics respect the caller's scope: owner=network, manager=branch, trainer=own athletes.
  // Overview: KPI tiles. Every admin role can read it (operator sees the same numbers).
  { method: 'GET', path: '/api/admin/analytics/overview', handler: async (req, res) => {
    const admin = await requireAdminAccount(req, res); if (!admin) return;
    try {
      const { summary } = await collectAnalytics({ users: db.users, scope: analyticsScope(admin) });
      json(res, 200, { summary, scope: analyticsScope(admin) });
    } catch (error) {
      console.error('analytics overview failed:', error.message);
      json(res, 503, { error: 'analytics unavailable' });
    }
  } },
  // Athlete table: one row per athlete, scoped to the caller. Frontend renders statuses
  // for an operator and full rows for everyone else.
  { method: 'GET', path: '/api/admin/analytics/athletes', handler: async (req, res) => {
    const admin = await requireAdminAccount(req, res); if (!admin) return;
    try {
      const { athletes } = await collectAnalytics({ users: db.users, scope: analyticsScope(admin) });
      // mark clients that have locked recurring («постоянные») slots, with a short schedule summary
      try {
        const days = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
        const rec = await listRecurringSummary();
        const byAth = new Map();
        for (const r of rec) {
          if (!r.active) continue;
          if (!byAth.has(r.athlete_id)) byAth.set(r.athlete_id, []);
          byAth.get(r.athlete_id).push(r);
        }
        const scopeKind = analyticsScope(admin).kind;
        const scout = admin.role === 'trainer' ? admin.id : null;
        for (const a of athletes) {
          const list = byAth.get(a.id) || [];
          const mine = scout ? list.filter(r => r.trainer_id === scout) : list;
          a.recurring = mine.length > 0;
          if (mine.length) {
            const uniq = [...new Set(mine.map(r => days[r.weekday] + ' ' + r.time))];
            a.recurringTime = uniq.slice(0, 3).join(', ') + (uniq.length > 3 ? '…' : '');
          }
        }
      } catch (e) { console.error('recurring annotate failed:', e.message); }
      json(res, 200, { athletes, scope: analyticsScope(admin) });
    } catch (error) {
      console.error('analytics athletes failed:', error.message);
      json(res, 503, { error: 'analytics unavailable' });
    }
  } },
  // Drill-down: one athlete. Owner/manager (branch-scoped), trainer (own athletes only).
  // Operator has no drill-down.
  { method: 'GET', path: '/api/admin/analytics/athlete', handler: async (req, res) => {
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
  } },
  // Leaderboard: points / volume / streak. Owner + manager only.
  { method: 'GET', path: '/api/admin/analytics/leaderboard', handler: async (req, res) => {
    const admin = await requireAdminAccount(req, res, ['owner', 'manager']); if (!admin) return;
    try {
      const { leaderboard } = await collectAnalytics({ users: db.users, scope: analyticsScope(admin) });
      json(res, 200, leaderboard);
    } catch (error) {
      console.error('analytics leaderboard failed:', error.message);
      json(res, 503, { error: 'analytics unavailable' });
    }
  } },
  // Trainer list for the assignment picker. Owner + manager only.
  { method: 'GET', path: '/api/admin/analytics/trainers', handler: async (req, res) => {
    const admin = await requireAdminAccount(req, res, ['owner', 'manager']); if (!admin) return;
    try {
      const admins = await listAdmins();
      json(res, 200, { trainers: admins.filter(a => a.role === 'trainer' && !a.disabled).map(a => ({ id: a.id, name: a.name })) });
    } catch (error) {
      console.error('analytics trainers failed:', error.message);
      json(res, 503, { error: 'analytics unavailable' });
    }
  } },
  // Retention ("Удержание"): serves the nightly precomputed snapshot, filtered by role.
  // No live DB/state scan at request time — the heavy work runs once at night.
  { method: 'GET', path: '/api/admin/analytics/retention', handler: async (req, res) => {
    const admin = await requireAdminAccount(req, res); if (!admin) return;
    try {
      const scope = analyticsScope(admin);
      const snapFile = path.join(DATA, 'retention-snapshot.json');
      let snap = null;
      try { snap = JSON.parse(fs.readFileSync(snapFile, 'utf8')); } catch {}
      // First boot / no nightly run yet: build on demand so the tab is never empty.
      if (!snap || !snap.athletes) {
        const built = await buildRetentionSnapshot({ users: db.users, stateOf: readState, dataDir: DATA });
        snap = built.snap;
      }
      let rows = snap.athletes;
      // scope filtering for trainers (their own athletes) & the network-wide default
      if (scope.kind === 'trainer') {
        const ta = await listTrainerAssignments();
        const mine = new Set(ta.filter(x => x.trainer_id === admin.id).map(x => x.user_id));
        rows = rows.filter(r => mine.has(r.id));
      }
      // Recompute summary/funnel from the filtered rows so a trainer sees THEIR numbers,
      // not the whole network's (the cached snapshot is network-wide).
      const sum = { total: rows.length };
      sum.active = rows.filter(r => r.level === 'active').length;
      sum.atRisk = rows.filter(r => r.level === 'at_risk').length;
      sum.gone = rows.filter(r => r.level === 'gone').length;
      const withAct = rows.filter(r => r.workouts > 0);
      sum.avgGap = withAct.length ? Math.round(withAct.reduce((s, r) => s + (r.gapDays || 0), 0) / withAct.length) : 0;
      sum.atRiskPct = rows.length ? Math.round((rows.length - sum.active) / rows.length * 100) : 0;
      const trained = rows.filter(r => r.spanDays != null);
      const funnel = {
        trained: trained.length,
        week4: trained.filter(r => r.spanDays >= 21).length,
        week8: trained.filter(r => r.spanDays >= 49).length
      };
      json(res, 200, { generatedAt: snap.generatedAt, summary: sum, funnel,
        zones: snap.zones, athletes: rows });
    } catch (error) {
      console.error('retention endpoint failed:', error.message);
      json(res, 503, { error: 'retention unavailable' });
    }
  } },
  // Assign (or unassign) an athlete to a trainer. Owner/manager pick any trainer;
  // a trainer can only manage their own roster (trainer_id is forced to self).
  { method: 'POST', path: '/api/admin/analytics/assign', handler: async (req, res) => {
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
  } },
  // Athlete search for the trainer portal ("add an existing athlete").
  { method: 'GET', path: '/api/admin/analytics/users', handler: async (req, res) => {
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
  } },

  /* ---------- trainer portal (admin side): athlete program ---------- */
  // View an athlete's training program + workout history (for per-exercise stats).
  { method: 'GET', path: '/api/admin/trainer/athlete/program', handler: async (req, res) => {
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
  } },
  // Save a trainer's edits to the athlete's routines. Merges only `routines` into
  // the athlete's state — workouts and everything else stay untouched, so a stale
  // trainer copy can never clobber the athlete's logs. Sanitised server-side.
  { method: 'PUT', path: '/api/admin/trainer/athlete/program', handler: async (req, res) => {
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
  } },

  /* ---------- trainer calendar: bookings ---------- */
  // Bookings in a range: trainer sees their own; owner/manager see everyone.
  { method: 'GET', path: '/api/admin/trainer/bookings', handler: async (req, res) => {
    const admin = await requireAdminAccount(req, res, ['owner', 'manager', 'trainer']); if (!admin) return;
    const from = String(new URL(req.url, 'http://x').searchParams.get('from') || '');
    const to = String(new URL(req.url, 'http://x').searchParams.get('to') || '');
    try {
      const trainerId = admin.role === 'trainer' ? admin.id : null;
      await rollRecurringForward(trainerId || undefined);
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
  } },
  // Change a booking's status (confirm / reject / cancel / done).
  { method: 'POST', path: '/api/admin/trainer/bookings/status', handler: async (req, res) => {
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
  } },
  // Trainer creates a session directly (status = confirmed).
  { method: 'POST', path: '/api/admin/trainer/bookings', handler: async (req, res) => {
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
  } },

  /* ---------- trainer calendar: working hours ---------- */
  // Trainer edits their own; owner/manager can set any trainer's.
  { method: 'GET', path: '/api/admin/trainer/availability', handler: async (req, res) => {
    const admin = await requireAdminAccount(req, res, ['owner', 'manager', 'trainer']); if (!admin) return;
    try {
      const trainerId = admin.role === 'trainer' ? admin.id : String(new URL(req.url, 'http://x').searchParams.get('trainer_id') || admin.id);
      json(res, 200, { availability: await getTrainerAvailability(trainerId) });
    } catch (error) {
      console.error('trainer availability get failed:', error.message);
      json(res, 503, { error: 'service unavailable' });
    }
  } },
  // Записать часы работы (может быть разрывной график: 9-12 и 16-21 в один день).
  { method: 'POST', path: '/api/admin/trainer/availability', handler: async (req, res) => {
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
  } },

  /* ---------- trainer calendar: recurring («постоянные») slots ---------- */
  // Fixed weekly slots reserved for a regular athlete, materialized forward so
  // they lock automatically and can't be taken by others.
  { method: 'GET', path: '/api/admin/trainer/recurring', handler: async (req, res) => {
    const admin = await requireAdminAccount(req, res, ['owner', 'manager', 'trainer']); if (!admin) return;
    try {
      const trainerId = admin.role === 'trainer' ? admin.id : String(new URL(req.url, 'http://x').searchParams.get('trainer_id') || admin.id);
      const rows = await listRecurringSeries(trainerId);
      const skips = await listRecurringSkips(trainerId);
      const byName = new Map(db.users.map(u => [u.id, u.name || u.id]));
      const series = new Map();
      for (const r of rows) {
        if (!series.has(r.series_id)) series.set(r.series_id, {
          series_id: r.series_id, athlete_id: r.athlete_id,
          athleteName: byName.get(r.athlete_id) || r.athlete_id, rules: []
        });
        series.get(r.series_id).rules.push({ weekday: r.weekday, time: r.time });
      }
      for (const [, se] of series) se.skips = skips.filter(x => x.series_id === se.series_id).map(x => x.date);
      json(res, 200, { series: [...series.values()] });
    } catch (error) {
      console.error('recurring list failed:', error.message);
      json(res, 503, { error: 'recurring unavailable' });
    }
  } },
  // Создать «постоянные» слоты: бронируются вперёд и блокируются от чужих записей.
  // Проверяет попадание в часы работы и возвращает конфликты с подсказкой свободного окна.
  { method: 'POST', path: '/api/admin/trainer/recurring', handler: async (req, res) => {
    const admin = await requireAdminAccount(req, res, ['owner', 'manager', 'trainer']); if (!admin) return;
    const body = await readBody(req);
    const athleteId = String(body.athlete_id || '');
    const u = db.users.find(x => x.id === athleteId);
    if (!u) return json(res, 404, { error: 'no such athlete' });
    const trainerId = admin.role === 'trainer' ? admin.id : String(body.trainer_id || admin.id);
    const rules = Array.isArray(body.rules) ? body.rules : [];
    try {
      if (admin.role === 'trainer' && !(await requireProgramAccess(admin, athleteId)))
        return json(res, 403, { error: 'no access to this athlete' });
      const avail = await getTrainerAvailability(trainerId);
      const clean = [];
      const conflicts = [];
      for (const rl of rules) {
        const wd = Math.max(0, Math.min(6, +rl.weekday || 0));
        const tm = String(rl.time || '').slice(0, 5);
        if (!/^\d{2}:\d{2}$/.test(tm)) continue;
        if (!avail.some(a => a.weekday === wd && tm >= a.time_start && tm < a.time_end)) {
          conflicts.push({ weekday: wd, time: tm });
          continue;
        }
        if (clean.some(c => c.weekday === wd && c.time === tm)) continue;
        clean.push({ weekday: wd, time: tm });
      }
      if (conflicts.length) return json(res, 400, {
        error: 'Постоянное время не входит в часы работы',
        details: conflicts.map(c => ({
          weekday: c.weekday, time: c.time,
          available: avail.filter(a => a.weekday === c.weekday).map(a => a.time_start + '\u2013' + a.time_end)
        }))
      });
      if (!clean.length) return json(res, 400, { error: 'at least one day is required' });
      const r = await setRecurringSeries({ trainerId, athleteId, rules: clean });
      const days = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
      const when = clean.map(x => days[x.weekday] + ' ' + x.time).join(', ');
      try {
        await saveNotification({
          id: 'rec-' + r.seriesId, userId: athleteId,
          title: 'Постоянные тренировки с тренером',
          body: (u.name || 'Спортсмен').slice(0, 60) + '! Тренер закрепил за вами слоты: ' + when
            + '. Они бронируются вперёд на 8 недель — эти времена больше не сможет занять другой спортсмен.',
          payload: { kind: 'recurring', seriesId: r.seriesId }
        });
        await sendPush(athleteId, {
          title: 'Постоянные тренировки с тренером',
          body: 'Закреплены слоты: ' + when,
          tag: 'recurring-' + r.seriesId, url: '/notifications',
          data: { kind: 'recurring', seriesId: r.seriesId }
        }).catch(() => {});
      } catch (e) { console.error('recurring notify failed:', e.message); }
      json(res, 200, { ok: true, series_id: r.seriesId, created: r.created });
    } catch (error) {
      console.error('recurring set failed:', error.message);
      json(res, 503, { error: 'service unavailable' });
    }
  } },
  // Удалить серию постоянных слотов (спортсмен получает уведомление).
  { method: 'POST', path: '/api/admin/trainer/recurring/delete', handler: async (req, res) => {
    const admin = await requireAdminAccount(req, res, ['owner', 'manager', 'trainer']); if (!admin) return;
    const body = await readBody(req);
    const athleteId = String(body.athlete_id || '');
    const trainerId = admin.role === 'trainer' ? admin.id : String(body.trainer_id || admin.id);
    try {
      const r = await deleteRecurringSeries({ trainerId, athleteId });
      if (r.seriesId) {
        try {
          await saveNotification({ id: 'rec-del-' + r.seriesId, userId: athleteId,
            title: 'Постоянные тренировки отменены',
            body: 'Тренер убрал закреплённые за вами постоянные слоты.',
            payload: { kind: 'recurring' } });
        } catch (e) { console.error('recurring delete notify failed:', e.message); }
      }
      json(res, 200, { ok: true, series_id: r.seriesId });
    } catch (error) {
      console.error('recurring delete failed:', error.message);
      json(res, 503, { error: 'service unavailable' });
    }
  } },
  // Отменить один конкретный день (например, на отпуск) — серия продолжается дальше.
  { method: 'POST', path: '/api/admin/trainer/recurring/skip', handler: async (req, res) => {
    const admin = await requireAdminAccount(req, res, ['owner', 'manager', 'trainer']); if (!admin) return;
    const body = await readBody(req);
    const athleteId = String(body.athlete_id || '');
    const date = String(body.date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json(res, 400, { error: 'date required' });
    const trainerId = admin.role === 'trainer' ? admin.id : String(body.trainer_id || admin.id);
    try {
      const r = await skipRecurringDate({ trainerId, athleteId, date });
      json(res, 200, { ok: true, series_id: r.seriesId });
    } catch (error) {
      console.error('recurring skip failed:', error.message);
      json(res, 503, { error: error.message });
    }
  } },
  // Вернуть пропущенный день обратно в серию.
  { method: 'POST', path: '/api/admin/trainer/recurring/unskip', handler: async (req, res) => {
    const admin = await requireAdminAccount(req, res, ['owner', 'manager', 'trainer']); if (!admin) return;
    const body = await readBody(req);
    const athleteId = String(body.athlete_id || '');
    const date = String(body.date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json(res, 400, { error: 'date required' });
    const trainerId = admin.role === 'trainer' ? admin.id : String(body.trainer_id || admin.id);
    try {
      const r = await unskipRecurringDate({ trainerId, athleteId, date });
      json(res, 200, { ok: true, series_id: r.seriesId });
    } catch (error) {
      console.error('recurring unskip failed:', error.message);
      json(res, 503, { error: error.message });
    }
  } },

  /* ---------- integrations: access-control bindings ---------- */
  // Список привязок внешних участников (турникет/CRM) к спортсменам.
  { method: 'GET', path: '/api/admin/integrations/access/bindings', handler: async (req, res) => {
    const admin = await requireAdminAccount(req, res); if (!admin) return;
    try {
      await integrationDbReady;
      const bindings = await listExternalMembers();
      json(res, 200, { bindings });
    } catch (error) {
      console.error('access bindings list failed:', error.message);
      json(res, 503, { error: 'integration database unavailable' });
    }
  } },
  // Owner/manager: привязать внешнего участника (турникет/CRM) к спортсмену приложения.
  { method: 'POST', path: '/api/admin/integrations/access/bind', handler: async (req, res) => {
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
  } },

  /* ---------- invites ---------- */
  // Все инвайт-коды: не использован / кем использован, режим short.
  { method: 'GET', path: '/api/admin/invites', handler: async (req, res) => {
    const admin = await requireAdminAccount(req, res); if (!admin) return;
    // resolve usedBy uid → name for display
    const invites = db.invites.map(i => ({
      ...i, usedByName: i.usedBy ? (db.users.find(u => u.id === i.usedBy) || {}).name || null : null
    }));
    json(res, 200, { invites, invite_only: INVITE_ONLY });
  } },
  // Создать инвайт-код для регистрации. short:true — короткий код для диктовки по телефону.
  // Тренер может создать код, привязывающий новичка сразу к себе (trainerId).
  { method: 'POST', path: '/api/admin/invites/new', handler: async (req, res) => {
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
  } },
  // Отозвать неиспользованный инвайт-код (использованный отозвать нельзя).
  { method: 'POST', path: '/api/admin/invites/revoke', handler: async (req, res) => {
    const admin = await requireAdminAccount(req, res); if (!admin) return;
    const body = await readBody(req);
    const inv = db.invites.find(i => i.code === String(body.code || '').toUpperCase());
    if (!inv) return json(res, 404, { error: 'no such code' });
    if (inv.usedBy) return json(res, 400, { error: 'already used — cannot revoke' });
    db.invites = db.invites.filter(i => i.code !== inv.code);
    saveDb();
    json(res, 200, { ok: true });
  } }
  ];
}
