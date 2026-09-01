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
import { pool } from './access-db.js';
import { replaceAthleteMetrics, backfillAthleteMetrics } from './metrics.js';

const USE_DB = !!process.env.DATABASE_URL;

const db = await import('./admin-db.js');
const {
  adminDbReady, setTrainerAvailability, getTrainerAvailability, createBooking,
  findBookingConflict, updateBookingStatus, getBooking, createAdminInvite,
  getAdminInvite, acceptLoyaltyEvent, getWallet, roleAllowed, recurHorizonDays,
  setTrainerAssignment, listTrainerAssignments, saveNotification,
  insertLead, findOwnerId
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
/* ---- интеграционные тесты: тренировочные метрики (athlete_metrics) ---- */
test('метрики: replace перезаписывает дни и удаляет пропавшие', async (t) => {
  if (!needDb(t)) return;
  const uid = 'mtr_' + T;
  await replaceAthleteMetrics(uid, { workouts: [
    { d: '2026-08-01', entries: [{ sets: [{ w: 60, r: 10, done: true }] }] },
    { d: '2026-08-02', entries: [{ sets: [{ w: 70, r: 8, done: true }] }] }
  ] });
  const one = await pool.query('SELECT * FROM athlete_metrics WHERE user_id=$1 ORDER BY day', [uid]);
  assert.equal(one.rows.length, 2);
  assert.equal(one.rows[0].volume, 600);
  assert.equal(one.rows[0].sets, 1);
  // повторный replace: день изменён, 08-02 пропал, 08-03 добавлен
  await replaceAthleteMetrics(uid, { workouts: [
    { d: '2026-08-01', entries: [{ sets: [{ w: 80, r: 10, done: true }] }] },
    { d: '2026-08-03', entries: [{ sets: [{ w: 90, r: 5, done: true }] }] }
  ] });
  const two = await pool.query('SELECT * FROM athlete_metrics WHERE user_id=$1 ORDER BY day', [uid]);
  assert.deepEqual(two.rows.map(r => r.day.toISOString().slice(0, 10)), ['2026-08-01', '2026-08-03']);
  assert.equal(two.rows[0].volume, 800);
  // replace пустым state стирает всё
  await replaceAthleteMetrics(uid, null);
  const none = await pool.query('SELECT * FROM athlete_metrics WHERE user_id=$1', [uid]);
  assert.equal(none.rows.length, 0);
  await pool.query('DELETE FROM athlete_metrics WHERE user_id=$1', [uid]);
});

test('метрики: backfill по users из state-файлов', async (t) => {
  if (!needDb(t)) return;
  const uid = 'mtr_' + T + 'b';
  const users = [{ id: uid }, { id: 'mtr_nostate_' + T, admin: true }];
  const stateOf = id => id === uid ? { workouts: [{ d: '2026-08-10', entries: [{ sets: [{ w: 40, r: 12, done: true }] }] }] } : null;
  const silent = { log() {}, error() {} };
  await backfillAthleteMetrics({ users, stateOf, log: silent });
  const rows = await pool.query('SELECT * FROM athlete_metrics WHERE user_id=$1', [uid]);
  assert.equal(rows.rows.length, 1);
  assert.equal(rows.rows[0].volume, 480);
  await pool.query('DELETE FROM athlete_metrics WHERE user_id=$1', [uid]);
});

test('уведомления: saveNotification идемпотентен по id (rowCount 1, затем 0)', async (t) => {
  if (!needDb(t)) return;
  const id = 'notif_' + T;
  try {
    const first = await saveNotification({ id, userId: 'u_notif_' + T, title: 'a', body: 'b' });
    assert.equal(first, 1, 'первая вставка создаёт запись');
    const second = await saveNotification({ id, userId: 'u_notif_' + T, title: 'a', body: 'b' });
    assert.equal(second, 0, 'повтор не создаёт дубль — вызывающий не шлёт повторный push');
  } finally {
    await pool.query('DELETE FROM app_notifications WHERE id=$1', [id]);
  }
});


/* ---- промо-заявки с сайта (тарифы / КП) ---- */
test('промо-заявки: insertLead + findOwnerId + уведомление владельцу идемпотентно', async (t) => {
  if (!needDb(t)) return;
  try {
    const ownerId = await findOwnerId();
    assert.ok(ownerId, 'в БД есть владелец (роль owner)');

    const leadId = 'lead_' + T;
    await insertLead({
      id: leadId, name: 'Тест', contact: 'test@example.com',
      gym: 'Тест-зал', message: 'хочу КП', plan: 'Индивидуально'
    });
    const rows = await (await pool.query('SELECT * FROM promo_leads WHERE id = $1', [leadId])).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, 'Тест');
    assert.equal(rows[0].plan, 'Индивидуально');

    // повторная вставка того же id — не дублирует журнал
    await insertLead({ id: leadId, name: 'Тест', contact: 'x' });
    const again = await (await pool.query('SELECT count(*)::int AS n FROM promo_leads WHERE id = $1', [leadId])).rows;
    assert.equal(again[0].n, 1, 'дубликат заявки не создаётся');

    // уведомление владельцу — идемпотентно (ровно одна запись)
    const notifId = 'promo-' + leadId;
    const first = await saveNotification({
      id: notifId, userId: ownerId, title: 'Новый запрос с сайта', body: 'тест', payload: { kind: 'promo_lead' }
    });
    const second = await saveNotification({
      id: notifId, userId: ownerId, title: 'Новый запрос с сайта', body: 'тест', payload: { kind: 'promo_lead' }
    });
    assert.equal(first, 1, 'первая запись создана');
    assert.equal(second, 0, 'повторная — ON CONFLICT DO NOTHING');
    const notifs = await (await pool.query('SELECT count(*)::int AS n FROM app_notifications WHERE id = $1', [notifId])).rows;
    assert.equal(notifs[0].n, 1, 'в центре уведомлений ровно одна');

    // подчистка
    await pool.query('DELETE FROM app_notifications WHERE id = $1', [notifId]);
    await pool.query('DELETE FROM promo_leads WHERE id = $1', [leadId]);
  } catch (e) {
    try { await pool.query('DELETE FROM promo_leads WHERE id = $1', ['lead_' + T]); } catch {}
    throw e;
  }
});
