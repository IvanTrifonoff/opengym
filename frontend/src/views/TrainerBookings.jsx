import { useEffect, useState } from 'react'
import { api } from '../lib/api.js'
import Icon from '../components/Icon.jsx'
import { Button } from '../components/ui.jsx'

const DAYS = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб']
const STATUS = {
  pending: { label: 'Ожидает', color: 'var(--yellow)' },
  confirmed: { label: 'Подтверждено', color: 'var(--green)' },
  rejected: { label: 'Отклонено', color: 'var(--red)' },
  cancelled: { label: 'Отменено', color: 'var(--label-3)' },
  done: { label: 'Пройдено', color: 'var(--blue)' }
}
const iso = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
const fmt = d => d.slice(8, 10) + '.' + d.slice(5, 7)
const nextHour = t => String(+t.split(':')[0] + 1).padStart(2, '0') + ':00'
const daySlots = (avail, wd) => {
  const a = (avail || []).find(x => x.weekday === wd)
  if (!a) return []
  const out = []
  let t = a.time_start
  while (t < a.time_end) { out.push(t); t = nextHour(t) }
  return out
}

export default function TrainerBookings({ admin }) {
  const [availability, setAvailability] = useState([])
  const [bookings, setBookings] = useState([])
  const [roster, setRoster] = useState([])
  const [selDay, setSelDay] = useState(iso(new Date()))
  const [err, setErr] = useState('')
  const [showHours, setShowHours] = useState(false)
  const [hours, setHours] = useState([])
  const [addMode, setAddMode] = useState(false)
  const [addAthlete, setAddAthlete] = useState('')
  const [addTime, setAddTime] = useState('')
  const [busy, setBusy] = useState('')

  const days = []
  for (let i = 0; i < 14; i++) { const d = new Date(); d.setDate(d.getDate() + i); days.push(iso(d)) }

  const load = () => Promise.all([
    api('/api/admin/trainer/availability').then(d => {
      setAvailability(d.availability || [])
      if (!(d.availability || []).length) setHours([1, 2, 3, 4, 5].map(wd => ({ weekday: wd, time_start: '09:00', time_end: '18:00' })))
    }),
    api('/api/admin/trainer/bookings?from=' + days[0] + '&to=' + days[days.length - 1]).then(d => setBookings(d.bookings || [])),
    api('/api/admin/analytics/athletes').then(d => setRoster(d.athletes || [])).catch(() => {})
  ]).catch(e => setErr(e.message))
  useEffect(() => { load() }, [])

  const saveHours = () => {
    setBusy('hours')
    api('/api/admin/trainer/availability', { method: 'POST', body: JSON.stringify({ slots: hours.filter(h => h.time_start && h.time_end) }) })
      .then(d => { setAvailability(d.availability || []); setShowHours(false); setErr('') })
      .catch(e => setErr(e.message)).finally(() => setBusy(''))
  }
  const setStatus = (id, status) => {
    setBusy(id)
    api('/api/admin/trainer/bookings/status', { method: 'POST', body: JSON.stringify({ id, status }) })
      .then(load).catch(e => setErr(e.message)).finally(() => setBusy(''))
  }
  const create = () => {
    if (!addAthlete || !addTime) return
    setBusy('create')
    api('/api/admin/trainer/bookings', { method: 'POST', body: JSON.stringify({ athlete_id: addAthlete, date: selDay, time: addTime, note: '' }) })
      .then(() => { setAddMode(false); setAddAthlete(''); setAddTime(''); load() })
      .catch(e => setErr(e.message)).finally(() => setBusy(''))
  }

  const wd = new Date(selDay + 'T12:00:00').getDay()
  const slots = daySlots(availability, wd)
  const taken = bookings.filter(b => (b.status === 'pending' || b.status === 'confirmed') && b.date === selDay).map(b => b.time)
  const freeSlots = slots.filter(t => !taken.includes(t))
  const dayBookings = bookings.filter(b => b.date === selDay).sort((a, b) => (a.time < b.time ? -1 : 1))
  const pending = bookings.filter(b => b.status === 'pending')

  return <div style={{ paddingBottom: 30 }}>
    <div className="row between" style={{ marginBottom: 12 }}>
      <div><h2 style={{ margin: 0 }}>Календарь</h2><div className="sub">Записи на тренировки · {pending.length ? pending.length + ' заявок ждут' : 'заявок нет'}</div></div>
      <Button size="sm" variant={showHours ? 'primary' : 'tinted'} icon="clock" onClick={() => setShowHours(v => !v)}>Часы работы</Button>
    </div>
    {err && <div className="small" style={{ color: 'var(--red)', marginBottom: 10 }}>{err}</div>}

    {showHours && <div className="card" style={{ marginBottom: 12 }}>
      <div className="row between"><h3 style={{ margin: 0 }}>Часы работы</h3><button className="iconbtn" onClick={() => setShowHours(false)}><Icon name="xmark" /></button></div>
      <p className="dim small" style={{ margin: '6px 0 10px' }}>Выходной — оставьте время пустым. Слоты создаются каждый час.</p>
      {hours.map((h, i) => <div className="row" key={h.weekday} style={{ gap: 8, marginBottom: 6 }}>
        <span style={{ width: 34, fontWeight: 500 }}>{DAYS[h.weekday]}</span>
        <input type="time" className="field" style={{ flex: 1, padding: '6px 8px' }} value={h.time_start}
          onChange={e => setHours(prev => prev.map((x, j) => j === i ? { ...x, time_start: e.target.value } : x))} />
        <span className="dim">—</span>
        <input type="time" className="field" style={{ flex: 1, padding: '6px 8px' }} value={h.time_end}
          onChange={e => setHours(prev => prev.map((x, j) => j === i ? { ...x, time_end: e.target.value } : x))} />
      </div>)}
      <Button variant="primary" size="sm" style={{ marginTop: 8 }} onClick={saveHours} disabled={busy === 'hours'}>{busy === 'hours' ? 'Сохранение…' : 'Сохранить часы'}</Button>
    </div>}

    {pending.length > 0 && <div className="card" style={{ marginBottom: 12 }}>
      <h3 style={{ marginTop: 0 }}>Заявки на подтверждение</h3>
      {pending.map(b => <div className="item" key={b.id}>
        <div className="grow">
          <div className="tt">{b.athleteName || 'Спортсмен'}</div>
          <div className="ss">{fmt(b.date)} · {b.time}{b.note ? ' · «' + b.note + '»' : ''}</div>
        </div>
        <div className="row" style={{ gap: 6 }}>
          <Button size="sm" variant="primary" onClick={() => setStatus(b.id, 'confirmed')} disabled={busy === b.id}>Подтвердить</Button>
          <Button size="sm" variant="danger" onClick={() => setStatus(b.id, 'rejected')} disabled={busy === b.id}>Отклонить</Button>
        </div>
      </div>)}
    </div>}

    <div className="row" style={{ gap: 6, marginBottom: 10, overflowX: 'auto', paddingBottom: 4 }}>
      {days.map(d => <button key={d} className={'btn xs ' + (d === selDay ? 'tinted' : 'plain')} onClick={() => { setSelDay(d); setAddMode(false) }}>
        {DAYS[new Date(d + 'T12:00:00').getDay()]} {fmt(d)}
      </button>)}
    </div>

    <div className="row between" style={{ marginBottom: 8 }}>
      <div className="sub">{fmt(selDay)} · свободно {freeSlots.length ? freeSlots.join(', ') : '—'}</div>
      <Button size="sm" variant="tinted" icon="plus" onClick={() => setAddMode(v => !v)}>Записать</Button>
    </div>

    {addMode && <div className="card" style={{ marginBottom: 10 }}>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <select className="field" style={{ flex: 1, minWidth: 160 }} value={addAthlete} onChange={e => setAddAthlete(e.target.value)}>
          <option value="">Спортсмен…</option>
          {roster.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <select className="field" style={{ flex: 1, minWidth: 100 }} value={addTime} onChange={e => setAddTime(e.target.value)}>
          <option value="">Время…</option>
          {freeSlots.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>
      <Button variant="primary" size="sm" style={{ marginTop: 8 }} onClick={create} disabled={!addAthlete || !addTime || busy === 'create'}>Создать запись</Button>
    </div>}

    {!dayBookings.length ? <div className="card empty">В этот день записей нет.</div> :
      <div className="list">{dayBookings.map(b => {
        const s = STATUS[b.status] || { label: b.status, color: 'var(--label-3)' }
        return <div className="item" key={b.id}>
          <div className="grow">
            <div className="tt">{b.time} · {b.athleteName || 'Спортсмен'}</div>
            <div className="ss">{b.note || '—'}</div>
          </div>
          <span className="tag" style={{ color: s.color, borderColor: s.color + '55' }}>{s.label}</span>
          {b.status === 'confirmed' && <button className="btn xs plain" onClick={() => setStatus(b.id, 'cancelled')} disabled={busy === b.id}>Отменить</button>}
        </div>
      })}</div>}
  </div>
}
