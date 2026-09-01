import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../lib/api.js'
import Icon from '../components/Icon.jsx'
import { refreshTrainerBadge } from '../lib/badge.js'

function fmtWhen(iso) {
  const d = new Date(iso)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })
}

// Trainer notification center (/trainer/notifications): booking requests and their
// statuses land here — same app_notifications table, scoped to the admin session.
export default function TrainerNotifications() {
  const nav = useNavigate()
  const [items, setItems] = useState(null)
  const [err, setErr] = useState(false)

  useEffect(() => {
    api('/api/admin/notifications')
      .then(d => {
        setItems(d.notifications || [])
        const unread = (d.notifications || []).filter(n => !n.read)
        if (unread.length) api('/api/admin/notifications/read', { method: 'POST', body: '{}' }).catch(() => {})
        refreshTrainerBadge()
      })
      .catch(() => { setItems([]); setErr(true) })
  }, [])

  return (
    <div className="narrow" style={{ paddingBottom: 40 }}>
      <div className="hdr">
        <button className="iconbtn" onClick={() => nav('/trainer')} aria-label="Назад"><Icon name="chevronLeft" /></button>
        <div><h1 style={{ margin: 0 }}>Уведомления</h1><div className="sub">Заявки, запросы с сайта и статусы</div></div>
      </div>

      {err && <div className="muted small" style={{ padding: '18px 2px' }}>Не удалось загрузить уведомления.</div>}

      {items && !err && items.length === 0 && (
        <div className="card">
          <div className="row" style={{ gap: 10 }}>
            <span className="lrow-i"><Icon name="bell" /></span>
            <div>
              <div className="ttl">Пока пусто</div>
              <div className="muted small">Новые заявки и уведомления появятся здесь.</div>
            </div>
          </div>
        </div>
      )}

      {items && !err && items.map(n => (
        <div key={n.id} className={'card' + (n.read ? '' : ' unread')} style={{ marginBottom: 10 }}>
          <div className="row between">
            <div style={{ minWidth: 0 }}>
              <div className="lbl2">{n.title}</div>
              <div className="ttl" style={{ fontSize: 15, lineHeight: 1.4 }}>{n.body}</div>
            </div>
            <span className="small muted" style={{ whiteSpace: 'nowrap', marginLeft: 10 }}>{fmtWhen(n.created_at)}</span>
          </div>
        </div>
      ))}
    </div>
  )
}
