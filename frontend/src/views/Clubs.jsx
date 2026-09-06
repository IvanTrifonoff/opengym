// frontend/src/views/Clubs.jsx — «Клубы»: список арендаторов платформы.
// Только для superadmin (владельца платформы). Каждая карточка — клуб с
// тарифом, статусом (active/frozen), trial_until и кнопкой kill-switch
// («Заморозить» блокирует доступ всему персоналу клуба мгновенно — бэкенд
// проверяет статус на каждом запросе). Пагинация курсором (limit=50).
// Рядом — сброс месячного бюджета trial-писем (Resend).
import { useEffect, useState } from 'react'
import { api } from '../lib/api.js'
import { Button } from '../components/ui.jsx'

const fmt = ts => ts ? new Date(ts).toLocaleString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'
const PLAN = { trial: 'Trial', start: 'Старт', network: 'Сеть', selfhosted: 'SelfHosted' }

export default function Clubs() {
  const [clubs, setClubs] = useState([])
  const [before, setBefore] = useState(null)
  const [hasMore, setHasMore] = useState(false)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState('')
  const [budgetMsg, setBudgetMsg] = useState('')

  const load = (prefix) => {
    const q = prefix ? `?limit=50&before=${encodeURIComponent(prefix)}` : '?limit=50'
    api('/api/admin/clubs' + q).then(d => {
      setClubs(d.clubs || [])
      setBefore(d.has_more && (d.clubs || []).length ? (d.clubs[d.clubs.length - 1]).id : null)
      setHasMore(!!d.has_more)
    }).catch(e => setErr(e.message))
  }
  useEffect(() => { load('') }, [])

  const toggle = c => {
    if (!window.confirm(c.status === 'frozen'
      ? `Разморозить клуб «${c.name}»? Персонал снова получит доступ.`
      : `Заморозить клуб «${c.name}»? ВЕСЬ персонал клуба потеряет доступ мгновенно (данные сохранятся).`)) return
    setBusy(c.id)
    api('/api/admin/clubs/status', { method: 'POST', body: JSON.stringify({ id: c.id, status: c.status === 'frozen' ? 'active' : 'frozen' }) })
      .then(() => load(before)).catch(e => setErr(e.message)).finally(() => setBusy(''))
  }
  const resetBudget = () => {
    if (!window.confirm('Сбросить месячный лимит отправки trial-писем? (Resend-бюджет текущего месяца обнулится.)')) return
    api('/api/admin/trial/budget/reset', { method: 'POST', body: '{}' })
      .then(() => setBudgetMsg('Бюджет trial-писем сброшен ✓')).catch(e => setErr(e.message))
  }

  return <div>
    <div className="row between" style={{ marginBottom: 10 }}>
      <div className="small dim">Арендаторы платформы (clubs). Заморозка мгновенно блокирует доступ всего персонала клуба.</div>
      <Button size="sm" variant="ghost" onClick={resetBudget}>Сбросить бюджет писем</Button>
    </div>
    {budgetMsg && <div className="small" style={{ color: 'var(--green)', marginBottom: 8 }}>{budgetMsg}</div>}
    {err && <div className="small" style={{ color: 'var(--red)', marginBottom: 8 }}>{err}</div>}
    <div className="list">
      {(clubs || []).map(c => <div className="item" key={c.id}>
        <div className="grow">
          <div className="tt">{c.name} <span className="tag" style={{ color: c.status === 'frozen' ? 'var(--red)' : 'var(--green)' }}>{c.status === 'frozen' ? 'заморожен' : 'активен'}</span></div>
          <div className="ss dim">{PLAN[c.plan] || c.plan}{c.plan === 'trial' && c.trial_until ? ' · до ' + fmt(c.trial_until) : ''}{c.owner_email ? ' · ' + c.owner_email : ''}</div>
        </div>
        <Button size="xs" variant={c.status === 'frozen' ? 'primary' : 'danger'} onClick={() => toggle(c)} disabled={busy === c.id}>
          {c.status === 'frozen' ? 'Разморозить' : 'Заморозить'}
        </Button>
      </div>)}
      {!clubs.length && !err && <div className="small dim">Клубов пока нет.</div>}
    </div>
    {hasMore && <div className="row" style={{ justifyContent: 'center', marginTop: 10 }}><Button size="sm" variant="ghost" onClick={() => load(before)}>Показать ещё</Button></div>}
  </div>
}
