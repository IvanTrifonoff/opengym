// api/admin-db.test.js — интеграционные тесты слоя БД (admin-db.js + access-db.js).
//
// Два класса тестов:
//  - чистые функции (roleAllowed, recurHorizonDays) — работают ВСЕГДА, БД не нужна;
//  - интеграционные (расписание, брони, лояльность…) — требуют ЖИВОЙ postgres.
//    Запуск: DATABASE_URL=postgres://user:pass@host:5432/db node --test admin-db.test.js
//    Без DATABASE_URL они скипаются (CI поднимает postgres-сервис; локально:
//    docker run --rm -p 5433:5432 -e POSTGRES_USER=g -e POSTGRES_PASSWORD=g -e POSTGRES_DB=g postgres:16-alpine).
//
// Изоляция: уникальные id/тренеры на прогон + подчистка в конце теста, чтобы
// повторные прогоны чисты и не задевают другие данные.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const USE_DB = !!process.env.DATABASE_URL;

const db = await import('./admin-db.js');
const {
  adminDbReady, setTrainerAvailability, getTrainerAvailability, createBooking,
  findBookingConflict, updateBookingStatus, getBooking, createAdminInvite,
  getAdminInvite, acceptLoyaltyEvent, getWallet, roleAllowed, recurHorizonDays,
  setTrainerAssignment, listTrainerAssignments
} = db;

const T = (Date.now() % 1e6).toString(36) + Math.random().toString(36).slice(2, 6);
const trainer = 'tr_' + T;
const athlete = 'at_' + T;
const UID = 'uid_' + T;

const needDb = (t) => {
  if (!USE_DB) { t.skip('SKIP: задай DATABASE_URL (живая postgres) для интеграционных тестов'); return false; }
  return true;
};

/* ---- чистые функции: работают всегда ---- */
test('роли: roleAllowed', () => {
  assert.equal(roleAllowed('owner', ['owner', 'trainer']), true);
  assert.equal(roleAllowed('trainer', ['owner']), false);
  assert.equal(roleAllowed('athlete', []), false);
});
test('постоянная серия: горизонт 8 недель', () => {
  assert.equal(recurHorizonDays(), 56);
});

/* ---- интеграционные тесты БД ---- */
test('инфраструктура: схема инициализируется (миграции идемпотентны)', async (t) => {
  if (!needDb(t)) return;
  await adminDbReady;
  await adminDbReady; // повтор — не должен бросить
  assert.ok(true, 'schema init ok');
});

test('расписание тренера: set/get с разрывным графиком', async (t) => {
  if (!needDb(t)) return;
  try {
    const slots = [
      { weekday: 1, time_start: '09:00', time_end: '12:00' },
      { weekday: 1, time_start: '16:00', time_end: '21:00' },
      { weekday: 3, time_start: '07:00', time_end: '11:00' }
    ];
    const saved = await setTrainerAvailability(trainer, slots);
    assert.equal(saved.length, 3);
    const got = await getTrainerAvailability(trainer);
    assert.equal(got.filter(s => s.weekday === 1).length, 2);
  } finally { await setTrainerAvailability(trainer, []); }
});

test('бронирование: create → conflict → update статус', async (t) => {
  if (!needDb(t)) return;
  const b = await createBooking({ trainerId: trainer, athleteId: athlete, date: '2026-09-10', time: '10:00', note: 'первая' });
  try {
    assert.ok(b && b.id);
    assert.equal((await findBookingConflict(trainer, '2026-09-10', '10:00')).id, b.id);
    assert.equal(await findBookingConflict(trainer, '2026-09-10', '11:00'), null);
    assert.equal(await findBookingConflict(trainer, '2026-09-11', '10:00'), null);
    await updateBookingStatus({ id: b.id, status: 'confirmed' });
    assert.equal((await getBooking(b.id)).status, 'confirmed');
    assert.equal((await getBooking(b.id)).athlete_id, athlete);
  } finally { await db.pool?.query('DELETE FROM coach_bookings WHERE id=$1', [b.id]); }
});

test('приглашения админа: getAdminInvite на чужой код — null; owner через invite запрещён', async (t) => {
  if (!needDb(t)) return;
  await adminDbReady;
  assert.equal(await getAdminInvite('ZZZZZZ'), null);
  const inv = await createAdminInvite({ name: 'Тест', role: 'trainer', createdBy: 'owner1' });
  assert.ok(inv && inv.code);
  // повторный get по этому коду — находит
  assert.ok(await getAdminInvite(inv.code));
  // owner нельзя создать invite'ом
  await assert.rejects(() => createAdminInvite({ name: 'X', role: 'owner', createdBy: 'owner1' }), /invalid staff role/);
});

test('лояльность: accept → duplicate на повтор, кошелёк возвращает balance', async (t) => {
  if (!needDb(t)) return;
  await adminDbReady;
  const ev = 'ev_' + T;
  const r1 = await acceptLoyaltyEvent({ eventId: ev, userId: UID, eventType: 'visit', occurredAt: '2026-09-01T10:00:00Z', payload: { test: 1 } });
  assert.ok(typeof r1.duplicate === 'boolean');
  const r2 = await acceptLoyaltyEvent({ eventId: ev, userId: UID, eventType: 'visit', occurredAt: '2026-09-01T10:00:00Z', payload: { test: 1 } });
  assert.equal(r2.duplicate, true);
  const w = await getWallet(UID);
  assert.ok(w && typeof w.balance === 'number');
});

test('назначение тренера: set/unset', async (t) => {
  if (!needDb(t)) return;
  try {
    const a = await setTrainerAssignment({ userId: UID, trainerId: trainer });
    assert.equal(a.trainer_id, trainer); // функция возвращает snake_case-строки
    assert.ok((await listTrainerAssignments()).some(x => x.user_id === UID && x.trainer_id === trainer));
  } finally { await setTrainerAssignment({ userId: UID, trainerId: null }); }
});