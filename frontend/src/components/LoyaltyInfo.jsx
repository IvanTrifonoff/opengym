import { useUI } from '../store/useUI.js'
import Icon from './Icon.jsx'
import { Button } from './ui.jsx'
import { t } from '../lib/i18n.js'

// Athlete-facing help sheet: what points and rewards are, how to exchange them.
// Bilingual — all strings go through t() (base English, translations in locales/).

const Step = ({ n, title, children }) => (
  <div className="row" style={{ gap: 10, alignItems: 'flex-start', marginBottom: 10 }}>
    <div className="tag acc" style={{ minWidth: 24, textAlign: 'center', marginTop: 1 }}>{n}</div>
    <div className="grow">
      <div className="small" style={{ fontWeight: 600 }}>{title}</div>
      <div className="muted small" style={{ lineHeight: 1.45 }}>{children}</div>
    </div>
  </div>
)

const Sec = ({ title, children }) => (
  <>
    <h4 className="sec" style={{ marginTop: 18 }}>{title}</h4>
    {children}
  </>
)

export function loyaltyInfoSheet() {
  useUI.getState().openSheet(close => <LoyaltyInfo close={close} />)
}

function LoyaltyInfo({ close }) {
  return (
    <div>
      <div className="row between" style={{ alignItems: 'flex-start' }}>
        <h3 style={{ margin: 0 }}>{t('Points & rewards')}</h3>
        <button className="iconbtn" onClick={close} aria-label={t('Close')}><Icon name="xmark" /></button>
      </div>
      <div className="muted small" style={{ lineHeight: 1.5, marginBottom: 4 }}>
        {t('Your club rewards your activity with points. Exchange them for rewards from the catalog.')}
      </div>

      <Sec title={t('How points work')}>
        <div className="muted small" style={{ lineHeight: 1.5, marginBottom: 10 }}>
          {t('Points are added automatically when the club registers your activity. The more regularly you train, the more you earn.')}
        </div>
        <div className="card" style={{ marginBottom: 6 }}><b>{t('Visits to the club')}</b><div className="muted small">{t('Every time you check in at the club')}</div></div>
        <div className="card" style={{ marginBottom: 6 }}><b>{t('Completed workouts')}</b><div className="muted small">{t('Workouts you finish in the app')}</div></div>
        <div className="card" style={{ marginBottom: 6 }}><b>{t('Training streaks')}</b><div className="muted small">{t('A series of training weeks without a break')}</div></div>
        <div className="card"><b>{t('Referrals')}</b><div className="muted small">{t('Friends who join the club with your link')}</div></div>
      </Sec>

      <Sec title={t('What rewards are')}>
        <div className="muted small" style={{ lineHeight: 1.5 }}>
          {t('Rewards are prizes from the club catalog: discounts, training sessions, merch, guest passes and more. Each reward costs points — the price is shown on its card.')}
        </div>
      </Sec>

      <Sec title={t('How to exchange points')}>
        <Step n={1} title={t('Pick a reward')}>{t('Choose a reward you can afford — the button is active when your balance is enough.')}</Step>
        <Step n={2} title={t('Tap Exchange')}>{t('Points are spent immediately and the request is sent to the club.')}</Step>
        <Step n={3} title={t('Get your reward')}>{t('Show the request to the staff — they confirm it and hand you the reward. Rewards with an auto-code generate a one-time code right away.')}</Step>
      </Sec>

      <Sec title={t('Request statuses')}>
        <div className="card" style={{ marginBottom: 6 }}><b>{t('Waiting for staff')}</b><div className="muted small">{t('Your request is pending — the club will confirm it soon.')}</div></div>
        <div className="card" style={{ marginBottom: 6 }}><b>{t('Completed')}</b><div className="muted small">{t('The reward is issued. If it had a code, you will find it here.')}</div></div>
        <div className="card"><b>{t('Rejected and refunded')}</b><div className="muted small">{t('The club declined the request and returned the points to your balance.')}</div></div>
      </Sec>

      <Button variant="primary" onClick={close} style={{ marginTop: 18 }}>{t('Got it')}</Button>
    </div>
  )
}
