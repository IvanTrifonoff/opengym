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
  insertLead, findOwnerId, getSetting, setSetting, deleteSetting,
  listLeads, markLeadsViewed, countUnreadLeads, listAdmins,
  softDeleteAdmin, restoreAdmin, listBranches, saveBranch, softDeleteBranch,
  createDemoToken, countDemoTokensSince, takeDemoToken,
  getDemoSession, createDemoSession, touchDemoSession,
  listExpiredDemoSessions, deleteDemoSession, purgeDemoTokens
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
      gym: 'Тест-зал', message: 'хочу КП', plan: 'Индивидуально',
      company: 'ООО Тест', inn: '7700000000', payment: 'sbp'
    });
    const rows = await (await pool.query('SELECT * FROM promo_leads WHERE id = $1', [leadId])).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, 'Тест');
    assert.equal(rows[0].plan, 'Индивидуально');
    assert.equal(rows[0].company, 'ООО Тест');
    assert.equal(rows[0].inn, '7700000000');
    assert.equal(rows[0].payment, 'sbp');

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


test('промо: настройки (СБП QR) + прочитанность заявок', async (t) => {
  if (!needDb(t)) return;
  try {
    // настройки ключ-значение
    await setSetting('test_key_' + T, 'data:image/png;base64,AAAA');
    assert.equal(await getSetting('test_key_' + T), 'data:image/png;base64,AAAA');
    await setSetting('test_key_' + T, 'v2');
    assert.equal(await getSetting('test_key_' + T), 'v2', 'перезапись');
    await deleteSetting('test_key_' + T);
    assert.equal(await getSetting('test_key_' + T), null, 'удаление');

    // заявка: непрочитана -> список -> прочитана (счётчики — относительно фона БД)
    const before = await countUnreadLeads();
    const lid = 'lead2_' + T;
    await insertLead({ id: lid, name: 'Чтение', contact: 'c@x.ru', plan: 'Старт' });
    assert.equal(await countUnreadLeads(), before + 1, '+1 непрочитанная');
    let list = await listLeads();
    const row = list.find(x => x.id === lid);
    assert.ok(row && !row.viewed, 'в списке с viewed:false');
    await markLeadsViewed();
    assert.equal(await countUnreadLeads(), before, 'после просмотра — как было');
    list = await listLeads();
    assert.ok(list.find(x => x.id === lid).viewed, 'теперь viewed:true');

    await pool.query('DELETE FROM promo_leads WHERE id = $1', [lid]);
  } catch (e) {
    try { await pool.query('DELETE FROM promo_leads WHERE id = $1', ['lead2_' + T]); } catch {}
    try { await deleteSetting('test_key_' + T); } catch {}
    throw e;
  }
});

/* ---- филиалы: CRUD + мягкое удаление ---- */
test('филиалы: save/list/rename/soft delete', async (t) => {
  if (!needDb(t)) return;
  const id = 'br_' + T;
  await saveBranch({ id, name: 'Зал тест' });
  await saveBranch({ id, name: 'Зал тест-2' });           // rename через ON CONFLICT
  let list = await listBranches();
  assert.ok(list.some(b => b.id === id && b.name === 'Зал тест-2'), 'renamed branch in list');
  const removed = await softDeleteBranch(id);
  assert.ok(removed && removed.id === id, 'soft delete returns branch');
  list = await listBranches();
  assert.ok(!list.some(b => b.id === id), 'soft-deleted branch hidden');
});

/* ---- мягкое удаление сотрудника ---- */
test('сотрудники: softDeleteAdmin скрывает и блокирует, restore возвращает', async (t) => {
  if (!needDb(t)) return;
  const id = 'adm_' + T;
  await pool.query(
    `INSERT INTO admin_users (id, name, role) VALUES ($1, $2, 'trainer') ON CONFLICT (id) DO NOTHING`,
    [id, 'Тест-тренер ' + T]
  );
  let admins = await listAdmins();
  assert.ok(admins.some(a => a.id === id), 'trainer visible before delete');
  const removed = await softDeleteAdmin(id);
  assert.ok(removed && removed.deleted_at, 'soft delete stamps deleted_at');
  admins = await listAdmins();
  assert.ok(!admins.some(a => a.id === id), 'trainer hidden after delete');
  await restoreAdmin(id);
  admins = await listAdmins();
  assert.ok(admins.some(a => a.id === id), 'trainer visible after restore');
  await pool.query('DELETE FROM admin_users WHERE id = $1', [id]);
});

/* ---- demo club: токены (антибот) и сессии (клон на одну сессию) ---- */
test('демо-токены: лимит окна, одноразовость, расход по IP', async (t) => {
  if (!needDb(t)) return;
  const ip = '10.' + (T.charCodeAt(0) % 200) + '.' + (T.charCodeAt(1) % 200) + '.1';
  const tok = 'dt_' + T;
  await createDemoToken({ token: tok, ip });
  assert.equal(await countDemoTokensSince(ip, 60 * 60 * 1000), 1, 'свежий токен учтён в окне');
  // Повторный create с тем же токеном — идемпотентно (ON CONFLICT DO NOTHING).
  await createDemoToken({ token: tok, ip });
  assert.equal(await countDemoTokensSince(ip, 60 * 60 * 1000), 1, 'дубликат токена не задваивает лимит');
  // Чужой IP не может расходовать токен.
  assert.equal(await takeDemoToken(tok, '10.9.9.9'), null, 'чужой IP отклонён');
  // Одноразовость: первый расход возвращает токен, второй — нет.
  const hit = await takeDemoToken(tok, ip);
  assert.ok(hit && hit.token === tok, 'первый расход успешен');
  assert.equal(await takeDemoToken(tok, ip), null, 'повторный расход невозможен');
  await pool.query('DELETE FROM demo_tokens WHERE token = $1', [tok]);
});

test('демо-токены: истёкшие и использованные вычищаются', async (t) => {
  if (!needDb(t)) return;
  const ip = '10.99.1.1';
  const a = 'dt_a_' + T, b = 'dt_b_' + T;
  await createDemoToken({ token: a, ip, ttlMs: 5 });
  await createDemoToken({ token: b, ip, ttlMs: 60 * 60 * 1000 });
  await takeDemoToken(b, ip);
  // a: протух (ttl 5 мс и прошло время), b: использован — оба должны уйти.
  await new Promise(r => setTimeout(r, 20));
  await purgeDemoTokens();
  const r = await pool.query('SELECT count(*)::int AS n FROM demo_tokens WHERE token = $1 OR token = $2', [a, b]);
  assert.equal(r.rows[0].n, 0, 'протухшие/использованные токены удалены');
});

test('демо-сессии: create/get/touch/expired/delete', async (t) => {
  if (!needDb(t)) return;
  const id = 'ds_' + T;
  const s1 = await createDemoSession({ id, token: 'dt_s_' + T, ip: '10.77.0.1', ttlMs: 200 });
  assert.ok(s1 && s1.id === id, 'сессия создана');
  // Продлеваем TTL — сессия не должна числиться истёкшей после паузы.
  await new Promise(r => setTimeout(r, 20));
  await touchDemoSession(id, 60 * 60 * 1000);
  let expired = await listExpiredDemoSessions();
  assert.ok(!expired.some(x => x.id === id), 'продлённая сессия не истекла');
  // Истёкшая сессия попадает в список кандидатов на удаление клона.
  await pool.query('UPDATE demo_sessions SET expires_at = now() - interval \'1 minute\' WHERE id = $1', [id]);
  expired = await listExpiredDemoSessions();
  assert.ok(expired.some(x => x.id === id), 'истёкшая сессия видна cleaner\'у');
  await deleteDemoSession(id);
  assert.equal(await getDemoSession(id), null, 'сессия удалена');
});

