// App icon badge (Badging API): shows how many things the athlete is waiting on —
// unread notifications + pending reward requests + pending bookings with the trainer.
// Supported on iOS/iPadOS 16.4+ Home Screen web apps and Chrome (Android/Windows)
// for installed PWAs; everywhere else it's a no-op (feature-detected).
import { api } from './api.js'

export const badgeSupported = () => typeof navigator !== 'undefined' && typeof navigator.setAppBadge === 'function'

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
    n += (wallet?.redemptions || []).filter(r => r.status === 'pending').length
    n += (bookings?.bookings || []).filter(b => b.status === 'pending').length
  } catch (e) { /* keep the current badge */ }
  try {
    if (n > 0) await navigator.setAppBadge(n)
    else await navigator.clearAppBadge()
  } catch (e) { /* badge API can throw when permission is missing — ignore */ }
}
