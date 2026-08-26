import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../lib/api.js'
import Icon from '../components/Icon.jsx'
import { Button } from '../components/ui.jsx'
import { AthleteCard, StatusTag, daysAgo } from './Analytics.jsx'

const STATUS_ORDER = [['all', 'Все'], ['active', 'Активен'], ['at_risk', 'Риск'], ['gone', 'Ушёл'], ['new', 'Новый']]

// Trainer portal (/trainer): own athletes + adding new (invite link) or existing (search) athletes.
export default function Trainer({ admin, onLogout }) {
  const nav = useNavigate()
  const [tab, setTab] = useState('athletes')
  const [athletes, setAthletes] = useState([])
  const [sel, setSel] = useState(null)
  const [filter, setFilter] = useState('all')
  const [q, setQ] = useState('')
  const [error, setError] = useState('')
  // new athlete via invite
  const [note, setNote] = useState('')
  const [created, setCreated] = useState(null)
  // add existing athlete
  const [sq, setSq] = useState('')
  const [results, setResults] = useState([])
  const [searched, setSearched] = useState(false)
  const [busy, setBusy] = useState('')

  const load = () => api('/api/admin/analytics/athletes').then(d => setAthletes(d.athletes || [])).catch(e => setError(e.message))
  useEffect(() => { load() }, [tab])

  const makeInvite = () => {
    setBusy('invite')
    api('/api/admin/invites/new', { method: 'POST', body: JSON.stringify({ note: (note.trim() || 'Спортсмен') + ' — ' + admin.name, short: true }) })
      .then(d => { setCreated(d.invite); setNote(''); setError('') })
      .catch(e => setError(e.message)).finally(() => setBusy(''))
  }
  const link = created && location.origin + '/?invite=' + created.code

  const search = () => {
    setBusy('search')
    setSearched(true)
    api('/api/admin/analytics/users?q=' + encodeURIComponent(sq.trim()))
      .then(d => setResults(d.users || [])).catch(e => setError(e.message)).finally(() => setBusy(''))
  }
  const addAthlete = id => {
    setBusy(id)
    api('/api/admin/analytics/assign', { method: 'POST', body: JSON.stringify({ user_id: id, trainer_id: admin.id }) })
      .then(() => { setError(''); search(); load() })
      .catch(e => setError(e.message)).finally(() => setBusy(''))
  }

  if (sel) return <AthleteCard id={sel} admin={admin} trainers={[]} onBack={() => setSel(null)} />

  const list = athletes.filter(a =>
    (filter === 'all' || a.status === filter) &&
    (!q.trim() || (a.name || '').toLowerCase().includes(q.trim().toLowerCase())))

  return <div className="narrow" style={{ paddingBottom: 40 }}>
    <div className="hdr">
      <button className="iconbtn" onClick={() => nav('/admin')} aria-label="Назад"><Icon name="chevronLeft" /></button>
      <div style={{ flex: 1 }}>
        <div className="small dim">Тренерский портал</div>
        <h1 style={{ margin: 0 }}>Мои спортсмены</h1>
        <div className="sub">{admin.name} · тренер</div>
      </div>
      <button className="iconbtn" onClick={onLogout} aria-label="Выйти"><Icon name="signOut" /></button>
    </div>

    <div className="seg" style={{ marginBottom: 16, '--n': 2, '--i': ['athletes', 'add'].indexOf(tab) }}>
      <span className="seg-sel" />
      {[['athletes', 'Спортсмены'], ['add', 'Добавить']].map(([v, label]) =>
        <button key={v} className={tab === v ? 'on' : ''} onClick={() => setTab(v)}>{label}</button>)}
    </div>
    {error && <div className="small" style={{ color: 'var(--red)', marginBottom: 10 }}>{error}</div>}

    {tab === 'athletes' && <>
      <div className="row" style={{ gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
        {STATUS_ORDER.map(([v, label]) => <button key={v} className={'btn xs ' + (filter === v ? 'tinted' : 'plain')} onClick={() => setFilter(v)}>{label}</button>)}
      </div>
      <div style={{ marginBottom: 10 }}><input className="field" placeholder="Поиск по имени…" value={q} onChange={e => setQ(e.target.value)} /></div>
      {!list.length ? <div className="card empty">У вас пока нет спортсменов. Перейдите во вкладку «Добавить».</div> :
        <div className="list">{list.map(a => <div className="item" key={a.id} onClick={() => setSel(a.id)} style={{ cursor: 'pointer' }}>
          <div className="grow">
            <div className="tt">{a.name} <StatusTag status={a.status} /></div>
            <div className="ss">визиты {a.visits} · тренировки {a.workouts} · серия {a.streak} нед · {a.freq ? a.freq + '/нед' : '—'} · активность {daysAgo(a.lastActivity)}</div>
          </div>
          <Icon name="chevronRight" style={{ color: 'var(--label-3)' }} />
        </div>)}</div>}
    </>}

    {tab === 'add' && <>
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Новый спортсмен</h3>
        <p className="dim small" style={{ margin: '0 0 12px' }}>Создайте ссылку-приглашение. Когда спортсмен зарегистрируется по ней в приложении, он автоматически появится в вашем списке.</p>
        <div className="row" style={{ gap: 8 }}>
          <input className="field" value={note} onChange={e => setNote(e.target.value)} placeholder="Имя спортсмена (необязательно)" />
          <Button variant="primary" size="sm" icon="plus" onClick={makeInvite} disabled={!!busy}>{busy === 'invite' ? 'Создание…' : 'Создать ссылку'}</Button>
        </div>
        {created && <div className="small" style={{ marginTop: 12 }}>
          Код: <b style={{ fontSize: 18, letterSpacing: '.12em' }}>{created.code}</b><br />
          Ссылка: <span className="dim">{link}</span>{' '}
          <button className="btn xs plain" onClick={() => navigator.clipboard?.writeText(link)}>Копировать ссылку</button>{' '}
          <button className="btn xs plain" onClick={() => navigator.clipboard?.writeText(created.code)}>Копировать код</button>
        </div>}
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Уже зарегистрирован</h3>
        <p className="dim small" style={{ margin: '0 0 12px' }}>Найдите спортсмена по имени — спортсмен может быть закреплён только за одним тренером.</p>
        <div className="row" style={{ gap: 8 }}>
          <input className="field" value={sq} onChange={e => setSq(e.target.value)} placeholder="Имя спортсмена…" onKeyDown={e => { if (e.key === 'Enter') search() }} />
          <Button variant="primary" size="sm" icon="magnifier" onClick={search} disabled={!!busy}>{busy === 'search' ? 'Поиск…' : 'Найти'}</Button>
        </div>
        {searched && !results.length && <div className="muted small" style={{ marginTop: 10 }}>Никого не найдено. Если спортсмен ещё не регистрировался — создайте ссылку выше.</div>}
        {results.length > 0 && <div className="list" style={{ marginTop: 12 }}>{results.map(u => <div className="item" key={u.id}>
          <div className="grow">
            <div className="tt">{u.name}</div>
            <div className="ss">{u.trainerId ? (u.trainerId === admin.id ? 'уже у вас' : 'у тренера ' + (u.trainerName || u.trainerId)) : 'без тренера'}</div>
          </div>
          {u.trainerId === admin.id
            ? <span className="tag acc">ваш</span>
            : <Button size="sm" variant="tinted" onClick={() => addAthlete(u.id)} disabled={!!busy}>{busy === u.id ? '…' : u.trainerId ? 'Забрать себе' : 'Добавить'}</Button>}
        </div>)}</div>}
      </div>
    </>}
  </div>
}
