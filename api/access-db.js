import pg from 'pg';

const { Pool } = pg;
const connectionString = process.env.DATABASE_URL || '';
export const pool = connectionString
  ? new Pool({ connectionString, max: 5, connectionTimeoutMillis: 5000 })
  : null;

let initError = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS access_events (
  event_id TEXT PRIMARY KEY,
  member_key TEXT NOT NULL,
  branch_key TEXT,
  direction TEXT NOT NULL DEFAULT 'in',
  occurred_at TIMESTAMPTZ NOT NULL,
  payload JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'unmatched',
  user_id TEXT
);
CREATE INDEX IF NOT EXISTS access_events_member_key_idx ON access_events (member_key);
CREATE INDEX IF NOT EXISTS access_events_occurred_at_idx ON access_events (occurred_at DESC);

CREATE TABLE IF NOT EXISTS external_member_bindings (
  member_key TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  branch_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS external_member_bindings_user_id_idx ON external_member_bindings (user_id);

CREATE TABLE IF NOT EXISTS visits (
  id BIGSERIAL PRIMARY KEY,
  event_id TEXT UNIQUE NOT NULL REFERENCES access_events(event_id),
  user_id TEXT NOT NULL,
  branch_key TEXT,
  occurred_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS visits_user_id_occurred_at_idx ON visits (user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS visits_branch_key_occurred_at_idx ON visits (branch_key, occurred_at DESC);
`;

export const integrationDbReady = (async () => {
  if (!pool) return;
  try {
    await pool.query(SCHEMA);
  } catch (error) {
    initError = error;
    console.error('access integration database init failed:', error.message);
  }
})();

export function integrationDbStatus() {
  if (!pool) return 'disabled';
  if (initError) return 'error';
  return 'configured';
}

async function requireDatabase() {
  await integrationDbReady;
  if (!pool) throw new Error('access integration database is not configured');
  if (initError) throw new Error('access integration database is unavailable');
}

export async function acceptAccessEvent({ eventId, memberKey, branchKey, direction, occurredAt, payload }) {
  await requireDatabase();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query(
      `INSERT INTO access_events
        (event_id, member_key, branch_key, direction, occurred_at, payload)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       ON CONFLICT (event_id) DO NOTHING
       RETURNING event_id`,
      [eventId, memberKey, branchKey, direction, occurredAt, JSON.stringify(payload)]
    );

    if (!inserted.rowCount) {
      const existing = await client.query(
        `SELECT user_id, status FROM access_events WHERE event_id = $1`, [eventId]
      );
      await client.query('COMMIT');
      const row = existing.rows[0] || {};
      return { duplicate: true, matched: !!row.user_id, userId: row.user_id || null, status: row.status || 'unknown', visitCreated: false };
    }

    const binding = await client.query(
      `SELECT user_id
       FROM external_member_bindings
       WHERE member_key = $1
         AND (branch_key IS NULL OR $2::text IS NULL OR branch_key = $2)
       LIMIT 1`,
      [memberKey, branchKey]
    );

    let userId = null;
    let status = 'unmatched';
    let visitCreated = false;
    if (binding.rowCount && direction !== 'out') {
      userId = binding.rows[0].user_id;
      const visit = await client.query(
        `INSERT INTO visits (event_id, user_id, branch_key, occurred_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (event_id) DO NOTHING
         RETURNING id`,
        [eventId, userId, branchKey, occurredAt]
      );
      visitCreated = !!visit.rowCount;
      status = 'matched';
    } else if (binding.rowCount) {
      userId = binding.rows[0].user_id;
      status = 'ignored_exit';
    }

    await client.query(
      `UPDATE access_events SET status = $2, user_id = $3 WHERE event_id = $1`,
      [eventId, status, userId]
    );
    await client.query('COMMIT');
    return { duplicate: false, matched: !!userId, userId, status, visitCreated };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function bindExternalMember({ memberKey, userId, branchKey }) {
  await requireDatabase();
  const result = await pool.query(
    `INSERT INTO external_member_bindings (member_key, user_id, branch_key)
     VALUES ($1, $2, $3)
     ON CONFLICT (member_key) DO UPDATE SET
       user_id = EXCLUDED.user_id,
       branch_key = EXCLUDED.branch_key,
       updated_at = now()
     RETURNING member_key, user_id, branch_key, created_at, updated_at`,
    [memberKey, userId, branchKey]
  );
  return result.rows[0];
}

export async function listExternalMembers() {
  await requireDatabase();
  const result = await pool.query(
    `SELECT member_key, user_id, branch_key, created_at, updated_at
     FROM external_member_bindings
     ORDER BY updated_at DESC`
  );
  return result.rows;
}
