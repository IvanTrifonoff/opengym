// api/migrate-athlete-club.js — привязка legacy-атлетов к клубу (одноразовая миграция).
//
// ЗАЧЕМ: атлеты, зарегистрированные до появления клубов (август 2026), не имеют
// club_id/branch_key в data/db.json — клубные скоупы (scopeUsers/analytics) их
// не видят. Миграция привязывает их к первому реальному клубу и его филиалу
// (единственная живая конфигурация той эпохи).
//
// ПОЧЕМУ НЕ В BOOT-ЦИКЛЕ server.js: мутация данных не должна происходить на
// каждом рестарте процесса (краш → docker restart → повторный проход; 2+
// инстанса на одном volume → гонка записи db.json). Запускается ОДИН РАЗ —
// руками или в пайплайне деплоя. Новые атлеты привязываются при регистрации
// (инвайт несёт club_id/branch_key), поэтому boot-вызов не нужен.
//
// ЗАПУСК (в контейнере api, где есть DATABASE_URL и /data):
//   node migrate-athlete-club.js            # dry-run: сколько нашлось
//   node migrate-athlete-club.js --apply    # реально записать db.json
//
// Идемпотентна: трогает только users без club_id, без demo_session и не админов.
// Супер-админ (владелец платформы) не привязывается — он видит всё через роль
// superadmin; его user-запись в db.json помечена ADMIN_UIDS (см. server.js isAdmin).
import { pool } from './access-db.js';
import { adminDbReady } from './admin-db.js';
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = process.env.DATA_DIR || '/data';
const APPLY = process.argv.includes('--apply');
const PLATFORM_ADMIN_UIDS = (process.env.ADMIN_UIDS || '').split(',').map(s => s.trim()).filter(Boolean);

export async function migrateLegacyAthletes({ dataDir = DATA_DIR, apply = APPLY } = {}) {
  await adminDbReady;
  if (!pool) throw new Error('DATABASE_URL not set — нужен PG для клуба/филиала');
  const r = await pool.query(
    `SELECT b.id, b.club_id FROM branches b
     WHERE b.deleted_at IS NULL AND b.club_id IS NOT NULL
     ORDER BY b.created_at LIMIT 1`
  );
  if (!r.rows.length) { console.log('[migrate] реальных филиалов с клубом нет — нечего наследовать'); return 0; }
  const { id: branchId, club_id: clubId } = r.rows[0];
  const dbFile = path.join(dataDir, 'db.json');
  const db = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
  let n = 0;
  for (const u of db.users || []) {
    // не трогаем: уже привязанных, демо-клоны, админ-записи (в т.ч. superadmin,
    // помеченный только через ADMIN_UIDS — владелец платформы не атлет клуба)
    if (u.club_id || u.demo_session || u.admin || PLATFORM_ADMIN_UIDS.includes(u.id)) continue;
    u.club_id = clubId;
    u.branch_key = branchId;
    n++;
  }
  if (n && apply) {
    const tmp = dbFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, dbFile);
    console.log(`[migrate] привязано атлетов: ${n} → клуб ${clubId}, филиал ${branchId} (записано)`);
  } else {
    console.log(`[migrate] атлетов для привязки: ${n} → клуб ${clubId}, филиал ${branchId}` + (n && !apply ? ' (dry-run — повтори с --apply)' : ''));
  }
  return n;
}

// Прямой запуск: node migrate-athlete-club.js [--apply]
const isDirect = process.argv[1] && (process.argv[1].endsWith('migrate-athlete-club.js') || process.argv[1].endsWith('migrate-athlete-club'));
if (isDirect) {
  migrateLegacyAthletes().then(() => process.exit(0)).catch(e => { console.error('[migrate] failed:', e.message); process.exit(1); });
}
