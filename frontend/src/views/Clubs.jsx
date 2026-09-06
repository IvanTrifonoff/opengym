// frontend/src/views/Clubs.jsx — «Клубы»: единая панель владельца платформы.
// Только для superadmin. Внутри каждой карточки клуба — три блока:
//   · Лояльность — правила начисления баллов ЭТОГО клуба (список, добавить,
//     изменить, удалить; создаются с club_id клуба, их видят сотрудники клуба);
//   · Филиалы — добавление/переименование/удаление залов клуба;
//   · Сотрудники — список, приглашение в клуб, «войти как», удаление.
// Вкладки «Филиалы», «Сотрудники» и «Loyalty» у суперадмина убраны (v1.4.5-1.4.6),
// «Клубы» вынесены в центр меню. Кнопка «Создать клуб» — новый арендатор
// (активный клуб + owner-инвайт для владельца).
// Пагинация клубов курсором (limit=50); филиалы/сотрудники/правила грузятся
// целиком и группируются по club_id.
import { useEffect, useState } from 'react'
import { api } from '../lib/api.js'
import { Button } from '../components/ui.jsx'
import Icon from '../components/Icon.jsx'
import { confirmSheet } from '../sheets.jsx'

const fmt = ts => ts ? new Date(ts).toLocaleString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'
const PLAN = { trial: 'Trial', start: 'Старт', network: 'Сеть', selfhosted: 'SelfHosted' }
const ROLE_LABELS = { superadmin: 'Владелец платформы', owner: 'Владелец клуба', manager: 'Менеджер', trainer: 'Тренер', operator: 'Оператор' }
const roleLabel = r => ROLE_LABELS[r] || r
const staffRoles = ['manager', 'trainer', 'operator']
const EVENT_TYPES = [
  ['visit', 'Посещение'],
  ['workout_completed', 'Завершение тренировки'],
  ['streak', 'Серия тренировок'],
  ['referral', 'Реферал'],
  ['manual', 'Ручное событие']
]
const blankRule = () => ({ id: null, name: '', event_type: 'visit', enabled: true, points: 10, club_id: '' })

export default function Clubs() {
  const [clubs, setClubs] = useState([])
  const [branches, setBranches] = useState([])
  const [staff, setStaff] = useState([])
  const [rules, setRules] = useState([])
  const [before, setBefore] = useState(null)
  const [hasMore, setHasMore] = useState(false)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState('')
  const [budgetMsg, setBudgetMsg] = useState('')
  const [branchDrafts, setBranchDrafts] = useState({})     // [clubId] = имя нового филиала
  const [staffDrafts, setStaffDrafts] = useState({})       // [clubId] = {name, role, branch}
  const [ruleEditors, setRuleEditors] = useState({})       // [clubId] = правило-черновик | null
  const [ruleDrafts, setRuleDrafts] = useState({})         // [clubId] = {name, event_type, points}
  const [expanded, setExpanded] = useState({})             // [clubId] = 'loyalty' | 'branches' | 'staff' | null
  const [newClub, setNewClub] = useState(null)             // {name, ownerName} — форма «Создать клуб»
  const [created, setCreated] = useState(null)             // {club, invite} — результат создания

  const loadBranches = () =>
    api('/api/admin/branches').then(d => setBranches(d.branches || [])).catch(() => {})
  const loadStaff = () =>
    api('/api/admin/staff').then(d => setStaff(d.admins || [])).catch(() => {})
  const loadRules = () =>
    api('/api/admin/loyalty/rules').then(d => setRules(d.rules || [])).catch(() => {})
  const load = (prefix) => {
    const q = prefix ? `?limit=50&before=${encodeURIComponent(prefix)}` : '?limit=50'
    api('/api/admin/clubs' + q).then(d => {
      setClubs(d.clubs || [])
      setBefore(d.has_more && (d.clubs || []).length ? (d.clubs[d.clubs.length - 1]).id : null)
      setHasMore(!!d.has_more)
    }).catch(e => setErr(e.message))
  }
  useEffect(() => { load(''); loadBranches(); loadStaff(); loadRules() }, [])

  const clubBranches = cid => (branches || []).filter(b => b.club_id === cid)
  const clubStaff = cid => (staff || []).filter(s => s.club_id === cid && s.role !== 'superadmin')
  const clubRules = cid => (rules || []).filter(r => r.club_id === cid)
  const setDraft = (map, setter, cid, v) => setter(d => ({ ...d, [cid]: v }))
  const setBranchDraft = (cid, v) => setDraft(branchDrafts, setBranchDrafts, cid, v)
  const setStaffDraft = (cid, v) => setDraft(staffDrafts, setStaffDrafts, cid, v)
  const setRuleDraft = (cid, v) => setDraft(ruleDrafts, setRuleDrafts, cid, v)
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
  const createClub = () => {
    const name = (newClub.name || '').trim()
    if (!name) return
    api('/api/admin/clubs/create', { method: 'POST', body: JSON.stringify({ name, ownerName: (newClub.ownerName || '').trim() }) })
      .then(d => {
        setCreated(d.club)
        setNewClub(null)
        load('')
      }).catch(e => setErr(e.message))
  }

  // ---- loyalty rules (per club) ----
  const openRuleEditor = (c, rule) => {
    setRuleDraft(c.id, rule
      ? { id: rule.id, name: rule.name, event_type: rule.event_type, enabled: rule.enabled !== false, points: (rule.actions || []).find(a => a.type === 'points')?.amount ?? 10 }
      : { ...blankRule(), club_id: c.id })
    setRuleEditors(r => ({ ...r, [c.id]: true }))
  }
  const saveRule = (c) => {
    const d = ruleDrafts[c.id] || {}
    if (!(d.name || '').trim()) return
    const payload = {
      id: d.id || null, name: d.name.trim(), event_type: d.event_type, enabled: d.enabled !== false,
      club_id: c.id,
      actions: [{ type: 'points', amount: Math.max(0, +(d.points || 0)) }],
      conditions: {}, limits: {}
    }
    api('/api/admin/loyalty/rules/save', { method: 'POST', body: JSON.stringify(payload) })
      .then(() => { setRuleEditors(r => ({ ...r, [c.id]: null })); return loadRules() })
      .catch(e => setErr(e.message))
  }
  const deleteRule = (c, rule) => confirmSheet({
    title: 'Удалить правило «' + rule.name + '»?',
    message: 'Правило перестанет начислять баллы. История начислений сохранится.',
    confirmText: 'Удалить', danger: true,
    onConfirm: () => api('/api/admin/loyalty/rules/delete', { method: 'POST', body: JSON.stringify({ id: rule.id }) }).then(loadRules).catch(e => setErr(e.message))
  })

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

  const LoyaltyBlock = ({ c }) => {
    const rs = clubRules(c.id)
    const editing = !!ruleEditors[c.id]
    const d = ruleDrafts[c.id] || blankRule()
    return <div>
      {rs.map(rule => <div key={rule.id} className="row" style={{ gap: 8, marginBottom: 6 }}>
        <div className="grow ss">{rule.name} {rule.enabled === false && <span className="tag">off</span>} <span className="dim">· {(EVENT_TYPES.find(([v]) => v === rule.event_type) || [])[1] || rule.event_type} · +{(rule.actions || []).find(a => a.type === 'points')?.amount ?? 0} баллов</span></div>
        <button className="btn xs plain" onClick={() => openRuleEditor(c, rule)}>Изменить</button>
        <button className="btn xs plain danger" onClick={() => deleteRule(c, rule)}>Удалить</button>
      </div>)}
      {!rs.length && !editing && <div className="small dim" style={{ marginBottom: 6 }}>Правил лояльности у клуба пока нет.</div>}
      {editing && <div className="card" style={{ padding: 10, marginBottom: 8 }}>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <input className="field" style={{ flex: '1 1 140px' }} value={d.name || ''} onChange={e => setRuleDraft(c.id, { ...d, name: e.target.value })} placeholder="Название правила" />
          <select className="field" style={{ flex: '0 0 auto' }} value={d.event_type || 'visit'} onChange={e => setRuleDraft(c.id, { ...d, event_type: e.target.value })}>{EVENT_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          <input className="field" style={{ flex: '0 0 90px' }} type="number" min="0" value={d.points} onChange={e => setRuleDraft(c.id, { ...d, points: e.target.value })} placeholder="Баллы" />
        </div>
        <div className="row" style={{ gap: 8, marginTop: 8 }}>
          <Button size="sm" variant="primary" onClick={() => saveRule(c)} disabled={!(d.name || '').trim()}>Сохранить</Button>
          <Button size="sm" variant="ghost" onClick={() => setRuleEditors(r => ({ ...r, [c.id]: null }))}>Отмена</Button>
        </div>
        <div className="small dim" style={{ marginTop: 6 }}>Правило привязано к клубу — его видят и применяют только сотрудники этого клуба.</div>
      </div>}
      {!editing && <Button size="sm" variant="ghost" onClick={() => openRuleEditor(c, null)}>+ Правило</Button>}
    </div>
  }

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
      <div className="small dim">Арендаторы платформы (clubs): внутри каждого — лояльность, филиалы и сотрудники. Заморозка мгновенно блокирует доступ всего персонала клуба.</div>
      <div className="row" style={{ gap: 6 }}>
        <Button size="sm" variant="ghost" onClick={resetBudget}>Сбросить бюджет писем</Button>
        <Button size="sm" variant="primary" onClick={() => { setNewClub({ name: '', ownerName: '' }); setCreated(null) }}>+ Создать клуб</Button>
      </div>
    </div>
    {budgetMsg && <div className="small" style={{ color: 'var(--green)', marginBottom: 8 }}>{budgetMsg}</div>}
    {err && <div className="small" style={{ color: 'var(--red)', marginBottom: 8 }}>{err}</div>}

    {newClub && <div className="card" style={{ borderColor: 'var(--acc)', marginBottom: 12 }}>
      <div className="row between"><h3 style={{ marginTop: 0 }}>Новый клуб</h3><button className="iconbtn" onClick={() => setNewClub(null)} aria-label="Закрыть"><Icon name="xmark" /></button></div>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <input className="field" style={{ flex: '1 1 160px' }} value={newClub.name} onChange={e => setNewClub({ ...newClub, name: e.target.value })} placeholder="Название клуба, например «ИмпульС»" />
        <input className="field" style={{ flex: '1 1 160px' }} value={newClub.ownerName} onChange={e => setNewClub({ ...newClub, ownerName: e.target.value })} placeholder="Имя владельца (необязательно)" />
        <Button size="sm" variant="primary" onClick={createClub} disabled={!newClub.name.trim()}>Создать</Button>
      </div>
      {created && <div className="small" style={{ marginTop: 10 }}>
        Клуб <b>{created.name}</b> создан. Код владельца: <b style={{ letterSpacing: '.1em' }}>{created.invite.code}</b><br />
        Ссылка для владельца: <span className="dim">{location.origin}/admin/register?code={created.invite.code}</span>{' '}
        <button className="btn xs plain" onClick={() => navigator.clipboard?.writeText(location.origin + '/admin/register?code=' + created.invite.code)}>Копировать</button>
      </div>}
    </div>}

    <div className="list">
      {(clubs || []).map(c => {
        const sec = expanded[c.id] || null
        const nb = clubBranches(c.id).length
        const ns = clubStaff(c.id).length
        const nr = clubRules(c.id).length
        return <div className="item" key={c.id} style={{ alignItems: 'flex-start', flexDirection: 'column' }}>
          <div style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8 }}>
            <Icon name="grid" size={22} style={{ color: 'var(--acc)', flex: 'none' }} />
            <div className="grow">
              <div className="tt">{c.name} <span className="tag" style={{ color: c.status === 'frozen' ? 'var(--red)' : 'var(--green)' }}>{c.status === 'frozen' ? 'заморожен' : 'активен'}</span></div>
              <div className="ss dim">{PLAN[c.plan] || c.plan}{c.plan === 'trial' && c.trial_until ? ' · до ' + fmt(c.trial_until) : ''}{c.owner_email ? ' · ' + c.owner_email : ''} · правил: {nr} · филиалов: {nb} · сотрудников: {ns}</div>
            </div>
            <Button size="xs" variant="ghost" onClick={() => toggleSection(c.id, 'loyalty')}>{sec === 'loyalty' ? 'Скрыть лояльность' : `Лояльность (${nr})`}</Button>
            <Button size="xs" variant="ghost" onClick={() => toggleSection(c.id, 'branches')}>{sec === 'branches' ? 'Скрыть филиалы' : `Филиалы (${nb})`}</Button>
            <Button size="xs" variant="ghost" onClick={() => toggleSection(c.id, 'staff')}>{sec === 'staff' ? 'Скрыть сотрудников' : `Сотрудники (${ns})`}</Button>
            <Button size="xs" variant={c.status === 'frozen' ? 'primary' : 'danger'} onClick={() => toggle(c)} disabled={busy === c.id}>
              {c.status === 'frozen' ? 'Разморозить' : 'Заморозить'}
            </Button>
          </div>
          {sec && <div style={{ width: '100%', marginTop: 10, paddingTop: 10, borderTop: 'var(--hair) solid var(--sep-op)' }}>
            {sec === 'loyalty' ? <LoyaltyBlock c={c} /> : sec === 'branches' ? <BranchBlock c={c} /> : <StaffBlock c={c} />}
          </div>}
        </div>
      })}
      {!clubs.length && !err && <div className="small dim">Клубов пока нет — создайте первый.</div>}
    </div>
    {hasMore && <div className="row" style={{ justifyContent: 'center', marginTop: 10 }}><Button size="sm" variant="ghost" onClick={() => load(before)}>Показать ещё</Button></div>}
  </div>
}
