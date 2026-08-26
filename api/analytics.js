/* api/analytics.js — athlete analytics for the admin dashboard.
   Read-only. Aggregates what we already store:
     · per-user JSON state files (workouts, bodyweight, routines) — passed in via stateOf()
     · PostgreSQL: visits (СКУД), loyalty_ledger, loyalty_accounts, redemptions,
       achievements, trainer assignments, branch of last visit.
   No writes here — the only write endpoint (assigning an athlete to a trainer)
   lives in admin-db.js.
*/
import { pool, integrationDbReady } from './access-db.js';

const DAY = 86400000;

function isoOf(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function weekKeyOf(d) {
  const dt = new Date(d + 'T12:00:00');
  const day = (dt.getDay() + 6) % 7;
  dt.setDate(dt.getDate() - day + 3);
  const jan4 = new Date(dt.getFullYear(), 0, 4);
  const week = 1 + Math.round(((dt - jan4) / 86400000 - 3 + ((jan4.getDay() + 6) % 7)) / 7);
  return dt.getFullYear() + '-' + week;
}
const tsOf = d => { const t = new Date(d); return isNaN(t) ? null : t.getTime(); };
const round1 = n => Math.round(n * 10) / 10;

export function workoutVolume(w) {
  let v = 0;
  (w.entries || []).forEach(e => (e.sets || []).forEach(s => { if (s.done) v += (s.w || 0) * (s.r || 0); }));
  return round1(v);
}
export function setsDone(w) {
  let n = 0;
  (w.entries || []).forEach(e => (e.sets || []).forEach(s => { if (s.done) n++; }));
  return n;
}
export function streakWeeks(workouts, now = Date.now()) {
  const weeks = new Set((workouts || []).map(w => weekKeyOf(w.d)));
  if (!weeks.size) return 0;
  let streak = 0;
  const cur = new Date(now);
  for (let i = 0; i < 520; i++) {
    if (weeks.has(weekKeyOf(isoOf(cur)))) streak++;
    else if (i > 0) break;
    cur.setDate(cur.getDate() - 7);
  }
  return streak;
}

/* ---------- PG aggregates (all users at once, one query each) ---------- */
async function pgAggregates(now) {
  const empty = { visitsByUser: new Map(), pointsByUser: new Map(), ledgerByUser: new Map(), redemptionsByUser: new Map(), achByUser: new Map(), trainerByUser: new Map(), branchByUser: new Map() };
  await integrationDbReady;
  if (!pool) return empty;
  const mapOf = rows => rows.reduce((m, r) => { m.set(r.user_id, r); return m; }, new Map());
  try {
    const [v, acc, ld, rd, ac, ta, bd] = await Promise.all([
      pool.query(
        `SELECT user_id, count(*)::int AS n, max(occurred_at) AS last,
                count(*) FILTER (WHERE occurred_at > $1)::int AS n30,
                (array_agg(branch_key ORDER BY occurred_at DESC) FILTER (WHERE branch_key IS NOT NULL))[1] AS branch
         FROM visits GROUP BY user_id`,
        [new Date(now - 30 * DAY)]
      ),
      pool.query('SELECT user_id, balance FROM loyalty_accounts'),
      pool.query(
        `SELECT user_id,
                COALESCE(sum(amount) FILTER (WHERE amount > 0), 0)::int AS issued,
                COALESCE(-sum(amount) FILTER (WHERE amount < 0), 0)::int AS spent,
                max(occurred_at) AS last
         FROM loyalty_ledger GROUP BY user_id`
      ),
      pool.query(
        `SELECT user_id, count(*)::int AS n, COALESCE(sum(cost), 0)::int AS cost
         FROM loyalty_redemptions WHERE status <> 'rejected' GROUP BY user_id`
      ),
      pool.query('SELECT user_id, count(*)::int AS n FROM loyalty_achievements GROUP BY user_id'),
      pool.query('SELECT user_id, trainer_id FROM trainer_assignments'),
      pool.query('SELECT user_id, branch_key FROM external_member_bindings')
    ]);
    return {
      visitsByUser: mapOf(v.rows),
      pointsByUser: mapOf(acc.rows),
      ledgerByUser: mapOf(ld.rows),
      redemptionsByUser: mapOf(rd.rows),
      achByUser: mapOf(ac.rows),
      trainerByUser: ta.rows.reduce((m, r) => { m.set(r.user_id, r.trainer_id); return m; }, new Map()),
      branchByUser: mapOf(bd.rows)
    };
  } catch (error) {
    console.error('analytics aggregates failed:', error.message);
    return empty;
  }
}

/* ---------- one athlete row ---------- */
function athleteRow(u, S, pg, now) {
  const workouts = S ? (S.workouts || []) : [];
  const unit = (S && S.unit) || 'kg';
  const lastW = workouts.length ? workouts[workouts.length - 1] : null;
  const lastWorkout = lastW ? tsOf(lastW.d) : null;
  const cut30 = now - 30 * DAY;
  const workouts30 = workouts.filter(w => tsOf(w.d) >= cut30).length;
  const volume = (S ? S.workouts || [] : []).reduce((v, w) => v + workoutVolume(w), 0);
  const volume30 = (S ? S.workouts || [] : []).filter(w => tsOf(w.d) >= cut30).reduce((v, w) => v + workoutVolume(w), 0);
  const vis = pg.visitsByUser.get(u.id);
  const ld = pg.ledgerByUser.get(u.id);
  const points = pg.pointsByUser.get(u.id);
  const bw = S && S.bodyweight && S.bodyweight.length ? S.bodyweight[S.bodyweight.length - 1] : null;
  const bw30 = S && S.bodyweight && S.bodyweight.length >= 2 ? S.bodyweight[S.bodyweight.length - 1].w - S.bodyweight[0].w : null;
  const lastVisit = vis && vis.last ? tsOf(vis.last) : null;
  const lastLedger = ld && ld.last ? tsOf(ld.last) : null;
  const lastActivity = [lastVisit, lastWorkout, lastLedger].filter(Boolean).reduce((a, b) => Math.max(a, b), 0) || null;
  const freqN = Math.max(vis ? vis.n30 : 0, workouts30);
  const branch = (vis && vis.branch) || (pg.branchByUser.get(u.id) || {}).branch_key || null;
  const row = {
    id: u.id, name: u.name, created: u.created || null, disabled: !!u.disabled,
    unit,
    branch,
    trainerId: pg.trainerByUser.get(u.id) || null,
    visits: vis ? vis.n : 0, visits30: vis ? vis.n30 : 0, lastVisit,
    workouts: workouts.length, workouts30, lastWorkout,
    volume: round1(volume), volume30: round1(volume30),
    streak: streakWeeks(workouts, now),
    freq: round1(freqN / (30 / 7)),
    lastActivity,
    points: points ? points.balance : 0,
    issued: ld ? ld.issued : 0, spent: ld ? ld.spent : 0,
    redemptions: pg.redemptionsByUser.get(u.id) ? pg.redemptionsByUser.get(u.id).n : 0,
    achievements: pg.achByUser.get(u.id) ? pg.achByUser.get(u.id).n : 0,
    bw: bw ? bw.w : null, bwDelta30: bw30 != null ? round1(bw30) : null
  };
  row.status = statusOf(row, now);
  return row;
}

function statusOf(row, now) {
  if (!row.lastActivity) return row.created && now - tsOf(row.created) < 90 * DAY ? 'new' : 'gone';
  const age = now - row.lastActivity;
  if (age <= 14 * DAY) return 'active';
  if (age <= 30 * DAY) return 'at_risk';
  return 'gone';
}

/* ---------- scope filtering ---------- */
// scope: { kind: 'all' } | { kind: 'branch', branch } | { kind: 'trainer', trainerId } | { kind: 'statuses' }
export function canSeeAthlete(scope, row) {
  if (scope.kind === 'all') return true;
  if (scope.kind === 'branch') return !scope.branch || row.branch === scope.branch;
  if (scope.kind === 'trainer') return row.trainerId === scope.trainerId;
  return true; // statuses: same list, frontend gates what it renders
}
export function filterAthletes(rows, scope) {
  return scope.kind === 'all' ? rows : rows.filter(r => canSeeAthlete(scope, r));
}

/* ---------- main collector ---------- */
export async function collectAnalytics({ users, stateOf, scope, now = Date.now() }) {
  const pg = await pgAggregates(now);
  const all = users
    .filter(u => !u.admin)                       // staff accounts live in the admin DB, not here
    .map(u => athleteRow(u, stateOf(u.id) || {}, pg, now))
    .filter(Boolean);
  const athletes = filterAthletes(all, scope).sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  const inScope = athletes;
  const withActivity = inScope.filter(r => r.lastActivity || r.workouts || r.visits);
  const active = inScope.filter(r => r.status === 'active').length;
  const atRisk = inScope.filter(r => r.status === 'at_risk').length;
  const gone = inScope.filter(r => r.status === 'gone').length;
  const fresh = inScope.filter(r => r.status === 'new').length;
  const base = withActivity.length || 1;
  const avgFreq = withActivity.length ? round1(withActivity.reduce((s, r) => s + r.freq, 0) / withActivity.length) : 0;

  const summary = {
    total: inScope.length,
    active, atRisk, gone, fresh,
    atRiskPct: Math.round(atRisk / base * 100),
    avgFreq,
    visits30: inScope.reduce((s, r) => s + r.visits30, 0),
    workouts30: inScope.reduce((s, r) => s + r.workouts30, 0),
    volume30: round1(inScope.reduce((s, r) => s + r.volume30, 0)),
    pointsIssued: inScope.reduce((s, r) => s + r.issued, 0),
    pointsSpent: inScope.reduce((s, r) => s + r.spent, 0),
    redemptions: inScope.reduce((s, r) => s + r.redemptions, 0)
  };

  const leaderboard = {
    byPoints: [...inScope].sort((a, b) => b.points - a.points).slice(0, 10).map(r => ({ id: r.id, name: r.name, value: r.points })),
    byVolume: [...inScope].sort((a, b) => b.volume - a.volume).slice(0, 10).map(r => ({ id: r.id, name: r.name, value: r.volume, unit: r.unit })),
    byStreak: [...inScope].sort((a, b) => b.streak - a.streak).slice(0, 10).map(r => ({ id: r.id, name: r.name, value: r.streak }))
  };

  return { athletes, summary, leaderboard };
}

/* ---------- drill-down: one athlete ---------- */
export async function athleteDetail({ user, stateOf, scope, now = Date.now() }) {
  const pg = await pgAggregates(now);
  const row = athleteRow(user, stateOf(user.id) || {}, pg, now);
  if (!canSeeAthlete(scope, row)) {
    const err = new Error('no access to this athlete'); err.status = 403; throw err;
  }
  const S = stateOf(user.id) || {};
  const workouts = S.workouts || [];
  const unit = S.unit || 'kg';

  // last 12 weeks: visits / workouts / volume buckets
  const weeks = [];
  for (let i = 11; i >= 0; i--) {
    const start = new Date(now - i * 7 * DAY);
    const key = weekKeyOf(isoOf(start));
    weeks.push({ key, label: isoOf(start).slice(5), visits: 0, workouts: 0, volume: 0 });
  }
  const wkIndex = new Map(weeks.map((w, i) => [w.key, i]));
  (pg.visitsByUser.get(user.id) ? [] : []); // visits come from detail query below
  const visits = await detailVisits(user.id);
  visits.forEach(v => { const i = wkIndex.get(weekKeyOf(isoOf(new Date(v.occurred_at)))); if (i != null) weeks[i].visits++; });
  workouts.forEach(w => { const i = wkIndex.get(weekKeyOf(w.d)); if (i != null) { weeks[i].workouts++; weeks[i].volume += workoutVolume(w); } });
  weeks.forEach(w => { w.volume = round1(w.volume); });

  // best lifts: top weight per exercise across done sets
  const best = {};
  workouts.forEach(w => (w.entries || []).forEach(e => {
    (e.sets || []).forEach(s => {
      if (s.done && (s.w || 0) > 0) {
        const cur = best[e.id];
        if (!cur || s.w > cur.w) best[e.id] = { id: e.id, w: s.w, r: s.r || 0, d: w.d };
      }
    });
    if (e.topW && (!best[e.id] || e.topW > best[e.id].w)) best[e.id] = { id: e.id, w: e.topW, r: 0, d: w.d };
  }));
  const bestLifts = Object.values(best).sort((a, b) => b.w - a.w).slice(0, 12);

  const recentWorkouts = [...workouts].reverse().slice(0, 10).map(w => ({
    d: w.d, volume: workoutVolume(w), sets: setsDone(w), ex: (w.entries || []).length
  }));

  const bw = (S.bodyweight || []).map(b => ({ t: b.t || tsOf(b.d) || 0, y: b.w, d: b.d }));

  const ledger = await detailLedger(user.id);
  const redemptions = await detailRedemptions(user.id);
  const achievements = await detailAchievements(user.id);

  return {
    user: { id: user.id, name: user.name, created: user.created || null, disabled: !!user.disabled, branch: row.branch, trainerId: row.trainerId },
    unit, status: row.status, lastActivity: row.lastActivity,
    visits: row.visits, visits30: row.visits30, lastVisit: row.lastVisit,
    workouts: row.workouts, workouts30: row.workouts30, lastWorkout: row.lastWorkout,
    volume: row.volume, volume30: row.volume30, streak: row.streak, freq: row.freq,
    points: row.points, issued: row.issued, spent: row.spent,
    redemptionsCount: row.redemptions, achievementsCount: row.achievements,
    bw, bwDelta30: row.bwDelta30,
    weeks, bestLifts, recentWorkouts,
    ledger, redemptions, achievements
  };
}

async function detailVisits(userId) {
  if (!pool) return [];
  try {
    const r = await pool.query('SELECT occurred_at FROM visits WHERE user_id = $1 ORDER BY occurred_at', [userId]);
    return r.rows;
  } catch (e) { console.error('detail visits failed:', e.message); return []; }
}
async function detailLedger(userId) {
  if (!pool) return [];
  try {
    const r = await pool.query(
      `SELECT action_key, amount, reason, occurred_at FROM loyalty_ledger
       WHERE user_id = $1 ORDER BY occurred_at DESC LIMIT 60`, [userId]);
    return r.rows;
  } catch (e) { console.error('detail ledger failed:', e.message); return []; }
}
async function detailRedemptions(userId) {
  if (!pool) return [];
  try {
    const r = await pool.query(
      `SELECT r.reward_id, r.cost, r.status, r.created_at, w.name AS reward_name
       FROM loyalty_redemptions r LEFT JOIN loyalty_rewards w ON w.id = r.reward_id
       WHERE r.user_id = $1 ORDER BY r.created_at DESC LIMIT 40`, [userId]);
    return r.rows;
  } catch (e) { console.error('detail redemptions failed:', e.message); return []; }
}
async function detailAchievements(userId) {
  if (!pool) return [];
  try {
    const r = await pool.query(
      `SELECT achievement_key, created_at FROM loyalty_achievements
       WHERE user_id = $1 ORDER BY created_at DESC LIMIT 40`, [userId]);
    return r.rows;
  } catch (e) { console.error('detail achievements failed:', e.message); return []; }
}
