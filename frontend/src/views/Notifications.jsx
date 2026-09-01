import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../lib/api.js'
import { t, dateLocale } from '../lib/i18n.js'
import { refreshBadge } from '../lib/badge.js'
import Icon from '../components/Icon.jsx'

function fmtWhen(iso) {
  const d = new Date(iso)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  if (sameDay) return d.toLocaleTimeString(dateLocale(), { hour: '2-digit', minute: '2-digit' })
  return d.toLocaleDateString(dateLocale(), { day: 'numeric', month: 'short' })
}

export default function Notifications() {
  const nav = useNavigate()
  const [items, setItems] = useState(null)
  const [err, setErr] = useState(false)

  useEffect(() => {
    api('/api/notifications')
      .then(d => {
        setItems(d.notifications || [])
        // the moment the athlete opens the page, everything is read
        const unread = (d.notifications || []).filter(n => !n.read)
        if (unread.length) {
          api('/api/notifications/read', { method: 'POST', body: JSON.stringify({}) }).catch(() => {})
        }
        refreshBadge()
      })
      .catch(() => { setItems([]); setErr(true) })
  }, [])

  return (
    <div className="narrow">
      <div className="hdr">
        <button className="iconbtn" onClick={() => nav('/home')} aria-label={t('Back')}><Icon name="chevronLeft" /></button>
        <div><h1>{t('Notifications')}</h1><div className="sub">{t('Your push messages and loyalty updates')}</div></div>
      </div>

      {err && <div className="muted small" style={{ padding: '18px 2px' }}>{t('Could not load notifications.')}</div>}

      {items && !err && items.length === 0 && (
        <div className="card">
          <div className="row" style={{ gap: 10 }}>
            <span className="lrow-i"><Icon name="bell" /></span>
            <div>
              <div className="ttl">{t('Nothing here yet')}</div>
              <div className="muted small">{t('Points, rewards and booking updates will show up here.')}</div>
            </div>
          </div>
        </div>
      )}

      {items && !err && items.map(n => (
        <div key={n.id} className={'card' + (n.read ? '' : ' unread')} style={{ marginBottom: 10 }}>
          <div className="row between">
            <div style={{ minWidth: 0 }}>
              <div className="lbl2">{(n.title === 'ИмпульС' || n.title === 'openGym') ? t('impulseGym') : n.title}</div>
              <div className="ttl" style={{ fontSize: 15, lineHeight: 1.4 }}>{n.body}</div>
            </div>
            <span className="small muted" style={{ whiteSpace: 'nowrap', marginLeft: 10 }}>{fmtWhen(n.created_at)}</span>
          </div>
        </div>
      ))}
    </div>
  )
}
