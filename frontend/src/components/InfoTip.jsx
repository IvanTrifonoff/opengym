import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import Icon from './Icon.jsx'

// «i»-подсказка для метрики/ячейки. Кнопка ставится рядом с названием метрики;
// по тапу показывает короткое объяснение рядом с ней. Закрывается вторым тапом,
// тапом мимо, прокруткой или Esc.
//
// Позиционируется поверх (fixed по координатам кнопки) и не сдвигает сетку —
// в плитках это важно: длинный текст не должен ломать высоту соседних ячеек.
export default function InfoTip({ text }) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState(null)
  const wrapRef = useRef(null)
  const btnRef = useRef(null)
  const popRef = useRef(null)

  const toggle = e => {
    e.stopPropagation()
    setOpen(o => !o)
  }

  // Кладём пузырь сразу после открытия: измеряем его реальную высоту в layout-фазе
  // (до отрисовки), чтобы подсказка не мигала и не уезжала за край экрана.
  useLayoutEffect(() => {
    if (!open) return
    const btn = btnRef.current, pop = popRef.current
    if (!btn || !pop) return
    const r = btn.getBoundingClientRect()
    const pw = pop.offsetWidth || 230
    const ph = pop.offsetHeight || 60
    const pad = 8
    let left = Math.min(r.right - pw, window.innerWidth - pw - pad)
    left = Math.max(pad, left)
    let top = r.bottom + 6
    if (top + ph > window.innerHeight - pad) top = Math.max(pad, r.top - ph - 6)
    setPos({ left, top })
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDoc = e => {
      const el = wrapRef.current
      if (el && el.contains(e.target)) return
      setOpen(false)
    }
    const onClose = () => setOpen(false)
    const onKey = e => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', onDoc, true)
    window.addEventListener('scroll', onClose, true)
    window.addEventListener('resize', onClose)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDoc, true)
      window.removeEventListener('scroll', onClose, true)
      window.removeEventListener('resize', onClose)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <span ref={wrapRef} className="itip-wrap">
      <button ref={btnRef} type="button" className="itip" onClick={toggle}
        aria-label="Справка о показателе" aria-expanded={open}>
        <Icon name="info" />
      </button>
      {open && <div ref={popRef} className="itip-bub" style={{ left: pos ? pos.left : 0, top: pos ? pos.top : 0, opacity: pos ? 1 : 0 }}>{text}</div>}
    </span>
  )
}
