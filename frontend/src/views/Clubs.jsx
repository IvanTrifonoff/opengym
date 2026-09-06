// frontend/src/views/Clubs.jsx — «Клубы»: список арендаторов платформы + филиалы и
// сотрудники внутри каждого клуба. Только для superadmin (владельца платформы).
// Вкладки «Филиалы» и «Сотрудники» у суперадмина убраны (v1.4.5) — обе сущности
// управляются прямо в карточке клуба, чтобы была видна иерархия «клуб → филиалы +
// сотрудники». Каждая карточка: тариф, статус (active/frozen), trial_until,
// kill-switch («Заморозить» блокирует доступ всему персоналу клуба мгновенно) и
// два раскрывающихся блока: филиалы (добавление/переименование/удаление) и
// сотрудники (список, приглашение в клуб, удаление, «войти как»).
// Пагинация клубов курсором (limit=50); филиалы и сотрудники грузятся целиком
// (GET /api/admin/branches и /api/admin/staff отдают суперадмину всё, каждая строка
// несёт club_id) и группируются по клубу.
import { useEffect, useState } from 'react'
import { api } from '../lib/api.js'
import { Button } from '../components/ui.jsx'

import { confirmSheet } from '../sheets.jsx'

const fmt = ts => ts ? new Date(ts).toLocaleString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'
const PLAN = { trial: 'Trial', start: 'Старт', network: 'Сеть', selfhosted: 'SelfHosted' }
const ROLE_LABELS = { superadmin: 'Владелец платформы', owner: 'Владелец клуба', manager: 'Менеджер', trainer: 'Тренер', operator: 'Оператор' }
const roleLabel = r => ROLE_LABELS[r] || r
const staffRoles = ['manager', 'trainer', 'operator']

export default function Clubs() {
  const [clubs, setClubs] = useState([])
  const [branches, setBranches] = useState([])
  const [staff, setStaff] = useState([])
  const [before, setBefore] = useState(null)
  const [hasMore, setHasMore] = useState(false)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState('')
  const [budgetMsg, setBudgetMsg] = useState('')
  const [branchDrafts, setBranchDrafts] = useState({})   // [clubId] = имя нового филиала
  const [staffDrafts, setStaffDrafts] = useState({})     // [clubId] = {name, role, branch}
  const [expanded, setExpanded] = useState({})           // [clubId] = 'branches' | 'staff' | null

  const loadBranches = () =>
    api('/api/admin/branches').then(d => setBranches(d.branches || [])).catch(() => {})
  const loadStaff = () =>
    api('/api/admin/staff').then(d => setStaff(d.admins || [])).catch(() => {})
  const load = (prefix) => {
    const q = prefix ? `?limit=50&before=${encodeURIComponent(prefix)}` : '?limit=50'
    api('/api/admin/clubs' + q).then(d => {
      setClubs(d.clubs || [])
      setBefore(d.has_more && (d.clubs || []).length ? (d.clubs[d.clubs.length - 1]).id : null)
      setHasMore(!!d.has_more)
    }).catch(e => setErr(e.message))
  }
  useEffect(() => { load(''); loadBranches(); loadStaff() }, [])

  const clubBranches = cid => (branches || []).filter(b => b.club_id === cid)
  const clubStaff = cid => (staff || []).filter(s => s.club_id === cid && s.role !== 'superadmin')
  const setDraft = (map, setter, cid, v) => setter(d => ({ ...d, [cid]: v }))
  const setBranchDraft = (cid, v) => setDraft(branchDrafts, setBranchDrafts, cid, v)
  const setStaffDraft = (cid, v) => setDraft(staffDrafts, setStaffDrafts, cid, v)
  const toggleSection = (cid, sec) => setExpanded(e => ({ ...e, [cid]: e[cid] === sec ? null : sec }))

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

  // ---- branches ----
  const addBranch = (c) => {
    const name = (branchDrafts[c.id] || '').trim()
    if (!name) return
    api('/api/admin/branches/save', { method: 'POST', body: JSON.stringify({ name, club_id: c.id }) })
      .then(() => { setBranchDraft(c.id, ''); return loadBranches() }).catch(e => setErr(e.message))
  }
  const renameBranch = (c, b) => {
    const n = window.prompt('Новое название филиала:', b.name)
    if (!n || !n.trim()) return
    api('/api/admin/branches/save', { method: 'POST', body: JSON.stringify({ id: b.id, name: n.trim(), club_id: c.id }) })
      .then(loadBranches).catch(e => setErr(e.message))
  }
  const delBranch = (c, b) => {
    if (!window.confirm(`Удалить филиал «${b.name}» клуба «${c.name}»? Филиал скроется из списков; правила лояльности, сотрудники и история по нему останутся в системе.`)) return
    api('/api/admin/branches/delete', { method: 'POST', body: JSON.stringify({ id: b.id }) })
      .then(loadBranches).catch(e => setErr(e.message))
  }

  // ---- staff ----
  const makeInvite = (c) => {
    const d = staffDrafts[c.id] || {}
    if (!(d.name || '').trim()) return
    api('/api/admin/staff/invite', { method: 'POST', body: JSON.stringify({ name: d.name.trim(), role: d.role || 'trainer', branch_key: d.branch || null, club_id: c.id }) })
      .then(res => {
        const link = location.origin + '/admin/register?code=' + res.invite.code
        window.prompt(`Код для «${d.name.trim()}»: ${res.invite.code}\nСсылка для входа сотрудника:`, link)
        setStaffDraft(c.id, { name: '', role: 'trainer', branch: '' })
        return loadStaff()
      }).catch(e => setErr(e.message))
  }
  const impersonate = s => api('/api/admin/impersonate', { method: 'POST', body: JSON.stringify({ kind: 'staff', id: s.id }) })
    .then(d => { location.href = d.redirect }).catch(e => setErr(e.message))
  const deleteStaff = (c, s) => confirmSheet({
    title: 'Удалить сотрудника ' + s.name + '?',
    message: 'Профиль скроется из списков, вход будет заблокирован. Данные и статистика останутся — восстановить можно в любой момент.',
    confirmText: 'Удалить', danger: true,
    onConfirm: () => api('/api/admin/staff/delete', { method: 'POST', body: JSON.stringify({ id: s.id }) }).then(loadStaff).catch(e => setErr(e.message))
  })

  const BranchBlock = ({ c }) => {
    const bs = clubBranches(c.id)
    return <div>
      {bs.map(b => <div key={b.id} className="row" style={{ gap: 8, marginBottom: 6 }}>
        <div className="grow ss">{b.name} <span className="dim">({b.id})</span></div>
        <button className="btn xs plain" onClick={() => renameBranch(c, b)}>Переименовать</button>
        <button className="btn xs plain danger" onClick={() => delBranch(c, b)}>Удалить</button>
      </div>)}
      {!bs.length && <div className="small dim" style={{ marginBottom: 6 }}>У клуба пока нет филиалов.</div>}
      <div className="row" style={{ gap: 8 }}>
        <input className="field" value={branchDrafts[c.id] || ''} onChange={e => setBranchDraft(c.id, e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') addBranch(c) }} placeholder="Название филиала, например «Филиал на Ленина»" />
        <Button size="sm" variant="primary" onClick={() => addBranch(c)} disabled={!(branchDrafts[c.id] || '').trim()}>Добавить филиал</Button>
      </div>
    </div>
  }

  const StaffBlock = ({ c }) => {
    const ss = clubStaff(c.id)
    const d = staffDrafts[c.id] || {}
    const cbrs = clubBranches(c.id)
    return <div>
      {ss.map(s => <div key={s.id} className="row" style={{ gap: 8, marginBottom: 6 }}>
        <div className="grow ss">{s.name} {s.disabled && <span className="tag" style={{ color: 'var(--red)' }}>off</span>} <span className="dim">· {roleLabel(s.role)} · {s.passkeys} passkey</span></div>
        <button className="btn xs plain" onClick={() => impersonate(s)} disabled={s.disabled}>Войти как</button>
        <button className="btn xs plain danger" onClick={() => deleteStaff(c, s)}>Удалить</button>
      </div>)}
      {!ss.length && <div className="small dim" style={{ marginBottom: 6 }}>В клубе пока нет сотрудников.</div>}
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <input className="field" style={{ flex: '1 1 120px' }} value={d.name || ''} onChange={e => setStaffDraft(c.id, { ...d, name: e.target.value })} placeholder="Имя сотрудника" />
        <select className="field" style={{ flex: '0 0 auto' }} value={d.role || 'trainer'} onChange={e => setStaffDraft(c.id, { ...d, role: e.target.value })}>{staffRoles.map(r => <option key={r} value={r}>{roleLabel(r)}</option>)}</select>
        <select className="field" style={{ flex: '0 0 auto' }} value={d.branch || ''} onChange={e => setStaffDraft(c.id, { ...d, branch: e.target.value })} title="Филиал"><option value="">Филиал: все</option>{cbrs.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
        <Button size="sm" variant="primary" onClick={() => makeInvite(c)} disabled={!(d.name || '').trim()}>Пригласить</Button>
      </div>
      <div className="small dim" style={{ marginTop: 6 }}>Приглашённый сотрудник пройдёт по invite-коду и создаст свой admin passkey. Филиал «все» = сотрудник клуба (видит аналитику всех залов клуба).</div>
    </div>
  }

  return <div>
    <div className="row between" style={{ marginBottom: 10 }}>
      <div className="small dim">Арендаторы платформы (clubs): внутри каждого — его филиалы и сотрудники. Заморозка мгновенно блокирует доступ всего персонала клуба.</div>
      <Button size="sm" variant="ghost" onClick={resetBudget}>Сбросить бюджет писем</Button>
    </div>
    {budgetMsg && <div className="small" style={{ color: 'var(--green)', marginBottom: 8 }}>{budgetMsg}</div>}
    {err && <div className="small" style={{ color: 'var(--red)', marginBottom: 8 }}>{err}</div>}
    <div className="list">
      {(clubs || []).map(c => {
        const sec = expanded[c.id] || null
        const nb = clubBranches(c.id).length
        const ns = clubStaff(c.id).length
        return <div className="item" key={c.id} style={{ alignItems: 'flex-start', flexDirection: 'column' }}>
          <div style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8 }}>
            <div className="grow">
              <div className="tt">{c.name} <span className="tag" style={{ color: c.status === 'frozen' ? 'var(--red)' : 'var(--green)' }}>{c.status === 'frozen' ? 'заморожен' : 'активен'}</span></div>
              <div className="ss dim">{PLAN[c.plan] || c.plan}{c.plan === 'trial' && c.trial_until ? ' · до ' + fmt(c.trial_until) : ''}{c.owner_email ? ' · ' + c.owner_email : ''} · филиалов: {nb} · сотрудников: {ns}</div>
            </div>
            <Button size="xs" variant="ghost" onClick={() => toggleSection(c.id, 'branches')}>{sec === 'branches' ? 'Скрыть филиалы' : `Филиалы (${nb})`}</Button>
            <Button size="xs" variant="ghost" onClick={() => toggleSection(c.id, 'staff')}>{sec === 'staff' ? 'Скрыть сотрудников' : `Сотрудники (${ns})`}</Button>
            <Button size="xs" variant={c.status === 'frozen' ? 'primary' : 'danger'} onClick={() => toggle(c)} disabled={busy === c.id}>
              {c.status === 'frozen' ? 'Разморозить' : 'Заморозить'}
            </Button>
          </div>
          {sec && <div style={{ width: '100%', marginTop: 10, paddingTop: 10, borderTop: 'var(--hair) solid var(--sep-op)' }}>
            {sec === 'branches' ? <BranchBlock c={c} /> : <StaffBlock c={c} />}
          </div>}
        </div>
      })}
      {!clubs.length && !err && <div className="small dim">Клубов пока нет.</div>}
    </div>
    {hasMore && <div className="row" style={{ justifyContent: 'center', marginTop: 10 }}><Button size="sm" variant="ghost" onClick={() => load(before)}>Показать ещё</Button></div>}
  </div>
}
