import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { api } from '../lib/api.js'
import { EXIDX } from '../lib/exercises.js'
import { exName } from '../lib/i18n.js'
import { fmtDate } from '../lib/format.js'
import { dateLocale } from '../lib/i18n.js'
import Icon from '../components/Icon.jsx'
import NavBar from '../components/NavBar.jsx'
import InfoTip from '../components/InfoTip.jsx'
import { Button } from '../components/ui.jsx'
import { confirmSheet } from '../sheets.jsx'
import LineChart from '../components/LineChart.jsx'
import TrainerProgram from './TrainerProgram.jsx'
import Retention from './Retention.jsx'
// Compat-шим (v1.3.x, Шаг 1-2): superadmin в UI ведёт себя как owner.
const isOwner = r => r === 'owner' || r === 'superadmin'
const ROLE_LABELS = { superadmin: 'Владелец платформы', owner: 'Владелец клуба', manager: 'Менеджер', trainer: 'Тренер', operator: 'Оператор' }
const roleLabel = r => ROLE_LABELS[r] || r

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

// Неделя в drill-down: читаемый диапазон дат («16–22 июн»), а не голый «06-20».
const fmtWeek = label => {
  const s = new Date(label + 'T12:00:00')
  const e = new Date(s); e.setDate(e.getDate() + 6)
  const loc = dateLocale()
  const sD = s.toLocaleDateString(loc, { day: 'numeric' })
  const eD = e.toLocaleDateString(loc, { day: 'numeric' })
  const m = e.toLocaleDateString(loc, { month: 'short' })
  return sD + '–' + eD + ' ' + m
}

export const daysAgo = t => {
  if (!t) return '—'
  const d = Math.round((Date.now() - t) / DAY)
  return d <= 0 ? 'сегодня' : d === 1 ? 'вчера' : d + ' дн. назад'
}

function Tile({ l, v, color, hint }) {
  return <div className="tile"><div className="l">{l}{hint && <InfoTip text={hint} />}</div><div className="v" style={color ? { color } : undefined}>{v}</div></div>
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
  const canManage = isOwner(admin.role) || admin.role === 'manager'
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

    {canManage && <div className="card" style={{ marginBottom: 12, borderColor: 'color-mix(in srgb, var(--red) 45%, transparent)' }}>
      <div className="row between" style={{ gap: 8, flexWrap: 'wrap' }}>
        <div><div style={{ fontWeight: 600 }}>Закрыть доступ</div><div className="small dim" style={{ marginTop: 2 }}>Профиль скрывается из списков, вход блокируется; данные и статистика остаются на сервере.</div></div>
        <Button size="sm" variant="danger" onClick={() => confirmSheet({
          title: 'Удалить спортсмена ' + d.user.name + '?', message: 'Профиль скроется из списков, вход и синхронизация будут заблокированы. Все данные останутся на сервере — восстановление возможно в любой момент.',
          confirmText: 'Удалить', danger: true,
          onConfirm: () => api('/api/admin/user/delete', { method: 'POST', body: JSON.stringify({ id }) }).then(() => { onBack() }).catch(e => setErr(e.message || 'Не удалось удалить'))
        })}>Удалить спортсмена</Button>
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
          <span className="nm">{fmtWeek(w.label)}</span>
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
  const loc = useLocation()
  // ПРАВИЛО УВЕДОМЛЕНИЙ (см. api/routes/notifications.js): переход из
  // уведомления retention/retention-net приносит state { tab: 'retention',
  // focusAthlete? } — открываем вкладку «Удержание» и фокусируем спортсмена.
  const navState = loc.state || {}
  const [tab, setTab] = useState(navState.tab === 'retention' ? 'retention' : 'athletes')
  const [focusAthlete, setFocusAthlete] = useState(navState.focusAthlete || null)
  useEffect(() => {
    const st = loc.state || {}
    if (st.tab === 'retention') setTab('retention')
    if (st.focusAthlete) setFocusAthlete(st.focusAthlete)
  }, [loc.state])
  const [summary, setSummary] = useState(null)
  const [athletes, setAthletes] = useState([])
  const [leaderboard, setLeaderboard] = useState(null)
  const [trainers, setTrainers] = useState([])
  const [sel, setSel] = useState(null)
  const [prog, setProg] = useState(null)
  const [filter, setFilter] = useState('all')
  const [q, setQ] = useState('')
  const [impErr, setImpErr] = useState('')
  const canManage = isOwner(admin.role) || admin.role === 'manager'
  const canDrill = admin.role !== 'operator'
  const impersonate = a => api('/api/admin/impersonate', { method: 'POST', body: JSON.stringify({ kind: 'athlete', id: a.id }) }).then(d => { location.href = d.redirect }).catch(e => setImpErr(e.message))
  // Multi-tenant (v1.3.x): superadmin видит всю платформу; owner — свой клуб;
  // manager — свой филиал (или клуб, если филиал не назначен); тренер/оператор — своё.
  const scopeLabel = admin.role === 'superadmin' ? 'вся платформа'
    : admin.role === 'owner' ? (admin.club_id ? 'клуб' : 'клуб не назначен')
    : admin.role === 'manager' ? (admin.branch_key ? 'филиал' : 'клуб')
    : admin.role === 'trainer' ? 'свои спортсмены'
    : 'только просмотр'

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
        <div className="small dim">ИмпульС</div>
        <h1 style={{ margin: 0 }}>Аналитика</h1>
        <div className="sub">{admin.name} · {roleLabel(admin.role)} · {scopeLabel}</div>
      </div>
    </div>

    <NavBar
      selected="analytics"
      items={[
        { key: 'overview', icon: 'house', label: 'Обзор', to: '/admin' },
        { key: 'analytics', icon: 'chart', label: 'Аналитика', to: '/admin/analytics' },
        { key: 'rewards', icon: 'medal', label: 'Награды', to: '/admin?tab=rewards' },
        { key: 'staff', icon: 'person', label: 'Сотрудники', to: '/admin?tab=staff' }
      ]}
    />

    {impErr && <div className="small" style={{ color: 'var(--red)', marginBottom: 10 }}>{impErr}</div>}

    {summary && <div className="tiles">
      <Tile l="Спортсмены" v={summary.total} hint="Все спортсмены в вашей зоне видимости: вся сеть, филиал или только привязанные к вам." />
      <Tile l="Активны" v={summary.active} color="var(--green)" hint="Тренировались или посещали зал за последние 14 дней." />
      <Tile l="В зоне риска" v={summary.atRisk ? summary.atRisk + ' · ' + summary.atRiskPct + '%' : '0'} color="var(--yellow)" hint="Без активности 14–30 дней — клиента ещё можно вернуть. Процент — доля риска среди тех, у кого активность была." />
      <Tile l="Ушли" v={summary.gone} color="var(--red)" hint="Нет активности больше 30 дней. Попробуйте вернуть акцией или персональным предложением." />
      <Tile l="Частота / нед" v={summary.avgFreq || '—'} hint="Среднее число тренировок в неделю у тех, кто занимался в последние 30 дней." />
      <Tile l="Визиты 30д" v={summary.visits30} hint="Посещений зала за 30 дней. Если СКУД не подключён — считаются дни с тренировками." />
      <Tile l="Тренировки 30д" v={summary.workouts30} hint="Число завершённых тренировок за последние 30 дней." />
      <Tile l="Тоннаж 30д"
        v={fmtNum2(summary.volume30) + ' кг' + (summary.volumeTrendPct == null ? '' :
          ' · ' + (summary.volumeTrendPct >= 0 ? '↑' : '↓') + Math.abs(summary.volumeTrendPct) + '%')}
        color={summary.volumeTrendPct == null ? undefined : (summary.volumeTrendPct >= 0 ? 'var(--green)' : 'var(--red)')}
        hint="Суммарный поднятый объём (кг) за 30 дней. Стрелка — рост или падение к предыдущим 30 дням." />
      <Tile l="Баллов выдано" v={summary.pointsIssued} color="var(--acc)" hint="Баллов лояльности начислено спортсменам (за всё время)." />
      <Tile l="Баллов потрачено" v={summary.pointsSpent} hint="Баллов потрачено на награды (за всё время)." />
      <Tile l="Наград выдано" v={summary.redemptions} hint="Наград выдано спортсменам (без учёта отклонённых заявок)." />
      <Tile l="Новые" v={summary.fresh} hint="Зарегистрировались, но ещё ни разу не тренировались. Главное — помочь сделать первую тренировку." />
    </div>}

    <div className="seg" style={{ marginBottom: 12, '--n': canManage ? 3 : 2, '--i': ['athletes', 'retention', 'leaderboard'].indexOf(tab) }}>
      <span className="seg-sel" />
      {[['athletes', 'Спортсмены'], ['retention', 'Удержание'], ...(canManage ? [['leaderboard', 'Лидерборд']] : [])].map(([v, label]) =>
        <button key={v} className={tab === v ? 'on' : ''} onClick={() => setTab(v)}>{label}</button>)}
    </div>

    {tab === 'retention' && <Retention admin={admin} focusAthlete={focusAthlete} />}

    {tab === 'leaderboard' && leaderboard && <Leaderboard lb={leaderboard} />}

    {tab === 'athletes' && <>
      <div className="row" style={{ gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
        {STATUS_ORDER.map(([v, label]) => <button key={v} className={'btn xs ' + (filter === v ? 'tinted' : 'plain')} onClick={() => setFilter(v)}>{label}</button>)}
      </div>
      <div style={{ marginBottom: 10 }}><input className="field" placeholder="Поиск по имени…" value={q} onChange={e => setQ(e.target.value)} /></div>
      {!list.length ? <div className="card empty">Спортсменов нет.</div> :
        <div className="list">{list.map(a => <div className="item" key={a.id} onClick={canDrill ? () => setSel(a.id) : undefined} style={canDrill ? { cursor: 'pointer' } : undefined}>
          <div className="grow">
            <div className="tt">{a.name} <StatusTag status={a.status} />{a.recurring && <span className="tag" style={{ marginLeft: 6, color: 'var(--acc)', borderColor: 'var(--acc)55' }}>постоянник</span>}</div>
            <div className="ss">{a.visits != null ? 'визиты ' + a.visits + ' · ' : ''}тренировки {a.workouts} · серия {a.streak} нед · {a.freq ? a.freq + '/нед' : '—'} · активность {daysAgo(a.lastActivity)}{a.recurring && a.recurringTime ? ' · постоянные слоты: ' + a.recurringTime : ''}</div>
            {canManage && a.branch && <div className="small dim">филиал {a.branch}{a.trainerId ? ' · тренер привязан' : ''}</div>}
          </div>
          {isOwner(admin.role) && <button className="btn xs plain" onClick={e => { e.stopPropagation(); impersonate(a) }}>Войти как</button>}
          {canDrill && <Icon name="chevronRight" style={{ color: 'var(--label-3)' }} />}
        </div>)}</div>}
    </>}
  </div>
}
