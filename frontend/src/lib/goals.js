// lib/goals.js — цели по упражнениям (например «жим лёжа → 120 кг»).
// Чистые функции без React: легко тестируются и используются и в листе целей,
// и в генераторе постера для соцсетей.
import { bestWeightFor } from './history.js'

// Лучшее число повторений в одном выполненном подходе (для bodyweight-целей,
// где отягощения нет и прогресс меряется повторами, а не килограммами).
export function bestRepsFor(S, exId) {
  let best = 0
  ;(S && S.workouts || []).forEach(w => (w.entries || []).forEach(e => {
    if (e.id === exId) (e.sets || []).forEach(s => { if (s && s.done && (s.r || 0) > best) best = s.r })
  }))
  return best
}

// Прогресс цели: текущий лучший результат упражнения vs целевой.
//   goal = { exId, w, unit, createdAt }     — силовая цель (вес)
//   goal = { exId, reps, createdAt }        — bodyweight-цель (повторения)
// kind: 'weight' | 'reps' — какую метрику сравниваем.
export function goalProg(S, goal) {
  if (!goal || !goal.exId) return { cur: 0, target: 0, pct: 0, done: false, kind: 'weight' }
  const byReps = goal.reps != null
  const hasW = !!(S && Array.isArray(S.workouts))
  const target = Math.max(0, Number(byReps ? goal.reps : goal.w) || 0)
  const cur = byReps ? (hasW ? bestRepsFor(S, goal.exId) : 0)
                     : (hasW ? bestWeightFor(S, goal.exId) : 0)
  return {
    cur,
    target,
    pct: target > 0 ? Math.min(100, Math.round(cur / target * 100)) : 0,
    done: target > 0 && cur >= target,
    kind: byReps ? 'reps' : 'weight'
  }
}

// Актуальные цели в порядке «для челленджа»: невыполненные сверху (по прогрессу),
// выполненные — вниз списка. Юзер видит, за что браться следующим.
export function sortGoals(S, goals) {
  return [...(goals || [])].sort((a, b) => {
    const da = goalProg(S, a), db = goalProg(S, b)
    if (da.done !== db.done) return da.done ? 1 : -1
    return db.pct - da.pct
  })
}