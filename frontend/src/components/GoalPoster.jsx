import { useEffect, useRef, useState } from 'react'
import { t, exName, dateLocale } from '../lib/i18n.js'
import { EXIDX } from '../lib/exercises.js'
import { fmtNum } from '../lib/format.js'
import { goalProg } from '../lib/goals.js'
import Icon from './Icon.jsx'
import { Button } from './ui.jsx'

/* GoalPoster — «потрясающий постер цели»: канвас 1080×1350 (портрет Instagram 4:5),
   генерируется на устройстве после сохранения новой цели по упражнению. Спортсмен
   жмёт «Поделиться» — нативный share с PNG-файлом (Instagram/Stories/куда угодно),
   или «Скачать». На постере: имя, название упражнения, целевой вес, прогресс и
   брендинг «ИмпульС» + gym.trfnv.ru — сарафанное радио, которое просили владельцы залов. */

const W = 1080, H = 1350
// roundRect доступен не во всех движках — безопасный фолбэк
function rr(ctx, x, y, w, h, r) {
  if (typeof ctx.roundRect === 'function') { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); return }
  ctx.beginPath(); ctx.rect(x, y, w, h)
}
const ACCENT = '#c8f14b'            // фирменный «известь» (дефолтный accent приложения)
const DARK = '#0d1016', DARK2 = '#171d2a'
const INK = '#f4f6fa', MUTED = '#9aa4b8'

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

// Чистый отрисовщик — отдельная функция, чтобы легко переиспользовать/тестировать геометрию.
export function drawGoalPoster(canvas, o) {
  const { title, name, weight, unit, cur, pct, done, dateLabel, slogan, url, labels = {} } = o
  const ctx = canvas.getContext('2d')
  canvas.width = W; canvas.height = H

  // фон: тёмный градиент
  const g = ctx.createLinearGradient(0, 0, W, H)
  g.addColorStop(0, DARK); g.addColorStop(1, DARK2)
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H)

  // декоративные кольца (полупрозрачный акцент) — справа-снизу
  const ring = (cx, cy, r) => { ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.strokeStyle = 'rgba(200,241,75,.10)'; ctx.lineWidth = 3; ctx.stroke() }
  ring(W - 120, H - 260, 340); ring(W - 120, H - 260, 280); ring(W - 120, H - 260, 220)
  const g2 = ctx.createRadialGradient(W - 120, H - 260, 40, W - 120, H - 260, 320)
  g2.addColorStop(0, 'rgba(200,241,75,.10)'); g2.addColorStop(1, 'rgba(200,241,75,0)')
  ctx.fillStyle = g2; ctx.beginPath(); ctx.arc(W - 120, H - 260, 320, 0, Math.PI * 2); ctx.fill()

  const base = "Arial, 'Helvetica Neue', sans-serif"
  const bold = "'Arial Black', Arial, 'Helvetica Neue', sans-serif"
  const cx = W / 2
  ctx.textAlign = 'center'

  // лого-строка сверху
  ctx.textBaseline = 'middle'
  ctx.fillStyle = INK
  ctx.font = `800 40px ${bold}`
  ctx.letterSpacing = '14px'
  ctx.fillText('ИМПУЛЬС', cx, 92)

  // бейдж «новая цель» / «цель достигнута»
  const badge = done ? (labels.done || 'Goal reached!') : (labels.newGoal || 'New goal')
  ctx.font = `700 34px ${base}`
  const bw = ctx.measureText(badge).width + 76
  ctx.fillStyle = done ? ACCENT : INK
  rr(ctx, cx - bw / 2, 168, bw, 74, 37); ctx.fill()
  ctx.fillStyle = done ? DARK : '#2a323f'
  ctx.fillText(badge, cx, 205)

  // имя
  ctx.fillStyle = MUTED
  ctx.font = `600 46px ${base}`
  ctx.fillText((name || '').toUpperCase(), cx, 330)

  // название упражнения (перенос на 2 строки)
  ctx.fillStyle = INK
  ctx.font = `900 104px ${bold}`
  const lines = wrap(ctx, title, 880)
  lines.slice(0, 2).forEach((l, i) => ctx.fillText(l, cx, 470 + i * 116))

  // целевой вес
  const yW = lines.slice(0, 2).length === 2 ? 790 : 700
  ctx.fillStyle = ACCENT
  ctx.font = `900 250px ${bold}`
  ctx.fillText(fmtNum(weight), cx, yW)
  ctx.font = `800 84px ${base}`
  ctx.fillText(String(unit || 'kg').toUpperCase(), cx, yW + 92)

  // прогресс-бар
  const barW = 640, barH = 22, barX = cx - barW / 2, barY = yW + 190
  ctx.fillStyle = 'rgba(255,255,255,.10)'
  rr(ctx, barX, barY, barW, barH, barH / 2); ctx.fill()
  const fill = Math.max(0, Math.min(1, pct / 100))
  if (fill > 0) {
    ctx.fillStyle = ACCENT
    rr(ctx, barX, barY, Math.max(barH, barW * fill), barH, barH / 2); ctx.fill()
  }
  // подпись прогресса
  ctx.fillStyle = MUTED
  ctx.font = `600 36px ${base}`
  const progTxt = done ? (labels.doneTxt || 'Done — new level!') : (labels.nowTxt || 'Now {0} · {1}% of goal')
    .replace('{0}', fmtNum(cur) + ' ' + unit).replace('{1}', String(pct))
  ctx.fillText(progTxt, cx, barY + 74)

  // слоган
  ctx.fillStyle = INK
  ctx.font = `700 38px ${base}`
  ctx.fillText(slogan, cx, H - 210)

  // футер: дата + url
  ctx.fillStyle = MUTED
  ctx.font = `500 34px ${base}`
  ctx.fillText(dateLabel, cx, H - 120)
  ctx.fillStyle = ACCENT
  ctx.font = `800 40px ${bold}`
  ctx.fillText(url, cx, H - 60)
}

export default function GoalPoster({ S, goal, userName = '', onDone }) {
  const ref = useRef(null)
  const [dataUrl, setDataUrl] = useState(null)
  const ex = goal && goal.exId ? EXIDX[goal.exId] : null
  const title = ex ? exName(ex) : (goal && goal.label) || ''
  const prog = goalProg(S || {}, goal)
  const unit = (goal && goal.unit) || (S && S.unit) || 'kg'
  const dateLabel = new Date(goal && goal.createdAt ? goal.createdAt : Date.now())
    .toLocaleDateString(dateLocale(), { day: 'numeric', month: 'long', year: 'numeric' })
  const slogan = t('Train · Set goals · Achieve').toUpperCase()
  const url = 'gym.trfnv.ru'

  useEffect(() => {
    const cv = ref.current
    if (!cv) return
    drawGoalPoster(cv, {
      title, name: userName, weight: goal.w, unit, cur: prog.cur, pct: prog.pct, done: prog.done,
      dateLabel, slogan, url,
      labels: { newGoal: t('New goal'), done: t('Goal reached!'), doneTxt: t('Goal reached — new level!'), nowTxt: t('Now {0} · {1}% of goal') }
    })
    setDataUrl(cv.toDataURL('image/png'))
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
    const text = `${title}: ${fmtNum(prog.cur)} → ${fmtNum(goal.w)} ${unit}. ${t('Made with impulseGym')} — ${url}`
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