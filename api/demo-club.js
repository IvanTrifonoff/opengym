// api/demo-club.js — спавн и полное удаление изолированного демо-клона «Демо-клуба».
//
// Каждая демо-сессия (id вида ds_*) получает свой мини-клуб:
//   · филиал      id = demo-<sid>  («ИмпульС · Демо-клуб»)
//   · владелец    роль owner, помечен demo_session (вход без passkey — Ф3)
//   · тренер      «Андрей Смирнов», роль trainer, branch_key = филиал
//   · 3 атлета    Артём (regular), Вероника (casual), Дмитрий (churn) —
//                  состояние (история тренировок, вес тела, цели) генерирует
//                  demo-seed.js, метрики для аналитики считаются сразу.
//   · лояльность  правила филиала + события → кошельки/ledger через движок
//   · расписание  часы тренера + пара записей (подтверждённая/заявка/выполнена)
//
// Вся сущность клона помечены sessionId (admin_users.demo_session,
// users.demo_session, id филиала) — destroyDemoClub удаляет ровно этот клон
// (файлы состояния, строки БД, правила, метрики), ничего чужого не трогая.
// Так посетители demo.gym.trfnv.ru не видят клоны друг друга и реальных данных.
import fs from 'node:fs';
import path from 'node:path';
import { pool } from './access-db.js';
import {
  adminDbReady, saveBranch, saveLoyaltyRule, acceptLoyaltyEvent,
  setTrainerAssignment, setTrainerAvailability, createBooking, saveNotification,
  saveReward, listExpiredDemoSessions, purgeDemoTokens
} from './admin-db.js';
import { replaceAthleteMetrics } from './metrics.js';
import { buildDemoState } from './demo-seed.js';

const BRANCH_NAME = 'ИмпульС · Демо-клуб';
const TRAINER_NAME = 'Андрей Смирнов';
const OWNER_NAME = 'Демо-владелец';
const ATHLETES = [
  { key: 'artem', persona: 'regular', name: 'Артём' },
  { key: 'vera', persona: 'casual', name: 'Вероника' },
  { key: 'dima', persona: 'churn', name: 'Дмитрий' }
];

export const demoIds = sessionId => ({
  branchId: 'demo-' + sessionId,
  ownerId: 'demo-owner-' + sessionId,
  trainerId: 'demo-trainer-' + sessionId,
  athleteIds: Object.fromEntries(ATHLETES.map(a => [a.key, 'demo-' + a.key + '-' + sessionId]))
});

// Из id демо-владельца (demo-owner-<sid>) обратно в id сессии — нужно в
// POST /api/demo/end, чтобы зачистить клон по куке админ-сессии.
export const ownerIdToSession = id => {
  const m = /^demo-owner-(.+)$/.exec(String(id || ''));
  return m ? m[1] : null;
};

// Один прогон cleaner'а (для тестов и для таймера): сессии с истёкшим TTL
// полностью удаляются вместе с клонами, протухшие/использованные токены
// вычищаются. Возвращает число удалённых сессий.
export async function runDemoCleanupOnce({ db, saveDb, dataDir, now = () => new Date() }) {
  const expired = await listExpiredDemoSessions(now());
  for (const s of expired) {
    try {
      await destroyDemoClub({ sessionId: s.id, db, saveDb, dataDir });
      console.log('[demo] cleaned expired session', s.id);
    } catch (e) {
      console.error('[demo] cleanup failed for', s.id, e.message);
    }
  }
  await purgeDemoTokens(now()).catch(() => {});
  return expired.length;
}

// Фоновый cleaner: первый прогон сразу при старте (подчистить наследие после
// перезапуска), затем каждые intervalMs. Запускается только при DEMO_MODE=1.
export function startDemoCleaner(deps) {
  const intervalMs = deps.intervalMs || 5 * 60 * 1000;
  runDemoCleanupOnce(deps).catch(e => console.error('[demo] initial cleanup failed:', e.message));
  const t = setInterval(() => {
    runDemoCleanupOnce(deps).catch(e => console.error('[demo] cleaner tick failed:', e.message));
  }, intervalMs);
  if (t.unref) t.unref();
  return t;
}

// Создание клона. db/saveDb/dataDir — пользовательское хранилище (server.js):
// users в памяти + файл состояния на диск. Всё остальное — в БД клона.
export async function spawnDemoClub({ sessionId, db, saveDb, dataDir, lang = 'ru' }) {
  await adminDbReady;
  const { branchId, ownerId, trainerId, athleteIds } = demoIds(sessionId);

  await pool.query(
    `INSERT INTO admin_users (id, name, role, branch_key, demo_session) VALUES ($1, $2, 'owner', NULL, $3)
     ON CONFLICT (id) DO NOTHING`, [ownerId, OWNER_NAME, sessionId]
  );
  await pool.query(
    `INSERT INTO admin_users (id, name, role, branch_key, demo_session) VALUES ($1, $2, 'trainer', $3, $4)
     ON CONFLICT (id) DO NOTHING`, [trainerId, TRAINER_NAME, branchId, sessionId]
  );
  const branch = await saveBranch({ id: branchId, name: BRANCH_NAME });

  // Правила лояльности филиала — до событий, чтобы движок их сразу применял.
  const rules = [
    { name: 'Посещение', eventType: 'visit', points: 2, limits: { period: 'week', max_per_period: 7 } },
    { name: 'Завершение тренировки', eventType: 'workout_completed', points: 5, limits: { period: 'week', max_per_period: 7 } },
    { name: 'Серия тренировок', eventType: 'streak', points: 30, limits: { period: 'month', max_per_period: 2 } }
  ];
  for (const r of rules) {
    await saveLoyaltyRule({
      id: 'demo-' + sessionId + '-' + r.eventType,
      name: r.name, eventType: r.eventType, enabled: true,
      conditions: { branch_key: branchId },
      actions: [{ type: 'points', amount: r.points }],
      limits: r.limits, createdBy: ownerId
    });
  }

  // Каталог наград клуба (в демо-БД он пустой — наполняем для витрины).
  await saveReward({ name: 'Фирменная бутылка', description: 'Мерч клуба за баллы', kind: 'merch', cost: 400, deliveryMode: 'staff', active: true, createdBy: ownerId });
  await saveReward({ name: 'Персональная тренировка', description: '1 занятие с тренером', kind: 'training', cost: 1500, deliveryMode: 'staff', active: true, createdBy: ownerId });

  // Атлеты: пользователь + state-файл + метрики + привязка к тренеру.
  const created = [];
  let eventNo = 0;
  for (const a of ATHLETES) {
    const uid = athleteIds[a.key];
    const S = buildDemoState({ persona: a.persona });
    db.users.push({ id: uid, name: a.name, created: new Date().toISOString(), demo_session: sessionId });
    fs.writeFileSync(path.join(dataDir, 'state-' + uid + '.json'), JSON.stringify(S));
    await replaceAthleteMetrics(uid, S);
    await setTrainerAssignment({ userId: uid, trainerId });

    // События лояльности из сгенерированной истории: визит + завершение
    // тренировки на каждый день занятий, пара серий — кошельки наполняются
    // движком правил (а не вручную), как в реальной жизни.
    for (const w of S.workouts || []) {
      await acceptLoyaltyEvent({
        eventId: `demo-${sessionId}-${uid}-visit-${++eventNo}`,
        userId: uid, eventType: 'visit', branchKey: branchId,
        occurredAt: new Date(w.start).toISOString(), payload: {}, lang
      });
      await acceptLoyaltyEvent({
        eventId: `demo-${sessionId}-${uid}-wc-${++eventNo}`,
        userId: uid, eventType: 'workout_completed', branchKey: branchId,
        occurredAt: new Date(w.end).toISOString(), payload: {}, lang
      });
    }
    await acceptLoyaltyEvent({
      eventId: `demo-${sessionId}-${uid}-streak-1`,
      userId: uid, eventType: 'streak', branchKey: branchId,
      occurredAt: S.workouts.length ? new Date(S.workouts[0].end).toISOString() : new Date().toISOString(), payload: {}, lang
    });

    if (a.key === 'artem') {
      await saveNotification({
        id: `demo-${sessionId}-artem-welcome`, userId: uid, lang,
        title: 'Добро пожаловать в демо-клуб', body: 'Это изолированный демо-клуб: данные удалятся по окончании сессии.'
      });
    }
    created.push({ key: a.key, id: uid, name: a.name, persona: a.persona });
  }

  // Расписание тренера: пн–вс 09:00–20:00 + три показательные записи.
  await setTrainerAvailability(trainerId, [0, 1, 2, 3, 4, 5, 6].map(weekday => ({
    weekday, time_start: '09:00', time_end: '20:00'
  })));
  const dayIso = offset => { const d = new Date(); d.setDate(d.getDate() + offset); return d.toISOString().slice(0, 10); };
  await createBooking({ trainerId, athleteId: athleteIds.artem, date: dayIso(7), time: '10:00', note: 'Демо-запись: подтверждена', status: 'confirmed' });
  await createBooking({ trainerId, athleteId: athleteIds.vera, date: dayIso(4), time: '12:00', note: 'Демо-заявка от спортсменки', status: 'pending' });
  await createBooking({ trainerId, athleteId: athleteIds.dima, date: dayIso(-1), time: '11:00', note: 'Демо-запись: выполнена', status: 'done' });

  return { sessionId, branchId, ownerId, trainerId, branch, athletes: created };
}

// Полное удаление клона: state-файлы, пользователи, строки БД — атомарно.
export async function destroyDemoClub({ sessionId, db, saveDb, dataDir }) {
  const { branchId, ownerId, trainerId, athleteIds } = demoIds(sessionId);
  const userUids = Object.values(athleteIds);
  for (const uid of userUids) {
    try { fs.unlinkSync(path.join(dataDir, 'state-' + uid + '.json')); } catch { /* уже нет */ }
  }
  db.users = (db.users || []).filter(u => u.demo_session !== sessionId);
  saveDb();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // ВАЖНО: плейсхолдеры IN-списка НЕ должны пересекаться с $1 других условий —
    // pg считает параметры по максимальному номеру плейсхолдера, и повторный $1
    // вместе с IN($1,$2,$3) даёт «supplies 4 parameters, requires 3».
    const userIds = userUids.map((_, i) => '$' + (i + 1)).join(',');
    const args = [...userUids];
    for (const table of ['loyalty_outbox', 'loyalty_ledger', 'loyalty_accounts', 'loyalty_events',
      'loyalty_achievements', 'loyalty_unlocks', 'loyalty_redemptions', 'app_notifications', 'athlete_metrics']) {
      await client.query(`DELETE FROM ${table} WHERE user_id IN (${userIds})`, args);
    }
    // IN-список со смещением: $1 — trainer_id, потом $2..$4 — атлеты.
    const userIdsOffset = userUids.map((_, i) => '$' + (i + 2)).join(',');
    await client.query(`DELETE FROM coach_bookings WHERE trainer_id = $1 OR athlete_id IN (${userIdsOffset})`, [trainerId, ...args]);
    await client.query('DELETE FROM trainer_availability WHERE trainer_id = $1', [trainerId]);
    await client.query(`DELETE FROM trainer_assignments WHERE trainer_id = $1 OR user_id IN (${userIdsOffset})`, [trainerId, ...args]);
    await client.query('DELETE FROM loyalty_rewards WHERE created_by = $1', [ownerId]);
    await client.query('DELETE FROM loyalty_rules WHERE created_by = $1', [ownerId]);
    await client.query('DELETE FROM admin_users WHERE id = $1 OR id = $2', [ownerId, trainerId]);
    await client.query('DELETE FROM branches WHERE id = $1', [branchId]);
    await client.query('DELETE FROM demo_sessions WHERE id = $1', [sessionId]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  return { sessionId, removedUsers: userUids };
}