import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import { MOBILE } from './lib/mobile.js'
import './index.css'

createRoot(document.getElementById('root')).render(
  <StrictMode><App /></StrictMode>
)

// ---------------------------------------------------------------------------
// Service worker: регистрация + уведомление о новой версии.
//
// Стратегия кэша (network-first для бандлов) гарантирует СВЕЖИЙ код при
// загрузке страницы, но открытая вкладка / живой PWA держит старый бандл
// в памяти до перезагрузки — без сигнала «вышла новая версия» пользователь
// видит старый UI после деплоя и думает, что он не прошёл.
//
// Здесь: как только новый SW скачан поверх действующего (updatefound →
// installed) или уже сменил контроллер (controllerchange), показываем
// баннер «Обновить» — перезагрузка доставляет свежий бандл сразу.
// ---------------------------------------------------------------------------
async function watchForUpdates() {
  if (MOBILE || !('serviceWorker' in navigator) || location.protocol !== 'https:') return
  try {
    const reg = await navigator.serviceWorker.register('sw.js')
    // Первая установка (только что добавили на экран/открыли впервые) —
    // объявлять нечего, свежий SW уже управляет этой загрузкой.
    if (!navigator.serviceWorker.controller) return
    let prompting = false
    const announce = () => {
      if (prompting) return
      prompting = true
      showUpdateBanner()
    }
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing
      if (!nw) return
      nw.addEventListener('statechange', () => {
        if (nw.state === 'installed') announce()
      })
    })
    // skipWaiting() активирует новый SW без перезагрузки — смена контроллера
    // это сигнал, что свежая версия уже здесь; reload завершает рукопожатие.
    navigator.serviceWorker.addEventListener('controllerchange', announce)
  } catch (e) { /* нет SW (http/не поддерживается) — жить можно */ }
}

// Баннер вне React-дерева: приложение может быть на экране логина/кешироваться
// в момент обновления, а фиксированный DOM-элемент сработает в любом случае.
function showUpdateBanner() {
  if (document.getElementById('update-banner')) return
  const bar = document.createElement('div')
  bar.id = 'update-banner'
  bar.setAttribute('role', 'status')
  const txt = document.createElement('span')
  txt.textContent = 'Вышла новая версия приложения'
  const btn = document.createElement('button')
  btn.textContent = 'Обновить'
  btn.onclick = () => location.reload()
  bar.append(txt, btn)
  document.body.appendChild(bar)
}

watchForUpdates()