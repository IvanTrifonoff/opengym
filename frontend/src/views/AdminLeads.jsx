// views/AdminLeads.jsx — вкладка «Заявки» панели управления (владелец/менеджер).
//
// Две задачи:
//  1. Настройка СБП-QR: владелец загружает QR-код оплаты (или вставляет ссылку) —
//     он сохраняется в app_settings и показывается прямо в модалке оплаты на
//     /pricing, чтобы клиент платил сразу, не дожидаясь ответа.
//  2. Список заявок с сайта (запросы КП и заказы тарифов из promo_leads):
//     непрочитанные подсвечены, при открытии вкладки помечаются прочитанными
//     (бейдж на вкладке сбрасывается — так же, как центр уведомлений).
import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api.js'
import Icon from '../components/Icon.jsx'
import { Button } from '../components/ui.jsx'

function fmtWhen(iso) {
  const d = new Date(iso)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })
}

export default function AdminLeads({ onViewed }) {
  const [leads, setLeads] = useState(null)
  const [qr, setQr] = useState(null)
  const [qrUrl, setQrUrl] = useState('')
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')
  const fileRef = useRef(null)

  useEffect(() => {
    api('/api/admin/leads').then(d => {
      setLeads(d.leads || [])
      if ((d.unread || 0) > 0) {
        api('/api/admin/leads/viewed', { method: 'POST', body: '{}' })
          .then(() => onViewed && onViewed(0)).catch(() => {})
      } else if (onViewed) onViewed(0)
    }).catch(() => setLeads([]))
    api('/api/sbp-qr').then(d => setQr(d.qr)).catch(() => {})
  }, [])

  const saveQr = async (value) => {
    setSaving(true); setMsg('')
    try {
      await api('/api/admin/sbp-qr', { method: 'POST', body: JSON.stringify({ qr: value }) })
      setQr(value); setQrUrl(''); setMsg('QR-код сохранён — он появится в модалке оплаты на /pricing.')
    } catch (e) {
      setMsg('Не удалось сохранить: ' + (e.data?.error || e.message))
    } finally { setSaving(false) }
  }

  const onFile = (e) => {
    const f = e.target.files && e.target.files[0]
    if (!f) return
    if (f.size > 250 * 1024) { setMsg('Файл больше 250 КБ — загрузите QR поменьше.'); return }
    const rd = new FileReader()
    rd.onload = () => saveQr(String(rd.result))
    rd.readAsDataURL(f)
  }

  const payLabel = p => p === 'sbp' ? 'СБП' : p === 'invoice' ? 'Счёт' : ''

  return (
    <div style={{ marginTop: 6 }}>
      {/* --- Настройка СБП-QR --- */}
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="row between" style={{ gap: 10, alignItems: 'center' }}>
          <div className="grow">
            <div style={{ fontWeight: 600 }}>Оплата по СБП — QR-код</div>
            <div className="small dim" style={{ marginTop: 3 }}>Клиент на /pricing увидит этот QR прямо в модалке «Оформить тариф» и оплатит сразу. Поддерживаются PNG/JPEG до 250 КБ или ссылка на картинку.</div>
          </div>
        </div>
        {qr && <div className="row" style={{ gap: 12, alignItems: 'center', marginTop: 10 }}>
          <img src={qr} alt="СБП QR" style={{ width: 96, height: 96, borderRadius: 10, border: '1px solid var(--sep-op)', background: '#fff' }} />
          <div className="grow">
            <Button size="sm" variant="ghost" onClick={() => { setQr(null); api('/api/admin/sbp-qr', { method: 'DELETE' }).then(() => setMsg('QR-код удалён.')).catch(() => {}) }}>Удалить</Button>
          </div>
        </div>}
        <div className="row" style={{ gap: 10, marginTop: qr ? 6 : 12, flexWrap: 'wrap' }}>
          <Button size="sm" variant={qr ? 'plain' : 'primary'} disabled={saving} onClick={() => fileRef.current && fileRef.current.click()}>Загрузить QR-код</Button>
          <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={onFile} />
          <input value={qrUrl} onChange={e => setQrUrl(e.target.value)} placeholder="или ссылка на картинку https://…"
            style={{ flex: 1, minWidth: 180, background: 'var(--bg-el)', border: '1px solid var(--sep-op)', borderRadius: 10, padding: '8px 11px', fontSize: 14, color: 'var(--label)' }} />
          <Button size="sm" variant="tinted" disabled={saving || !qrUrl.trim()} onClick={() => saveQr(qrUrl.trim())}>Сохранить</Button>
        </div>
        {msg && <div className="small" style={{ marginTop: 8, color: msg.startsWith('Не удалось') ? 'var(--red)' : 'var(--green)' }}>{msg}</div>}
      </div>

      {/* --- Список заявок --- */}
      {leads !== null && leads.length === 0 && (
        <div className="card">
          <div className="row" style={{ gap: 10 }}>
            <span className="lrow-i"><Icon name="clipboard" /></span>
            <div>
              <div className="ttl">Заявок пока нет</div>
              <div className="muted small">Запросы КП и заказы тарифов с /promo и /pricing появятся здесь.</div>
            </div>
          </div>
        </div>
      )}

      {leads && leads.map(l => (
        <div key={l.id} className={'card' + (l.viewed ? '' : ' unread')} style={{ marginBottom: 10 }}>
          <div className="row between" style={{ gap: 10 }}>
            <div style={{ minWidth: 0 }}>
              <div className="lbl2">
                {l.plan}{payLabel(l.payment) ? ' · ' + payLabel(l.payment) : ''}
                {!l.viewed && <span className="tag acc" style={{ marginLeft: 8 }}>новое</span>}
              </div>
              <div className="ttl" style={{ fontSize: 15, lineHeight: 1.4 }}>{l.name}{l.gym ? ' · ' + l.gym : ''}</div>
              <div className="small muted" style={{ marginTop: 4, whiteSpace: 'pre-line' }}>
                Контакт: {l.contact}
                {l.company ? '\n' + l.company + (l.inn ? ' · ИНН ' + l.inn : '') : ''}
                {l.message ? '\n' + l.message : ''}
              </div>
            </div>
            <span className="small muted" style={{ whiteSpace: 'nowrap', marginLeft: 8 }}>{fmtWhen(l.created_at)}</span>
          </div>
        </div>
      ))}
    </div>
  )
}