// api/logic.js — чистая бизнес-логика openGym (автономная, без БД/env/сетей).
//
// Извлечена из server.js для юнит-тестирования: все функции не имеют побочных
// эффектов и не зависят от глобального состояния. server.js импортирует их
// отсюда — это единый код, НЕ копия. Тесты: api/logic.test.js (node:test).
//
// Правило: сюда можно добавлять только чистые функции (детерминированные,
// без I/O). Всё, что требует поднятой БД/push/env, остаётся в server.js
// и интеграционных тестах.

export const validTime = t => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(t));

export const timeInRange = (t, start, end) => t >= start && t < end;

export const BOOKING_TRANSITIONS = {
  pending: new Set(['confirmed', 'rejected', 'cancelled']),
  confirmed: new Set(['cancelled', 'done']),
  rejected: new Set(), cancelled: new Set(), done: new Set()
};
export function bookingTransitionAllowed(from, to) { return from === to || !!BOOKING_TRANSITIONS[from]?.has(to); }

export function validateAvailabilitySlots(slots) {
  if (!Array.isArray(slots) || slots.length > 14) throw new Error('invalid availability');
  const seen = new Set();
  for (const s of slots) {
    const weekday = Number(s.weekday);
    const start = String(s.time_start || ''); const end = String(s.time_end || '');
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6 || !validTime(start) || !validTime(end) || start >= end) throw new Error('invalid availability interval');
    const key = weekday + ':' + start + '-' + end;
    if (seen.has(key)) throw new Error('duplicate availability interval');
    seen.add(key);
  }
  for (const a of slots) for (const b of slots) if (a !== b && Number(a.weekday) === Number(b.weekday) && String(a.time_start) < String(b.time_end) && String(b.time_start) < String(a.time_end)) throw new Error('overlapping availability intervals');
}

// Ядро извлечения routine-id для конкретной даты: override дня → ротация по неделе → null (отдых).
export function effectiveRoutineId(S, iso) {
  const ov = S.dayPlan?.[iso];
  if (ov === 'rest') return null;
  if (ov && S.routines?.some(r => r.id === ov)) return ov;
  const wd = new Date(iso + 'T12:00:00').getDay();
  return S.week?.[wd] || null;
}

// Следующий целый час от любого времени "HH:MM" (для генерации слотов дня).
export function nextHour(t) { const [h, m] = t.split(':').map(Number); return String(h + 1).padStart(2, '0') + ':00'; }

// Слоты рабочего дня с поддержкой разрывного графика (несколько интервалов/день).
export function daySlots(availability, weekday) {
  const out = [];
  for (const a of (availability || [])) {
    if (a.weekday !== weekday) continue;
    let t = a.time_start;
    while (t < a.time_end) { if (!out.includes(t)) out.push(t); t = nextHour(t); }
  }
  return out.sort();
}

export function userNow(tz) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
    }).formatToParts(new Date());
    const g = t => parts.find(p => p.type === t)?.value;
    return { date: `${g('year')}-${g('month')}-${g('day')}`, hhmm: `${g('hour')}:${g('minute')}` };
  } catch { return null; } // unknown/invalid tz string — skip rather than guess
}

// Нормализация события доступа (вебхук турникета/xмс). Намеренно допускает
// много входных форм (member_key|external_member_id|card_id|athlete_id и т.п.)
// и мапит любой текстовый направление в строгий enum in/out/unknown.
export function normaliseAccessEvent(body) {
  const eventId = String(body.event_id || body.id || '').trim().slice(0, 200);
  const memberKey = String(
    body.member_key || body.external_member_id || body.card_id || body.athlete_id || ''
  ).trim().slice(0, 200);
  const branchKey = String(body.branch_key || body.branch_id || body.club_id || '').trim().slice(0, 100) || null;
  const directionValue = String(body.direction || body.type || 'in').trim().toLowerCase();
  const direction = ['out', 'exit', 'leave', 'checkout'].includes(directionValue) ? 'out'
    : ['unknown', 'test'].includes(directionValue) ? 'unknown' : 'in';
  const rawDate = body.occurred_at || body.timestamp || body.time || Date.now();
  const occurredAt = new Date(rawDate);
  if (!eventId) throw new Error('event_id is required');
  if (!memberKey) throw new Error('member_key is required');
  if (Number.isNaN(occurredAt.getTime())) throw new Error('occurred_at is invalid');
  return { eventId, memberKey, branchKey, direction, occurredAt: occurredAt.toISOString(), payload: body };
}