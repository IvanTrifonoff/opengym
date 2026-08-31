import { useEffect } from 'react'
import { BrowserRouter, Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom'
import { useStore } from './store/useStore.js'
import { useUI } from './store/useUI.js'
import { bindUI } from './components/ui.jsx'
import { ACCENTS } from './lib/format.js'
import { setLang, detectBrowserLang, useLang } from './lib/i18n.js'
import { setNav } from './lib/nav.js'
import { useWakeLock } from './lib/wakelock.js'
import { refreshBadge } from './lib/badge.js'
import { startFlow } from './sheets.jsx'
import Icon from './components/Icon.jsx'
import NavBar from './components/NavBar.jsx'
import { t } from './lib/i18n.js'
import { effectiveRoutine } from './lib/history.js'
import { todayISO } from './lib/format.js'
import ErrorBoundary from './components/ErrorBoundary.jsx'
import Modals from './components/Modals.jsx'
import Toast from './components/Toast.jsx'
import RestTimer from './components/RestTimer.jsx'
import Login from './views/Login.jsx'
import Home from './views/Home.jsx'
import Plan from './views/Plan.jsx'
import RoutineEdit from './views/RoutineEdit.jsx'
import Workout from './views/Workout.jsx'
import Stats from './views/Stats.jsx'
import History from './views/History.jsx'
import Library from './views/Library.jsx'
import Settings from './views/Settings.jsx'
import Notifications from './views/Notifications.jsx'
import Admin from './views/Admin.jsx'
import AdminApp, { AdminBoundary } from './views/AdminApp.jsx'

bindUI(useUI)   // lets the shared controls open sheets without importing the store at module scope

function applyPrefs(theme, accent) {
  const de = document.documentElement
  de.dataset.theme = theme === 'light' ? 'light' : 'dark'
  de.dataset.accent = ACCENTS[accent] ? accent : 'lime'
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.content = de.dataset.theme === 'light' ? '#f2f2f7' : '#000000'
}

function Shell() {
  const navigate = useNavigate()
  const loc = useLocation()
  const cur = loc.pathname.split('/')[1] || 'home'
  const { S, user, ready } = useStore()
  const isGuest = useStore(s => s.isGuest())
  const langV = useLang()   // re-renders the whole shell when the language (pack) changes
  useEffect(() => { setNav(navigate) }, [navigate])
  useEffect(() => { applyPrefs(S.theme, S.accent) }, [S.theme, S.accent])
  // Default language comes from the browser (this fork's primary is Russian), unless the
  // profile has an explicit choice. Empty S.lang means "not chosen yet".
  useEffect(() => { setLang(S.lang || detectBrowserLang()) }, [S.lang])
  useEffect(() => { document.documentElement.lang = S.lang || detectBrowserLang() }, [langV, S.lang])
  // every tab/route change starts at the top of the page
  useEffect(() => { window.scrollTo(0, 0) }, [loc.pathname])
  // app icon badge: recompute on boot and whenever the app comes back to the foreground
  useEffect(() => {
    refreshBadge()
    const onVisible = () => { if (document.visibilityState === 'visible') refreshBadge() }
    window.addEventListener('focus', onVisible)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.removeEventListener('focus', onVisible)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])
  // bound to the workout, not to the route — checking Stats mid-session keeps the screen on
  useWakeLock(!!S.active && S.keepAwake !== false)

  const authed = user || isGuest
  if (!ready && !authed) return (
    <div id="app">
      <div style={{ paddingTop: '44vh', display: 'flex', justifyContent: 'center', fontSize: 34, color: 'var(--label-3)' }}>
        <Icon name="dumbbell" />
      </div>
    </div>
  )

  return (
    <>
      {/* keyed on the route: a view that throws is contained, and switching tabs
          re-mounts the boundary, so the tab bar is always a way out */}
      <div id="app" className="vfade" key={loc.pathname}>
        <ErrorBoundary>
          {!authed ? <Login /> : (
            <Routes>
              <Route path="/home" element={<Home />} />
              <Route path="/plan" element={<Plan />} />
              <Route path="/plan/r/:id" element={<RoutineEdit />} />
              <Route path="/workout" element={<Workout />} />
              <Route path="/stats" element={<Stats />} />
              <Route path="/history" element={<History />} />
              <Route path="/library" element={<Library />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="/notifications" element={<Notifications />} />
              <Route path="*" element={<Navigate to="/home" replace />} />
            </Routes>
          )}
        </ErrorBoundary>
      </div>
      <NavBar
        items={[
          { key: 'home', icon: 'house', label: t('Home'), to: '/home' },
          { key: 'plan', icon: 'calendar', label: t('Plan'), to: '/plan' },
          { key: 'stats', icon: 'chart', label: t('Stats'), to: '/stats' },
          { key: 'library', icon: 'list', label: t('Exercises'), to: '/library' }
        ]}
        selected={cur}
        center={{
          icon: S.active ? 'play' : 'dumbbell',
          label: S.active ? t('Resume') : t('Start'),
          active: !!S.active,
          onClick: () => {
            if (!S.active) {
              const r = effectiveRoutine(S, todayISO())
              if (r && r.ex.length) { startFlow(r.id); return }
            }
            navigate('/workout')
          }
        }}
      />
      <RestTimer />
      <Modals />
      <Toast />
    </>
  )
}

export default function App() {
  const adminPath = window.location.pathname === '/admin' || window.location.pathname.startsWith('/admin/')
    || window.location.pathname === '/trainer' || window.location.pathname.startsWith('/trainer/')
  const boot = useStore(s => s.boot)
  useEffect(() => { if (!adminPath) boot() }, [boot, adminPath])
  return <BrowserRouter>{adminPath ? <AdminBoundary><AdminApp /></AdminBoundary> : <Shell />}</BrowserRouter>
}