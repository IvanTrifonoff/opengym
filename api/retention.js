/* api/retention.js — retention ("Удержание") analytics.
   Designed to run as a nightly batch: collectRetention() reads users + state files (+PG when
   available) and produces a snapshot that /admin/analytics/retention simply filters by role.
   During the day we don't re-scan state files or hit the DB — heavy work is done at night.
*/
import { workoutVolume, setsDone } from './analytics.js';

const DAY = 86400000;
const tsOf = d => { const t = new Date(d); return isNaN(t) ? null : t.getTime(); };

export function gapDays(workouts, now = Date.now()) {
  const dts = (workouts || []).map(w => tsOf(w.d)).filter(Boolean).sort((a, b) => b - a);
  if (!dts.length) return null;
  return Math.floor((now - dts[0]) / DAY);
}

// Compare the latest N days vs the preceding N days: frequency (workouts) and sets.
function windowOf(workouts, now, days = 28) {
  const inWin = w => { const t = tsOf(w.d); return t != null && t >= now - days * DAY; };
  const cur = (workouts || []).filter(inWin);
  const prev = (workouts || []).filter(w => { const t = tsOf(w.d); return t != null && t >= now - 2 * days * DAY && t < now - days * DAY; });
  const sumVol = arr => arr.reduce((s, w) => s + workoutVolume(w), 0);
  const sumSets = arr => arr.reduce((s, w) => s + setsDone(w), 0);
  return { curW: cur.length, prevW: prev.length, curV: sumVol(cur), prevV: sumVol(prev), curS: sumSets(cur), prevS: sumSets(prev) };
}

// Progression: best weight across the athlete's program lifts in the last 28d vs the 28d
// before. stalled=true means the most recent top isn't higher than the preceding one.
function progression(routineEx, workouts, now) {
  const want = new Set((routineEx || []).map(e => e.id));
  if (!want.size) return null;
  const topIn = arr => {
    let top = 0;
    arr.forEach(w => (w.entries || []).forEach(e => {
      if (!want.has(e.id)) return;
      (e.sets || []).forEach(s => { if (s.done && (s.w || 0) > top) top = s.w; });
      if (e.topW && e.topW > top) top = e.topW;
    }));
    return top;
  };
  const cur = (workouts || []).filter(w => { const t = tsOf(w.d); return t != null && t >= now - 28 * DAY; });
  const prev = (workouts || []).filter(w => { const t = tsOf(w.d); return t != null && t >= now - 56 * DAY && t < now - 28 * DAY; });
  const tPrev = topIn(prev);
  const tCur = topIn(cur);
  if (!tPrev && !tCur) return null;
  return { top: tCur, prevTop: tPrev, stalled: tPrev ? tCur <= tPrev : false, improving: !!(tPrev && tCur > tPrev) };
}

export function lifetime(state) {
  const ws = (state && state.workouts) || [];
  const dts = ws.map(w => tsOf(w.d)).filter(Boolean).sort((a, b) => a - b);
  if (!dts.length) return null;
  return { firstActivity: dts[0], lastActivity: dts[dts.length - 1], spanDays: Math.floor((dts[dts.length - 1] - dts[0]) / DAY) };
}

function levelKey(score) { return score >= 4.5 ? 'gone' : score >= 2 ? 'at_risk' : 'active'; }

export function riskLevels() {
  return [
    { key: 'active', label: 'Активен', color: 'var(--green)' },
    { key: 'at_risk', label: 'В зоне риска', color: 'var(--yellow)' },
    { key: 'gone', label: 'Ушёл', color: 'var(--red)' }
  ];
}

export async function collectRetention({ users, stateOf, now = Date.now() }) {
  const athletes = users
    .filter(u => !u.admin)
    .map(u => {
      const S = stateOf(u.id) || {};
      const ws = S.workouts || [];
      const gap = gapDays(ws, now);
      const w = windowOf(ws, now);
      const prog = progression((S.routines || []).flatMap(r => r.ex || []), ws, now);
      const life = lifetime(S);
      const reasons = [];
      let score = 0;
      if (gap != null && gap >= 30) { score = Math.max(score, 5); reasons.push('нет активности 30+ дней'); }
      else if (gap != null && gap >= 14) { score = Math.max(score, 4); reasons.push('нет активности 2+ недели'); }
      else if (gap != null && gap >= 7) { score = Math.max(score, 2); reasons.push('нет активности больше недели'); }
      if (w.curW < w.prevW * 0.6 && w.prevW > 0) { score += 2; reasons.push('снижение частоты'); }
      if (prog && prog.stalled) { score += 2; reasons.push('прогресс остановился'); }
      if (w.prevS > 0 && w.curS < w.prevS * 0.6) { score += 1; reasons.push('меньше подходов'); }
      const lastBW = S.bodyweight && S.bodyweight.length ? S.bodyweight[S.bodyweight.length - 1] : null;
      const bwDelta = S.bodyweight && S.bodyweight.length >= 2 ? Math.round((S.bodyweight[S.bodyweight.length - 1].w - S.bodyweight[0].w) * 10) / 10 : null;
      return {
        id: u.id, name: u.name, created: u.created || null,
        workouts: ws.length, lastWorkout: life ? life.lastActivity : null,
        gapDays: gap,
        workouts4w: w.curW, prev4w: w.prevW,
        volume4w: Math.round(w.curV * 10) / 10, prevVolume4w: Math.round(w.prevV * 10) / 10,
        sets4w: w.curS, prevSets4w: w.prevS,
        stall: prog ? prog.stalled : null, topLift: prog ? prog.top : null,
        spanDays: life ? life.spanDays : null,
        bw: lastBW ? lastBW.w : null, bwDelta,
        score: Math.round(score * 10) / 10, reasons,
        level: levelKey(score)
      };
    })
    .filter(Boolean);

  const withActivity = athletes.filter(a => a.workouts);
  const summary = {
    total: athletes.length,
    active: athletes.filter(a => a.level === 'active').length,
    atRisk: athletes.filter(a => a.level === 'at_risk').length,
    gone: athletes.filter(a => a.level === 'gone').length,
    avgGap: withActivity.length ? Math.round(withActivity.reduce((s, a) => s + (a.gapDays || 0), 0) / withActivity.length) : 0,
    atRiskPct: athletes.length ? Math.round(athletes.filter(a => a.level !== 'active').length / athletes.length * 100) : 0
  };
  // Retention funnel: of those who ever trained, how many kept going to 4 / 8 weeks.
  // spanDays = time between first and last workout — the honest "how long they held on".
  // A monotone chain (trained >= week4 >= week8) so it never reads backwards.
  const trained = athletes.filter(a => a.spanDays != null);
  const funnel = {
    trained: trained.length,
    week4: trained.filter(a => a.spanDays >= 21).length,
    week8: trained.filter(a => a.spanDays >= 49).length
  };
  return {
    generatedAt: now, summary, funnel, zones: riskLevels(),
    athletes: [...athletes].sort((a, b) => b.score - a.score)
  };
}

/* scope filtering: mirror of analytics `scope` shapes — {kind:'all'} | {kind:'trainer',trainerId} |
   | {kind:'branch',branch}. Since the snapshot is network-wide, the caller passes an id set. */
export function filterRetention(rows, scope, userIds) {
  if (scope.kind === 'all') return rows;
  if (scope.kind === 'trainer') return rows.filter(r => userIds && userIds.has(r.id));
  return rows;
}