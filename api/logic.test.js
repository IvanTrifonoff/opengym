// api/logic.test.js — юнит-тесты чистой бизнес-логики (node:test).
// Запуск: cd api && node --test logic.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validTime, timeInRange, bookingTransitionAllowed, validateAvailabilitySlots,
  effectiveRoutineId, nextHour, daySlots, userNow, normaliseAccessEvent
} from './logic.js';

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