import { useEffect, useState } from 'react'
import { api } from '../lib/api.js'
import { fmtDate } from '../lib/format.js'
import Icon from '../components/Icon.jsx'

const DAY = 86400000
const daysAgo = t => {
  if (!t) return '—'
  const d = Math.round((Date.now() - t) / DAY)
  return d <= 0 ? 'сегодня' : d === 1 ? 'вчера' : d + ' дн. назад'
}
const LEVEL_COLORS = { active: 'var(--green)', at_risk: 'var(--yellow)', gone: 'var(--red)' }
const LEVEL_LABELS = { active: 'Активен', at_risk: 'В зоне риска', gone: 'Ушёл' }

function Tile({ l, v, color }) {
  return <div className="tile"><div className="l">{l}</div><div className="v" style={color ? { color } : undefined}>{v}</div></div>
}

// Small inline bar so the tab reads at a glance (kept dependency-free, like the app).
function Bar({ pct, color }) {
  return <span className="bar"><i style={{ width: Math.max(2, Math.min(100, pct)) + '%', background: color }} /></span>
}

const fmtV = n => (Math.round(n * 10) / 10).toLocaleString('ru-RU')

export default function Retention({ admin }) {
  const [data, setData] = useState(null)
  const [err, setErr] = useState('')
  const [level, setLevel] = useState('all')
  const [q, setQ] = useState('')
  const canDrill = admin.role !== 'operator'
  useEffect(() => {
    api('/api/admin/analytics/retention').then(d => setData(d)).catch(e => setErr(e.message || 'Удержание недоступно'))
  }, [])

  if (err) return <div className="card empty">{err}</div>
  if (!data) return <div className="narrow" style={{ paddingTop: '42vh', textAlign: 'center' }}><Icon name="dumbbell" style={{ color: 'var(--label-3)', fontSize: 30 }} /></div>

  const { summary, funnel, athletes, generatedAt } = data
  const list = athletes.filter(a =>
    (level === 'all' || a.level === level) &&
    (!q.trim() || (a.name || '').toLowerCase().includes(q.trim().toLowerCase())))
  const maxGap = Math.max(1, ...athletes.map(a => a.gapDays || 0))
  const generatedLabel = generatedAt ? new Date(generatedAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }) : '—'

  return <div style={{ paddingBottom: 40 }}>
    <div className="small dim" style={{ marginBottom: 8 }}>Снимок: {generatedLabel} · пересчитывается ночью</div>

    <div className="tiles">
      <Tile l="Всего" v={summary.total} />
      <Tile l="Активны" v={summary.active} color="var(--green)" />
      <Tile l="В зоне риска" v={summary.atRisk} color="var(--yellow)" />
      <Tile l="Ушли" v={summary.gone} color="var(--red)" />
      <Tile l="Средний перерыв" v={summary.avgGap ? summary.avgGap + ' дн' : '—'} />
      <Tile l="Риск, %" v={summary.atRiskPct + '%'} color="var(--yellow)" />
    </div>

    <div className="card">
      <h2>Воронка удержания <span className="dim" style={{ textTransform: 'none', letterSpacing: 0 }}>· из активных за 30 дней</span></h2>
      <div className="mrow"><span className="nm">Тренировались за 30 дней</span><Bar pct={funnel.started30 ? funnel.started30 / (funnel.started30 || 1) * 100 : 0} color="var(--acc)" /><span className="v">{funnel.started30}</span></div>
      <div className="mrow"><span className="nm">Держатся 4 недели</span><Bar pct={funnel.week4 ? funnel.week4 / (funnel.started30 || 1) * 100 : 0} color="var(--acc)" /><span className="v">{funnel.week4}</span></div>
      <div className="mrow"><span className="nm">Держатся 8 недель</span><Bar pct={funnel.week8 ? funnel.week8 / (funnel.started30 || 1) * 100 : 0} color="var(--acc)" /><span className="v">{funnel.week8}</span></div>
      <div className="dim small" style={{ marginTop: 6 }}>Каждый шаг показывает, сколько спортсменов из пришедших за месяц ещё держат активность — первый провал обычно на 2–4 неделе.</div>
    </div>

    <div className="row" style={{ gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
      {[['all', 'Все'], ['active', 'Активен'], ['at_risk', 'В зоне риска'], ['gone', 'Ушёл']].map(([v, l]) =>
        <button key={v} className={'btn xs ' + (level === v ? 'tinted' : 'plain')} onClick={() => setLevel(v)}>{l}</button>)}
    </div>
    <div style={{ marginBottom: 10 }}><input className="field" placeholder="Поиск по имени…" value={q} onChange={e => setQ(e.target.value)} /></div>

    {!list.length ? <div className="card empty">Спортсменов нет.</div> :
      <div className="list">{list.map(a => <div className="item" key={a.id} style={canDrill ? { cursor: 'pointer' } : undefined}>
        <div className="grow">
          <div className="tt">{a.name} <span className="tag" style={{ color: LEVEL_COLORS[a.level], borderColor: LEVEL_COLORS[a.level] + '55' }}>{LEVEL_LABELS[a.level] || a.level}</span></div>
          <div className="ss">
            {a.workouts ? `${a.workouts} тр · активность ${daysAgo(a.lastWorkout)}` : 'без тренировок'}
            {a.gapDays != null ? ` · перерыв ${a.gapDays} дн` : ''}
            {a.workouts4w != null && ` · 4нед/ранее: ${a.workouts4w}/${a.prev4w}`}
            {a.volume4w ? ` · объём ${fmtV(a.volume4w)} кг` : ''}
            {a.stall ? ' · прогресс встал' : ''}
          </div>
          {a.reasons.length > 0 && <div className="small" style={{ color: 'var(--red)', marginTop: 2 }}>⚠ {a.reasons.join(' · ')}</div>}
          {a.gapDays != null && <div className="small dim" style={{ marginTop: 2 }}>риск {a.score} · последняя тренировка {fmtDate(new Date(a.lastWorkout).toISOString().slice(0, 10), true)}</div>}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
          {a.gapDays != null && <Bar pct={a.gapDays / maxGap * 100} color={LEVEL_COLORS[a.level]} />}
          <span className="small dim">{a.gapDays != null ? a.gapDays + ' дн' : ''}</span>
        </div>
      </div>)}</div>}
  </div>
}