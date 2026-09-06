import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api.js'
import { fmtDate } from '../lib/format.js'
import Icon from '../components/Icon.jsx'
import { retentionHelpSheet } from '../components/RetentionHelp.jsx'
import InfoTip from '../components/InfoTip.jsx'

const DAY = 86400000
const daysAgo = t => {
  if (!t) return '—'
  const d = Math.round((Date.now() - t) / DAY)
  return d <= 0 ? 'сегодня' : d === 1 ? 'вчера' : d + ' дн. назад'
}

const LEVEL_COLORS = { active: 'var(--green)', at_risk: 'var(--yellow)', gone: 'var(--red)', new: 'var(--blue)' }
const LEVEL_LABELS = { active: 'Активен', at_risk: 'В зоне риска', gone: 'Ушёл', new: 'Новый' }

function Tile({ l, v, color, hint }) {
  return <div className="tile"><div className="l">{l}{hint && <InfoTip text={hint} />}</div><div className="v" style={color ? { color } : undefined}>{v}</div></div>
}

function Bar({ pct, color }) {
  return <span className="bar"><i style={{ width: Math.max(2, Math.min(100, pct)) + '%', background: color }} /></span>
}

const fmtV = n => (Math.round(n * 10) / 10).toLocaleString('ru-RU')

export default function Retention({ admin, focusAthlete }) {
  const [data, setData] = useState(null)
  const [err, setErr] = useState('')
  const [level, setLevel] = useState('all')
  const [q, setQ] = useState('')
  const focusRef = useRef(null)
  useEffect(() => {
    api('/api/admin/analytics/retention').then(d => setData(d)).catch(e => setErr(e.message || 'Удержание недоступно'))
  }, [])
  // ПРАВИЛО УВЕДОМЛЕНИЙ (см. api/routes/notifications.js): переход из
  // уведомления retention несёт athleteId — ставим фильтр по его статусу,
  // ищем по имени и подсвечиваем карточку, чтобы тренер сразу отреагировал.
  useEffect(() => {
    if (!focusAthlete || !data) return
    const a = (data.athletes || []).find(x => x.id === focusAthlete)
    if (!a) return
    if (a.level) setLevel(a.level)
    if (a.name) setQ(a.name)
  }, [focusAthlete, data])
  useEffect(() => {
    // deps включают level/q: скроллим уже ПОСЛЕ того, как фильтр отрисовал строку
    if (focusRef.current) focusRef.current.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [focusAthlete, data, level, q])

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
  const FILTERS = [['all', 'Все'], ['active', 'Активен'], ['at_risk', 'В зоне риска'], ['gone', 'Ушёл'], ['new', 'Новый']]

  return <div style={{ paddingBottom: 40 }}>
    <div className="row between" style={{ marginBottom: 8, alignItems: 'flex-start' }}>
      <div className="small dim">
        Снимок от {generatedLabel} · пересчитывается ночью · обновление без нагрузки на БД
      </div>
      <button className="btn xs plain" onClick={retentionHelpSheet}><Icon name="info" style={{ fontSize: 13, verticalAlign: '-2px', marginRight: 4 }} />Инструкция</button>
    </div>

    <div className="tiles">
      <Tile l="Всего" v={summary.total} hint="Все спортсмены в вашей зоне видимости, включая новых." />
      <Tile l="Активны" v={summary.active} color="var(--green)" hint="Тренировались менее 14 дней назад — всё в порядке." />
      <Tile l="В зоне риска" v={summary.atRisk} color="var(--yellow)" hint="Без активности 14–30 дней или активность снизилась. Стоит написать и предложить тренировку." />
      <Tile l="Ушли" v={summary.gone} color="var(--red)" hint="Нет активности больше 30 дней. Клиента можно попробовать вернуть акцией или предложением." />
      <Tile l="Новые" v={summary.fresh || 0} color="var(--blue)" hint="Зарегистрировались, но ни разу не тренировались." />
      <Tile l="Средний перерыв" v={summary.avgGap ? summary.avgGap + ' дн' : '—'} hint="Среднее число дней с последней тренировки у тех, кто когда-либо тренировался." />
      <Tile l="Риск, %" v={summary.atRiskPct + '%'} color="var(--yellow)" hint="Доля «в зоне риска» и «ушли» среди начавших тренироваться (без новичков)." />
    </div>

    <div className="card">
      <h2 style={{ marginTop: 0 }}>Воронка удержания</h2>
      {[
        ['Тренировались', funnel.trained, 'var(--acc)', 'Спортсмены хотя бы с одной тренировкой — база воронки (100%).'],
        ['Держатся ≥ 4 недель', funnel.week4, 'var(--acc)', 'Те, кто дотянул от первой тренировки до ~4 недель занятий.'],
        ['Держатся ≥ 8 недель', funnel.week8, 'var(--acc)', 'Те, кто дошёл от первой тренировки до ~2 месяцев.']
      ].map(([label, val, color, hint]) => <div className="mrow" key={label}>
        <span className="nm">{label}{hint && <InfoTip text={hint} />}</span>
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
        const focused = focusAthlete && a.id === focusAthlete
        return <div className="item" key={a.id} ref={focused ? focusRef : undefined}
          style={focused ? { background: 'color-mix(in srgb, var(--acc) 12%, var(--bg-el))', border: '1px solid var(--acc)', borderRadius: 10 } : undefined}>
          <div className="grow">
            <div className="tt">{a.name} <span className="tag" style={{ color: lc, borderColor: lc + '55' }}>{label}</span>{a.recurring && <span className="tag" style={{ marginLeft: 6, color: 'var(--acc)', borderColor: 'var(--acc)55' }}>постоянник</span>}</div>
            <div className="ss">
              {a.workouts ? `${a.workouts} тр · активность ${daysAgo(a.lastWorkout)}` : (a.level === 'new' ? 'зарегистрирован, тренировок не было' : 'без тренировок')}
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