import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../lib/api.js'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import Icon from '../components/Icon.jsx'
import { Button } from '../components/ui.jsx'
import { t } from '../lib/i18n.js'

// «Приватный режим» — скрытая страница /private. Гостевой локальный режим
// (данные только на устройстве) активируется кодом, который владелец выдаёт
// после разовой оплаты. Код проверяется на сервере (/api/private/unlock),
// подделать его на клиенте нельзя.

export default function Private() {
  const nav = useNavigate()
  const setGuest = useStore(s => s.setGuest)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const activate = async () => {
    if (!code.trim()) { setErr(t('Enter the access code')); return }
    setBusy(true); setErr('')
    try {
      await api('/api/private/unlock', { method: 'POST', body: JSON.stringify({ code: code.trim() }) })
      setGuest(true)
      useUI.getState().toast(t('Private mode is on — your data stays on this device'))
      nav('/home', { replace: true })
    } catch (e) {
      setErr(e.message || t('Wrong code — check and try again'))
    } finally { setBusy(false) }
  }

  const wrap = { display: 'flex', flexDirection: 'column', justifyContent: 'center', minHeight: '78vh', textAlign: 'center' }

  return (
    <div className="narrow" style={wrap}>
      <div style={{ fontSize: 54, display: 'flex', justifyContent: 'center', color: 'var(--acc)' }}><Icon name="lock" /></div>
      <h1 style={{ fontSize: 30, fontWeight: 700, letterSpacing: '-.024em', margin: '12px 0 6px' }}>{t('Private mode')}</h1>
      <div className="muted" style={{ marginBottom: 22, lineHeight: 1.5 }}>
        {t('Everything stays on this device — no account, no server, no sync.')}<br />
        {t('A one-time payment unlocks it for good.')}
      </div>

      <div className="card" style={{ textAlign: 'left' }}>
        <label className="small muted" style={{ display: 'block', marginBottom: 6 }}>{t('Access code')}</label>
        <input className="field" autoFocus value={code} onChange={e => setCode(e.target.value)}
          placeholder="XXXX-XXXX-XXXX" maxLength={20}
          onKeyDown={e => { if (e.key === 'Enter') activate() }} autoCapitalize="characters" autoCorrect="off" spellCheck={false} />
        <div style={{ height: 12 }} />
        <Button variant="primary" style={{ width: '100%' }} onClick={activate} disabled={busy}>{busy ? t('Checking…') : t('Activate')}</Button>
        {err && <div className="small" style={{ color: 'var(--red)', marginTop: 10 }}>{err}</div>}
      </div>

      <div className="dim small" style={{ marginTop: 20, lineHeight: 1.6 }}>
        {t('Don’t have a code?')} <a href="mailto:ivan@trfnv.ru?subject=Приватный%20режим">ivan@trfnv.ru</a><br />
        <button className="btn ghost sm" style={{ marginTop: 6 }} onClick={() => nav('/')}>{t('Back to sign in')}</button>
      </div>
    </div>
  )
}