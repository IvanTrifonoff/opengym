import { useNavigate } from 'react-router-dom'
import Icon from './Icon.jsx'

// Единый адаптивный навигационный бар для всех ролей (спортсмен / тренер / админ):
//   · mobile  (по умолчанию): фиксированный нижний бар — иконка + подпись,
//     активная подсветка, опциональный бейдж и центральная круглая кнопка.
//   · desktop (≥1000px): та же строка фиксируется сверху как «пилюля» — контент
//     получает отступ сверху, благодаря чему разделы видны на любом экране.
//
// Пропсы:
//   items   — [{ key, icon, label, to?, onClick? }] — разделы в порядке показа.
//             `to` навигирует по роутеру, `onClick` вызывает локальный обработчик
//             (вкладки с внутренним state, как у тренера/админа).
//   selected— key активного раздела (подсветка).
//   badges  — { [key]: number } — счётчики (значение ≤0 не показывается).
//   center  — { icon, label, onClick, active } | null — центральная круглая кнопка
//             (у спортсмена — «Старт» / «Продолжить»).
export default function NavBar({ items, selected, badges, center }) {
  const nav = useNavigate()
  const pick = it => () => {
    if (it.onClick) it.onClick()
    else if (it.to) nav(it.to)
  }
  return (
    <nav id="navbar">
      {items.map(it => {
        const b = badges && badges[it.key] > 0 ? badges[it.key] : 0
        return (
          <button key={it.key} className={it.key === selected ? 'on' : ''} onClick={pick(it)} aria-label={it.label}>
            <Icon name={it.icon} />
            <span>{it.label}</span>
            {b > 0 && <span className="tab-badge">{b > 9 ? '9+' : b}</span>}
          </button>
        )
      })}
      {center && center.icon && (
        <button className={'start' + (center.active ? ' rec' : '')} onClick={center.onClick}>
          <span className="cir"><Icon name={center.icon} /></span>
          {center.label && <span>{center.label}</span>}
        </button>
      )}
    </nav>
  )
}