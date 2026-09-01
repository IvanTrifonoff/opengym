import { describe, it, expect } from 'vitest'
import { goalProg, sortGoals } from './goals.js'

// state спортсмена: жим лёжа 100 кг одной тренировкой, присед 140 кг
const S = { workouts: [
  { d: '2026-08-01', entries: [
    { id: 'bench', sets: [{ w: 100, r: 5, done: true }, { w: 60, r: 10, done: false }] },
    { id: 'squat', sets: [{ w: 140, r: 3, done: true }] }
  ] }
] }

describe('goalProg', () => {
  it('считает текущий лучший вес и процент к цели', () => {
    const p = goalProg(S, { exId: 'bench', w: 120 })
    expect(p.cur).toBe(100)
    expect(p.target).toBe(120)
    expect(p.pct).toBe(83) // round(100/120*100)
    expect(p.done).toBe(false)
  })
  it('цель ниже текущего веса — достигнута на 100%', () => {
    const p = goalProg(S, { exId: 'bench', w: 80 })
    expect(p.done).toBe(true)
    expect(p.pct).toBe(100)
  })
  it('без тренировок по упражнению — 0%', () => {
    const p = goalProg(S, { exId: 'no-such', w: 100 })
    expect(p.cur).toBe(0)
    expect(p.pct).toBe(0)
    expect(p.done).toBe(false)
  })
  it('невалидная/нулевая цель — 0%, не падает', () => {
    expect(goalProg(S, null).pct).toBe(0)
    expect(goalProg(null, { exId: 'bench', w: 100 }).cur).toBe(0)
    expect(goalProg(S, { exId: 'bench' }).pct).toBe(0)
  })
})

describe('sortGoals', () => {
  const g = (exId, w) => ({ id: exId + w, exId, w })
  it('невыполненные сверху (по прогрессу), достигнутые вниз', () => {
    const goals = [g('bench', 130), g('squat', 180), g('bench', 90), g('squat', 100)]
    const sorted = sortGoals(S, goals)
    expect(sorted[0].id).toBe('squat180')   // 140/180 = 78% — лидер по прогрессу
    expect(sorted[1].id).toBe('bench130')   // 100/130 = 77%
    const last = sorted[sorted.length - 1]
    expect(goalProg(S, last).done).toBe(true)
    expect(sorted[0].id).toBe('squat180')
    expect(sorted.slice(0, 2).every(x => !goalProg(S, x).done)).toBe(true)
  })
  it('пустой список — пустой', () => {
    expect(sortGoals(S, [])).toEqual([])
    expect(sortGoals(S, null)).toEqual([])
  })
})