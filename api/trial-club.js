// api/trial-club.js — жизненный цикл Trial-клубов (Шаги 4-5, docs/design-step4-5.md).
//
// Продолжение мультитенантной модели: trial-клуб — это РЕАЛЬНЫЙ клуб в таблице
// clubs (plan='trial', trial_until=now()+TTL), НЕ demo-сессия. Он живёт на
// проде рядом с платными клубами, но:
//   · пока trial активен — его owner видит только свой клуб (скоуп Шага 3);
//   · по истечении trial_until воркер переводит клуб в status='frozen' —
//     kill-switch (см. requireAdminAccount в server.js) закрывает доступ всему
//     персоналу немедленно, данные сохраняются (клиент может оплатить);
//   · после grace-периода (TRIAL_GRACE_DAYS, по умолчанию 30) frozen-триал
//     удаляется полностью через destroyClub.
//
// Функции:
//   · startTrialCleaner({db, saveDb, dataDir, intervalMs}) — фоновый GC
//   · freezeExpiredTrials() — один проход: trial_until < now → status='frozen'
//   · purgeExpiredFrozenClubs(...) — один проход: frozen + grace истёк → destroy
//   · destroyClub({clubId, db, saveDb, dataDir}) — полное удаление клуба:
//     PG-строки (админы+passkeys, филиалы, лояльность, брони, метрики, атлеты)
//     и файловые данные (state-файлы атлетов клуба, записи в db.json).
import fs from 'node:fs';
import path from 'node:path';
import { pool } from './access-db.js';
import { adminDbReady, getClub, setClubStatus, listExpiredTrials, listFrozenExpiredGrace, listAdmins, listBranches, listLoyaltyRules, listRewards,
  acceptLoyaltyEvent, setTrainerAssignment, setTrainerAvailability, createBooking, saveLoyaltyRule, saveReward, saveBranch,
  countTrialRequestsSince, addTrialRequest, purgeOldTrialRequests, trialEmailBudgetUsed, trialEmailBudgetIncrement } from './admin-db.js';
import { replaceAthleteMetrics } from './metrics.js';
import { buildDemoState } from './demo-seed.js';
import dns from 'node:dns';
import { sendEmail } from './email.js';
import { createTrialOwnerInvite } from './admin-db.js';

const GRACE_DAYS = Math.max(0, +(process.env.TRIAL_GRACE_DAYS || 30));

// Перевести просроченные активные trial-клубы в frozen. Возвращает список.
export async function freezeExpiredTrials(now = new Date()) {
  await adminDbReady;
  if (!pool) return [];
  const expired = await listExpiredTrials(now);
  const frozen = [];
  for (const club of expired) {
    try {
      await setClubStatus(club.id, 'frozen');
      frozen.push(club.id);
      // Уведомление владельцу: данные сохранены, можно продлить.
      if (club.owner_email) {
        const msg = `Тrial «${club.name}» истёк. Доступ приостановлен, данные сохранены на ${GRACE_DAYS} дн. — продлите подписку, чтобы продолжить.`;
        try {
          await sendEmail({ to: club.owner_email, subject: 'Trial истёк — данные сохранены', text: msg }).catch(() => {});
        } catch (e) { console.error('[trial-gc] expiry email failed for', club.id, e.message); }
      }
      console.log('[trial-gc] frozen expired trial', club.id, club.name);
    } catch (e) {
      console.error('[trial-gc] freeze failed for', club.id, e.message);
    }
  }
  return frozen;
}

// Полное удаление клуба: PG + db.json + state-файлы. Для frozen-триалов после
// grace-периода. Атомарность: PG-удаление в транзакции; файловая часть после.
export async function destroyClub({ clubId, db, saveDb, dataDir, now = new Date() }) {
  await adminDbReady;
  if (!pool) throw new Error('no database');
  const club = await getClub(clubId);
  if (!club) return { removed: false, reason: 'not found' };

  // Все сотрудники и атлеты клуба.
  const staff = await listAdmins();
  const staffIds = staff.filter(a => a.club_id === clubId).map(a => a.id);
  const adminRows = await pool.query(
    `SELECT a.id, a.name FROM admin_users a WHERE a.club_id = $1 AND a.deleted_at IS NULL`, [clubId]
  );
  const allAdminIds = [...new Set([...staffIds, ...adminRows.rows.map(r => r.id)])];
  const branches = (await listBranches()).filter(b => b.club_id === clubId).map(b => b.id);

  // Спортсмены клуба в db.json (users с club_id этого клуба) — их state-файлы.
  const athleteIds = (db.users || []).filter(u => u.club_id === clubId).map(u => u.id);
  for (const uid of athleteIds) {
    try { fs.unlinkSync(path.join(dataDir, 'state-' + uid.replace(/[^a-zA-Z0-9_-]/g, '') + '.json')); } catch { /* уже нет */ }
  }
  // Удаляем и пользователей (включая админ-записи, если они есть в db.json).
  db.users = (db.users || []).filter(u => u.club_id !== clubId);
  db.creds = (db.creds || []).filter(c => !athleteIds.includes(c.userId));
  db.subs = (db.subs || []).filter(sub => !athleteIds.includes(sub.userId));
  // Подстраховка: если db.json разошёлся с диском (клуб создан до ребута,
  // пользователи добавлены напрямую и т.п.) — вычищаем state-файлы клуба
  // ПРЕФИКСОМ. Для trial-клубов uid = `<clubId>-<key>`, поэтому сканирование
  // каталога добирает осиротевшие файлы, которых нет в db.users.
  let prefixStates = 0;
  try {
    for (const f of fs.readdirSync(dataDir)) {
      if (f.startsWith('state-' + clubId + '-') && f.endsWith('.json')) {
        try { fs.unlinkSync(path.join(dataDir, f)); prefixStates++; } catch { /* гонка — файл уже удалён */ }
      }
    }
  } catch { /* dataDir недоступен — пропускаем */ }
  if (prefixStates) console.log('[trial-gc] destroy: убрано осиротевших state-файлов:', prefixStates);
  if (saveDb) saveDb();

  const allUserIds = [...new Set([...allAdminIds, ...athleteIds])];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Дочерние таблицы, привязанные к пользователям клуба (динамический IN).
    const uidList = allUserIds.map((_, i) => '$' + (i + 1)).join(',');
    const uidArgs = allUserIds;
    for (const table of ['loyalty_outbox', 'loyalty_ledger', 'loyalty_accounts', 'loyalty_events',
      'loyalty_achievements', 'loyalty_unlocks', 'loyalty_redemptions', 'app_notifications', 'athlete_metrics']) {
      if (allUserIds.length) await client.query(`DELETE FROM ${table} WHERE user_id IN (${uidList})`, uidArgs);
    }
    if (allUserIds.length) {
      await client.query(`DELETE FROM coach_bookings WHERE athlete_id IN (${uidList})`, uidArgs);
      await client.query(`DELETE FROM recurring_bookings WHERE athlete_id IN (${uidList})`, uidArgs);
      // recurring_skips ключуется series_id (см. coach_bookings.series_id), колонки
      // athlete_id в ней нет — пропуски серий уходят вместе с самими сериями выше.
      await client.query(`DELETE FROM trainer_assignments WHERE user_id IN (${uidList})`, uidArgs);
    }
    // Всё, созданное владельцем/сотрудниками клуба (правила, награды, брони).
    if (allAdminIds.length) {
      const aList = allAdminIds.map((_, i) => '$' + (i + 1)).join(',');
      const aArgs = allAdminIds;
      for (const table of ['loyalty_rules', 'loyalty_rewards', 'private_codes']) {
        await client.query(`DELETE FROM ${table} WHERE created_by IN (${aList})`, aArgs);
      }
      await client.query(`DELETE FROM coach_bookings WHERE trainer_id IN (${aList})`, aArgs);
      await client.query(`DELETE FROM trainer_availability WHERE trainer_id IN (${aList})`, aArgs);
      await client.query(`DELETE FROM trainer_assignments WHERE trainer_id IN (${aList})`, aArgs);
      await client.query(`DELETE FROM admin_credentials WHERE admin_id IN (${aList})`, aArgs);
      await client.query(`DELETE FROM admin_users WHERE id IN (${aList})`, aArgs);
    }
    // Филиалы клуба и сам клуб.
    if (branches.length) {
      const bList = branches.map((_, i) => '$' + (i + 1)).join(',');
      await client.query(`DELETE FROM branches WHERE id IN (${bList})`, branches);
    }
    await client.query('DELETE FROM clubs WHERE id = $1', [clubId]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[trial-gc] destroyClub DB failed for', clubId, e.message);
    throw e;
  } finally {
    client.release();
  }
  return { removed: true, athletes: athleteIds.length, staff: allAdminIds.length };
}

// Очистка демо-данных клуба («Clear demo data», кнопка у владельца trial-клуба).
// Удаляет ровно is_seed=true строки, созданные spawnTrialClub: seed-тренера +
// seed-атлетов, их state-файлы, db.json-записи (users/creds), подписки на пуши
// и все строки БД (метрики, лояльность, брони, уведомления, аватарки-креды).
// НЕ трогает:
//   · владельца — реальный аккаунт, вошедший по magic-link (у него есть passkey,
//     поэтому запись admin_users не попадает в выборку ниже);
//   · филиалы, правила лояльности и награды — витрина клуба, владелец
//     редактирует их как свои (созданы его seed-owner'ом = им самим);
//   · реальных клиентов, заведённых владельцем за время триала (is_seed=false).
// Возвращает { athletes, staff, states } — сколько удалено по каждому типу.
export async function purgeSeedData({ clubId, db, saveDb, dataDir }) {
  await adminDbReady;
  if (!pool) throw new Error('no database');
  if (!clubId) throw new Error('clubId is required');

  // 1) db.json: seed-атлеты клуба (is_seed=true) — их state-файлы + записи.
  const seedUsers = (db.users || []).filter(u => u.club_id === clubId && u.is_seed === true);
  const athleteIds = seedUsers.map(u => u.id);
  let states = 0;
  for (const uid of athleteIds) {
    try { fs.unlinkSync(path.join(dataDir, 'state-' + uid.replace(/[^a-zA-Z0-9_-]/g, '') + '.json')); states++; } catch { /* уже нет */ }
  }
  if (athleteIds.length) {
    db.users = (db.users || []).filter(u => !(u.club_id === clubId && u.is_seed === true));
    db.creds = (db.creds || []).filter(c => !athleteIds.includes(c.userId));
    db.subs = (db.subs || []).filter(sub => !athleteIds.includes(sub.userId));
    if (saveDb) saveDb();
  }

  // 2) БД: is_seed админ-записи клуба БЕЗ passkey (у владельца после входа по
  //    magic-link passkey есть — его строка автоматически исключается).
  const seeded = await pool.query(
    `SELECT a.id, a.role FROM admin_users a
     WHERE a.club_id = $1 AND a.is_seed = true AND a.deleted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM admin_credentials c WHERE c.admin_id = a.id)`,
    [clubId]
  );
  const staffIds = seeded.rows.filter(r => r.role !== 'owner').map(r => r.id);
  const allIds = [...new Set([...athleteIds, ...staffIds])];
  const client = await pool.connect();
  try {
    if (allIds.length) {
      const list = allIds.map((_, i) => '$' + (i + 1)).join(',');
      const args = allIds;
      for (const table of ['loyalty_outbox', 'loyalty_ledger', 'loyalty_accounts', 'loyalty_events',
        'loyalty_achievements', 'loyalty_unlocks', 'loyalty_redemptions', 'app_notifications', 'athlete_metrics']) {
        await client.query(`DELETE FROM ${table} WHERE user_id IN (${list})`, args);
      }
      await client.query(`DELETE FROM coach_bookings WHERE athlete_id IN (${list})`, args);
      await client.query(`DELETE FROM recurring_bookings WHERE athlete_id IN (${list})`, args);
      // recurring_skips НЕ имеет колонки athlete_id (ключ — series_id, см.
      // coach_bookings.series_id) — привязанные пропуски удаляются вместе с
      // самой серией через recurring_bookings/coach_bookings выше.
      await client.query(`DELETE FROM trainer_assignments WHERE user_id IN (${list})`, args);
      // Строки, созданные seed-тренером (правила/награды он не создавал — их
      // создал seed-owner; но на всякий случай чистим, если что-то осталось).
      await client.query(`DELETE FROM loyalty_rules WHERE created_by IN (${list})`, args);
      await client.query(`DELETE FROM loyalty_rewards WHERE created_by IN (${list})`, args);
    }
    if (staffIds.length) {
      const aList = staffIds.map((_, i) => '$' + (i + 1)).join(',');
      await client.query(`DELETE FROM coach_bookings WHERE trainer_id IN (${aList})`, staffIds);
      await client.query(`DELETE FROM trainer_availability WHERE trainer_id IN (${aList})`, staffIds);
      await client.query(`DELETE FROM trainer_assignments WHERE trainer_id IN (${aList})`, staffIds);
      await client.query(`DELETE FROM admin_credentials WHERE admin_id IN (${aList})`, staffIds);
      await client.query(`DELETE FROM admin_users WHERE id IN (${aList})`, staffIds);
    }
  } finally {
    client.release();
  }
  return { athletes: athleteIds.length, staff: staffIds.length, states };
}

// Удалить frozen-триалы, чей grace-период истёк.
export async function purgeExpiredFrozenClubs({ db, saveDb, dataDir, now = new Date() }) {
  await adminDbReady;
  if (!pool) return [];
  const graceMs = GRACE_DAYS * 86400000;
  const candidates = await listFrozenExpiredGrace(graceMs, now);
  const removed = [];
  for (const club of candidates) {
    try {
      await destroyClub({ clubId: club.id, db, saveDb, dataDir, now });
      removed.push(club.id);
      console.log('[trial-gc] purged expired frozen trial', club.id);
    } catch (e) {
      console.error('[trial-gc] purge failed for', club.id, e.message);
    }
  }
  return removed;
}

// Фоновый GC: первый проход сразу, затем каждые intervalMs (по умолчанию 15 мин).
export function startTrialCleaner({ db, saveDb, dataDir, intervalMs = 15 * 60 * 1000 }) {
  const run = async () => {
    try {
      await freezeExpiredTrials();
      await purgeExpiredFrozenClubs({ db, saveDb, dataDir });
    } catch (e) {
      console.error('[trial-gc] tick failed:', e.message);
    }
  };
  setTimeout(run, 15000);          // скоро после старта
  const t = setInterval(run, intervalMs);
  if (t.unref) t.unref();          // не держим процесс из-за GC
  return run;
}

export { GRACE_DAYS };

/* ================= spawn: наполнение trial-клуба демо-контентом ================= */

const ATHLETES = [
  { key: 'artem', persona: 'regular', name: 'Артём' },
  { key: 'vera', persona: 'casual', name: 'Вера' },
  { key: 'dima', persona: 'churn', name: 'Дима' }
];

// Сгенерировать детерминированный trial-код (по времени) — id всех сущностей.
export function trialCode(ts = Date.now()) {
  return (ts % 1e12).toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase();
}

// Создать РЕАЛЬНЫЙ trial-клуб: clubs-строка + филиал + тренер + 3 seed-атлета
// с state-файлами, метриками, лояльностью. Owner НЕ создаётся здесь — он
// регистрируется по magic-link (invite, роль owner, club_id этого клуба).
// is_seed=true на всём спавне — purge-seed удалит ровно демо-данные, реальные
// клиенты владельца (is_seed=false) не затрагиваются.
export async function spawnTrialClub({ email, gymName = 'Мой клуб', db, saveDb, dataDir, lang = 'ru', ttlMs = 14 * 86400000 }) {
  const now = new Date();
  const code = trialCode(now.getTime());
  const clubId = 'trial-' + code.toLowerCase();
  const branchId = clubId + '-b';
  const seedOwnerId = clubId + '-o';
  const trainerId = clubId + '-tr';
  const athleteUids = Object.fromEntries(ATHLETES.map(a => [a.key, clubId + '-' + a.key]));

  // 1) Клуб (trial, TTL). active до trial_until; GC переведёт в frozen.
  await pool.query(
    `INSERT INTO clubs (id, name, owner_email, owner_admin_id, status, plan, trial_until)
     VALUES ($1, $2, $3, NULL, 'active', 'trial', $4) ON CONFLICT (id) DO NOTHING`,
    [clubId, String(gymName).trim().slice(0, 80) || 'Мой клуб', email, new Date(now.getTime() + ttlMs)]
  );

  // 2) Филиал клуба.
  await saveBranch({ id: branchId, name: 'Основной зал', clubId });

  // 3) Seed-тренер (is_seed — удаляется purge-seed / destroy).
  await pool.query(
    `INSERT INTO admin_users (id, name, role, club_id, branch_key, is_seed)
     VALUES ($1, $2, 'trainer', $3, $4, true) ON CONFLICT (id) DO NOTHING`,
    [trainerId, 'Андрей Смирнов', clubId, branchId]
  );
  // Seed-owner — техническая запись (created_by правил/наград), вход не даёт.
  await pool.query(
    `INSERT INTO admin_users (id, name, role, club_id, is_seed)
     VALUES ($1, $2, 'owner', $3, true) ON CONFLICT (id) DO NOTHING`,
    [seedOwnerId, 'Основатель (демо)', clubId]
  );

  // 4) Правила лояльности + награды витрины.
  const rules = [
    { name: 'Посещение', eventType: 'visit', points: 2, limits: { period: 'week', max_per_period: 7 } },
    { name: 'Завершение тренировки', eventType: 'workout_completed', points: 5, limits: { period: 'week', max_per_period: 7 } },
    { name: 'Серия тренировок', eventType: 'streak', points: 30, limits: { period: 'month', max_per_period: 2 } }
  ];
  for (const r of rules) {
    await saveLoyaltyRule({
      id: clubId + '-' + r.eventType, name: r.name, eventType: r.eventType, enabled: true,
      conditions: { branch_key: branchId }, actions: [{ type: 'points', amount: r.points }],
      limits: r.limits, createdBy: seedOwnerId, clubId
    });
  }
  await saveReward({ id: clubId + '-bottle', name: 'Фирменная бутылка', description: 'Мерч клуба за баллы', kind: 'merch', cost: 400, deliveryMode: 'staff', active: true, createdBy: seedOwnerId, clubId });
  await saveReward({ id: clubId + '-pt', name: 'Персональная тренировка', description: '1 занятие с тренером', kind: 'training', cost: 1500, deliveryMode: 'staff', active: true, createdBy: seedOwnerId, clubId });

  // 5) Seed-атлеты: users + state-файлы + метрики + привязка к тренеру + лояльность.
  let eventNo = 0;
  const created = [];
  for (const a of ATHLETES) {
    const uid = athleteUids[a.key];
    const S = buildDemoState({ persona: a.persona });
    db.users.push({ id: uid, name: a.name, created: now.toISOString(), club_id: clubId, branch_key: branchId, is_seed: true });
    fs.writeFileSync(path.join(dataDir, 'state-' + uid + '.json'), JSON.stringify(S));
    await replaceAthleteMetrics(uid, S);
    await setTrainerAssignment({ userId: uid, trainerId });
    for (const w of S.workouts || []) {
      await acceptLoyaltyEvent({ eventId: `${clubId}-${uid}-visit-${++eventNo}`, userId: uid, eventType: 'visit', branchKey: branchId, occurredAt: new Date(w.start).toISOString(), payload: {}, lang });
      await acceptLoyaltyEvent({ eventId: `${clubId}-${uid}-wc-${++eventNo}`, userId: uid, eventType: 'workout_completed', branchKey: branchId, occurredAt: new Date(w.end).toISOString(), payload: {}, lang });
    }
    if (S.workouts && S.workouts.length) {
      await acceptLoyaltyEvent({ eventId: `${clubId}-${uid}-streak-1`, userId: uid, eventType: 'streak', branchKey: branchId, occurredAt: new Date(S.workouts[0].end).toISOString(), payload: {}, lang });
    }
    created.push({ key: a.key, id: uid, name: a.name });
  }
  if (saveDb) saveDb();

  // 6) Расписание тренера + показательные записи.
  await setTrainerAvailability(trainerId, [0, 1, 2, 3, 4, 5, 6].map(weekday => ({ weekday, time_start: '09:00', time_end: '20:00' })));
  const dayIso = offset => { const d = new Date(); d.setDate(d.getDate() + offset); return d.toISOString().slice(0, 10); };
  await createBooking({ trainerId, athleteId: athleteUids.artem, date: dayIso(3), time: '10:00', note: 'Запись после регистрации', status: 'confirmed' });

  return { clubId, branchId, seedOwnerId, trainerId, athleteUids, branch: branchId, athletes: created, code };
}

/* ================= публичный /api/trial: защита от спама ================= */

const RE_EMAIL = /^[^\s@]{1,120}@[^\s@]{1,120}\.[^\s@]{2,}$/;
// MX-проверка с жёстким таймаутом: dns.resolveMx — сетевой вызов к чужим DNS,
// может висеть. Promise.race на 2000 мс; без ответа — отклоняем (надёжнее
// для Resend-бюджета, чем пропустить фейковый домен).
export function domainHasMx(domain, timeoutMs = 2000) {
  return new Promise(resolve => {
    let done = false;
    const finish = v => { if (!done) { done = true; resolve(v); } };
    const t = setTimeout(() => finish(false), timeoutMs);
    dns.resolveMx(domain, (err, addrs) => {
      clearTimeout(t);
      finish(!err && Array.isArray(addrs) && addrs.length > 0);
    });
  });
}

export async function validateTrialEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!RE_EMAIL.test(e) || e.length > 120) return { ok: false, error: 'invalid email' };
  const domain = e.split('@')[1];
  // Одноразовые/мусорные домены — блок-лист (env DISPOSABLE_DOMAINS, через запятую).
  const block = (process.env.DISPOSABLE_DOMAINS || 'mailinator.com,yopmail.com,guerrillamail.com,sharklasers.com,tempmail.com').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
  if (block.includes(domain)) return { ok: false, error: 'disposable email domain not allowed' };
  const mx = await domainHasMx(domain);
  if (!mx) return { ok: false, error: 'email domain does not accept mail' };
  return { ok: true, email: e };
}

// Rate-limit по IP в БД: TRIAL_PER_IP_HOUR (по умолчанию 2) и TRIAL_PER_IP_DAY (5).
// In-memory Map не годится — сбрасывается при рестарте и не работает на 2+ инстансах.
export async function trialRateLimited(ip) {
  const HOUR = 3600e3, DAY = 86400e3;
  const perHour = Math.max(0, +(process.env.TRIAL_PER_IP_HOUR || 2));
  const perDay = Math.max(0, +(process.env.TRIAL_PER_IP_DAY || 5));
  const [h, d] = await Promise.all([
    countTrialRequestsSince(ip, new Date(Date.now() - HOUR)),
    countTrialRequestsSince(ip, new Date(Date.now() - DAY))
  ]);
  if (h >= perHour || d >= perDay) return { limited: true, error: 'too many trial requests — try later' };
  await addTrialRequest(ip);
  await purgeOldTrialRequests(25).catch(() => {});   // ленивая чистка хвоста
  return { limited: false };
}

// Полный флоу запроса trial-клуба. Вызывается из роута; возвращает
// { ok, code, invite?, email? } — роут отдаёт клиенту минимум, письмо уходит
// через sendEmail (Resend). Месячный бюджет защищает от «разорения».
export async function requestTrialClub({ email, gymName, ip, db, saveDb, dataDir, origin, lang = 'ru' }) {
  const v = await validateTrialEmail(email);
  if (!v.ok) return { ok: false, error: v.error };

  const rl = await trialRateLimited(ip);
  if (rl.limited) return { ok: false, error: rl.error, status: 429 };

  const TRIAL_TTL_MS = Math.max(86400000, +(process.env.TRIAL_TTL_DAYS || 14) * 86400000);
  const spawned = await spawnTrialClub({ email: v.email, gymName, db, saveDb, dataDir, lang, ttlMs: TRIAL_TTL_MS });

  // Owner magic-link: инвайт роли owner для этого club_id.
  const invite = await createTrialOwnerInvite({ name: 'Владелец клуба', createdBy: spawned.seedOwnerId, clubId: spawned.clubId });

  // Месячный бюджет Resend: превышен → отвечаем 503, но клуб уже создан (владелец
  // сможет получить ссылку через саппорт; повторный запрос с того же IP будет
  // 429 по rate-limit — приемлемо и безопаснее, чем слать без бюджета).
  const budgetMax = Math.max(0, +(process.env.TRIAL_EMAIL_MONTH_BUDGET || 200));
  const used = await trialEmailBudgetUsed();
  if (budgetMax && used >= budgetMax) {
    return { ok: false, error: 'trial email quota exceeded — try again later', status: 503 };
  }

  const regUrl = origin + '/admin/register?code=' + invite.code;
  const html = `
    <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px">
      <h2 style="margin:0 0 8px">Ваш клуб <b>${esc(gymName)}</b> готов в ИмпульС</h2>
      <p style="color:#444">Мы создали изолированный trial-клуб с примерами данных (тренер, спортсмены,
      программа лояльности) — посмотрите, как всё устроено изнутри.</p>
      <p style="color:#444">Нажмите кнопку, чтобы настроить вход (passkey) и попасть в админку клуба:</p>
      <p><a href="${regUrl}" style="display:inline-block;background:#16a34a;color:#fff;padding:12px 22px;border-radius:10px;text-decoration:none;font-weight:600">Войти в мой клуб →</a></p>
      <p style="color:#888;font-size:12px">Ссылка одноразовая и действует ${Math.round(TRIAL_TTL_MS / 86400000)} дней — до конца trial-периода.
      Если кнопка не работает: ${regUrl}</p>
    </div>`;
  const okMail = await sendEmail({ to: v.email, subject: 'Ваш клуб готов — ИмпульС', html, text: 'Ваш клуб готов: ' + regUrl })
    .then(() => true).catch(e => { console.error('[trial] welcome email failed:', e.message); return false; });
  if (okMail) await trialEmailBudgetIncrement(1);

  return { ok: true, club_id: spawned.clubId, email_sent: okMail, code: invite.code };
}

function esc(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
