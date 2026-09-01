import { useEffect, useRef, useState } from 'react'
import { t, exName, dateLocale } from '../lib/i18n.js'
import { EXIDX } from '../lib/exercises.js'
import { fmtNum } from '../lib/format.js'
import { goalProg } from '../lib/goals.js'
import Icon from './Icon.jsx'
import { Button } from './ui.jsx'

/* GoalPoster — постер цели 1080×1350 (портрет Instagram 4:5), рисуется на устройстве
   после сохранения цели по упражнению. Спортсмен жмёт «Поделиться» (нативный share с
   PNG) или «Скачать».
   Дизайн осознанно минимальный: логотип, имя, название упражнения, целевая цифра,
   полоса прогресса, ссылка и CTA «установи бесплатно» под ней — ничего лишнего (раньше тут были
   слоган, дата и текст прогресса, постер был перегружен). Шрифты — Russo One (цифры/заголовок) и Oswald (подписи),
   оба с кириллицей. Все размеры подбираются автоматически по ширине текста, поэтому
   длинные названия упражнений и большие числа всегда влезают. */

const W = 1080, H = 1350
const ACCENT = '#c8f14b'            // фирменный «известь»
const DARK = '#0d1016', DARK2 = '#171d2a'
const INK = '#f4f6fa', MUTED = '#9aa4b8'
const DISP = "'Russo One', 'Arial Black', Arial, sans-serif"   // display: цифра + заголовок
const BODY = "'Oswald', Arial, 'Helvetica Neue', sans-serif"   // текст: подписи, имя, url

function rr(ctx, x, y, w, h, r) {
  if (typeof ctx.roundRect === 'function') { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); return }
  ctx.beginPath(); ctx.rect(x, y, w, h)
}

function wrap(ctx, text, maxW) {
  const out = []
  const words = String(text).split(' ')
  let line = ''
  for (const w of words) {
    const tryLine = line ? line + ' ' + w : w
    if (ctx.measureText(tryLine).width > maxW && line) { out.push(line); line = w }
    else line = tryLine
  }
  if (line) out.push(line)
  return out
}

// Подбор размера шрифта: самый крупный px (шаг 4), при котором текст влезает в maxW.
function fitPx(ctx, txt, weight, fam, base, maxW, min = 36) {
  let px = base
  while (px > min) {
    ctx.font = `${weight} ${px}px ${fam}`
    if (ctx.measureText(txt).width <= maxW) break
    px -= 4
  }
  return px
}

// Чистый отрисовщик — отдельная функция, чтобы легко переиспользовать/тестировать.
export function drawGoalPoster(canvas, o) {
  const { title, name, weight, unit, cur, pct, done, dateLabel, slogan, url, cta, labels = {} } = o
  const ctx = canvas.getContext('2d')
  canvas.width = W; canvas.height = H
  const cx = W / 2

  // фон: тёмный градиент
  const g = ctx.createLinearGradient(0, 0, W, H)
  g.addColorStop(0, DARK); g.addColorStop(1, DARK2)
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H)

  // декоративные кольца справа-снизу — тихий фон, не несут информации
  const ring = (cx2, cy, r) => { ctx.beginPath(); ctx.arc(cx2, cy, r, 0, Math.PI * 2); ctx.strokeStyle = 'rgba(200,241,75,.10)'; ctx.lineWidth = 3; ctx.stroke() }
  ring(W - 120, H - 260, 340); ring(W - 120, H - 260, 280); ring(W - 120, H - 260, 220)
  const g2 = ctx.createRadialGradient(W - 120, H - 260, 40, W - 120, H - 260, 320)
  g2.addColorStop(0, 'rgba(200,241,75,.10)'); g2.addColorStop(1, 'rgba(200,241,75,0)')
  ctx.fillStyle = g2; ctx.beginPath(); ctx.arc(W - 120, H - 260, 320, 0, Math.PI * 2); ctx.fill()

  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'

  // верх: логотип
  ctx.fillStyle = ACCENT
  ctx.font = `400 44px ${DISP}`
  ctx.fillText('ИМПУЛЬС', cx, 84)

  // имя спортсмена (мелко, не спорит с цифрой)
  ctx.fillStyle = MUTED
  const nPx = fitPx(ctx, String(name || '').toUpperCase(), 500, BODY, 36, 920)
  ctx.font = `500 ${nPx}px ${BODY}`
  ctx.fillText(String(name || '').toUpperCase(), cx, 156)

  // бейдж «новая цель» / «цель достигнута» — единственный статусный элемент
  const badge = done ? (labels.done || 'Goal reached!') : (labels.newGoal || 'New goal')
  ctx.font = `600 30px ${BODY}`
  const bw = ctx.measureText(badge).width + 72
  ctx.fillStyle = done ? ACCENT : 'rgba(255,255,255,.08)'
  rr(ctx, cx - bw / 2, 188, bw, 62, 31); ctx.fill()
  ctx.fillStyle = done ? DARK : INK
  ctx.fillText(badge, cx, 219)

  // название упражнения: подбираем размер так, чтобы влезало максимум в 2 строки
  const tPx = (() => {
    let px = 100
    while (px > 54) {
      ctx.font = `400 ${px}px ${DISP}`
      if (wrap(ctx, title, 880).length <= 2) break
      px -= 4
    }
    return px
  })()
  ctx.font = `400 ${tPx}px ${DISP}`
  const tLines = wrap(ctx, title, 880).slice(0, 2)
  ctx.fillStyle = INK
  tLines.forEach((l, i) => ctx.fillText(l, cx, 352 + i * 108))

  // целевая цифра — герой постера: огромная, с авто-подбором под ширину
  const wPx = fitPx(ctx, fmtNum(weight), 400, DISP, 300, 840, 140)
  ctx.font = `400 ${wPx}px ${DISP}`
  const yW = 352 + (tLines.length - 1) * 108 + 168
  ctx.fillStyle = ACCENT
  ctx.fillText(fmtNum(weight), cx, yW)

  // единицы (кг / повторения) — компактно под цифрой
  ctx.fillStyle = INK
  const uPx = fitPx(ctx, String(unit || 'kg').toUpperCase(), 600, BODY, 56, 700)
  ctx.font = `600 ${uPx}px ${BODY}`
  ctx.fillText(String(unit || 'kg').toUpperCase(), cx, yW + 118)

  // подпись прогресса над полосой: «ПРОГРЕСС · 83%» либо «ДОСТИГНУТО»
  const barY = yW + 212, barW = 620, barH = 24, barX = cx - barW / 2
  const progLabel = done ? (labels.doneTxt || 'Done — new level!') : (labels.nowTxt || 'Progress · {1}%')
    .replace('{1}', String(pct))
  ctx.fillStyle = MUTED
  ctx.font = `500 32px ${BODY}`
  ctx.fillText(progLabel.toUpperCase(), cx, barY - 46)

  // полоса прогресса
  ctx.fillStyle = 'rgba(255,255,255,.10)'
  rr(ctx, barX, barY, barW, barH, barH / 2); ctx.fill()
  const fill = Math.max(0, Math.min(1, pct / 100))
  if (fill > 0) {
    ctx.fillStyle = ACCENT
    rr(ctx, barX, barY, Math.max(barH, barW * fill), barH, barH / 2); ctx.fill()
  }
  if (done) {
    // галочка справа от полосы — мгновенно читается как «выполнено»
    ctx.strokeStyle = ACCENT; ctx.lineWidth = 8; ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(barX + barW + 34, barY + barH / 2 - 16); ctx.lineTo(barX + barW + 58, barY + barH / 2 + 10)
    ctx.lineTo(barX + barW + 106, barY + barH / 2 - 34)
    ctx.stroke()
  }

  // низ: ссылка, под ней CTA «установи бесплатно и присоединяйся к челленджу»
  // (QR не рисуем — постера это перегружало). CTA переносится на 2 строки и
  // ужимается, если не влезает.
  ctx.fillStyle = ACCENT
  const uPx2 = fitPx(ctx, url, 400, DISP, 44, 900)
  ctx.font = `400 ${uPx2}px ${DISP}`
  ctx.fillText(url, cx, H - 96)
  if (cta) {
    const cPx = fitPx(ctx, cta, 600, BODY, 34, 880, 24)
    ctx.font = `600 ${cPx}px ${BODY}`
    const cLines = wrap(ctx, cta, 880).slice(0, 2)
    ctx.fillStyle = INK
    cLines.forEach((l, i) => ctx.fillText(l, cx, H - 52 + i * 44))
  }
}

// Шрифты должны быть загружены до отрисовки, иначе канвас нарисует системной заменой.
// Ждём оба семейства (Russo One — display, Oswald — текст); при ошибке рисуем как есть.
const FONTS_TO_LOAD = [
  '400 44px "Russo One"', '400 300px "Russo One"',
  '500 36px "Oswald"', '600 30px "Oswald"', '700 56px "Oswald"'
]
export async function ensureGoalFonts() {
  if (typeof document === 'undefined' || !document.fonts) return
  try {
    await Promise.all(FONTS_TO_LOAD.map(f => document.fonts.load(f)))
    await document.fonts.ready
  } catch (e) { /* нет FontFace — рисуем системными */ }
}

export default function GoalPoster({ S, goal, userName = '', onDone }) {
  const ref = useRef(null)
  const [dataUrl, setDataUrl] = useState(null)
  const ex = goal && goal.exId ? EXIDX[goal.exId] : null
  const title = ex ? exName(ex) : (goal && goal.label) || ''
  const prog = goalProg(S || {}, goal)
  const isReps = !!(goal && goal.reps != null)
  const unit = isReps ? t('reps').toUpperCase() : ((goal && goal.unit) || (S && S.unit) || 'kg').toUpperCase()
  const displayW = isReps ? goal.reps : goal.w
  const dateLabel = new Date(goal && goal.createdAt ? goal.createdAt : Date.now())
    .toLocaleDateString(dateLocale(), { day: 'numeric', month: 'long', year: 'numeric' })
  const slogan = t('Train · Set goals · Achieve').toUpperCase()
  const url = 'gym.trfnv.ru'

  useEffect(() => {
    const cv = ref.current
    if (!cv) return
    let alive = true
    ensureGoalFonts().then(() => {
      if (!alive) return
      drawGoalPoster(cv, {
        title, name: userName, weight: displayW, unit, cur: prog.cur, pct: prog.pct, done: prog.done,
        dateLabel, slogan, url, cta: t('Install free and join the challenge'),
        labels: { newGoal: t('New goal'), done: t('Goal reached!'), doneTxt: t('Goal reached — new level!'), nowTxt: t('Progress · {1}% of goal') }
      })
      setDataUrl(cv.toDataURL('image/png'))
    })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goal && goal.id, prog.done])

  const toBlob = () => new Promise(res => ref.current.toBlob(res, 'image/png'))
  const download = async () => {
    const b = await toBlob()
    const a = document.createElement('a')
    a.href = URL.createObjectURL(b); a.download = 'impulsegym-goal.png'; a.click()
  }
  const share = async () => {
    const b = await toBlob()
    const file = new File([b], 'impulsegym-goal.png', { type: 'image/png' })
    const text = `${title}: ${fmtNum(prog.cur)} → ${fmtNum(isReps ? goal.reps : goal.w)} ${unit}. ${t('Made with impulseGym')} — ${url}`
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title, text }) } catch (e) { /* отменено */ }
    } else download()
  }

  return <div style={{ textAlign: 'center' }}>
    <h3>{t('Your poster is ready — share it!')}</h3>
    <p className="muted small" style={{ margin: '-4px 0 12px' }}>{t('Show your goal on Instagram — friends will want to compete.')}</p>
    <canvas ref={ref} style={{ display: 'none' }} />
    {dataUrl && <img src={dataUrl} alt={title} style={{ width: '100%', maxWidth: 340, borderRadius: 18, border: 'var(--hair) solid var(--sep-op)' }} />}
    <div style={{ height: 14 }} />
    <div className="row" style={{ justifyContent: 'center', gap: 10, flexWrap: 'wrap' }}>
      <Button variant="primary" icon="share" onClick={share}>{t('Share')}</Button>
      <Button icon="download" onClick={download}>{t('Download')}</Button>
      {onDone && <Button variant="ghost" onClick={onDone}>{t('Done')}</Button>}
    </div>
  </div>
}