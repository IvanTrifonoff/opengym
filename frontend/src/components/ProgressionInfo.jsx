import { useUI } from '../store/useUI.js'
import Icon from './Icon.jsx'
import { t } from '../lib/i18n.js'

// Athlete-facing help sheet for the automatic progression feature (issue #17):
// what the policies mean, how a session is read, when a deload happens.
// Bilingual — all strings go through t() (base English, translations in locales/).

const Step = ({ icon, title, children }) => (
  <div className="row" style={{ gap: 10, alignItems: 'flex-start', marginBottom: 10 }}>
    <span className="tag acc" style={{ minWidth: 24, textAlign: 'center', marginTop: 1 }}><Icon name={icon} style={{ fontSize: 13 }} /></span>
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

const Policy = ({ name, children }) => (
  <div className="card" style={{ marginBottom: 8 }}>
    <b>{t(name)}</b>
    <div className="muted small" style={{ lineHeight: 1.45, marginTop: 3 }}>{children}</div>
  </div>
)

export function progressionInfoSheet() {
  useUI.getState().openSheet(close => <ProgressionInfo close={close} />)
}

function ProgressionInfo({ close }) {
  return (
    <div>
      <div className="row between" style={{ alignItems: 'flex-start' }}>
        <h3 style={{ margin: 0 }}>{t('How progression works')}</h3>
        <button className="iconbtn" onClick={close} aria-label={t('Close')}><Icon name="xmark" /></button>
      </div>
      <div className="muted small" style={{ lineHeight: 1.5, marginBottom: 4 }}>
        {t('The app reads your finished workouts and suggests the next target for each exercise. Pick a rule, and weights, reps or time go up on their own — while the reason is always shown.')}
      </div>

      <Sec title={t('How a session is judged')}>
        <Step icon="check" title={t('A set counts as hit')}>{t('Only sets you checked off with at least the planned reps (or full time for timed holds). Everything else counts as a miss.')}</Step>
        <Step icon="arrowUp" title={t('Hits move the target up')}>{t('When every set is hit, the app raises the load by the step — more weight, more reps, or more time, depending on the rule.')}</Step>
        <Step icon="arrowDown" title={t('Misses trigger a deload')}>{t('Consecutive missed sessions roll the load back (the default is a 10% drop, sooner for Greyskull) so you rebuild from a manageable weight.')}</Step>
      </Sec>

      <Sec title={t('Pick a rule')}>
        <Policy name={t('No automatic progression')}>{t('Targets stay exactly where you set them. The app never changes them on its own.')}</Policy>
        <Policy name={t('Linear progression')}>{t('Hit every rep in every set and the weight goes up by the step. Three stalled sessions in a row trigger a deload. Simple and effective for beginners.')}</Policy>
        <Policy name={t('Greyskull LP')}>{t('Two straight sets plus a final set taken to failure. Beat the target on the final set and the weight goes up — beat it by doubling the reps and it goes up double. A single failure resets the weight by 10%.')}</Policy>
        <Policy name={t('Double progression')}>{t('Work up through a rep range at the same weight, for example 8–12. Reach the top of the range in every set and the weight goes up while reps drop back to the bottom. Reach the bottom again? Add a set instead.')}</Policy>
        <Policy name={t('Add time')}>{t('For timed holds: keep every set for the full duration and the target time increases by the step.')}</Policy>
      </Sec>

      <Sec title={t('Adjustment step')}>
        <Step icon="chartLine" title={t('Default by body part')}>{t('Lower-body lifts (legs, back, glutes) normally step by 5 kg, upper body by 2.5 kg. You can change the step per exercise.')}</Step>
        <Step icon="weight" title={t('Bodyweight exercises')}>{t('Progress in reps or sets instead of weight — there is no meaningful “deload” for push-ups. Past six sets the app suggests adding weight or a harder variation.')}</Step>
      </Sec>

      <Sec title={t('Where to set it')}>
        <Step icon="list" title={t('One rule for the whole routine')}>{t('Set in the program editor: applies to every exercise that does not set its own rule.')}</Step>
        <Step icon="dumbbell" title={t('Per exercise')}>{t('Open an exercise in the program and choose “Follow the routine” or its own rule and step.')}</Step>
      </Sec>
    </div>
  )
}