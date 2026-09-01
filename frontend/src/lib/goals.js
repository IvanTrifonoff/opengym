// lib/goals.js — цели по упражнениям (например «жим лёжа → 120 кг»).
// Чистые функции без React: легко тестируются и используются и в листе целей,
// и в генераторе постера для соцсетей.
import { bestWeightFor } from './history.js'

// Прогресс цели: текущий лучший вес упражнения vs целевой.
//   goal = { exId, w, unit, createdAt, ... }
export function goalProg(S, goal) {
  const target = Math.max(0, Number(goal && goal.w) || 0)
  const cur = goal && goal.exId && S && Array.isArray(S.workouts) ? bestWeightFor(S, goal.exId) : 0
  return {
    cur,
    target,
    pct: target > 0 ? Math.min(100, Math.round(cur / target * 100)) : 0,
    done: target > 0 && cur >= target
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