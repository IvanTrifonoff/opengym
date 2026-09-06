import { useUI } from '../store/useUI.js'
import Icon from './Icon.jsx'
import { Button } from './ui.jsx'
import { t } from '../lib/i18n.js'

// Athlete-facing general help: how the app is organised, what each tab does.
// Bilingual — all strings go through t() (base English, translations in locales/).

const Step = ({ n, title, children }) => (
  <div className="row" style={{ gap: 10, alignItems: 'flex-start', marginBottom: 10 }}>
    <span className="tag acc" style={{ minWidth: 24, textAlign: 'center', marginTop: 1 }}>{n}</span>
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

const Card = ({ title, children }) => (
  <div className="card" style={{ marginBottom: 8 }}>
    <b>{t(title)}</b>
    <div className="muted small" style={{ lineHeight: 1.45, marginTop: 3 }}>{children}</div>
  </div>
)

export function athleteHelpSheet() {
  useUI.getState().openSheet(close => <AthleteHelp close={close} />)
}

function AthleteHelp({ close }) {
  return (
    <div>
      <div className="row between" style={{ alignItems: 'flex-start' }}>
        <h3 style={{ margin: 0 }}>{t('How the app works')}</h3>
        <button className="iconbtn" onClick={close} aria-label={t('Close')}><Icon name="xmark" /></button>
      </div>
      <div className="muted small" style={{ lineHeight: 1.5, marginBottom: 4 }}>
        {t('A short tour of the sections, so you know where everything is.')}
      </div>

      <Sec title={t('Home')}>
        <Card title={t('This week')}>{t('Your plan for the week and today’s session. Tap “Start” to begin a workout, or tap a day to change the plan.')}</Card>
        <Card title={t('My trainer')}>{t('If the club assigned you a trainer, the card shows their name. Tap it to book a session or message-free book a slot.')}</Card>
        <Card title={t('Body weight')}>{t('Log your weight here and set a goal — the progress line shows how you’re moving towards it.')}</Card>
      </Sec>

      <Sec title={t('Plan')}>
        <Card title={t('Your programs')}>{t('Build your own plan or load a ready-made Push / Pull / Legs. Each program has exercises with sets × reps × weight.')}</Card>
        <Card title={t('Exercises')}>{t('Tap an exercise to see how to do it — most have step-by-step instructions and an animation. You can also create your own exercise.')}</Card>
        <Card title={t('Progression')}>{t('Optional automatic progression: the app suggests the next weight or reps after every workout. Open the (i) in the program editor to read how it works.')}</Card>
      </Sec>

      <Sec title={t('Workout')}>
        <Card title={t('Logging sets')}>{t('Check off each set as done — the app counts volume and keeps history automatically. Track effort per set (RIR/RPE) if you like.')}</Card>
        <Card title={t('Rest timer')}>{t('A rest timer between sets keeps you on track; the screen can stay awake during the workout.')}</Card>
      </Sec>

      <Sec title={t('Stats & history')}>
        <Card title={t('Progress')}>{t('Charts of volume, best lifts and body weight over time — see what’s working.')}</Card>
        <Card title={t('History')}>{t('All your past workouts, searchable by date or exercise.')}</Card>
      </Sec>

      <Sec title={t('Goals')}>
        <Card title={t('Weight goal')}>{t('Set a target weight from Home → Body weight → Goal and watch the line move.')}</Card>
        <Card title={t('Exercise goals')}>{t('You can also set a goal per exercise (e.g. bench press 100 kg). When you hit it, the app celebrates with a shareable poster.')}</Card>
      </Sec>

      <Sec title={t('Loyalty & rewards')}>
        <Card title={t('Points')}>{t('The club rewards visits, completed workouts, streaks and referrals with points. Tap the (i) next to “Points & rewards” in Settings for details.')}</Card>
        <Card title={t('Rewards')}>{t('Spend points on rewards from the club catalog — discounts, training sessions, merch. Requests are confirmed by the staff.')}</Card>
      </Sec>

      <Sec title={t('Notifications')}>
        <Card title={t('The bell')}>{t('Workout reminders, loyalty points and booking updates arrive here. Enable push notifications in Settings to get them on your phone.')}</Card>
      </Sec>

      <Sec title={t('Privacy & accounts')}>
        <Card title={t('Passkey profile')}>{t('With a profile, your data syncs across devices and is tied to your club account. No passwords — just Face ID / fingerprint / security key.')}</Card>
        <Card title={t('Private mode')}>{t('Data stays on this device only, with a one-time unlock. Guest data is never sent anywhere — back it up from Settings → Export.')}</Card>
      </Sec>

      <Button variant="primary" onClick={close} style={{ marginTop: 18 }}>{t('Got it')}</Button>
    </div>
  )
}