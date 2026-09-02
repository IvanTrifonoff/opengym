import { Component, useEffect, useState } from 'react'
import { Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { setLang, detectBrowserLang, useLang } from '../lib/i18n.js'
import { api, passkeyAdminLogin, passkeyAdminRegister } from '../lib/api.js'
import Icon from '../components/Icon.jsx'
import NavBar from '../components/NavBar.jsx'
import { Button, Switch } from '../components/ui.jsx'
import { confirmSheet } from '../sheets.jsx'
import { loyaltyHelpSheet } from '../components/LoyaltyHelp.jsx'
import Analytics from './Analytics.jsx'
import Trainer from './Trainer.jsx'
import TrainerNotifications from './TrainerNotifications.jsx'
import AdminHelp from './AdminHelp.jsx'
import AdminLeads from './AdminLeads.jsx'
import Modals from '../components/Modals.jsx'
import Toast from '../components/Toast.jsx'

const roles = ['owner', 'manager', 'trainer', 'operator']
const eventTypes = [
  ['visit', 'Посещение'],
  ['workout_completed', 'Завершение тренировки'],
  ['streak', 'Серия тренировок'],
  ['referral', 'Реферал'],
  ['manual', 'Ручное событие']
]

const emptyRule = () => ({
  id: null, name: '', event_type: 'visit', enabled: true,
  branch_key: '', points: 10, achievement: '', reward: '', notification: '',
  limit_period: 'day', limit_max: 1
})

function ErrorLine({ error }) { return error ? <div className="small" style={{ color: 'var(--red)', marginTop: 8 }}>{error}</div> : null }

function AdminLogin({ onLogin }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const login = async () => {
    setBusy(true); setError('')
    try { onLogin(await passkeyAdminLogin()) }
    catch (e) { setError(e.message || 'Не удалось войти'); setBusy(false) }
  }
  return <div className="narrow" style={{ paddingTop: '18vh' }}>
    <div className="card" style={{ textAlign: 'center', padding: '28px 22px' }}>
      <div style={{ color: 'var(--acc)', fontSize: 36, marginBottom: 8 }}><Icon name="wrench" /></div>
      <h1 style={{ margin: 0 }}>ИмпульС</h1>
      <p className="dim" style={{ margin: '8px 0 22px' }}>Управление сетью, сотрудниками и программой лояльности</p>
      <Button variant="primary" onClick={login} disabled={busy}>{busy ? 'Ожидание passkey…' : 'Войти как сотрудник'}</Button>
      <ErrorLine error={error} />
      <div className="small dim" style={{ marginTop: 18 }}>Используется отдельный admin passkey. Пароли не хранятся.</div>
    </div>
  </div>
}

function AdminRegister() {
  const loc = useLocation(); const nav = useNavigate()
  const initial = new URLSearchParams(loc.search).get('code') || ''
  const [code, setCode] = useState(initial); const [busy, setBusy] = useState(false); const [error, setError] = useState('')
  const register = async () => {
    if (!code.trim()) { setError('Введите invite-код'); return }
    setBusy(true); setError('')
    try { await passkeyAdminRegister(code.trim()); nav('/admin', { replace: true }) }
    catch (e) { setError(e.message || 'Не удалось зарегистрировать passkey'); setBusy(false) }
  }
  return <div className="narrow" style={{ paddingTop: '15vh' }}>
    <div className="card">
      <div className="row" style={{ gap: 8 }}><Icon name="key" style={{ color: 'var(--acc)' }} /><h1 style={{ margin: 0 }}>Регистрация сотрудника</h1></div>
      <p className="dim">Введите код, который выдал владелец или менеджер сети, затем создайте passkey.</p>
      <input className="field" value={code} onChange={e => setCode(e.target.value)} placeholder="Invite-код" autoCapitalize="characters" />
      <Button variant="primary" style={{ marginTop: 12 }} onClick={register} disabled={busy}>{busy ? 'Создание passkey…' : 'Создать admin passkey'}</Button>
      <ErrorLine error={error} />
      {error && <Button variant="ghost" size="sm" style={{ marginTop: 10 }} onClick={() => nav('/admin')}>Войти как сотрудник</Button>}
    </div>
  </div>
}

function RuleEditor({ value, onSave, onCancel, canEdit }) {
  const [form, setForm] = useState(() => value ? ruleToForm(value) : emptyRule())
  const set = (key, next) => setForm(prev => ({ ...prev, [key]: next }))
  const template = type => {
    const t = {
      visit: { name: 'Ежедневное посещение', event_type: 'visit', points: 10, limit_period: 'day', limit_max: 1 },
      workout: { name: 'Завершённая тренировка', event_type: 'workout_completed', points: 25, limit_period: 'day', limit_max: 2 },
      streak: { name: 'Недельная серия', event_type: 'streak', points: 100, achievement: 'weekly-streak', limit_period: 'week', limit_max: 1 },
      referral: { name: 'Новый реферал', event_type: 'referral', points: 200, reward: 'referral-bonus', limit_period: 'month', limit_max: 10 }
    }[type]
    setForm({ ...emptyRule(), ...t })
  }
  const save = () => {
    const actions = []
    if (+form.points > 0) actions.push({ type: 'points', amount: +form.points })
    if (form.achievement.trim()) actions.push({ type: 'achievement', key: form.achievement.trim() })
    if (form.reward.trim()) actions.push({ type: 'reward', key: form.reward.trim() })
    if (form.notification.trim()) actions.push({ type: 'notification', message: form.notification.trim() })
    onSave({ id: form.id, name: form.name, event_type: form.event_type, enabled: form.enabled,
      conditions: form.branch_key ? { branch_key: form.branch_key.trim() } : {}, actions,
      limits: form.limit_max > 0 ? { period: form.limit_period, max_per_period: +form.limit_max } : {} })
  }
  return <div className="card" style={{ borderColor: 'var(--acc)' }}>
    <div className="row between"><h2 style={{ margin: 0 }}>{form.id ? 'Изменить правило' : 'Новое правило'}</h2><button className="iconbtn" onClick={onCancel}><Icon name="xmark" /></button></div>
    <div className="small dim" style={{ margin: '6px 0 12px' }}>Шаблон заполняет форму, все поля можно изменить.</div>
    <div className="row" style={{ flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
      {[['visit', 'Посещение'], ['workout', 'Тренировка'], ['streak', 'Streak'], ['referral', 'Реферал']].map(([k, label]) => <button key={k} className="btn xs tinted" onClick={() => template(k)}>{label}</button>)}
    </div>
    <label className="small dim">Название<input className="field" value={form.name} onChange={e => set('name', e.target.value)} placeholder="Например: баллы за первое посещение" /></label>
    <label className="small dim">Событие<select className="field" value={form.event_type} onChange={e => set('event_type', e.target.value)}>{eventTypes.map(([v, label]) => <option key={v} value={v}>{label}</option>)}</select></label>
    <label className="small dim">Филиал (пусто — все филиалы)<input className="field" value={form.branch_key} onChange={e => set('branch_key', e.target.value)} placeholder="branch-1" /></label>
    <div className="row" style={{ gap: 10 }}>
      <label className="small dim" style={{ flex: 1 }}>Баллы<input className="field" type="number" min="0" value={form.points} onChange={e => set('points', e.target.value)} /></label>
      <label className="small dim" style={{ flex: 1 }}>Лимит<select className="field" value={form.limit_period} onChange={e => set('limit_period', e.target.value)}><option value="day">в день</option><option value="week">в неделю</option><option value="month">в месяц</option></select></label>
      <label className="small dim" style={{ flex: 1 }}>Раз максимум<input className="field" type="number" min="0" value={form.limit_max} onChange={e => set('limit_max', e.target.value)} /></label>
    </div>
    <label className="small dim">Ключ достижения<input className="field" value={form.achievement} onChange={e => set('achievement', e.target.value)} placeholder="weekly-streak" /></label>
    <label className="small dim">Ключ награды<input className="field" value={form.reward} onChange={e => set('reward', e.target.value)} placeholder="free-session" /></label>
    <label className="small dim">Уведомление<input className="field" value={form.notification} onChange={e => set('notification', e.target.value)} placeholder="Вы получили бонус за посещение" /></label>
    <div className="small dim" style={{ marginBottom: 12 }}>Если уведомление не задано, при начислении баллов спортсмен получит автоматический push (например «+10 баллов — Ежедневное посещение»).</div>
    <div className="row between" style={{ margin: '12px 0' }}><span>Правило включено</span><Switch checked={form.enabled} onChange={v => set('enabled', v)} /></div>
    {canEdit && <div className="row" style={{ gap: 8 }}><Button variant="primary" onClick={save}>Сохранить</Button><Button variant="ghost" onClick={onCancel}>Отмена</Button></div>}
  </div>
}

function ruleToForm(rule) {
  const actions = rule.actions || []; const points = actions.find(a => a.type === 'points')
  return { id: rule.id, name: rule.name, event_type: rule.event_type, enabled: rule.enabled,
    branch_key: rule.conditions?.branch_key || '', points: points?.amount || 0,
    achievement: actions.find(a => a.type === 'achievement')?.key || '', reward: actions.find(a => a.type === 'reward')?.key || '',
    notification: actions.find(a => a.type === 'notification')?.message || '',
    limit_period: rule.limits?.period || 'day', limit_max: rule.limits?.max_per_period || 0 }
}

function Loyalty({ canEdit }) {
  const [rules, setRules] = useState([]); const [editing, setEditing] = useState(null); const [error, setError] = useState('')
  const load = () => api('/api/admin/loyalty/rules').then(d => setRules(d.rules || [])).catch(e => setError(e.message))
  useEffect(() => { load(); }, [])
  const save = data => api('/api/admin/loyalty/rules/save', { method: 'POST', body: JSON.stringify(data) }).then(() => { setEditing(null); load() }).catch(e => setError(e.message))
  const remove = id => api('/api/admin/loyalty/rules/delete', { method: 'POST', body: JSON.stringify({ id }) }).then(load).catch(e => setError(e.message))
  return <>
    <div className="row between" style={{ marginBottom: 10 }}><div><h2 style={{ margin: 0 }}>Программа лояльности</h2><div className="sub">Правила применяются к событиям без изменения кода</div></div><div className="row" style={{ gap: 6 }}><button className="btn xs plain" onClick={loyaltyHelpSheet}><Icon name="info" style={{ fontSize: 13, verticalAlign: '-2px', marginRight: 4 }} />Инструкция</button>{canEdit && <Button variant="primary" size="sm" icon="plus" onClick={() => setEditing({})}>Правило</Button>}</div></div>
    {editing && <RuleEditor value={editing.id ? editing : null} onSave={save} onCancel={() => setEditing(null)} canEdit={canEdit} />}
    <ErrorLine error={error} />
    {!rules.length && !editing && <div className="card empty">Правил пока нет. Создайте первое из шаблона «Посещение».</div>}
    <div className="list">{rules.map(rule => <div className="item" key={rule.id}>
      <div className="grow"><div className="tt">{rule.name} {!rule.enabled && <span className="tag" style={{ marginLeft: 5 }}>off</span>}</div>
        <div className="ss">{eventTypes.find(([v]) => v === rule.event_type)?.[1] || rule.event_type} · {(rule.actions || []).map(a => a.type === 'points' ? '+' + a.amount + ' баллов' : a.type).join(', ') || 'без действий'}</div></div>
      {canEdit && <><button className="btn xs plain" onClick={() => setEditing(rule)}>Изменить</button><button className="iconbtn" onClick={() => remove(rule.id)} aria-label="Удалить"><Icon name="trash" /></button></>}
    </div>)}</div>
  </>
}

const rewardKinds = [['discount', 'Скидка'], ['training', 'Тренировка'], ['merch', 'Товар/мерч'], ['guest_pass', 'Гостевой пропуск'], ['custom', 'Произвольная']]
const blankReward = () => ({ id: null, name: '', description: '', kind: 'custom', cost: 100, delivery_mode: 'staff', active: true, stock: '' })

function Rewards({ canEdit }) {
  const [rewards, setRewards] = useState([]); const [redemptions, setRedemptions] = useState([]); const [form, setForm] = useState(null); const [error, setError] = useState('')
  const load = () => Promise.all([api('/api/admin/loyalty/rewards'), api('/api/admin/loyalty/redemptions')]).then(([r, d]) => { setRewards(r.rewards || []); setRedemptions(d.redemptions || []) }).catch(e => setError(e.message))
  useEffect(() => { load(); }, [])
  const set = (key, value) => setForm(prev => ({ ...prev, [key]: value }))
  const save = () => api('/api/admin/loyalty/rewards/save', { method: 'POST', body: JSON.stringify(form) }).then(() => { setForm(null); load() }).catch(e => setError(e.message))
  const remove = id => api('/api/admin/loyalty/rewards/delete', { method: 'POST', body: JSON.stringify({ id }) }).then(load).catch(e => setError(e.message))
  const closeRequest = (id, status) => api('/api/admin/loyalty/redemptions/update', { method: 'POST', body: JSON.stringify({ id, status }) }).then(load).catch(e => setError(e.message))
  return <>
    <div className="row between" style={{ marginBottom: 10 }}><div><h2 style={{ margin: 0 }}>Награды</h2><div className="sub">Каталог, стоимость и способ выдачи</div></div><div className="row" style={{ gap: 6 }}><button className="btn xs plain" onClick={loyaltyHelpSheet}><Icon name="info" style={{ fontSize: 13, verticalAlign: '-2px', marginRight: 4 }} />Инструкция</button>{canEdit && <Button variant="primary" size="sm" icon="plus" onClick={() => setForm(blankReward())}>Награда</Button>}</div></div>
    {form && <div className="card" style={{ borderColor: 'var(--acc)' }}><div className="row between"><h3 style={{ marginTop: 0 }}>{form.id ? 'Изменить награду' : 'Новая награда'}</h3><button className="iconbtn" onClick={() => setForm(null)}><Icon name="xmark" /></button></div><input className="field" placeholder="Название" value={form.name} onChange={e => set('name', e.target.value)} /><textarea className="field area" placeholder="Описание и инструкция сотруднику" value={form.description} onChange={e => set('description', e.target.value)} /><div className="row" style={{ gap: 8 }}><select className="field" value={form.kind} onChange={e => set('kind', e.target.value)}>{rewardKinds.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select><input className="field" type="number" min="1" value={form.cost} onChange={e => set('cost', e.target.value)} placeholder="Баллы" /><input className="field" type="number" min="0" value={form.stock} onChange={e => set('stock', e.target.value)} placeholder="Запас (пусто = безлимит)" /></div><select className="field" value={form.delivery_mode} onChange={e => set('delivery_mode', e.target.value)}><option value="staff">Подтверждение сотрудником</option><option value="auto_code">Автоматический одноразовый код</option></select><div className="row" style={{ gap: 8, marginTop: 10 }}><Button variant="primary" onClick={save} disabled={!form.name.trim()}>Сохранить</Button><Button variant="ghost" onClick={() => setForm(null)}>Отмена</Button></div></div>}
    <ErrorLine error={error} />
    <div className="list">{rewards.map(reward => <div className="item" key={reward.id} style={!reward.active ? { opacity: .5 } : null}><div className="grow"><div className="tt">{reward.name} {!reward.active && <span className="tag">off</span>}</div><div className="ss">{reward.cost} pts · {reward.delivery_mode === 'auto_code' ? 'auto-code' : 'staff'} · {reward.stock == null ? 'безлимит' : 'остаток ' + reward.stock}</div></div>{canEdit && <><button className="btn xs plain" onClick={() => setForm(reward)}>Изменить</button><button className="iconbtn" onClick={() => remove(reward.id)}><Icon name="trash" /></button></>}</div>)}</div>
    <h3 className="sec">Заявки на выдачу</h3>
    {!redemptions.length && <div className="card empty">Заявок пока нет.</div>}
    <div className="list">{redemptions.map(item => <div className="item" key={item.id}><div className="grow"><div className="tt">{item.reward_name}</div><div className="ss">user {item.user_id} · -{item.cost} pts · {item.status}</div></div>{item.status === 'pending' && <div className="row" style={{ gap: 4 }}><button className="btn xs primary" onClick={() => closeRequest(item.id, 'fulfilled')}>Выдать</button><button className="btn xs danger" onClick={() => closeRequest(item.id, 'rejected')}>Отклонить</button></div>}{item.code && <span className="tag acc">{item.code}</span>}</div>)}</div>
  </>
}

function Staff({ admin }) {
  const [staff, setStaff] = useState([]); const [name, setName] = useState(''); const [role, setRole] = useState('trainer'); const [invite, setInvite] = useState(null); const [error, setError] = useState('')
  const canManage = admin.role === 'owner' || admin.role === 'manager'
  const load = () => api('/api/admin/staff').then(d => setStaff(d.admins || [])).catch(e => setError(e.message))
  useEffect(() => { load(); }, [])
  const makeInvite = () => api('/api/admin/staff/invite', { method: 'POST', body: JSON.stringify({ name, role }) }).then(d => { setInvite(d.invite); setName(''); load() }).catch(e => setError(e.message))
  const impersonate = s => api('/api/admin/impersonate', { method: 'POST', body: JSON.stringify({ kind: 'staff', id: s.id }) }).then(d => { location.href = d.redirect }).catch(e => setError(e.message))
  const link = invite && location.origin + '/admin/register?code=' + invite.code
  return <>
    <div className="row between" style={{ marginBottom: 10 }}><div><h2 style={{ margin: 0 }}>Сотрудники</h2><div className="sub">Отдельные passkey и роли доступа</div></div></div>
    {canManage && <div className="card"><h3 style={{ marginTop: 0 }}>Пригласить сотрудника</h3><div className="row" style={{ gap: 8 }}><input className="field" value={name} onChange={e => setName(e.target.value)} placeholder="Имя сотрудника" /><select className="field" value={role} onChange={e => setRole(e.target.value)}>{roles.filter(r => r !== 'owner').map(r => <option key={r}>{r}</option>)}</select><Button variant="primary" size="sm" onClick={makeInvite} disabled={!name.trim()}>Создать</Button></div>{invite && <div className="small" style={{ marginTop: 10 }}>Код: <b>{invite.code}</b><br />Ссылка: <span className="dim">{link}</span><button className="btn xs plain" onClick={() => navigator.clipboard?.writeText(link)}>Копировать</button></div>}</div>}
    <ErrorLine error={error} />
    <div className="list">{staff.map(s => <div className="item" key={s.id}><div className="grow"><div className="tt">{s.name} {s.disabled && <span className="tag" style={{ color: 'var(--red)' }}>off</span>}</div><div className="ss">{s.role} · {s.passkeys} passkey</div></div>{admin.role === 'owner' && <button className="btn xs plain" onClick={() => impersonate(s)} disabled={s.disabled}>Войти как</button>}<span className="tag acc">{s.role}</span>{admin.role === 'owner' && s.role !== 'owner' && <button className="btn xs plain danger" onClick={() => confirmSheet({
      title: 'Удалить сотрудника ' + s.name + '?', message: 'Профиль скроется из списков, вход будет заблокирован. Данные и статистика останутся — восстановить можно в любой момент.',
      confirmText: 'Удалить', danger: true,
      onConfirm: () => api('/api/admin/staff/delete', { method: 'POST', body: JSON.stringify({ id: s.id }) }).then(load).catch(e => setError(e.message))
    })}>Удалить</button>}</div>)}</div>
  </>
}

function Branches({ admin }) {
  const [branches, setBranches] = useState([]); const [name, setName] = useState(''); const [error, setError] = useState('')
  const canEdit = admin.role === 'owner' || admin.role === 'manager'
  const load = () => api('/api/admin/branches').then(d => setBranches(d.branches || [])).catch(e => setError(e.message))
  useEffect(() => { load(); }, [])
  const create = () => api('/api/admin/branches/save', { method: 'POST', body: JSON.stringify({ name }) }).then(() => { setName(''); load() }).catch(e => setError(e.message))
  const rename = (id, n) => api('/api/admin/branches/save', { method: 'POST', body: JSON.stringify({ id, name: n }) }).then(load).catch(e => setError(e.message))
  const del = b => confirmSheet({ title: 'Удалить филиал «' + b.name + '»?', message: 'Филиал скроется из списков; правила лояльности, сотрудники и история по нему останутся в системе.', confirmText: 'Удалить', danger: true, onConfirm: () => api('/api/admin/branches/delete', { method: 'POST', body: JSON.stringify({ id: b.id }) }).then(load).catch(e => setError(e.message)) })
  return <>
    <div className="row between" style={{ marginBottom: 10 }}><div><h2 style={{ margin: 0 }}>Филиалы</h2><div className="sub">Залы сети: правила лояльности и аналитика в разрезе филиала</div></div></div>
    {canEdit && <div className="card"><h3 style={{ marginTop: 0 }}>Добавить филиал</h3><div className="row" style={{ gap: 8 }}><input className="field" value={name} onChange={e => setName(e.target.value)} placeholder="Название зала, например «Филиал на Ленина»" /><Button variant="primary" size="sm" onClick={create} disabled={!name.trim()}>Создать</Button></div></div>}
    <ErrorLine error={error} />
    <div className="list">{branches.length ? branches.map(b => <div className="item" key={b.id}><div className="grow"><div className="tt">{b.name}</div><div className="ss">id: {b.id}</div></div>
      {canEdit && <button className="btn xs plain" onClick={() => { const n = prompt('Новое название филиала:', b.name); if (n && n.trim()) rename(b.id, n.trim()) }}>Переименовать</button>}
      {admin.role === 'owner' && <button className="iconbtn" onClick={() => del(b)} aria-label="Удалить филиал"><Icon name="trash" /></button>}
    </div>) : <div className="empty small muted">Филиалов пока нет — добавьте первый зал.</div>}</div>
  </>
}

function Invites({ admin }) {
  const [invites, setInvites] = useState([]); const [note, setNote] = useState(''); const [created, setCreated] = useState(null); const [error, setError] = useState('')
  const canManage = admin.role === 'owner' || admin.role === 'manager'
  const load = () => api('/api/admin/invites').then(d => setInvites(d.invites || [])).catch(e => setError(e.message))
  useEffect(() => { load(); }, [])
  const create = () => api('/api/admin/invites/new', { method: 'POST', body: JSON.stringify({ note, short: true }) }).then(d => { setCreated(d.invite); setNote(''); load() }).catch(e => setError(e.message))
  const revoke = code => api('/api/admin/invites/revoke', { method: 'POST', body: JSON.stringify({ code }) }).then(load).catch(e => setError(e.message))
  const link = code => location.origin + '/?invite=' + code
  return <>
    <div className="row between" style={{ marginBottom: 10 }}><div><h2 style={{ margin: 0 }}>Приглашения спортсменов</h2><div className="sub">Код для регистрации в приложении — вход остаётся через passkey</div></div></div>
    {canManage && <div className="card"><h3 style={{ marginTop: 0 }}>Создать код</h3><div className="row" style={{ gap: 8 }}><input className="field" value={note} onChange={e => setNote(e.target.value)} placeholder="Кому выдаётся (необязательно)" /><Button variant="primary" size="sm" onClick={create}>Создать</Button></div>
      {created && <div className="small" style={{ marginTop: 10 }}>Код: <b style={{ fontSize: 18, letterSpacing: '.12em' }}>{created.code}</b><br />Ссылка для спортсмена: <span className="dim">{link(created.code)}</span>{' '}<button className="btn xs plain" onClick={() => navigator.clipboard?.writeText(link(created.code))}>Копировать ссылку</button>{' '}<button className="btn xs plain" onClick={() => navigator.clipboard?.writeText(created.code)}>Копировать код</button></div>}
    </div>}
    <ErrorLine error={error} />
    {!invites.length && <div className="card empty">Кодов пока нет. Создайте первый — спортсмен введёт его при создании профиля.</div>}
    <div className="list">{invites.map(i => <div className="item" key={i.code}><div className="grow"><div className="tt" style={{ letterSpacing: '.08em' }}>{i.code}</div><div className="ss">{i.note || 'без пометки'} · {new Date(i.created).toLocaleDateString()}</div></div>{i.usedBy ? <span className="tag acc">использован{i.usedByName ? ' — ' + i.usedByName : ''}</span> : <><span className="tag">свободен</span><button className="btn xs plain" onClick={() => revoke(i.code)}>Отозвать</button></>}</div>)}</div>
  </>
}

// Коды «Приватного режима» (/private): гостевой локальный режим приложения без
// аккаунта. Код выдаётся владельцем после разовой оплаты (СБП/счёт) и активирует
// режим на устройстве спортсмена. Видят и создают коды только владельцы — код —
// это товар, за который спортсмен заплатил один раз.
function PrivateCodes({ admin }) {
  const [codes, setCodes] = useState([]); const [note, setNote] = useState(''); const [created, setCreated] = useState(null); const [error, setError] = useState('')
  const load = () => api('/api/admin/private-codes').then(d => setCodes(d.codes || [])).catch(e => setError(e.message))
  useEffect(() => { load(); }, [])
  const create = () => api('/api/admin/private-codes/new', { method: 'POST', body: JSON.stringify({ note }) }).then(d => { setCreated(d.code); setNote(''); load() }).catch(e => setError(e.message))
  const revoke = code => api('/api/admin/private-codes/revoke', { method: 'POST', body: JSON.stringify({ code }) }).then(load).catch(e => setError(e.message))
  return <>
    <div className="row between" style={{ marginBottom: 10 }}><div><h2 style={{ margin: 0 }}>Приватный режим</h2><div className="sub">Гостевой доступ на /private — данные только на устройстве. Код выдаётся после разовой оплаты и активирует режим навсегда</div></div></div>
    <div className="card"><h3 style={{ marginTop: 0 }}>Создать код</h3><div className="row" style={{ gap: 8 }}><input className="field" value={note} onChange={e => setNote(e.target.value)} placeholder="Кому выдан (необязательно)" /><Button variant="primary" size="sm" onClick={create}>Создать</Button></div>
      {created && <div className="small" style={{ marginTop: 10 }}>Код доступа: <b style={{ fontSize: 20, letterSpacing: '.14em' }}>{created.code}</b>{' '}<button className="btn xs plain" onClick={() => navigator.clipboard?.writeText(created.code)}>Копировать код</button><br />Страница входа: <span className="dim">{location.origin}/private</span></div>}
    </div>
    <ErrorLine error={error} />
    {!codes.length && <div className="card empty">Кодов пока нет. Создайте первый — спортсмен введёт его на {location.origin}/private.</div>}
    <div className="list">{codes.map(c => <div className="item" key={c.code}><div className="grow"><div className="tt" style={{ letterSpacing: '.1em' }}>{c.code}</div><div className="ss">{c.note || 'без пометки'} · создан {new Date(c.created_at).toLocaleDateString()} · активаций: {c.uses}</div></div>{c.active ? <><span className="tag acc">активен</span><button className="btn xs plain" onClick={() => revoke(c.code)}>Отозвать</button></> : <span className="tag">отозван</span>}</div>)}</div>
  </>
}

function AdminDashboard({ admin, onLogout }) {
  const nav = useNavigate()
  const [sp] = useSearchParams(); const [staff, setStaff] = useState([]); const [rules, setRules] = useState([]); const [push, setPush] = useState(null)
  const [unread, setUnread] = useState(0)
  const [leadUnread, setLeadUnread] = useState(0)
  const tab = sp.get('tab') || 'overview'
  const go = v => nav('/admin' + (v === 'overview' ? '' : '?tab=' + v))
  // Непрочитанные уведомления (заявки с сайта, заказы тарифов, статусы) — бейдж на колокольчике.
  const refreshUnread = () => {
    api('/api/admin/notifications')
      .then(d => setUnread((d.notifications || []).filter(n => !n.read).length)).catch(() => {})
    api('/api/admin/leads').then(d => setLeadUnread(d.unread || 0)).catch(() => {})
  }
  useEffect(() => {
    refreshUnread()
    const t = setInterval(refreshUnread, 60000)
    return () => clearInterval(t)
  }, [])
  useEffect(() => {
    api('/api/admin/staff').then(d => setStaff(d.admins || [])).catch(() => {})
    api('/api/admin/loyalty/rules').then(d => setRules(d.rules || [])).catch(() => {})
    api('/api/admin/push/status').then(d => setPush(d)).catch(() => {})
  }, [tab])
  const resetPush = () => api('/api/admin/push/status/reset', { method: 'POST', body: '{}' })
    .then(() => api('/api/admin/push/status').then(setPush)).catch(() => {})
  const lastPushFail = push?.stats?.failures?.length ? push.stats.failures[push.stats.failures.length - 1] : null
  const pushTile = push ? (push.degraded ? 'сбои' : 'ok') : '—'
  const canEdit = admin.role === 'owner' || admin.role === 'manager'
  const isDemo = !!admin.demo_session   // демо-клон (demo.gym.trfnv.ru): приватный режим не нужен
  const tabs = [['overview', 'Обзор'], ['loyalty', 'Loyalty'], ['rewards', 'Награды'], ['staff', 'Сотрудники'], ...(canEdit ? [['branches', 'Филиалы'], ['invites', 'Приглашения'], ['leads', 'Заявки']] : [])]
  const back = () => api('/api/admin/impersonate/back', { method: 'POST', body: '{}' }).then(d => { location.href = d.redirect || '/admin' }).catch(() => {})
  return <div className="narrow" style={{ paddingBottom: 40 }}>
    <div className="hdr"><div style={{ flex: 1 }}><div className="small dim">ИмпульС</div><h1 style={{ margin: 0 }}>Панель управления</h1><div className="sub">{admin.name} · {admin.role}</div></div><button className="iconbtn" onClick={() => nav('/admin/help')} aria-label="Справка"><Icon name="info" /></button><button className="iconbtn" style={{ position: 'relative' }} onClick={() => nav('/admin/notifications')} aria-label="Уведомления"><Icon name="bell" />{unread > 0 && <span className="notif-badge">{unread > 9 ? '9+' : unread}</span>}</button><button className="iconbtn" onClick={() => nav('/admin/analytics')} aria-label="Аналитика"><Icon name="chart" /></button><button className="iconbtn" onClick={onLogout} aria-label="Выйти"><Icon name="signOut" /></button></div>
    {admin.impersonated && <div className="card" style={{ borderColor: 'var(--acc)', marginBottom: 14 }}><div className="row between" style={{ gap: 8 }}><div className="small">Вы смотрите интерфейс от имени <b>{admin.name}</b> · {admin.role}</div><Button size="sm" variant="primary" onClick={back}>Вернуться</Button></div></div>}
    <NavBar
      selected={tab}
      badges={{ leads: leadUnread }}
      items={[
        { key: 'overview', icon: 'house', label: 'Обзор', onClick: () => go('overview') },
        { key: 'loyalty', icon: 'crown', label: 'Loyalty', onClick: () => go('loyalty') },
        { key: 'rewards', icon: 'medal', label: 'Награды', onClick: () => go('rewards') },
        { key: 'staff', icon: 'person', label: 'Сотрудники', onClick: () => go('staff') },
        ...(canEdit ? [
          { key: 'branches', icon: 'house', label: 'Филиалы', onClick: () => go('branches') },
          { key: 'invites', icon: 'link', label: 'Приглашения', onClick: () => go('invites') },
          { key: 'leads', icon: 'clipboard', label: 'Заявки', onClick: () => go('leads') }
        ] : []),
        ...(admin.role === 'owner' && !isDemo ? [{ key: 'private', icon: 'lock', label: 'Приватный', onClick: () => go('private') }] : [])
      ]}
    />
    {tab === 'overview' && <><div className="tiles"><div className="tile"><div className="l">Сотрудники</div><div className="v">{staff.length || '—'}</div></div><div className="tile"><div className="l">Правила</div><div className="v">{rules.length || '—'}</div></div><div className="tile"><div className="l">Пуши</div><div className="v" style={{ fontSize: '1rem', color: push?.degraded ? 'var(--red)' : 'var(--green)' }}>{pushTile}</div></div><div className="tile"><div className="l">Роль</div><div className="v" style={{ fontSize: '1rem' }}>{admin.role}</div></div><div className="tile"><div className="l">База</div><div className="v" style={{ fontSize: '1rem', color: 'var(--green)' }}>online</div></div></div>{push?.degraded && <div className="card" style={{ borderColor: 'var(--red)', marginBottom: 12, background: 'color-mix(in srgb,var(--red) 7%,var(--bg-el))' }}><div className="row between" style={{ gap: 10 }}><div className="grow"><div style={{ fontWeight: 600, color: 'var(--red)' }}>Сбои доставки push-уведомлений</div><div className="small dim" style={{ marginTop: 3 }}>не отправлено {push.stats?.failed || 0} шт. за 24 ч{lastPushFail ? ' · последний: ' + lastPushFail.host + (lastPushFail.status ? ' · ' + lastPushFail.status : '') + (lastPushFail.error ? ' · ' + lastPushFail.error : '') : ''}{push.webhookConfigured ? '' : ' · вебхук-алерт не настроен'}</div></div>{canEdit && <Button size="sm" variant="ghost" onClick={resetPush}>Сбросить</Button>}</div></div>}<div className="card"><h2 style={{ marginTop: 0 }}>Быстрый старт</h2><p className="dim">Создайте правило «Посещение» и выдайте сотруднику invite-код. События СКУД начнут начислять баллы после привязки member_key к профилю спортсмена.</p><Button variant="primary" onClick={() => go('loyalty')}>Настроить loyalty</Button></div></>}
    {tab === 'loyalty' && <Loyalty canEdit={canEdit} />}
    {tab === 'rewards' && <Rewards canEdit={canEdit} />}
    {tab === 'staff' && <Staff admin={admin} />}
    {tab === 'branches' && <Branches admin={admin} />}
    {tab === 'invites' && <Invites admin={admin} />}
    {tab === 'private' && !isDemo && <PrivateCodes admin={admin} />}
    {tab === 'leads' && <AdminLeads onViewed={n => setLeadUnread(n)} />}
  </div>
}


export class AdminBoundary extends Component {
  constructor(props) { super(props); this.state = { failed: false } }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch(err) { console.error('openGym admin render error:', err) }
  render() {
    if (!this.state.failed) return <>{this.props.children}<Modals /><Toast /></>
    return (
      <div className="narrow" style={{ paddingTop: '16vh', textAlign: 'center' }}>
        <div style={{ color: 'var(--acc)', fontSize: 36, marginBottom: 8 }}><Icon name="wrench" /></div>
        <h2 style={{ margin: '0 0 6px' }}>Ошибка интерфейса</h2>
        <p className="dim">Экран не удалось отрисовать. Данные в безопасности.</p>
        <Button variant="primary" onClick={() => location.reload()}>Перезагрузить</Button>
      </div>
    )
  }
}

export default function AdminApp() {
  const loc = useLocation(); const nav = useNavigate(); const [admin, setAdmin] = useState(undefined)
  const register = loc.pathname === '/admin/register'
  // i18n: the athlete Shell initialises the language, but the admin/trainer portal
  // has its own root — without this the names pack never loads and exercise titles
  // stay English everywhere (progress, exercise picker, best results).
  useLang()
  useEffect(() => { setLang(detectBrowserLang()) }, [])
  useEffect(() => { if (!register) api('/api/admin/auth/me').then(d => setAdmin(d.admin)).catch(() => setAdmin(null)) }, [register])
  if (register) return <AdminRegister />
  if (admin === undefined) return <div className="narrow" style={{ paddingTop: '42vh', textAlign: 'center' }}><Icon name="dumbbell" style={{ color: 'var(--label-3)', fontSize: 30 }} /></div>
  if (!admin) return <AdminLogin onLogin={setAdmin} />
  if (loc.pathname.startsWith('/admin/analytics')) return <Analytics admin={admin} />
  if (loc.pathname.startsWith('/admin/help')) return <AdminHelp />
  if (loc.pathname.startsWith('/admin/notifications')) return <TrainerNotifications />
  if (loc.pathname.startsWith('/trainer/notifications')) {
    if (admin.role !== 'trainer') return <Navigate to="/admin" replace />
    return <TrainerNotifications />
  }
  if (loc.pathname.startsWith('/trainer')) {
    if (admin.role !== 'trainer') return <Navigate to="/admin" replace />
    return <Trainer admin={admin} onLogout={() => api('/api/admin/auth/logout', { method: 'POST', body: '{}' }).then(() => { setAdmin(null); nav('/admin') })} />
  }
  return <AdminDashboard admin={admin} onLogout={() => api('/api/admin/auth/logout', { method: 'POST', body: '{}' }).then(() => { setAdmin(null); nav('/admin') })} />
}
