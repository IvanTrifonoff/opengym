/* api/metrics.js — инкрементальные тренировочные метрики спортсменов (PostgreSQL).
 *
 * Зачем: полная история тренировок живёт в per-user JSON-файлах (data/state-*.json),
 * а аналитика (обзор / список / лидерборд) раньше читала и парсила ВСЕ эти файлы
 * с диска на каждый запрос (N синхронных readFileSync в одном запросе). Чтобы
 * агрегация была SQL'ем, а не циклом по файлам, после каждой сохранённой
 * тренировки мы пишем денормализованные агрегаты по дням в таблицу
 * `athlete_metrics` (user_id, day, workouts, volume, sets, exercises).
 *
 *   · metricsFromState(S)           — чистая функция: state → дни с метриками
 *   · replaceAthleteMetrics(userId, S) — перезапись метрик одного спортсмена
 *                                       (DELETE всех его строк + batch INSERT)
 *   · backfillAthleteMetrics(...)   — разовый пересчёт по всем users из файлов
 *                                     (вызывается при старте api)
 *
 * Объём метрики — вес × повторения (как в analytics.workoutVolume): kg/фунты по
 * unit спортсмена, но сами единицы здесь не хранятся (см. docs/analytics-metrics.md).
 *
 * Полная перезапись на каждое сохранение — осознанный выбор: файл одного
 * спортсмена — источник правды (workouts в нём), а его размер (десятки-сотни
 * тренировок) делает DELETE+INSERT в транзакции дешёвым. Пересчёт только
 * изменившихся дней потребовал бы хранить прошлые дни и ловить удаления.
 */
import { pool } from './access-db.js';

// state → [{ day: 'YYYY-MM-DD', workouts, volume, sets, exercises }]
// Один объект на день; volume — сумма (вес × повторения) выполненных подходов.
export function metricsFromState(S) {
  const byDay = new Map();
  for (const w of (S && S.workouts) || []) {
    if (!w || !w.d) continue;
    const day = String(w.d).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue; // мусорные даты не попадают в таблицу
    let m = byDay.get(day);
    if (!m) { m = { day, workouts: 0, volume: 0, sets: 0, exercises: 0 }; byDay.set(day, m); }
    m.workouts++;
    for (const e of w.entries || []) {
      const done = (e.sets || []).filter(s => s && s.done);
      if (done.length) m.exercises++;
      for (const s of done) { m.sets++; m.volume += (s.w || 0) * (s.r || 0); }
    }
  }
  const out = [...byDay.values()];
  out.forEach(m => { m.volume = Math.round(m.volume * 10) / 10; });
  return out;
}

// DELETE всех строк спортсмена + batch INSERT текущих дней — в одной транзакции.
// Идемпотентно; безопасно звать повторно. Без БД (pool === null) — no-op.
export async function replaceAthleteMetrics(userId, S) {
  if (!pool) return;
  const days = metricsFromState(S);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM athlete_metrics WHERE user_id = $1', [userId]);
    if (days.length) {
      // batch VALUES одним запросом; ON CONFLICT — на случай параллельных записей
      const values = days.map((_, i) => `($1, $${i * 5 + 2}::date, $${i * 5 + 3}::int, $${i * 5 + 4}::float8, $${i * 5 + 5}::int, $${i * 5 + 6}::int)`).join(',');
      const params = [userId];
      days.forEach(m => params.push(m.day, m.workouts, m.volume, m.sets, m.exercises));
      await client.query(
        `INSERT INTO athlete_metrics (user_id, day, workouts, volume, sets, exercises)
         VALUES ${values}
         ON CONFLICT (user_id, day) DO UPDATE SET
           workouts = EXCLUDED.workouts, volume = EXCLUDED.volume,
           sets = EXCLUDED.sets, exercises = EXCLUDED.exercises`,
        params
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// Разовый пересчёт метрик по всем users из их state-файлов (старт api, отладка).
// Читает файлы последовательно — это фоновый прогон, не горячий путь.
export async function backfillAthleteMetrics({ users, stateOf, log = console }) {
  if (!pool) return;
  let ok = 0, fail = 0;
  for (const u of users || []) {
    if (u && u.admin) continue; // админ-аккаунты не спортсмены
    try {
      const S = stateOf(u.id);
      if (S && (S.workouts || []).length) { await replaceAthleteMetrics(u.id, S); ok++; }
      else { await replaceAthleteMetrics(u.id, null); ok++; } // стираем устаревшие строки
    } catch (e) { fail++; log.error('backfill metrics failed for ' + (u && u.id) + ': ' + e.message); }
  }
  log.log(`metrics backfill done: ${ok} users ok, ${fail} failed`);
}