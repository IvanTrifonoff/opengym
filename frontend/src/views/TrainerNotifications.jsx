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

// Trainer notification center (/trainer/notifications and /admin/notifications):
// booking requests, retention alerts and site leads land here — same app_notifications
// table, scoped to the admin session. Every item must lead to its source (rule in
// api/routes/notifications.js) so the staff member can react in one tap.
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

      {items && !err && items.map(n => {
        // ПРАВИЛО УВЕДОМЛЕНИЙ (см. api/routes/notifications.js): тап по
        // уведомлению ведёт к источнику события. kind → маршрут:
        //   booking       → /trainer → календарь + подсветка заявки
        //   retention     → /admin/analytics → «Удержание» + фокус на спортсмене
        //   retention-net → /admin/analytics → «Удержание»
        //   promo_lead    → /admin?tab=leads + фокус на заявке
        const kind = n.payload && n.payload.kind
        const isBooking = kind === 'booking' && n.payload.booking_id
        const isRetention = kind === 'retention' && n.payload.athleteId
        const isRetentionNet = kind === 'retention-net'
        const isLead = kind === 'promo_lead' && n.payload.lead_id
        const go = isBooking ? () => nav('/trainer', { state: { tab: 'calendar', focusBooking: n.payload.booking_id } })
          : isRetention ? () => nav('/admin/analytics', { state: { tab: 'retention', focusAthlete: n.payload.athleteId } })
          : isRetentionNet ? () => nav('/admin/analytics', { state: { tab: 'retention' } })
          : isLead ? () => nav('/admin?tab=leads', { state: { focusLead: n.payload.lead_id } })
          : null
        const tag = isBooking ? 'Открыть заявку' : isRetention ? 'Удержание' : isRetentionNet ? 'Удержание' : isLead ? 'Заявка с сайта' : null
        return <div key={n.id} className={'card' + (n.read ? '' : ' unread')}
          style={{ marginBottom: 10, cursor: go ? 'pointer' : 'default' }}
          onClick={go || undefined}>
          <div className="row between" style={{ gap: 8 }}>
            <div style={{ minWidth: 0 }}>
              <div className="lbl2">{n.title}</div>
              <div className="ttl" style={{ fontSize: 15, lineHeight: 1.4 }}>{n.body}</div>
            </div>
            <div className="row" style={{ gap: 6, flex: 'none' }}>
              {tag && <span className="tag acc">{tag}</span>}
              <span className="small muted" style={{ whiteSpace: 'nowrap' }}>{fmtWhen(n.created_at)}</span>
            </div>
          </div>
        </div>
      })}
    </div>
  )
}
