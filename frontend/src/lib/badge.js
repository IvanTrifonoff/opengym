// App icon badge (Badging API): shows how many things the athlete is waiting on —
// unread notifications + pending reward requests + pending bookings with the trainer
// that the athlete hasn't seen yet. Supported on iOS/iPadOS 16.4+ Home Screen web
// apps and Chrome (Android/Windows) for installed PWAs; everywhere else it's a no-op
// (feature-detected).
import { api } from './api.js'

export const badgeSupported = () => typeof navigator !== 'undefined' && typeof navigator.setAppBadge === 'function'

const unviewed = list => (list || []).filter(x => x.status === 'pending' && !x.viewed_at)

export async function refreshBadge() {
  if (!badgeSupported()) return
  let n = 0
  try {
    const [notifs, wallet, bookings] = await Promise.all([
      api('/api/notifications').catch(() => null),
      api('/api/loyalty/wallet').catch(() => null),
      api('/api/trainer/my-bookings').catch(() => null)
    ])
    n += (notifs?.notifications || []).filter(x => !x.read).length
    n += unviewed(wallet?.redemptions).length
    n += unviewed(bookings?.bookings).length
  } catch (e) { /* keep the current badge */ }
  try {
    if (n > 0) await navigator.setAppBadge(n)
    else await navigator.clearAppBadge()
  } catch (e) { /* badge API can throw when permission is missing — ignore */ }
}

// The athlete opened the section where their pending rewards/bookings are shown
// (Settings → Loyalty, coach sheet) — those stop counting on the badge from now on.
export async function markBadgeSeen() {
  try { await api('/api/badge/seen', { method: 'POST', body: '{}' }) } catch (e) { /* not fatal */ }
  await refreshBadge()
}
