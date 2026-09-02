// api/demo-club.test.js — демо-клуб: генератор состояний (чистые) и спавн/удаление клона.
//
// Два класса тестов:
//  - чистые функции demo-seed.js (состояния персон) — работают ВСЕГДА, БД не нужна;
//  - интеграционные (спавн клона → данные на месте → destroy → всё удалено) —
//    требуют ЖИВОЙ postgres (DATABASE_URL) и временной dataDir; используют
//    уникальные id + полную зачистку, как и admin-db.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pool } from './access-db.js';
import { buildDemoState, bestWeightsOf } from './demo-seed.js';
import { spawnDemoClub, destroyDemoClub, demoIds, ownerIdToSession, runDemoCleanupOnce } from './demo-club.js';
import { getWallet, createDemoToken, takeDemoToken, createDemoSession, getDemoSession } from './admin-db.js';

const USE_DB = !!process.env.DATABASE_URL;
const T = (Date.now() % 1e6).toString(36) + Math.random().toString(36).slice(2, 6);

const needDb = (t) => {
  if (!USE_DB) { t.skip('SKIP: задай DATABASE_URL (живая postgres) для интеграционных тестов'); return false; }
  return true;
};

const gapDays = (S, now = new Date().toISOString().slice(0, 10)) => {
  const last = S.workouts.length ? S.workouts[S.workouts.length - 1].d : now;
  return Math.round((new Date(now) - new Date(last)) / 86400000);
};

/* ---------- demo-seed: чистые генераторы персон ---------- */
test('персона regular: глубокая история, прогресс весов, цели, effort', () => {
  const S = buildDemoState({ persona: 'regular' });
  assert.ok(S.workouts.length >= 55 && S.workouts.length <= 84, `тренировок ~78 минус пропуски, got ${S.workouts.length}`);
  assert.ok(S.bodyweight.length >= 40, 'взвешивания 2×/нед');
  const first = S.bodyweight[0].w, last = S.bodyweight[S.bodyweight.length - 1].w;
  assert.ok(first > last, 'вес тела снижается к цели (' + first + ' -> ' + last + ')');
  assert.ok(bestWeightsOf(S)['0025'] >= 95, 'жим вырос к ~100 кг');
  assert.equal(S.effort, 'rir');
  assert.ok(S.routines.length === 3 && Object.keys(S.week).length === 3, '3 программы, расписание пн/ср/пт');
  assert.equal(S.goals.length, 2, 'цели по упражнениям есть');
  assert.equal(S.unit, 'kg');
  // Детерминизм: тот же seed → тот же профиль (для скриншотов и тестов).
  assert.equal(JSON.stringify(S), JSON.stringify(buildDemoState({ persona: 'regular' })));
});

test('персона casual: реже, вялый прогресс, без effort', () => {
  const S = buildDemoState({ persona: 'casual' });
  assert.ok(S.workouts.length >= 8 && S.workouts.length <= 22, '10 недель × 2/нед с пропусками');
  assert.ok(S.workouts.length < buildDemoState({ persona: 'regular' }).workouts.length, 'меньше тренировок, чем regular');
  assert.ok(bestWeightsOf(S)['0025'] < 82, 'цель 80 кг не достигнута (прогресс вялый)');
  assert.equal(S.effort, undefined, 'оценки усилия выключены');
});

test('персона churn: затухание и длинный разрыв — витрина ухода', () => {
  const S = buildDemoState({ persona: 'churn' });
  assert.ok(S.workouts.length >= 4 && S.workouts.length <= 9, '4-5 недель с затуханием');
  assert.ok(gapDays(S) >= 13, 'последняя тренировка давно — клиент «ушёл»');
  assert.equal(buildDemoState({ persona: 'churn' }).effort, undefined);
});

test('демо: ownerId → sessionId (для /api/demo/end), и только для демо-владельца', () => {
  const ids = demoIds('ds_xyz');
  assert.equal(ownerIdToSession(ids.ownerId), 'ds_xyz');
  assert.equal(ownerIdToSession('admin-abc'), null);
  assert.equal(ownerIdToSession(null), null);
});

/* ---------- demo-club: спавн и полное удаление клона ---------- */
test('демо-клон: спавн создаёт полный клуб, destroy всё удаляет', async (t) => {
  if (!needDb(t)) return;
  const sid = 'ds_' + T;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-'));
  const db = { users: [] };
  const saveDb = () => {};
  const ids = demoIds(sid);
  try {
    const r = await spawnDemoClub({ sessionId: sid, db, saveDb, dataDir: dir });
    assert.equal(r.branchId, ids.branchId);

    // users + state-файлы
    assert.equal(db.users.length, 3, '3 демо-атлета добавлены в users');
    assert.ok(db.users.every(u => u.demo_session === sid), 'все помечены сессией');
    const files = fs.readdirSync(dir).filter(f => f.startsWith('state-'));
    assert.equal(files.length, 3, 'state-файлы записаны');

    // БД: филиал, владелец/тренер, правила, награды
    const branch = await pool.query('SELECT id FROM branches WHERE id = $1', [ids.branchId]);
    assert.equal(branch.rows.length, 1, 'филиал создан');
    const admins = await pool.query("SELECT id, role, demo_session FROM admin_users WHERE id = ANY($1)", [[ids.ownerId, ids.trainerId]]);
    assert.equal(admins.rows.length, 2, 'владелец и тренер созданы');
    assert.ok(admins.rows.every(a => a.demo_session === sid), 'помечены demo_session');
    const rules = await pool.query('SELECT count(*)::int n FROM loyalty_rules WHERE created_by = $1', [ids.ownerId]);
    assert.equal(rules.rows[0].n, 3, '3 правила филиала');
    const rewards = await pool.query('SELECT count(*)::int n FROM loyalty_rewards WHERE created_by = $1', [ids.ownerId]);
    assert.equal(rewards.rows[0].n, 2, '2 награды в каталоге');

    // Привязки, расписание, записи
    const assigns = await pool.query('SELECT count(*)::int n FROM trainer_assignments WHERE trainer_id = $1', [ids.trainerId]);
    assert.equal(assigns.rows[0].n, 3, 'все атлеты привязаны к тренеру');
    const avail = await pool.query('SELECT count(*)::int n FROM trainer_availability WHERE trainer_id = $1', [ids.trainerId]);
    assert.equal(avail.rows[0].n, 7, 'часы работы пн–вс');
    const bookings = await pool.query('SELECT count(*)::int n FROM coach_bookings WHERE trainer_id = $1', [ids.trainerId]);
    assert.equal(bookings.rows[0].n, 3, 'записи: подтверждена/заявка/выполнена');

    // Лояльность и метрики — кошельки наполнил движок правил
    const wallet = await getWallet(ids.athleteIds.artem);
    assert.ok(wallet.balance >= 300, 'у Артёма солидный баланс баллов (' + wallet.balance + ')');
    const metrics = await pool.query('SELECT count(*)::int n FROM athlete_metrics WHERE user_id = $1', [ids.athleteIds.artem]);
    assert.ok(metrics.rows[0].n >= 40, 'метрики посчитаны (по дням тренировок)');

    // destroy — полное удаление
    await destroyDemoClub({ sessionId: sid, db, saveDb, dataDir: dir });
    assert.equal(db.users.length, 0, 'пользователи удалены из users');
    assert.equal(fs.readdirSync(dir).filter(f => f.startsWith('state-')).length, 0, 'state-файлы удалены');
    assert.equal((await pool.query('SELECT id FROM branches WHERE id = $1', [ids.branchId])).rows.length, 0, 'филиал удалён');
    assert.equal((await pool.query('SELECT id FROM admin_users WHERE id = ANY($1)', [[ids.ownerId, ids.trainerId]])).rows.length, 0, 'владелец/тренер удалены');
    assert.equal((await pool.query('SELECT count(*)::int n FROM loyalty_rules WHERE created_by = $1', [ids.ownerId])).rows[0].n, 0, 'правила удалены');
    assert.equal((await pool.query('SELECT count(*)::int n FROM loyalty_rewards WHERE created_by = $1', [ids.ownerId])).rows[0].n, 0, 'награды удалены');
    assert.equal((await pool.query('SELECT count(*)::int n FROM coach_bookings WHERE trainer_id = $1', [ids.trainerId])).rows[0].n, 0, 'записи удалены');
    assert.equal((await pool.query('SELECT count(*)::int n FROM trainer_availability WHERE trainer_id = $1', [ids.trainerId])).rows[0].n, 0, 'расписание удалено');
    assert.equal((await pool.query('SELECT count(*)::int n FROM trainer_assignments WHERE trainer_id = $1', [ids.trainerId])).rows[0].n, 0, 'привязки удалены');
    assert.equal((await pool.query('SELECT count(*)::int n FROM athlete_metrics WHERE user_id = $1', [ids.athleteIds.artem])).rows[0].n, 0, 'метрики удалены');
    assert.equal((await getWallet(ids.athleteIds.artem)).balance, 0, 'кошелёк пуст');
  } finally {
    await pool.query('DELETE FROM demo_sessions WHERE id = $1', [sid]).catch(() => {});
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});
/* ---- Ф3: жизненный цикл сессии: токен -> клон -> TTL -> cleaner ---- */
test('демо: cleaner удаляет истёкшие клоны и токены', async (t) => {
  if (!needDb(t)) return;
  const sid = 'ds2_' + T;
  const tok = 'dtc_' + T;
  const ip = '10.55.0.9';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demo2-'));
  const db = { users: [] };
  const saveDb = () => {};
  const ids = demoIds(sid);
  try {
    await createDemoToken({ token: tok, ip });
    const hit = await takeDemoToken(tok, ip);
    assert.ok(hit && hit.token === tok, 'токен расходуется (как в /api/demo/enter)');
    await spawnDemoClub({ sessionId: sid, db, saveDb, dataDir: dir });
    await createDemoSession({ id: sid, token: tok, ip, ttlMs: 60 * 60 * 1000 });
    assert.ok(await getDemoSession(sid), 'сессия создана');

    // Форсируем истечение TTL и прогоняем cleaner.
    await pool.query(`UPDATE demo_sessions SET expires_at = now() - interval '1 hour' WHERE id = $1`, [sid]);
    const cleaned = await runDemoCleanupOnce({ db, saveDb, dataDir: dir });
    assert.ok(cleaned >= 1, 'cleaner нашёл истёкшую сессию (' + cleaned + ')');

    assert.equal(db.users.length, 0, 'users очищены');
    assert.equal(fs.readdirSync(dir).filter(f => f.startsWith('state-')).length, 0, 'state-файлы удалены');
    assert.equal((await pool.query('SELECT id FROM branches WHERE id = $1', [ids.branchId])).rows.length, 0, 'филиал удалён');
    assert.equal(await getDemoSession(sid), null, 'demo_sessions удалена');
    const tokens = await pool.query('SELECT count(*)::int n FROM demo_tokens WHERE token = $1', [tok]);
    assert.equal(tokens.rows[0].n, 0, 'использованный токен вычищен');
  } finally {
    await destroyDemoClub({ sessionId: sid, db, saveDb, dataDir: dir }).catch(() => {});
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});
