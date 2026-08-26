import { useEffect, useState } from 'react'
import { api } from '../lib/api.js'
import { useUI } from '../store/useUI.js'
import { t, dateLocale } from '../lib/i18n.js'
import { DAYS } from '../lib/format.js'
import Icon from '../components/Icon.jsx'
import { refreshBadge, markBadgeSeen } from '../lib/badge.js'
import { Button } from '../components/ui.jsx'

const iso = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
const fmtDate = d => new Date(d + 'T12:00:00').toLocaleDateString(dateLocale(), { day: 'numeric', month: 'short' })
const nextHour = t2 => String(+t2.split(':')[0] + 1).padStart(2, '0') + ':00'
const daySlots = (avail, wd) => {
  const out = []
  for (const a of (avail || [])) {
    if (a.weekday !== wd) continue
    let t = a.time_start
    while (t < a.time_end) { if (!out.includes(t)) out.push(t); t = nextHour(t) }
  }
  return out.sort()
}
const STATUS = {
  pending: { label: 'Pending', color: 'var(--yellow)' },
  confirmed: { label: 'Confirmed', color: 'var(--green)' },
  rejected: { label: 'Rejected', color: 'var(--red)' },
  cancelled: { label: 'Cancelled', color: 'var(--label-3)' },
  done: { label: 'Done', color: 'var(--blue)' }
}

// Athlete → trainer booking sheet ("My trainer" card on Home).
export function CoachSheet({ user, close }) {
  const [data, setData] = useState(null)
  const [mine, setMine] = useState([])
  const [date, setDate] = useState('')
  const [time, setTime] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [msg, setMsg] = useState('')

  const load = () => Promise.all([
    api('/api/trainer/availability'),
    api('/api/trainer/my-bookings')
  ]).then(([a, m]) => { setData(a); setMine(m.bookings || []); markBadgeSeen() }).catch(e => setErr(e.message))
  useEffect(() => { load() }, [])

  const days = []
  if (data) {
    const base = new Date()
    for (let i = 0; i < 21 && days.length < 7; i++) {
      const d = new Date(); d.setDate(base.getDate() + i)
      if ((data.availability || []).some(a => a.weekday === d.getDay())) days.push(iso(d))
    }
  }
  const wd = date ? new Date(date + 'T12:00:00').getDay() : -1
  const slots = date ? daySlots(data?.availability, wd) : []
  const taken = new Set((data?.taken || []).filter(x => x.date === date).map(x => x.time))
  const free = slots.filter(s => !taken.has(s))

  const book = () => {
    if (!date || !time) return
    setBusy(true); setErr(''); setMsg('')
    api('/api/trainer/book', { method: 'POST', body: JSON.stringify({ date, time, note }) })
      .then(() => { setMsg(t('Request sent — waiting for your trainer to confirm.')); setNote(''); load(); refreshBadge() })
      .catch(e => setErr(e.message)).finally(() => setBusy(false))
  }
  const cancel = id => {
    api('/api/trainer/bookings/cancel', { method: 'POST', body: JSON.stringify({ id }) })
      .then(() => { load(); refreshBadge() }).catch(e => setErr(e.message))
  }

  return <div style={{ maxHeight: '76vh', overflowY: 'auto', padding: '2px 2px 6px' }}>
    <div className="row between" style={{ marginBottom: 10 }}>
      <h3 style={{ margin: 0 }}>{t('Book a session')}</h3>
      <button className="iconbtn" onClick={close} aria-label={t('Cancel')}><Icon name="xmark" /></button>
    </div>
    <div className="dim small" style={{ marginBottom: 14 }}>{t('Choose a free slot — the trainer will confirm your request.')}</div>
    {err && <div className="small" style={{ color: 'var(--red)', marginBottom: 8 }}>{err}</div>}
    {msg && <div className="small" style={{ color: 'var(--acc)', marginBottom: 8 }}>{msg}</div>}

    {!data ? <div className="muted small">…</div> : <>
      <div className="row" style={{ gap: 6, marginBottom: 10, overflowX: 'auto', paddingBottom: 4 }}>
        {days.map(d => <button key={d} className={'btn xs ' + (d === date ? 'tinted' : 'plain')} onClick={() => { setDate(d); setTime('') }}>
          {t(DAYS[new Date(d + 'T12:00:00').getDay()])} {fmtDate(d)}
        </button>)}
        {!days.length && <span className="dim small">{t('Trainer has not set working hours yet.')}</span>}
      </div>

      {date && <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
        {free.length ? free.map(s => <button key={s} className={'btn xs ' + (s === time ? 'primary' : 'plain')} onClick={() => setTime(s)}>{s}</button>)
          : <span className="dim small">{t('No free slots this day.')}</span>}
      </div>}

      <input className="input" placeholder={t('Note for the trainer (optional)')} maxLength={200} value={note} onChange={e => setNote(e.target.value)} />
      <div style={{ height: 10 }} />
      <Button variant="primary" icon="check" onClick={book} disabled={busy || !date || !time}>{busy ? t('Sending…') : t('Send request')}</Button>
    </>}

    <div style={{ height: 18 }} />
    <h3 className="sec">{t('My bookings')}</h3>
    {!mine.length ? <div className="muted small">{t('No bookings yet.')}</div> : <div className="list">
      {mine.sort((a, b) => (a.date + a.time) < (b.date + b.time) ? 1 : -1).map(b => {
        const s = STATUS[b.status] || { label: b.status, color: 'var(--label-3)' }
        return <div className="item" key={b.id}>
          <div className="grow">
            <div className="tt">{fmtDate(b.date)} · {b.time}</div>
            <div className="ss">{b.note || '—'}</div>
          </div>
          <span className="tag" style={{ color: s.color, borderColor: s.color + '55' }}>{t(s.label)}</span>
          {(b.status === 'pending' || b.status === 'confirmed') && <button className="btn xs plain" onClick={() => cancel(b.id)}>{t('Cancel')}</button>}
        </div>
      })}
    </div>}
  </div>
}

export const openCoachSheet = user => useUI.getState().openSheet(close => <CoachSheet user={user} close={close} />)
