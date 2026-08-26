import { useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api.js'
import { uid } from '../lib/format.js'
import { exOr } from '../lib/exercises.js'
import { exName } from '../lib/i18n.js'
import { Thumb } from '../components/Media.jsx'
import { exercisePicker } from '../sheets.jsx'
import Icon from '../components/Icon.jsx'
import { Button } from '../components/ui.jsx'

const DAYS = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб']
const fmtNum = n => (Math.round(n * 10) / 10).toLocaleString('ru-RU')
const fmtDate = d => d ? new Date(d.slice(0, 10) + 'T12:00:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }) : '—'

// Trainer view/edit of one athlete's training program, plus per-exercise weight/set history.
export default function TrainerProgram({ athlete, onBack }) {
  const [data, setData] = useState(null)
  const [err, setErr] = useState('')
  const [tab, setTab] = useState('program')
  const [draft, setDraft] = useState(null)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  const load = () => api('/api/admin/trainer/athlete/program?id=' + encodeURIComponent(athlete.id))
    .then(d => { setData(d); setDraft(JSON.parse(JSON.stringify(d.routines || []))); setErr('') })
    .catch(e => setErr(e.message || 'Нет доступа к программе'))
  useEffect(() => { load() }, [athlete.id])

  const unit = data?.unit || 'кг'
  const exNameOf = id => {
    const c = (data?.customEx || []).find(x => x && x.id === id)
    return c ? (c.n || 'Упражнение') : exName(exOr(id))
  }
  const rname = rid => (draft || []).find(r => r.id === rid)?.name || '—'

  const touch = fn => { fn(); setDirty(true) }
  const setR = (ri, patch) => touch(() => setDraft(prev => prev.map(r => r.id === ri ? { ...r, ...patch } : r)))
  const setEx = (ri, ei, patch) => touch(() => setDraft(prev => prev.map(r => r.id === ri ? { ...r, ex: r.ex.map((e, i) => i === ei ? { ...e, ...patch } : e) } : r)))
  const moveEx = (ri, ei, dir) => touch(() => setDraft(prev => prev.map(r => {
    if (r.id !== ri) return r
    const ex = [...r.ex]; const j = ei + dir
    if (j < 0 || j >= ex.length) return r
    ;[ex[ei], ex[j]] = [ex[j], ex[ei]]
    return { ...r, ex }
  })))
  const delEx = (ri, ei) => touch(() => setDraft(prev => prev.map(r => r.id === ri ? { ...r, ex: r.ex.filter((_, i) => i !== ei) } : r)))
  const addEx = ri => exercisePicker(ex => touch(() => setDraft(prev => prev.map(r => r.id === ri ? { ...r, ex: [...r.ex, { id: ex.id, sets: 3, reps: 10, weight: 0 }] } : r))))
  const delR = ri => touch(() => setDraft(prev => prev.filter(r => r.id !== ri)))
  const addR = () => touch(() => setDraft(prev => [...prev, { id: 'r' + uid(), name: 'Новая программа', emoji: 'dumbbell', prog: '', ex: [] }]))

  const save = () => {
    setSaving(true); setSaved(false)
    api('/api/admin/trainer/athlete/program?id=' + encodeURIComponent(athlete.id), { method: 'PUT', body: JSON.stringify({ routines: draft }) })
      .then(() => { setSaved(true); setDirty(false); setTimeout(() => setSaved(false), 2500) })
      .catch(e => setErr(e.message)).finally(() => setSaving(false))
  }

  // Per-exercise history from the athlete's logged workouts.
  const exStats = useMemo(() => {
    const map = new Map()
    const add = (id, d, w, r, done) => {
      if (!map.has(id)) map.set(id, [])
      map.get(id).push({ d, w: +w || 0, r: +r || 0, done: !!done })
    }
    ;(data?.workouts || []).forEach(w => (w.entries || []).forEach(e => (e.sets || []).forEach(s => {
      if (s.w || s.r) add(e.id, w.d, s.w, s.r, s.done)
    })))
    return [...map.entries()].map(([id, sets]) => {
      const done = sets.filter(s => s.done)
      const best = done.length ? Math.max(...done.map(s => s.w)) : null
      const byDate = {}
      sets.forEach(s => { (byDate[s.d] = byDate[s.d] || []).push(s) })
      return {
        id, name: exNameOf(id),
        total: sets.length, done: done.length, best,
        byDate: Object.entries(byDate).sort((a, b) => (a[0] < b[0] ? 1 : -1))
      }
    }).sort((a, b) => (a.name || '').localeCompare(b.name || ''))
  }, [data])

  if (err) return <div className="narrow" style={{ paddingTop: '12vh', textAlign: 'center' }}>
    <h2>Нет доступа</h2><p className="dim">{err}</p>
    <Button variant="primary" onClick={onBack}>Назад</Button>
  </div>
  if (!data) return <div className="narrow" style={{ paddingTop: '42vh', textAlign: 'center' }}><Icon name="dumbbell" style={{ color: 'var(--label-3)', fontSize: 30 }} /></div>

  const weekRows = Object.entries(data.week || {}).sort((a, b) => +a[0] - +b[0])
  const num = (v, d) => { const n = parseFloat(v); return isNaN(n) ? d : n }

  return <div className="narrow" style={{ paddingBottom: 40 }}>
    <div className="hdr">
      <button className="iconbtn" onClick={onBack} aria-label="Назад"><Icon name="chevronLeft" /></button>
      <div style={{ flex: 1 }}>
        <div className="small dim">Программа · спортсмен</div>
        <h1 style={{ margin: 0 }}>{athlete.name}</h1>
        <div className="sub">{draft.length} программ{weekRows.length ? ' · дни: ' + weekRows.map(([d, rid]) => DAYS[+d] + ' — ' + rname(rid)).join(', ') : ''}</div>
      </div>
    </div>

    <div className="seg" style={{ marginBottom: 14, '--n': 2, '--i': ['program', 'stats'].indexOf(tab) }}>
      <span className="seg-sel" />
      {[['program', 'Программа'], ['stats', 'Прогресс']].map(([v, label]) =>
        <button key={v} className={tab === v ? 'on' : ''} onClick={() => setTab(v)}>{label}</button>)}
    </div>
    {err && <div className="small" style={{ color: 'var(--red)', marginBottom: 10 }}>{err}</div>}

    {tab === 'program' && <>
      <div style={{ marginBottom: 10 }}><Button variant="tinted" size="sm" icon="plus" onClick={addR}>Новая программа</Button></div>
      {!draft.length && <div className="card empty">У спортсмена пока нет программ — создайте первую.</div>}
      {draft.map((r, ri) => <div className="card" key={r.id} style={{ marginBottom: 12 }}>
        <div className="row between">
          <input className="field" style={{ fontWeight: 600, fontSize: 17, flex: 1 }} value={r.name}
            onChange={e => setR(r.id, { name: e.target.value })} placeholder="Название программы" />
          <button className="iconbtn" onClick={() => delR(r.id)} aria-label="Удалить программу"><Icon name="trash" /></button>
        </div>
        <div className="list" style={{ marginTop: 10 }}>
          {r.ex.map((e, ei) => {
            const ex = exOr(e.id)
            return <div className="item" key={ei} style={{ flexWrap: 'wrap' }}>
              <Thumb ex={ex} />
              <div className="grow" style={{ minWidth: 140 }}>
                <div className="tt capitalize">{exNameOf(e.id)}</div>
                <div className="row" style={{ gap: 6, marginTop: 6 }}>
                  <label className="dim small" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>подх
                    <input type="number" min="1" max="20" className="field" style={{ width: 46, padding: '4px 6px' }} value={e.sets}
                      onChange={ev => setEx(r.id, ei, { sets: Math.max(1, num(ev.target.value, 1)) })} /></label>
                  <label className="dim small" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>повт
                    <input type="number" min="1" max="200" className="field" style={{ width: 52, padding: '4px 6px' }} value={e.reps}
                      onChange={ev => setEx(r.id, ei, { reps: Math.max(1, num(ev.target.value, 1)) })} /></label>
                  <label className="dim small" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>{unit}
                    <input type="number" min="0" step="0.5" className="field" style={{ width: 60, padding: '4px 6px' }} value={e.weight}
                      onChange={ev => setEx(r.id, ei, { weight: Math.max(0, num(ev.target.value, 0)) })} /></label>
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, alignItems: 'center' }}>
                <div style={{ display: 'flex', gap: 2 }}>
                  <button className="iconbtn" aria-label="Вверх" style={{ width: 26, height: 22, borderRadius: 7, fontSize: 12 }} onClick={() => moveEx(r.id, ei, -1)}><Icon name="chevronUp" /></button>
                  <button className="iconbtn" aria-label="Вниз" style={{ width: 26, height: 22, borderRadius: 7, fontSize: 12 }} onClick={() => moveEx(r.id, ei, 1)}><Icon name="chevronDown" /></button>
                </div>
                <button className="iconbtn" aria-label="Удалить упражнение" onClick={() => delEx(r.id, ei)}><Icon name="xmark" /></button>
              </div>
            </div>
          })}
        </div>
        {!r.ex.length && <div className="muted small" style={{ margin: '8px 2px' }}>Упражнений пока нет.</div>}
        <Button size="sm" variant="tinted" icon="plus" style={{ marginTop: 10 }} onClick={() => addEx(r.id)}>Упражнение</Button>
      </div>)}
      <div className="row" style={{ gap: 8 }}>
        <Button variant="primary" icon="check" onClick={save} disabled={saving || !dirty} style={{ flex: 1 }}>{saving ? 'Сохранение…' : saved ? 'Сохранено ✓' : 'Сохранить изменения'}</Button>
        <Button variant="ghost" onClick={onBack}>Назад</Button>
      </div>
    </>}

    {tab === 'stats' && <>
      {!exStats.length && <div className="card empty">Записей тренировок ещё нет — статистика появится после первых занятий.</div>}
      {exStats.map(s => <div className="card" key={s.id} style={{ marginBottom: 12 }}>
        <div className="row between">
          <h3 style={{ margin: 0 }} className="capitalize">{s.name}</h3>
          <div className="row" style={{ gap: 6 }}>
            {s.best != null && <span className="tag acc">макс {fmtNum(s.best)} {unit}</span>}
            <span className="tag">{s.done} из {s.total} подходов</span>
          </div>
        </div>
        {s.byDate.map(([d, sets]) => <div className="mrow" key={d}>
          <span className="nm">{fmtDate(d)}</span>
          <span className="v">{sets.map(x => fmtNum(x.w) + ' × ' + x.r).join(', ')}{s.done ? '' : ''}</span>
        </div>)}
      </div>)}
    </>}
  </div>
}
