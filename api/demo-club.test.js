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
import { getWallet, createDemoToken, takeDemoToken, createDemoSession, getDemoSession,
  listAdmins, listLoyaltyRules, listRewards, listBranches } from './admin-db.js';
import { collectAnalytics, canSeeAthlete } from './analytics.js';
import { scopeAdmins, scopeBranches, scopeOwnerRows, scopeUsers, demoModeOn } from './demo-scope.js';

const USE_DB = !!process.env.DATABASE_URL;
const T = (Date.now() % 1e6).toString(36) + Math.random().toString(36).slice(2, 6);

const needDb = (t) => {
  if (!USE_DB) { t.skip('SKIP: задай DATABASE_URL (живая postgres) для интеграционных тестов'); return false; }
  if (/retail_db/.test(process.env.DATABASE_URL || '') && process.env.ALLOW_PROD_DB_TESTS !== '1') {
    t.skip('SKIP: DATABASE_URL указывает на прод-PG (retail_db). Демо-тесты пишут клоны в БД — запрещены на проде.');
    return false;
  }
  return true;
};

const gapDays = (S, now = new Date().toISOString().slice(0, 10)) => {
  const last = S.workouts.length ? S.workouts[S.workouts.length - 1].d : now;
  return Math.round((new Date(now) - new Date(last)) / 86400000);
};

/* ---------- demo-seed: чистые генераторы персон ---------- */
// Фиксируем «сегодня»: генератор детерминирован для заданного now, но от
// реальной даты зависит раскладка недель/пропусков (churn на 2026-09-05 даёт
// 3 тренировки, на 2026-09-02 — 8). Без фиксации тест флакал от календаря.
const DEMO_NOW = new Date('2026-09-02T12:00:00Z');
const demoState = persona => buildDemoState({ persona, now: DEMO_NOW });

test('персона regular: глубокая история, прогресс весов, цели, effort', () => {
  const S = demoState('regular');
  assert.ok(S.workouts.length >= 55 && S.workouts.length <= 84, `тренировок ~78 минус пропуски, got ${S.workouts.length}`);
  assert.ok(S.bodyweight.length >= 40, 'взвешивания 2×/нед');
  const first = S.bodyweight[0].w, last = S.bodyweight[S.bodyweight.length - 1].w;
  assert.ok(first > last, 'вес тела снижается к цели (' + first + ' -> ' + last + ')');
  assert.ok(bestWeightsOf(S)['0025'] >= 95, 'жим вырос к ~100 кг');
  assert.equal(S.effort, 'rir');
  assert.ok(S.routines.length === 3 && Object.keys(S.week).length === 3, '3 программы, расписание пн/ср/пт');
  assert.equal(S.goals.length, 2, 'цели по упражнениям есть');
  assert.equal(S.unit, 'kg');
  // Детерминизм: тот же seed + тот же now → тот же профиль (для скриншотов и тестов).
  assert.equal(JSON.stringify(S), JSON.stringify(demoState('regular')));
});

test('персона casual: реже, вялый прогресс, без effort', () => {
  const S = demoState('casual');
  assert.ok(S.workouts.length >= 8 && S.workouts.length <= 22, '10 недель × 2/нед с пропусками');
  assert.ok(S.workouts.length < demoState('regular').workouts.length, 'меньше тренировок, чем regular');
  assert.ok(bestWeightsOf(S)['0025'] < 82, 'цель 80 кг не достигнута (прогресс вялый)');
  assert.equal(S.effort, undefined, 'оценки усилия выключены');
});

test('персона churn: затухание и длинный разрыв — витрина ухода', () => {
  const S = demoState('churn');
  assert.ok(S.workouts.length >= 4 && S.workouts.length <= 9, '4-5 недель с затуханием');
  assert.ok(gapDays(S, '2026-09-02') >= 13, 'последняя тренировка давно — клиент «ушёл»');
  assert.equal(demoState('churn').effort, undefined);
});

test('демо: ownerId → sessionId (для /api/demo/end), и только для демо-владельца', () => {
  const ids = demoIds('ds_xyz');
  assert.equal(ownerIdToSession(ids.ownerId), 'ds_xyz');
  assert.equal(ownerIdToSession('admin-abc'), null);
  assert.equal(ownerIdToSession(null), null);
});

/* ---- Ф4: демо-скоуп (изоляция клонов, DEMO_MODE=1) ---- */
test('демо-скоуп: canSeeAthlete и списковые хелперы фильтруют по demo_session', () => {
  const prev = process.env.DEMO_MODE;
  process.env.DEMO_MODE = '1';
  try {
    // canSeeAthlete (как его зовёт collectAnalytics через filterAthletes)
    assert.equal(canSeeAthlete({ kind: 'demoSession', session: 'ds_a' }, { demoSession: 'ds_a' }), true);
    assert.equal(canSeeAthlete({ kind: 'demoSession', session: 'ds_a' }, { demoSession: 'ds_b' }), false);
    assert.equal(canSeeAthlete({ kind: 'demoSession', session: 'ds_a' }, { demoSession: null }), false);
    assert.equal(canSeeAthlete({ kind: 'all' }, { demoSession: 'ds_b' }), true, 'owner-скоуп прода не тронут');
    // списковые хелперы: demo-админ видит только свою сессию
    const adminA = { demo_session: 'ds_a' };
    const rows = [
      { id: '1', demo_session: 'ds_a' }, { id: '2', demo_session: 'ds_b' }, { id: '3', demo_session: null }
    ];
    assert.deepEqual(scopeAdmins(adminA, rows).map(r => r.id), ['1']);
    assert.deepEqual(scopeUsers(adminA, rows).map(r => r.id), ['1']);
    const branches = [{ id: 'demo-ds_a' }, { id: 'demo-ds_b' }, { id: 'real-branch' }];
    assert.deepEqual(scopeBranches(adminA, branches).map(b => b.id), ['demo-ds_a']);
    const owned = [{ id: 'r1', created_by: 'demo-owner-ds_a' }, { id: 'r2', created_by: 'demo-owner-ds_b' }];
    assert.deepEqual(scopeOwnerRows(adminA, owned).map(r => r.id), ['r1']);
    // вне демо-режима — прод-владелец НЕ видит демо-строки (безопасность:
    // инцидент 2026-09-02 — демо-клоны попали в прод БД и выглядели как
    // «боты-тренеры»; даже случайно просочившиеся демо-строки скрываются).
    process.env.DEMO_MODE = '0';
    assert.deepEqual(scopeAdmins(adminA, rows).map(r => r.id), ['3']);
    assert.equal(demoModeOn(), false);
  } finally {
    process.env.DEMO_MODE = prev;
  }
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

/* ---- Ф4: два параллельных демо-клона не видят друг друга ---- */
test('демо-изоляция: аналитика и списки владельца видят только свой клон', async (t) => {
  if (!needDb(t)) return;
  const sidA = 'dsA_' + T, sidB = 'dsB_' + T;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demoIso-'));
  const db = { users: [] };
  const saveDb = () => {};
  const prev = process.env.DEMO_MODE;
  process.env.DEMO_MODE = '1';
  const idsA = demoIds(sidA), idsB = demoIds(sidB);
  try {
    await spawnDemoClub({ sessionId: sidA, db, saveDb, dataDir: dir });
    await spawnDemoClub({ sessionId: sidB, db, saveDb, dataDir: dir });
    assert.equal(db.users.length, 6, 'в users оба клона');
    const adminA = { demo_session: sidA };

    // атлеты: только свои
    const mine = scopeUsers(adminA, db.users);
    assert.deepEqual(mine.map(u => u.id).sort(), Object.values(idsA.athleteIds).sort());

    // сотрудники/филиалы/правила/награды: только свои
    const admins = scopeAdmins(adminA, await listAdmins());
    assert.deepEqual(admins.map(a => a.id).sort(), [idsA.ownerId, idsA.trainerId].sort());
    const branches = scopeBranches(adminA, await listBranches());
    assert.deepEqual(branches.map(b => b.id), [idsA.branchId]);
    const rules = scopeOwnerRows(adminA, await listLoyaltyRules());
    assert.equal(rules.length, 3, 'правила только клона A');
    assert.ok(rules.every(r => r.created_by === idsA.ownerId));
    const rewards = scopeOwnerRows(adminA, await listRewards(false));
    assert.equal(rewards.length, 2, 'награды только клона A');
    assert.ok(rewards.every(r => r.created_by === idsA.ownerId));

    // аналитика владельца A: ровно 3 атлета клона A, без следов B
    const { athletes } = await collectAnalytics({ users: db.users, scope: { kind: 'demoSession', session: sidA } });
    assert.equal(athletes.length, 3, 'в аналитике только клон A');
    assert.ok(athletes.every(a => Object.values(idsA.athleteIds).includes(a.id)), 'нет атлетов клона B');
    assert.ok(athletes.every(a => a.demoSession === sidA), 'метка demoSession в строке аналитики');
  } finally {
    process.env.DEMO_MODE = prev;
    await destroyDemoClub({ sessionId: sidA, db, saveDb, dataDir: dir }).catch(() => {});
    await destroyDemoClub({ sessionId: sidB, db, saveDb, dataDir: dir }).catch(() => {});
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});
