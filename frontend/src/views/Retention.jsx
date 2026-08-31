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

function Bar({ pct, color }) {
  return <span className="bar"><i style={{ width: Math.max(2, Math.min(100, pct)) + '%', background: color }} /></span>
}

const fmtV = n => (Math.round(n * 10) / 10).toLocaleString('ru-RU')

export default function Retention({ admin }) {
  const [data, setData] = useState(null)
  const [err, setErr] = useState('')
  const [level, setLevel] = useState('all')
  const [q, setQ] = useState('')
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
  const base = funnel.trained || 1
  const surv = (n) => Math.round((n || 0) / base * 100) + '%'
  const generatedLabel = generatedAt ? new Date(generatedAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }) : '—'
  const FILTERS = [['all', 'Все'], ['active', 'Активен'], ['at_risk', 'В зоне риска'], ['gone', 'Ушёл']]

  return <div style={{ paddingBottom: 40 }}>
    <div className="small dim" style={{ marginBottom: 8 }}>
      Снимок от {generatedLabel} · пересчитывается ночью · обновление без нагрузки на БД
    </div>

    <div className="tiles">
      <Tile l="Всего" v={summary.total} />
      <Tile l="Активны" v={summary.active} color="var(--green)" />
      <Tile l="В зоне риска" v={summary.atRisk} color="var(--yellow)" />
      <Tile l="Ушли" v={summary.gone} color="var(--red)" />
      <Tile l="Средний перерыв" v={summary.avgGap ? summary.avgGap + ' дн' : '—'} />
      <Tile l="Риск, %" v={summary.atRiskPct + '%'} color="var(--yellow)" />
    </div>

    <div className="card">
      <h2 style={{ marginTop: 0 }}>Воронка удержания</h2>
      {[
        ['Тренировались', funnel.trained, 'var(--acc)'],
        ['Держатся ≥ 4 недель', funnel.week4, 'var(--acc)'],
        ['Держатся ≥ 8 недель', funnel.week8, 'var(--acc)']
      ].map(([label, val, color]) => <div className="mrow" key={label}>
        <span className="nm">{label}</span>
        <Bar pct={val / base * 100} color={color} />
        <span className="v">{val} · <b style={{ color }}>{surv(val)}</b></span>
      </div>)}
      <div className="dim small" style={{ marginTop: 6 }}>
        Из всех, кто начал тренироваться, сколько дотянули до 4 и 8 недель. Первый провал — обычно на 2–4 неделе: именно тогда спортсмен теряет мотивацию.
      </div>
    </div>

    <div className="row" style={{ gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
      {FILTERS.map(([v, l]) =>
        <button key={v} className={'btn xs ' + (level === v ? 'tinted' : 'plain')} onClick={() => setLevel(v)}>{l}</button>)}
    </div>
    <div style={{ marginBottom: 10 }}><input className="field" placeholder="Поиск по имени…" value={q} onChange={e => setQ(e.target.value)} /></div>

    {!list.length ? <div className="card empty">Спортсменов нет.</div> :
      <div className="list">{list.map(a => {
        const lc = LEVEL_COLORS[a.level] || 'var(--label-3)'
        const label = LEVEL_LABELS[a.level] || a.level
        return <div className="item" key={a.id}>
          <div className="grow">
            <div className="tt">{a.name} <span className="tag" style={{ color: lc, borderColor: lc + '55' }}>{label}</span>{a.recurring && <span className="tag" style={{ marginLeft: 6, color: 'var(--acc)', borderColor: 'var(--acc)55' }}>постоянник</span>}</div>
            <div className="ss">
              {a.workouts ? `${a.workouts} тр · активность ${daysAgo(a.lastWorkout)}` : 'без тренировок'}
              {a.gapDays != null && ` · перерыв ${a.gapDays} дн`}
              {a.workouts4w != null && ` · 4нед/ранее: ${a.workouts4w}/${a.prev4w}`}
              {a.volume4w ? ` · объём ${fmtV(a.volume4w)} кг` : ''}
              {a.stall && ' · прогресс встал'}
              {a.recurring && a.recurringTime ? ` · постоянные слоты: ${a.recurringTime}` : ''}
            </div>
            {a.reasons.length > 0 && <div className="small" style={{ color: 'var(--red)', marginTop: 3 }}>⚠ {a.reasons.join(' · ')}</div>}
            {a.workouts > 0 && <div className="small dim" style={{ marginTop: 3 }}>
              последняя тренировка {fmtDate(new Date(a.lastWorkout).toISOString().slice(0, 10), true)}
              {a.spanDays != null ? ` · тренировался ${a.spanDays} дн` : ''}
            </div>}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
            {a.gapDays != null && <>
              <Bar pct={a.gapDays / maxGap * 100} color={lc} />
              <span className="small" style={{ color: lc, fontWeight: 600 }}>{a.gapDays} дн</span>
            </>}
            {a.score > 0 && <span className="small dim" style={{ color: lc }}>риск {a.score}</span>}
          </div>
        </div>
      })}</div>}
  </div>
}