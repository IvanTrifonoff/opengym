// api/demo-seed.js — серверная фабрика демо-состояния спортсмена (клон «Демо-клуба»).
//
// Чистые функции без БД и I/O: генерируют JSON-состояние, идентичное тому, что
// пишет приложение (PUT /api/data) — те же ключи и формы, что у frontend
// src/lib/demoSeed.js, чтобы вкладки статистики, целей и удержания в демо
// показывали живые графики, а не пустоту.
//
// Три персоны (для owner-аналитики «кто уходит и почему», см. docs/demo-club.md):
//   regular — ходит 26 недель 3×/нед, вес растёт, цели близки/достигнуты;
//   casual  — 10 недель 2×/нед, пропуски, прогресс вялый;
//   churn   — 4 недели с затухающей посещаемостью, потом тишина — витрина
//             ухода клиента (длинный gap в retention-статистике тренера/владельца).

// Расписание стартовой программы (id упражнений — из каталога, как в starter.js).
const ROUTINE_SPEC = {
  push: { name: 'Push Day', emoji: 'barbell', ex: [['0025', 4, 8], ['0047', 3, 10], ['0426', 3, 10], ['0334', 3, 12], ['0241', 3, 12], ['0251', 3, 10]] },
  pull: { name: 'Pull Day', emoji: 'pullup', ex: [['2330', 4, 10], ['0027', 4, 8], ['1323', 3, 10], ['0031', 3, 10], ['0313', 3, 12]] },
  legs: { name: 'Leg Day', emoji: 'legs', ex: [['0043', 4, 8], ['0085', 3, 10], ['0739', 3, 12], ['0585', 3, 12], ['0586', 3, 12]] }
};

// Стартовый вес и недельный шаг (кг) по упражнениям — базовые линии персон.
const PROG = {
  '0025': [70, 1.25], '0047': [45, 1], '0426': [20, 0.5], '0334': [10, 0.25], '0241': [25, 0.75], '0251': [0, 0],
  '2330': [50, 1.25], '0027': [50, 1], '1323': [45, 1], '0031': [30, 0.5], '0313': [12, 0.3],
  '0043': [70, 1.5], '0085': [60, 1.25], '0739': [120, 3], '0585': [45, 1], '0586': [40, 1]
};

// Конфиги персон. scale — доля недельного шага (вялый прогресс), missByWeek —
// вероятность пропуска по неделям (для churn растёт к 1 — «ушёл»).
const PERSONAS = {
  regular: {
    weeks: 26, days: { 1: 'push', 3: 'pull', 5: 'legs' }, miss: 0.05, deloadEvery: 6,
    scale: 1, effort: 'rir', bwFrom: 82.4, bwTo: 78.3, targetW: 77,
    goals: [{ exId: '0025', w: 100 }, { exId: '0043', w: 110 }]
  },
  casual: {
    weeks: 10, days: { 2: 'push', 4: 'legs' }, miss: 0.15, deloadEvery: 0,
    scale: 0.5, effort: '', bwFrom: 65.2, bwTo: 64.8, targetW: 63,
    goals: [{ exId: '0025', w: 80 }, { exId: '0043', w: 90 }]
  },
  churn: {
    weeks: 5, days: { 1: 'push', 3: 'pull', 5: 'legs' }, miss: 0, deloadEvery: 0,
    scale: 0.4, effort: '', bwFrom: 88, bwTo: 87.9, targetW: 85,
    missByWeek: [0.1, 0.25, 0.6, 1, 1],   // последние 2 недели — ни одного визита
    goals: []
  }
};

// Детерминированный PRNG — демо выглядит одинаково при каждом спавне.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round = (w, step) => Math.round(w / step) * step;
const isoOf = d => d.toISOString().slice(0, 10);
const at = (date, h, m) => { const d = new Date(date); d.setHours(h, m, 0, 0); return d.getTime(); };
const monday = date => { const d = new Date(date); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); d.setHours(12, 0, 0, 0); return +d; };

let uidSeq = 0;
const uid = prefix => (prefix || 'd') + (++uidSeq).toString(36);

function makeRoutines() {
  const out = {};
  for (const [key, spec] of Object.entries(ROUTINE_SPEC)) {
    out[key] = { id: 'rt_' + uid('r'), name: spec.name, emoji: spec.emoji,
      ex: spec.ex.map(([id, sets, reps]) => ({ id, sets, reps, weight: 0 })) };
  }
  return out;
}

// Целевые упражнения персоны выставляем на реальную линию прогресса: цели
// подбираются так, чтобы у regular они были близки к выполнению, у casual —
// на половине пути (виден прогресс-бар, но цель не достигнута).
export function bestWeightsOf(S) {
  const best = {};
  for (const w of (S.workouts || [])) {
    for (const e of (w.entries || [])) {
      for (const s of (e.sets || [])) {
        if (s && s.done && (s.w || 0) > (best[e.id] || 0)) best[e.id] = s.w;
      }
    }
  }
  return best;
}

// Сборка состояния персоны. `now` — «сегодня» (для тестов можно передать свою дату).
export function buildDemoState({ persona = 'regular', now = new Date() } = {}) {
  const cfg = PERSONAS[persona];
  if (!cfg) throw new Error('unknown demo persona: ' + persona);
  const rnd = rng(persona === 'regular' ? 20260723 : persona === 'casual' ? 20260901 : 20260902);
  uidSeq = 0;
  const routines = makeRoutines();
  const byWeekday = {};
  for (const [wd, key] of Object.entries(cfg.days)) byWeekday[+wd] = routines[key];

  const today = new Date(now); today.setHours(12, 0, 0, 0);
  const start = new Date(today); start.setDate(start.getDate() - cfg.weeks * 7);
  const nowH = new Date(now).getHours();

  const workouts = [];
  const bodyweight = [];
  const exWeights = {};
  const best = {};
  let wIdx = 0;

  for (let d = new Date(start); d <= today; d.setDate(d.getDate() + 1)) {
    const day = new Date(d);
    const iso = isoOf(day);
    const weekIdx = Math.floor((day - start) / (7 * 86400000));
    const weekNo = Math.floor((monday(day) - monday(start)) / (7 * 86400000));
    const p = Math.min(1, weekIdx / cfg.weeks);
    const missThisWeek = cfg.miss === 0 && cfg.missByWeek ? cfg.missByWeek[Math.min(weekNo, cfg.weeks - 1)] : cfg.miss;

    // взвешивания: понедельник и четверг утром
    if (day.getDay() === 1 || day.getDay() === 4) {
      const w = cfg.bwFrom + (cfg.bwTo - cfg.bwFrom) * p + (rnd() - 0.5) * 0.7;
      bodyweight.push({ d: iso, w: Math.round(w * 10) / 10, t: at(day, 7, 30) });
    }

    const routine = byWeekday[day.getDay()];
    if (!routine) continue;
    if (rnd() < missThisWeek) continue;
    if (iso === isoOf(today) && nowH < 18) continue;

    const weekP = Math.min(1, weekIdx / Math.max(1, cfg.weeks));
    const rir0 = 2.3 - weekP * 0.4;                 // со временем тренируются ближе к отказу
    const deload = cfg.deloadEvery && weekNo > 0 && weekNo % cfg.deloadEvery === 0 ? 0.88 : 1;
    const prs = [];
    const entries = routine.ex.map(cfgEx => {
      const [base, inc] = PROG[cfgEx.id] || [20, 0.5];
      const step = base >= 40 ? 2.5 : 1.25;
      const w = base ? Math.max(step, round((base + inc * weekIdx * cfg.scale) * deload, step)) : 0;
      const sets = [];
      for (let i = 0; i < cfgEx.sets; i++) {
        const drop = i === cfgEx.sets - 1 && rnd() < 0.55 ? (rnd() < 0.4 ? 2 : 1) : 0;
        const s = { w, r: Math.max(4, cfgEx.reps - drop), done: true };
        if (cfg.effort) {
          s[cfg.effort] = clamp(round(rir0 - i * 0.5 + (rnd() - 0.5), 0.5), 0, 6);
        }
        sets.push(s);
      }
      if (w > (best[cfgEx.id] || 0)) { best[cfgEx.id] = w; prs.push(cfgEx.id); }
      exWeights[cfgEx.id] = { w: Math.max(w, exWeights[cfgEx.id]?.w || 0), d: iso };
      return { id: cfgEx.id, sets, topW: w || null };
    });

    const bw = bodyweight.length ? bodyweight[bodyweight.length - 1].w : cfg.bwFrom;
    const startMs = at(day, 18, 5 + Math.floor(rnd() * 25));
    const w = {
      id: uid('w'), d: iso, start: startMs, end: startMs + (46 + Math.floor(rnd() * 26)) * 60000,
      routineId: routine.id, name: routine.name, bw,
      entries,
      prs: wIdx === 0 ? [] : prs
    };
    w.vol = entries.reduce((v, e) => v + e.sets.reduce((n, s) => n + s.w * s.r, 0), 0);
    workouts.push(w);
    wIdx++;
  }

  // Цели: createdAt — через 2 недели от старта.
  const goals = (cfg.goals || []).map((g, i) => ({
    id: uid('g'), exId: g.exId, w: g.w, unit: 'kg',
    createdAt: isoOf(new Date(start.getTime() + 14 * 86400000))
  }));

  return {
    routines: Object.values(routines),
    week: Object.fromEntries(Object.entries(cfg.days).map(([wd, key]) => [+wd, routines[key].id])),
    dayPlan: {},
    workouts, bodyweight, exWeights,
    targetW: cfg.targetW,
    effort: cfg.effort || undefined,
    lang: 'ru', unit: 'kg',
    goals
  };
}