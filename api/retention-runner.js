/* api/retention-runner.js — nightly batch that precomputes the retention snapshot so the
   /admin/analytics/retention endpoint only filters a cached file (no DB/state scan at day).
   Scheduled inside server.js; hour defaults to 04:00 local and is overridable via
   RETENTION_RUN_HOUR. Writes data/retention-snapshot.json atomically. */
import fs from 'node:fs';
import path from 'node:path';
import { collectRetention } from './retention.js';

export async function buildRetentionSnapshot({ users, stateOf, dataDir, now = Date.now() }) {
  const snap = await collectRetention({ users, stateOf, now });
  const file = path.join(dataDir, 'retention-snapshot.json');
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(snap, null, 2));
  fs.renameSync(tmp, file);
  return snap;
}

// Lightweight in-process scheduler: fire at the configured hour once per day. Uses a longer
// check interval so we don't spin constantly, and never blocks the event loop.
export function scheduleRetentionSnapshot({ users, stateOf, dataDir, hour, now = Date.now() }) {
  const H = Number.isInteger(hour) ? ((hour % 24) + 24) % 24 : 4;
  let lastRunDate = null;
  const run = async () => {
    const d = new Date();
    if (d.getHours() === H && lastRunDate !== d.toDateString()) {
      lastRunDate = d.toDateString();
      try {
        const snap = await buildRetentionSnapshot({ users, stateOf, dataDir, now: d.getTime() });
        console.log(`[retention] snapshot rebuilt at ${d.toISOString()} (${snap.athletes.length} athletes)`);
      } catch (e) {
        console.error('[retention] nightly rebuild failed:', e.message);
      }
    }
  };
  // fire shortly after boot too, in case the container started after the nightly hour
  setTimeout(run, 3000);
  setInterval(run, 60 * 60 * 1000); // check hourly; only acts during the target hour
  return run;
}