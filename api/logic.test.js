// api/logic.test.js — юнит-тесты чистой бизнес-логики (node:test).
// Запуск: cd api && node --test logic.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validTime, timeInRange, bookingTransitionAllowed, validateAvailabilitySlots,
  effectiveRoutineId, nextHour, daySlots, userNow, normaliseAccessEvent
} from './logic.js';
import { trendPct, workoutVolume } from './analytics.js';
import { metricsFromState } from './metrics.js';
import { streakFromWeeks } from './analytics.js';

/* ---------- validTime ---------- */
test('validTime: принимает корректные 24ч форматы', () => {
  assert.equal(validTime('00:00'), true);
  assert.equal(validTime('09:30'), true);
  assert.equal(validTime('23:59'), true);
});
test('validTime: отвергает мусор', () => {
  assert.equal(validTime('9:00'), false);          // без ведущего нуля
  assert.equal(validTime('24:00'), false);         // час за пределами
  assert.equal(validTime('09:60'), false);         // минуты за пределами
  assert.equal(validTime('abc'), false);
  assert.equal(validTime(''), false);
  assert.equal(validTime(null), false);
});

/* ---------- timeInRange ---------- */
test('timeInRange: границы полуинтервал [start, end)', () => {
  assert.equal(timeInRange('09:00', '09:00', '18:00'), true);
  assert.equal(timeInRange('17:59', '09:00', '18:00'), true);
  assert.equal(timeInRange('18:00', '09:00', '18:00'), false); // конец не включён
  assert.equal(timeInRange('08:59', '09:00', '18:00'), false);
});

/* ---------- bookingTransitionAllowed ---------- */
test('booking: pending -> confirmed|rejected, confirmed -> done', () => {
  assert.equal(bookingTransitionAllowed('pending', 'confirmed'), true);
  assert.equal(bookingTransitionAllowed('pending', 'rejected'), true);
  assert.equal(bookingTransitionAllowed('confirmed', 'done'), true);
  assert.equal(bookingTransitionAllowed('confirmed', 'cancelled'), true);
});
test('booking: запрещённые и цикличные переходы', () => {
  assert.equal(bookingTransitionAllowed('confirmed', 'pending'), false); // назад нельзя
  assert.equal(bookingTransitionAllowed('rejected', 'confirmed'), false); // принять отклонённое нельзя
  assert.equal(bookingTransitionAllowed('done', 'pending'), false);
  assert.equal(bookingTransitionAllowed('confirmed', null), false);
});
test('booking: из статуса в себя всегда разрешено', () => {
  assert.equal(bookingTransitionAllowed('pending', 'pending'), true);
  assert.equal(bookingTransitionAllowed('done', 'done'), true);
});

/* ---------- validateAvailabilitySlots ---------- */
const ok = w => [
  { weekday: w, time_start: '09:00', time_end: '18:00' }
];
test('avail: валидный разрывной график проходит', () => {
  const slots = [
    { weekday: 0, time_start: '16:00', time_end: '21:00' },
    { weekday: 0, time_start: '09:00', time_end: '12:00' },
    { weekday: 2, time_start: '00:00', time_end: '00:00' } // подождём — невалиден ниже
  ];
  // заменим на реально валидный второй день
  const valid = [
    { weekday: 0, time_start: '16:00', time_end: '21:00' },
    { weekday: 0, time_start: '09:00', time_end: '12:00' },
    { weekday: 2, time_start: '07:00', time_end: '11:00' }
  ];
  assert.doesNotThrow(() => validateAvailabilitySlots(valid));
  assert.equal(slots.length, 3);
});
test('avail: weekday вне [0..6] — ошибка', () => {
  assert.throws(() => validateAvailabilitySlots([{ weekday: 7, time_start: '09:00', time_end: '18:00' }]), /invalid availability interval/);
  assert.throws(() => validateAvailabilitySlots([{ weekday: -1, time_start: '09:00', time_end: '18:00' }]), /invalid availability interval/);
});
test('avail: start >= end — ошибка', () => {
  assert.throws(() => validateAvailabilitySlots([{ weekday: 0, time_start: '18:00', time_end: '09:00' }]), /invalid availability interval/);
  assert.throws(() => validateAvailabilitySlots([{ weekday: 0, time_start: '12:00', time_end: '12:00' }]), /invalid availability interval/);
});
test('avail: невалидное время — ошибка', () => {
  assert.throws(() => validateAvailabilitySlots([{ weekday: 0, time_start: '9:00', time_end: '18:00' }]), /invalid availability interval/);
});
test('avail: пересекающиеся интервалы в один день — ошибка', () => {
  assert.throws(() => validateAvailabilitySlots([
    { weekday: 0, time_start: '09:00', time_end: '14:00' },
    { weekday: 0, time_start: '13:00', time_end: '18:00' }  // 13:00 < 14:00 и 13:00 < 14:00
  ]), /overlapping/);
});
test('avail: дубликаты — ошибка', () => {
  assert.throws(() => validateAvailabilitySlots([...ok(0), ...ok(0)]), /duplicate/);
});
test('avail: ровно 14 слотов — допустимо (лимит >14)', () => {
  const many = [];
  for (let w = 0; w < 7; w++) many.push({ weekday: w, time_start: '09:00', time_end: '10:00' }, { weekday: w, time_start: '11:00', time_end: '12:00' });
  assert.doesNotThrow(() => validateAvailabilitySlots(many));
});
test('avail: 15 слотов — ошибка', () => {
  const many = [
    { weekday: 0, time_start: '09:00', time_end: '10:00' }, { weekday: 0, time_start: '11:00', time_end: '12:00' },
    { weekday: 1, time_start: '09:00', time_end: '10:00' }, { weekday: 1, time_start: '11:00', time_end: '12:00' },
    { weekday: 2, time_start: '09:00', time_end: '10:00' }, { weekday: 2, time_start: '11:00', time_end: '12:00' },
    { weekday: 3, time_start: '09:00', time_end: '10:00' }, { weekday: 3, time_start: '11:00', time_end: '12:00' },
    { weekday: 4, time_start: '09:00', time_end: '10:00' }, { weekday: 4, time_start: '11:00', time_end: '12:00' },
    { weekday: 5, time_start: '09:00', time_end: '10:00' }, { weekday: 5, time_start: '11:00', time_end: '12:00' },
    { weekday: 6, time_start: '09:00', time_end: '10:00' }, { weekday: 6, time_start: '11:00', time_end: '12:00' },
    { weekday: 6, time_start: '13:00', time_end: '14:00' }
  ];
  assert.throws(() => validateAvailabilitySlots(many), /invalid availability/);
});
test('avail: не-массив — ошибка', () => {
  assert.throws(() => validateAvailabilitySlots(null), /invalid availability/);
  assert.throws(() => validateAvailabilitySlots('nope'), /invalid availability/);
});

/* ---------- effectiveRoutineId ---------- */
const plan = (timestamps, routines, week) => ({ dayPlan: { '2026-09-01': timestamps }, routines, week, dayPlan2: undefined });
test('routine: override дня', () => {
  const S = { dayPlan: { '2026-09-01': 'chest' }, routines: [{ id: 'chest' }], week: {} };
  assert.equal(effectiveRoutineId(S, '2026-09-01'), 'chest');
});
test('routine: rest день', () => {
  const S = { dayPlan: { '2026-09-01': 'rest' }, routines: [{ id: 'chest' }], week: { 1: 'chest' } };
  assert.equal(effectiveRoutineId(S, '2026-09-01'), null);
});
test('routine: fallback на неделю', () => {
  // 2026-09-01 — вторник (getDay()===2). week[2] должен вернуться.
  const S = { dayPlan: {}, routines: [{ id: 'legs' }, { id: 'push' }], week: [null, null, 'legs'] };
  assert.equal(effectiveRoutineId(S, '2026-09-01'), 'legs');
});
// 2026-09-01 — вторник => weekday 2. game перекрывающего override нет, поэтому спуск по week[2].
test('routine: override ссылается на несуществующий id — игнор, fallback на неделю', () => {
  const S = { dayPlan: { '2026-09-01': 'ghost' }, routines: [{ id: 'legs' }], week: [null, null, 'legs'] };
  assert.equal(effectiveRoutineId(S, '2026-09-01'), 'legs'); // вторник → week[2]
});
test('routine: нет ничего — null', () => {
  assert.equal(effectiveRoutineId({ dayPlan: {}, routines: [], week: {} }, '2026-09-01'), null);
});

/* ---------- nextHour ---------- */
test('nextHour: округляет к следующему целому часу', () => {
  assert.equal(nextHour('09:15'), '10:00');
  assert.equal(nextHour('09:00'), '10:00');
  // Нюанс на границе: из 23:xx получается '24:00' (невалидный 24ч формат).
  // Это не баг в проде: daySlots останавливает цикл по t < time_end до '24:00',
  // а validateAvailabilitySlots требует time_end <= 23:59, так что '24:00' никогда
  // не попадает в итоговый набор слотов. Зафиксировано как есть (детерминизм).
  assert.equal(nextHour('23:45'), '24:00');
});

/* ---------- daySlots ---------- */
test('daySlots: разрывной график (2 интервала) сливается в один отсортированный список', () => {
  const avail = [
    { weekday: 1, time_start: '09:00', time_end: '11:00' },
    { weekday: 1, time_start: '16:00', time_end: '18:00' }
  ];
  assert.deepEqual(daySlots(avail, 1), ['09:00', '10:00', '16:00', '17:00']);
});
test('daySlots: другой день не учитывается', () => {
  assert.deepEqual(daySlots([{ weekday: 1, time_start: '09:00', time_end: '11:00' }], 2), []);
});
test('daySlots: пустой график', () => {
  assert.deepEqual(daySlots([], 0), []);
});

/* ---------- userNow ---------- */
test('userNow: неизвестный tz -> null, а не бросок', () => {
  assert.equal(userNow('Not/A_Timezone'), null);
});
test('userNow: валидная tz возвращает date+hhmm того формата', () => {
  const now = userNow('UTC');
  assert.ok(now && /^\d{4}-\d{2}-\d{2}$/.test(now.date), 'date формат YYYY-MM-DD');
  assert.ok(now && /^\d{2}:\d{2}$/.test(now.hhmm), 'hhmm формат HH:MM');
});

/* ---------- normaliseAccessEvent ---------- */
test('access: базовый вход (in)', () => {
  const e = normaliseAccessEvent({ event_id: 'e1', member_key: 'm1', occurred_at: '2026-09-01T10:00:00Z' });
  assert.equal(e.eventId, 'e1');
  assert.equal(e.memberKey, 'm1');
  assert.equal(e.direction, 'in');
  assert.equal(e.branchKey, null);
});
test('access: направление out когда не вход', () => {
  const e = normaliseAccessEvent({ id: 'e1', card_id: '123', type: 'exit', timestamp: Date.now() });
  assert.equal(e.direction, 'out');
  assert.equal(e.memberKey, '123');
});
test('access: мапит branch_key/branch_id/club_id', () => {
  assert.equal(normaliseAccessEvent({ event_id: 'e1', member_key: 'm1', branch_id: 'b2' }).branchKey, 'b2');
  assert.equal(normaliseAccessEvent({ event_id: 'e1', member_key: 'm1', club_id: 'b9' }).branchKey, 'b9');
});
test('access: unknown/test -> unknown', () => {
  assert.equal(normaliseAccessEvent({ event_id: 'e1', member_key: 'm1', direction: 'test' }).direction, 'unknown');
});
test('access: без event_id — ошибка', () => {
  assert.throws(() => normaliseAccessEvent({ member_key: 'm1', occurred_at: '2026-09-01T10:00:00Z' }), /event_id is required/);
});
test('access: без member_key — ошибка', () => {
  assert.throws(() => normaliseAccessEvent({ event_id: 'e1', occurred_at: '2026-09-01T10:00:00Z' }), /member_key is required/);
});
test('access: невалидная дата — ошибка', () => {
  assert.throws(() => normaliseAccessEvent({ event_id: 'e1', member_key: 'm1', occurred_at: 'not-a-date' }), /occurred_at is invalid/);
});
/* ---------- аналитика: тоннаж и тренд ---------- */
test('тренд тоннажа: рост / падение / нет базы', () => {
  assert.equal(trendPct(110, 100), 10);
  assert.equal(trendPct(90, 100), -10);
  assert.equal(trendPct(105.5, 100), 5.5);
  assert.equal(trendPct(100, 0), null);      // предыдущий период пуст — базы нет
  assert.equal(trendPct(100, null), null);
  assert.equal(trendPct(null, 100), null);
});
test('объём тренировки: вес×повторения только выполненных подходов', () => {
  const w = { entries: [
    { sets: [{ w: 100, r: 10, done: true }, { w: 100, r: 10, done: true }, { w: 100, r: 10, done: false }] },
    { sets: [{ w: 30, r: 15, done: true }] }
  ]};
  assert.equal(workoutVolume(w), 100 * 10 * 2 + 30 * 15); // 2450
  assert.equal(workoutVolume({ entries: [] }), 0);
  assert.equal(workoutVolume({}), 0);
});

/* ---------- метрики тренировок (athlete_metrics) ---------- */
test('метрики из state: агрегаты по дням (объём = вес×повторения)', () => {
  const S = { workouts: [
    { d: '2026-08-31', entries: [
      { sets: [{ w: 100, r: 10, done: true }, { w: 100, r: 10, done: true }, { w: 100, r: 10, done: false }] },
      { sets: [{ w: 30, r: 15, done: true }] }
    ] },
    { d: '2026-08-31', entries: [] },   // вторая тренировка в тот же день
    { d: '2026-09-01', entries: [{ sets: [{ w: 50, r: 8, done: true }] }] }
  ]};
  const m = metricsFromState(S);
  assert.equal(m.length, 2);
  const d31 = m.find(x => x.day === '2026-08-31');
  assert.equal(d31.workouts, 2);
  assert.equal(d31.volume, 100 * 10 * 2 + 30 * 15); // 2450
  assert.equal(d31.sets, 3);
  assert.equal(d31.exercises, 2);
  const d01 = m.find(x => x.day === '2026-09-01');
  assert.equal(d01.workouts, 1);
  assert.equal(d01.volume, 400);
  assert.equal(d01.sets, 1);
  assert.equal(d01.exercises, 1);
});
test('метрики из state: пустой state — пустой список', () => {
  assert.deepEqual(metricsFromState({}), []);
  assert.deepEqual(metricsFromState(null), []);
  assert.deepEqual(metricsFromState({ workouts: [{ d: 'x', entries: [] }] }), []);
});

/* ---------- серия недель из ключей (SQL) ---------- */
function wkKey(dateStr) {
  const dt = new Date(dateStr + 'T12:00:00');
  const day = (dt.getDay() + 6) % 7;
  dt.setDate(dt.getDate() - day + 3);
  const jan4 = new Date(dt.getFullYear(), 0, 4);
  const week = 1 + Math.round(((dt - jan4) / 86400000 - 3 + ((jan4.getDay() + 6) % 7)) / 7);
  return dt.getFullYear() + '-' + week;
}
test('серия недель: подряд 3, пауза обрывает, давно не было = 0, пусто = 0', () => {
  const now = Date.now();
  const k = n => wkKey(new Date(now - n * 7 * 86400000).toISOString().slice(0, 10));
  assert.equal(streakFromWeeks([k(0), k(1), k(2)], now), 3);
  assert.equal(streakFromWeeks([k(0), k(2)], now), 1);   // пропуск на прошлой неделе
  assert.equal(streakFromWeeks([k(5)], now), 0);          // тренировка 5 недель назад — серия 0
  assert.equal(streakFromWeeks([], now), 0);
  assert.equal(streakFromWeeks(null, now), 0);
});
