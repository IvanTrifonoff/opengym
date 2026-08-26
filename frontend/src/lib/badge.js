// App icon badge (Badging API): shows how many things the athlete is waiting on —
// pending reward requests + pending bookings with the trainer. Supported on
// iOS/iPadOS 16.4+ Home Screen web apps and Chrome (Android/Windows) for installed
// PWAs; everywhere else it's a no-op (feature-detected).
import { api } from './api.js'

export const badgeSupported = () => typeof navigator !== 'undefined' && typeof navigator.setAppBadge === 'function'

export async function refreshBadge() {
  if (!badgeSupported()) return
  let n = 0
  try {
    const [wallet, bookings] = await Promise.all([
      api('/api/loyalty/wallet').catch(() => null),
      api('/api/trainer/my-bookings').catch(() => null)
    ])
    n += (wallet?.redemptions || []).filter(r => r.status === 'pending').length
    n += (bookings?.bookings || []).filter(b => b.status === 'pending').length
  } catch (e) { /* keep the current badge */ }
  try {
    if (n > 0) await navigator.setAppBadge(n)
    else await navigator.clearAppBadge()
  } catch (e) { /* badge API can throw when permission is missing — ignore */ }
}
