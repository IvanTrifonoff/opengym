import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../lib/api.js'
import { EXIDX } from '../lib/exercises.js'
import { exName } from '../lib/i18n.js'
import { fmtDate } from '../lib/format.js'
import Icon from '../components/Icon.jsx'
import { Button } from '../components/ui.jsx'
import LineChart from '../components/LineChart.jsx'
import TrainerProgram from './TrainerProgram.jsx'

const DAY = 86400000
const STATUS = {
  active: { label: 'Активен', color: 'var(--green)' },
  at_risk: { label: 'В зоне риска', color: 'var(--yellow)' },
  gone: { label: 'Ушёл', color: 'var(--red)' },
  new: { label: 'Новый', color: 'var(--blue)' }
}
const STATUS_ORDER = [['all', 'Все'], ['active', 'Активен'], ['at_risk', 'Риск'], ['gone', 'Ушёл'], ['new', 'Новый']]

export const StatusTag = ({ status }) => {
  const s = STATUS[status] || { label: status, color: 'var(--label-3)' }
  return <span className="tag" style={{ color: s.color, borderColor: s.color + '55' }}>{s.label}</span>
}

export const daysAgo = t => {
  if (!t) return '—'
  const d = Math.round((Date.now() - t) / DAY)
  return d <= 0 ? 'сегодня' : d === 1 ? 'вчера' : d + ' дн. назад'
}

function Tile({ l, v, color }) {
  return <div className="tile"><div className="l">{l}</div><div className="v" style={color ? { color } : undefined}>{v}</div></div>
}

function Leaderboard({ lb }) {
  const lists = [
    ['Топ по баллам', lb.byPoints, v => String(v), ''],
    ['Топ по объёму', lb.byVolume, v => v + ' ' + (lb.byVolume[0]?.unit || 'кг'), ''],
    ['Серия недель', lb.byStreak, v => v + ' нед', '']
  ]
  return <div className="cols">
    {lists.map(([title, rows, fmt]) => <div className="card" key={title}>
      <h2 style={{ marginTop: 0 }}>{title}</h2>
      {!rows.length ? <div className="muted small">Пока нет данных.</div> : rows.map((r, i) => <div className="mrow" key={r.id}>
        <span className="nm"><b style={{ color: i < 3 ? 'var(--yellow)' : 'var(--label-3)' }}>{i + 1}</b> · {r.name}</span>
        <span className="v"><b>{fmt(r.value)}</b></span>
      </div>)}
    </div>)}
  </div>
}

export function AthleteCard({ id, admin, trainers, onBack, onProgram }) {
  const [d, setD] = useState(null)
  const [err, setErr] = useState('')
  const [tr, setTr] = useState('')
  const [busy, setBusy] = useState(false)
  const canManage = admin.role === 'owner' || admin.role === 'manager'
  useEffect(() => {
    setD(null); setErr('')
    api('/api/admin/analytics/athlete?id=' + encodeURIComponent(id))
      .then(x => { setD(x); setTr(x.user.trainerId || '') })
      .catch(e => setErr(e.message || 'Нет доступа к спортсмену'))
  }, [id])
  const assign = () => {
    setBusy(true)
    api('/api/admin/analytics/assign', { method: 'POST', body: JSON.stringify({ user_id: id, trainer_id: tr }) })
      .then(() => setErr('')).catch(e => setErr(e.message)).finally(() => setBusy(false))
  }
  if (err) return <div className="narrow" style={{ paddingTop: '12vh', textAlign: 'center' }}>
    <h2>Нет доступа</h2><p className="dim">{err}</p>
    <Button variant="primary" onClick={onBack}>Назад</Button>
  </div>
  if (!d) return <div className="narrow" style={{ paddingTop: '42vh', textAlign: 'center' }}><Icon name="dumbbell" style={{ color: 'var(--label-3)', fontSize: 30 }} /></div>
  const unit = d.unit || 'кг'
  const maxVol = Math.max(1, ...d.weeks.map(w => w.volume))
  const maxLift = d.bestLifts[0]?.w || 0
  return <div className="narrow" style={{ paddingBottom: 40 }}>
    <div className="hdr">
      <button className="iconbtn" onClick={onBack} aria-label="Назад"><Icon name="chevronLeft" /></button>
      <div style={{ flex: 1 }}>
        <div className="small dim">Аналитика · спортсмен</div>
        <h1 style={{ margin: 0 }}>{d.user.name} <StatusTag status={d.status} /></h1>
        <div className="sub">{d.user.branch ? 'филиал ' + d.user.branch : 'без филиала'} · создан {d.user.created ? fmtDate(d.user.created.slice(0, 10), true) : '—'} · активность {daysAgo(d.lastActivity)}</div>
      </div>
      {onProgram && <button className="iconbtn" onClick={onProgram} aria-label="Программа"><Icon name="list" /></button>}
    </div>

    {canManage && <div className="card" style={{ marginBottom: 12 }}>
      <div className="row between"><h3 style={{ margin: 0 }}>Тренер</h3>
        <div className="row" style={{ gap: 8 }}>
          <select className="field" value={tr} onChange={e => setTr(e.target.value)}>
            <option value="">— без тренера —</option>
            {trainers.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <Button size="sm" variant="primary" onClick={assign} disabled={busy || tr === (d.user.trainerId || '')}>Сохранить</Button>
        </div>
      </div>
    </div>}

    <div className="tiles">
      <Tile l="Визиты" v={d.visits} />
      <Tile l="Тренировки" v={d.workouts} />
      <Tile l="Объём" v={fmtNum2(d.volume) + ' ' + unit} />
      <Tile l="Баллы" v={d.points} color="var(--acc)" />
      <Tile l="Серия недель" v={d.streak} />
      <Tile l="Частота" v={d.freq ? d.freq + '/нед' : '—'} />
      <Tile l="Визиты 30д" v={d.visits30} />
      <Tile l="Тренировки 30д" v={d.workouts30} />
      <Tile l="Вес" v={d.user && d.user.bw != null ? d.user.bw + ' ' + unit : '—'} />
      <Tile l="Вес 30д" v={d.bwDelta30 == null ? '—' : (d.bwDelta30 > 0 ? '+' : '') + d.bwDelta30 + ' ' + unit} />
      <Tile l="Выдано/потрачено" v={d.issued + '/' + d.spent} />
      <Tile l="Наград получено" v={d.redemptionsCount} />
    </div>

    <div className="card">
      <h2>Активность по неделям <span className="dim" style={{ textTransform: 'none', letterSpacing: 0 }}>· последние 12 недель</span></h2>
      {d.weeks.every(w => !w.visits && !w.workouts) ? <div className="muted small">Нет данных.</div> :
        d.weeks.map(w => <div className="mrow" key={w.key}>
          <span className="nm">{w.label}</span>
          <span className="bar"><i style={{ width: Math.round(w.volume / maxVol * 100) + '%' }} /></span>
          <span className="v">{w.workouts ? w.workouts + ' тр · ' : ''}{w.visits ? w.visits + ' виз · ' : ''}{fmtNum2(w.volume)} {unit}</span>
        </div>)}
    </div>

    {d.bw && d.bw.length >= 2 && <div className="card">
      <h2>Вес тела</h2>
      <div className="chart"><LineChart points={d.bw} h={140} unit={unit} /></div>
    </div>}

    {d.bestLifts.length > 0 && <div className="card">
      <h2>Лучшие результаты <span className="dim" style={{ textTransform: 'none', letterSpacing: 0 }}>· топ по весу</span></h2>
      {d.bestLifts.map((ex, i) => <div className="mrow" key={i}>
        <span className="nm">{exName(EXIDX[ex.id] || { id: ex.id, n: ex.id })}</span>
        <span className="bar"><i style={{ width: Math.round(ex.w / maxLift * 100) + '%', background: 'var(--acc)' }} /></span>
        <span className="v">{ex.w} {unit}{ex.r ? ' × ' + ex.r : ''} · {fmtDate(ex.d, true)}</span>
      </div>)}
    </div>}

    {d.recentWorkouts.length > 0 && <div className="card">
      <h2>Последние тренировки</h2>
      {d.recentWorkouts.map((w, i) => <div className="mrow" key={i}>
        <span className="nm">{fmtDate(w.d, true)}</span>
        <span className="v">{w.volume ? fmtNum2(w.volume) + ' ' + unit : '—'} · {w.sets} подх · {w.ex} упр</span>
      </div>)}
    </div>}

    {d.ledger.length > 0 && <div className="card">
      <h2>История баллов</h2>
      {d.ledger.map((r, i) => <div className="mrow" key={i}>
        <span className="nm">{r.reason || r.action_key}</span>
        <span className="v" style={{ color: r.amount > 0 ? 'var(--acc)' : 'var(--red)' }}>{r.amount > 0 ? '+' : ''}{r.amount} · {new Date(r.occurred_at).toLocaleDateString()}</span>
      </div>)}
    </div>}

    {d.redemptions.length > 0 && <div className="card">
      <h2>Награды</h2>
      {d.redemptions.map((r, i) => <div className="mrow" key={i}>
        <span className="nm">{r.reward_name || r.reward_id}</span>
        <span className="v">-{r.cost} · {r.status} · {new Date(r.created_at).toLocaleDateString()}</span>
      </div>)}
    </div>}

    {d.achievements.length > 0 && <div className="card">
      <h2>Достижения</h2>
      <div className="mchips">{d.achievements.map((a, i) => <span key={i} className="mchip">{a.achievement_key}</span>)}</div>
    </div>}
  </div>
}

const fmtNum2 = n => (Math.round(n * 10) / 10).toLocaleString('ru-RU')

export default function Analytics({ admin }) {
  const nav = useNavigate()
  const [tab, setTab] = useState('athletes')
  const [summary, setSummary] = useState(null)
  const [athletes, setAthletes] = useState([])
  const [leaderboard, setLeaderboard] = useState(null)
  const [trainers, setTrainers] = useState([])
  const [sel, setSel] = useState(null)
  const [prog, setProg] = useState(null)
  const [filter, setFilter] = useState('all')
  const [q, setQ] = useState('')
  const [impErr, setImpErr] = useState('')
  const canManage = admin.role === 'owner' || admin.role === 'manager'
  const canDrill = admin.role !== 'operator'
  const impersonate = a => api('/api/admin/impersonate', { method: 'POST', body: JSON.stringify({ kind: 'athlete', id: a.id }) }).then(d => { location.href = d.redirect }).catch(e => setImpErr(e.message))
  const scopeLabel = admin.role === 'owner' ? 'вся сеть'
    : admin.role === 'manager' ? (admin.branch_key ? 'филиал ' + admin.branch_key : 'сеть (все филиалы)')
    : admin.role === 'trainer' ? 'свои спортсмены'
    : 'только статусы'

  useEffect(() => {
    api('/api/admin/analytics/overview').then(d => setSummary(d.summary)).catch(() => {})
    api('/api/admin/analytics/athletes').then(d => setAthletes(d.athletes || [])).catch(() => {})
    if (canManage) {
      api('/api/admin/analytics/leaderboard').then(setLeaderboard).catch(() => {})
      api('/api/admin/analytics/trainers').then(d => setTrainers(d.trainers || [])).catch(() => {})
    }
  }, [canManage])

  if (prog) return <TrainerProgram athlete={prog} onBack={() => setProg(null)} />
  if (sel) return <AthleteCard id={sel} admin={admin} trainers={trainers} onBack={() => setSel(null)} onProgram={() => setProg({ id: sel, name: (athletes.find(x => x.id === sel) || {}).name || 'Спортсмен' })} />

  const list = athletes.filter(a =>
    (filter === 'all' || a.status === filter) &&
    (!q.trim() || (a.name || '').toLowerCase().includes(q.trim().toLowerCase())))

  return <div className="narrow" style={{ paddingBottom: 40 }}>
    <div className="hdr">
      <button className="iconbtn" onClick={() => nav('/admin')} aria-label="Назад"><Icon name="chevronLeft" /></button>
      <div style={{ flex: 1 }}>
        <div className="small dim">openGym Admin</div>
        <h1 style={{ margin: 0 }}>Аналитика</h1>
        <div className="sub">{admin.name} · {admin.role} · {scopeLabel}</div>
      </div>
    </div>

    {impErr && <div className="small" style={{ color: 'var(--red)', marginBottom: 10 }}>{impErr}</div>}

    {summary && <div className="tiles">
      <Tile l="Спортсмены" v={summary.total} />
      <Tile l="Активны" v={summary.active} color="var(--green)" />
      <Tile l="В зоне риска" v={summary.atRisk ? summary.atRisk + ' · ' + summary.atRiskPct + '%' : '0'} color="var(--yellow)" />
      <Tile l="Ушли" v={summary.gone} color="var(--red)" />
      <Tile l="Частота / нед" v={summary.avgFreq || '—'} />
      <Tile l="Визиты 30д" v={summary.visits30} />
      <Tile l="Тренировки 30д" v={summary.workouts30} />
      <Tile l="Объём 30д" v={fmtNum2(summary.volume30) + ' кг'} />
      <Tile l="Баллов выдано" v={summary.pointsIssued} color="var(--acc)" />
      <Tile l="Баллов потрачено" v={summary.pointsSpent} />
      <Tile l="Наград выдано" v={summary.redemptions} />
      <Tile l="Новые" v={summary.fresh} />
    </div>}

    <div className="seg" style={{ marginBottom: 12, '--n': canManage ? 2 : 1, '--i': ['athletes', 'leaderboard'].indexOf(tab) }}>
      <span className="seg-sel" />
      {[['athletes', 'Спортсмены'], ...(canManage ? [['leaderboard', 'Лидерборд']] : [])].map(([v, label]) =>
        <button key={v} className={tab === v ? 'on' : ''} onClick={() => setTab(v)}>{label}</button>)}
    </div>

    {tab === 'leaderboard' && leaderboard && <Leaderboard lb={leaderboard} />}

    {tab === 'athletes' && <>
      <div className="row" style={{ gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
        {STATUS_ORDER.map(([v, label]) => <button key={v} className={'btn xs ' + (filter === v ? 'tinted' : 'plain')} onClick={() => setFilter(v)}>{label}</button>)}
      </div>
      <div style={{ marginBottom: 10 }}><input className="field" placeholder="Поиск по имени…" value={q} onChange={e => setQ(e.target.value)} /></div>
      {!list.length ? <div className="card empty">Спортсменов нет.</div> :
        <div className="list">{list.map(a => <div className="item" key={a.id} onClick={canDrill ? () => setSel(a.id) : undefined} style={canDrill ? { cursor: 'pointer' } : undefined}>
          <div className="grow">
            <div className="tt">{a.name} <StatusTag status={a.status} /></div>
            <div className="ss">визиты {a.visits} · тренировки {a.workouts} · серия {a.streak} нед · {a.freq ? a.freq + '/нед' : '—'} · активность {daysAgo(a.lastActivity)}</div>
            {canManage && a.branch && <div className="small dim">филиал {a.branch}{a.trainerId ? ' · тренер привязан' : ''}</div>}
          </div>
          {admin.role === 'owner' && <button className="btn xs plain" onClick={e => { e.stopPropagation(); impersonate(a) }}>Войти как</button>}
          {canDrill && <Icon name="chevronRight" style={{ color: 'var(--label-3)' }} />}
        </div>)}</div>}
    </>}
  </div>
}
