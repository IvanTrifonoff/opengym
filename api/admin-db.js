import crypto from 'node:crypto';
import { integrationDbReady, pool } from './access-db.js';

let initError = null;
const ROLES = new Set(['owner', 'manager', 'trainer', 'operator']);
const EVENT_TYPES = new Set(['visit', 'workout_completed', 'streak', 'referral', 'manual']);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS admin_users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','manager','trainer','operator')),
  disabled BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS admin_credentials (
  id TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  public_key TEXT NOT NULL,
  counter BIGINT NOT NULL DEFAULT 0,
  transports JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS admin_credentials_admin_id_idx ON admin_credentials (admin_id);
CREATE TABLE IF NOT EXISTS admin_invites (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','manager','trainer','operator')),
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  used_at TIMESTAMPTZ,
  used_admin_id TEXT
);

CREATE TABLE IF NOT EXISTS loyalty_rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  event_type TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  conditions JSONB NOT NULL DEFAULT '{}'::jsonb,
  actions JSONB NOT NULL DEFAULT '[]'::jsonb,
  limits JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS loyalty_rules_event_enabled_idx ON loyalty_rules (event_type, enabled);
CREATE TABLE IF NOT EXISTS loyalty_events (
  event_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  branch_key TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS loyalty_events_user_idx ON loyalty_events (user_id, occurred_at DESC);
CREATE TABLE IF NOT EXISTS loyalty_ledger (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  rule_id TEXT NOT NULL REFERENCES loyalty_rules(id) ON DELETE RESTRICT,
  event_id TEXT NOT NULL,
  action_key TEXT NOT NULL,
  amount INTEGER NOT NULL,
  reason TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, rule_id, event_id, action_key)
);
CREATE INDEX IF NOT EXISTS loyalty_ledger_user_idx ON loyalty_ledger (user_id, occurred_at DESC);
CREATE TABLE IF NOT EXISTS loyalty_achievements (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  achievement_key TEXT NOT NULL,
  rule_id TEXT NOT NULL REFERENCES loyalty_rules(id) ON DELETE RESTRICT,
  event_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, achievement_key)
);
CREATE TABLE IF NOT EXISTS loyalty_unlocks (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  reward_key TEXT NOT NULL,
  rule_id TEXT NOT NULL REFERENCES loyalty_rules(id) ON DELETE RESTRICT,
  event_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, reward_key)
);
CREATE TABLE IF NOT EXISTS loyalty_accounts (
  user_id TEXT PRIMARY KEY,
  balance INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS loyalty_rewards (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'custom',
  cost INTEGER NOT NULL CHECK (cost > 0),
  delivery_mode TEXT NOT NULL DEFAULT 'staff' CHECK (delivery_mode IN ('staff','auto_code')),
  active BOOLEAN NOT NULL DEFAULT true,
  stock INTEGER,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS loyalty_redemptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  reward_id TEXT NOT NULL REFERENCES loyalty_rewards(id) ON DELETE RESTRICT,
  cost INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','fulfilled','rejected')),
  code TEXT UNIQUE,
  note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  fulfilled_by TEXT
);
CREATE INDEX IF NOT EXISTS loyalty_redemptions_user_idx ON loyalty_redemptions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS loyalty_redemptions_status_idx ON loyalty_redemptions (status, created_at DESC);

CREATE TABLE IF NOT EXISTS loyalty_outbox (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS trainer_assignments (
  user_id TEXT PRIMARY KEY,
  trainer_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS trainer_assignments_trainer_idx ON trainer_assignments (trainer_id);
`;

const LEDGER_MIGRATION = `
ALTER TABLE loyalty_ledger ALTER COLUMN rule_id DROP NOT NULL;
ALTER TABLE loyalty_ledger ADD COLUMN IF NOT EXISTS source_type TEXT;
ALTER TABLE loyalty_ledger ADD COLUMN IF NOT EXISTS source_id TEXT;
`;

const ADMIN_MIGRATION = `
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS branch_key TEXT;
`;

export const adminDbReady = (async () => {
  await integrationDbReady;
  if (!pool) return;
  try {
    await pool.query(SCHEMA);
    await pool.query(LEDGER_MIGRATION);
    await pool.query(ADMIN_MIGRATION);
  } catch (error) {
    initError = error;
    console.error('admin database init failed:', error.message);
  }
})();

async function ready() {
  await adminDbReady;
  if (!pool || initError) throw new Error('admin database unavailable');
}

export function roleAllowed(role, allowed) {
  return allowed.includes(role);
}

export async function syncAdminOwners(users, credentials, ownerIds) {
  try {
    await ready();
    for (const userId of ownerIds) {
      const user = users.find(item => item.id === userId);
      if (!user) continue;
      await pool.query(
        `INSERT INTO admin_users (id, name, role)
         VALUES ($1, $2, 'owner') ON CONFLICT (id) DO NOTHING`,
        [user.id, user.name]
      );
      for (const credential of credentials.filter(item => item.userId === user.id)) {
        await pool.query(
          `INSERT INTO admin_credentials (id, admin_id, public_key, counter, transports)
           VALUES ($1, $2, $3, $4, $5::jsonb) ON CONFLICT (id) DO NOTHING`,
          [credential.id, user.id, credential.publicKey, credential.counter || 0, JSON.stringify(credential.transports || [])]
        );
      }
    }
  } catch (error) {
    console.error('admin owner bootstrap failed:', error.message);
  }
}

export async function getAdmin(id) {
  await ready();
  const result = await pool.query(
    `SELECT id, name, role, branch_key, disabled, created_at, updated_at FROM admin_users WHERE id = $1`, [id]
  );
  return result.rows[0] || null;
}

export async function getAdminCredential(credentialId) {
  await ready();
  const result = await pool.query(
    `SELECT c.id, c.admin_id, c.public_key, c.counter, c.transports, a.name, a.role, a.disabled
     FROM admin_credentials c JOIN admin_users a ON a.id = c.admin_id WHERE c.id = $1`, [credentialId]
  );
  return result.rows[0] || null;
}

export async function updateAdminCounter(credentialId, counter) {
  await ready();
  await pool.query('UPDATE admin_credentials SET counter = $2 WHERE id = $1', [credentialId, counter]);
}

export async function listAdmins() {
  await ready();
  const result = await pool.query(
    `SELECT a.id, a.name, a.role, a.branch_key, a.disabled, a.created_at, a.updated_at,
            count(c.id)::int AS passkeys
     FROM admin_users a LEFT JOIN admin_credentials c ON c.admin_id = a.id
     GROUP BY a.id ORDER BY a.created_at`
  );
  return result.rows;
}

export async function createAdminInvite({ name, role, createdBy }) {
  await ready();
  if (!ROLES.has(role) || role === 'owner') throw new Error('invalid staff role');
  const code = crypto.randomBytes(12).toString('hex').toUpperCase();
  const result = await pool.query(
    `INSERT INTO admin_invites (code, name, role, created_by) VALUES ($1, $2, $3, $4)
     RETURNING code, name, role, created_at`,
    [code, String(name).trim().slice(0, 80), role, createdBy]
  );
  return result.rows[0];
}

export async function getAdminInvite(code) {
  await ready();
  const result = await pool.query(
    `SELECT code, name, role, created_by, created_at FROM admin_invites WHERE code = $1 AND used_at IS NULL`, [code]
  );
  return result.rows[0] || null;
}

export async function findUsedAdminInvite(code) {
  await ready();
  const result = await pool.query(
    `SELECT code, name, role, used_at FROM admin_invites WHERE code = $1 AND used_at IS NOT NULL`, [code]
  );
  return result.rows[0] || null;
}

export async function registerAdmin({ id, name, role, credentialId, publicKey, counter, transports, inviteCode }) {
  await ready();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const invite = await client.query(
      `SELECT code, name, role FROM admin_invites WHERE code = $1 AND used_at IS NULL FOR UPDATE`, [inviteCode]
    );
    if (!invite.rowCount) throw new Error('invite expired or already used');
    const data = invite.rows[0];
    await client.query(
      `INSERT INTO admin_users (id, name, role) VALUES ($1, $2, $3)`,
      [id, name || data.name, role || data.role]
    );
    await client.query(
      `INSERT INTO admin_credentials (id, admin_id, public_key, counter, transports)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [credentialId, id, publicKey, counter || 0, JSON.stringify(transports || [])]
    );
    await client.query(
      `UPDATE admin_invites SET used_at = now(), used_admin_id = $2 WHERE code = $1`, [inviteCode, id]
    );
    await client.query('COMMIT');
    return { id, name: name || data.name, role: role || data.role };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function updateAdmin({ id, role, disabled }) {
  await ready();
  if (role && !ROLES.has(role)) throw new Error('invalid role');
  const result = await pool.query(
    `UPDATE admin_users SET role = COALESCE($2, role), disabled = COALESCE($3, disabled), updated_at = now()
     WHERE id = $1 RETURNING id, name, role, disabled`,
    [id, role || null, typeof disabled === 'boolean' ? disabled : null]
  );
  return result.rows[0] || null;
}

export async function listLoyaltyRules() {
  await ready();
  const result = await pool.query(
    `SELECT id, name, event_type, enabled, conditions, actions, limits, created_by, created_at, updated_at
     FROM loyalty_rules ORDER BY updated_at DESC`
  );
  return result.rows;
}

export async function saveLoyaltyRule({ id, name, eventType, enabled, conditions, actions, limits, createdBy }) {
  await ready();
  if (!EVENT_TYPES.has(eventType)) throw new Error('invalid event type');
  if (!String(name || '').trim()) throw new Error('rule name is required');
  const ruleId = id || crypto.randomBytes(12).toString('hex');
  const result = await pool.query(
    `INSERT INTO loyalty_rules (id, name, event_type, enabled, conditions, actions, limits, created_by)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8)
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name, event_type = EXCLUDED.event_type, enabled = EXCLUDED.enabled,
       conditions = EXCLUDED.conditions, actions = EXCLUDED.actions, limits = EXCLUDED.limits,
       updated_at = now()
     RETURNING id, name, event_type, enabled, conditions, actions, limits, created_by, created_at, updated_at`,
    [ruleId, String(name).trim().slice(0, 120), eventType, enabled !== false,
      JSON.stringify(conditions || {}), JSON.stringify(actions || []), JSON.stringify(limits || {}), createdBy]
  );
  return result.rows[0];
}

export async function deleteLoyaltyRule(id) {
  await ready();
  await pool.query('DELETE FROM loyalty_rules WHERE id = $1', [id]);
}

export async function acceptLoyaltyEvent({ eventId, userId, eventType, branchKey, occurredAt, payload }) {
  await ready();
  const inserted = await pool.query(
    `INSERT INTO loyalty_events (event_id, user_id, event_type, branch_key, payload, occurred_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)
     ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
    [eventId, userId, eventType, branchKey, JSON.stringify(payload || {}), occurredAt]
  );
  if (!inserted.rowCount) return { duplicate: true, points: 0, rulesApplied: [] };
  const loyalty = await applyLoyaltyRules({ userId, eventId, eventType, branchKey, occurredAt });
  return { duplicate: false, ...loyalty };
}

export async function getWallet(userId) {
  await ready();
  const account = await pool.query('SELECT user_id, balance, updated_at FROM loyalty_accounts WHERE user_id = $1', [userId]);
  const ledger = await pool.query(
    `SELECT id, amount, reason, source_type, occurred_at, created_at
     FROM loyalty_ledger WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`, [userId]
  );
  const redemptions = await pool.query(
    `SELECT r.id, r.cost, r.status, r.code, r.note, r.created_at, r.updated_at,
            w.id AS reward_id, w.name AS reward_name, w.kind AS reward_kind
     FROM loyalty_redemptions r JOIN loyalty_rewards w ON w.id = r.reward_id
     WHERE r.user_id = $1 ORDER BY r.created_at DESC LIMIT 50`, [userId]
  );
  return { balance: account.rows[0]?.balance || 0, ledger: ledger.rows, redemptions: redemptions.rows };
}

export async function listRewards(activeOnly = false) {
  await ready();
  const result = await pool.query(
    `SELECT id, name, description, kind, cost, delivery_mode, active, stock, created_by, created_at, updated_at
     FROM loyalty_rewards ${activeOnly ? 'WHERE active = true AND (stock IS NULL OR stock > 0)' : ''} ORDER BY updated_at DESC`
  );
  return result.rows;
}

export async function saveReward({ id, name, description, kind, cost, deliveryMode, active, stock, createdBy }) {
  await ready();
  const rewardId = id || crypto.randomBytes(12).toString('hex');
  const amount = Math.max(1, Math.min(100000000, Math.round(Number(cost) || 0)));
  if (!String(name || '').trim()) throw new Error('reward name is required');
  if (!['discount', 'training', 'merch', 'guest_pass', 'custom'].includes(kind)) throw new Error('invalid reward kind');
  if (!['staff', 'auto_code'].includes(deliveryMode)) throw new Error('invalid delivery mode');
  const stockValue = stock === null || stock === undefined || stock === '' ? null : Math.max(0, Math.round(Number(stock) || 0));
  const result = await pool.query(
    `INSERT INTO loyalty_rewards (id, name, description, kind, cost, delivery_mode, active, stock, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description,
       kind = EXCLUDED.kind, cost = EXCLUDED.cost, delivery_mode = EXCLUDED.delivery_mode,
       active = EXCLUDED.active, stock = EXCLUDED.stock, updated_at = now()
     RETURNING id, name, description, kind, cost, delivery_mode, active, stock, created_by, created_at, updated_at`,
    [rewardId, String(name).trim().slice(0, 120), String(description || '').slice(0, 500), kind, amount, deliveryMode, active !== false, stockValue, createdBy]
  );
  return result.rows[0];
}

export async function deleteReward(id) {
  await ready();
  await pool.query('UPDATE loyalty_rewards SET active = false, updated_at = now() WHERE id = $1', [id]);
}

export async function redeemReward({ userId, rewardId }) {
  await ready();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const rewardResult = await client.query(
      `SELECT id, name, cost, delivery_mode, stock FROM loyalty_rewards
       WHERE id = $1 AND active = true AND (stock IS NULL OR stock > 0) FOR UPDATE`, [rewardId]
    );
    if (!rewardResult.rowCount) throw new Error('reward unavailable');
    const reward = rewardResult.rows[0];
    await client.query(
      `INSERT INTO loyalty_accounts (user_id, balance) VALUES ($1, 0) ON CONFLICT (user_id) DO NOTHING`, [userId]
    );
    const account = await client.query('SELECT balance FROM loyalty_accounts WHERE user_id = $1 FOR UPDATE', [userId]);
    if (account.rows[0].balance < reward.cost) throw new Error('not enough points');
    const redemptionId = crypto.randomBytes(12).toString('hex');
    const code = reward.delivery_mode === 'auto_code' ? crypto.randomBytes(6).toString('hex').toUpperCase() : null;
    const status = reward.delivery_mode === 'auto_code' ? 'fulfilled' : 'pending';
    await client.query(
      `UPDATE loyalty_accounts SET balance = balance - $2, updated_at = now() WHERE user_id = $1`, [userId, reward.cost]
    );
    await client.query(
      `INSERT INTO loyalty_ledger (user_id, rule_id, event_id, action_key, amount, reason, occurred_at, source_type, source_id)
       VALUES ($1, NULL, $2, $3, $4, $5, now(), 'redemption', $2)`,
      [userId, redemptionId, 'redemption:' + redemptionId, -reward.cost, 'Обмен: ' + reward.name]
    );
    await client.query(
      `INSERT INTO loyalty_redemptions (id, user_id, reward_id, cost, status, code)
       VALUES ($1, $2, $3, $4, $5, $6)`, [redemptionId, userId, reward.id, reward.cost, status, code]
    );
    if (reward.stock !== null) await client.query('UPDATE loyalty_rewards SET stock = stock - 1, updated_at = now() WHERE id = $1', [reward.id]);
    await client.query('COMMIT');
    return { id: redemptionId, rewardName: reward.name, cost: reward.cost, status, code };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

export async function listRedemptions() {
  await ready();
  const result = await pool.query(
    `SELECT r.id, r.user_id, r.cost, r.status, r.code, r.note, r.created_at, r.updated_at, r.fulfilled_by,
            w.name AS reward_name, w.kind AS reward_kind
     FROM loyalty_redemptions r JOIN loyalty_rewards w ON w.id = r.reward_id
     ORDER BY r.created_at DESC LIMIT 200`
  );
  return result.rows;
}

export async function updateRedemption({ id, status, adminId, note }) {
  await ready();
  if (!['fulfilled', 'rejected'].includes(status)) throw new Error('invalid redemption status');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query('SELECT id, user_id, cost, status FROM loyalty_redemptions WHERE id = $1 FOR UPDATE', [id]);
    if (!result.rowCount) throw new Error('redemption not found');
    const redemption = result.rows[0];
    if (redemption.status !== 'pending') throw new Error('redemption already closed');
    if (status === 'rejected') {
      await client.query('UPDATE loyalty_accounts SET balance = balance + $2, updated_at = now() WHERE user_id = $1', [redemption.user_id, redemption.cost]);
      await client.query(
        `INSERT INTO loyalty_ledger (user_id, rule_id, event_id, action_key, amount, reason, occurred_at, source_type, source_id)
         VALUES ($1, NULL, $2, $3, $4, $5, now(), 'refund', $2)`,
        [redemption.user_id, id, 'refund:' + id, redemption.cost, 'Возврат за отклонённую награду']
      );
    }
    const updated = await client.query(
      `UPDATE loyalty_redemptions SET status = $2, note = $3, updated_at = now(), fulfilled_by = $4
       WHERE id = $1 RETURNING id, user_id, status, note, updated_at`,
      [id, status, String(note || '').slice(0, 300), adminId]
    );
    await client.query('COMMIT');
    return updated.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

export async function applyLoyaltyRules({ userId, eventId, eventType, branchKey, occurredAt }) {
  await ready();
  const rules = await pool.query(
    `SELECT id, name, conditions, actions, limits FROM loyalty_rules
     WHERE enabled = true AND event_type = $1 ORDER BY created_at`, [eventType]
  );
  let points = 0;
  const applied = [];
  for (const rule of rules.rows) {
    const conditions = rule.conditions || {};
    if (conditions.branch_key && conditions.branch_key !== branchKey) continue;
    const limits = rule.limits || {};
    let since = null;
    if (limits.period === 'day') since = new Date(occurredAt); 
    if (limits.period === 'week') since = new Date(new Date(occurredAt).getTime() - 7 * 86400000);
    if (limits.period === 'month') since = new Date(new Date(occurredAt).getTime() - 31 * 86400000);
    if (since && Number(limits.max_per_period) > 0) {
      const used = await pool.query(
        `SELECT count(*)::int AS count FROM loyalty_ledger WHERE user_id = $1 AND rule_id = $2 AND occurred_at >= $3`,
        [userId, rule.id, since.toISOString()]
      );
      if (used.rows[0].count >= Number(limits.max_per_period)) continue;
    }
    for (const [index, action] of (rule.actions || []).entries()) {
      const actionKey = String(action.key || action.type || 'action') + ':' + index;
      if (action.type === 'points') {
        const amount = Math.max(0, Math.min(100000, Math.round(Number(action.amount) || 0)));
        if (!amount) continue;
        const inserted = await pool.query(
          `INSERT INTO loyalty_ledger (user_id, rule_id, event_id, action_key, amount, reason, occurred_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (user_id, rule_id, event_id, action_key) DO NOTHING RETURNING amount`,
          [userId, rule.id, eventId, actionKey, amount, rule.name, occurredAt]
        );
        if (inserted.rowCount) {
          await pool.query(
            `INSERT INTO loyalty_accounts (user_id, balance) VALUES ($1, $2)
             ON CONFLICT (user_id) DO UPDATE SET balance = loyalty_accounts.balance + EXCLUDED.balance, updated_at = now()`,
            [userId, amount]
          );
          points += amount;
        }
      } else if (action.type === 'achievement' && action.key) {
        await pool.query(
          `INSERT INTO loyalty_achievements (user_id, achievement_key, rule_id, event_id)
           VALUES ($1, $2, $3, $4) ON CONFLICT (user_id, achievement_key) DO NOTHING`,
          [userId, String(action.key).slice(0, 120), rule.id, eventId]
        );
      } else if (action.type === 'reward' && action.key) {
        await pool.query(
          `INSERT INTO loyalty_unlocks (user_id, reward_key, rule_id, event_id)
           VALUES ($1, $2, $3, $4) ON CONFLICT (user_id, reward_key) DO NOTHING`,
          [userId, String(action.key).slice(0, 120), rule.id, eventId]
        );
      } else if (action.type === 'notification' && action.message) {
        await pool.query(
          `INSERT INTO loyalty_outbox (user_id, kind, payload)
           VALUES ($1, 'loyalty', $2::jsonb)`,
          [userId, JSON.stringify({ message: String(action.message).slice(0, 300), rule_id: rule.id, event_id: eventId })]
        );
      }
    }
    applied.push(rule.id);
  }
  return { points, rulesApplied: applied };
}

/**
 * Push dispatcher: claim undelivered loyalty_outbox rows and hand each to
 * `send` (a callback the caller wires to web-push). Rows are claimed with
 * FOR UPDATE SKIP LOCKED so concurrent dispatches never double-send. Only
 * successfully sent rows are marked delivered; failures stay pending for the
 * next tick.
 */
export async function dispatchOutbox({ send, batch = 25 } = {}) {
  await ready();
  if (!pool || typeof send !== 'function') return 0;
  const client = await pool.connect();
  let sent = 0;
  try {
    await client.query('BEGIN');
    const claimed = await client.query(
      `SELECT id, user_id, kind, payload FROM loyalty_outbox
       WHERE delivered_at IS NULL
       ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED`, [batch]
    );
    const rows = claimed.rows;
    if (!rows.length) { await client.query('COMMIT'); return 0; }
    await client.query('COMMIT'); // release the claim; we deliver outside the txn
    for (const row of rows) {
      try {
        const payload = row.payload || {};
        await send(row.user_id, {
          title: 'openGym',
          body: String(payload.message || payload.body || '').slice(0, 300),
          tag: payload.tag || ('loyalty-' + row.id),
          data: { outbox_id: row.id, rule_id: payload.rule_id, event_id: payload.event_id }
        });
        await pool.query('UPDATE loyalty_outbox SET delivered_at = now() WHERE id = $1', [row.id]);
        sent++;
      } catch (error) {
        console.error('outbox dispatch failed', row.id, error.message);
        // leave undelivered for the next tick
      }
    }
  } catch (error) {
    console.error('outbox dispatch error:', error.message);
  } finally {
    client.release();
  }
  return sent;
}

export async function setTrainerAssignment({ userId, trainerId }) {
  await ready();
  if (!trainerId) {
    await pool.query('DELETE FROM trainer_assignments WHERE user_id = $1', [userId]);
    return { userId, trainerId: null };
  }
  const result = await pool.query(
    `INSERT INTO trainer_assignments (user_id, trainer_id)
     VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET trainer_id = EXCLUDED.trainer_id, updated_at = now()
     RETURNING user_id, trainer_id`,
    [userId, trainerId]
  );
  return result.rows[0];
}

export async function listTrainerAssignments() {
  await ready();
  const result = await pool.query('SELECT user_id, trainer_id FROM trainer_assignments');
  return result.rows;
}
