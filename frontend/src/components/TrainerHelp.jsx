import { useUI } from '../store/useUI.js'
import Icon from './Icon.jsx'
import { Button } from './ui.jsx'

// Detailed in-app instruction for the trainer portal (/trainer).
// Opens as a bottom sheet from the header of the trainer portal.

const Field = ({ name, children }) => (
  <div style={{ marginBottom: 10 }}>
    <div className="small" style={{ fontWeight: 600, marginBottom: 2 }}>{name}</div>
    <div className="muted small" style={{ lineHeight: 1.45 }}>{children}</div>
  </div>
)

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

export function trainerHelpSheet() {
  useUI.getState().openSheet(close => <TrainerHelp close={close} />)
}

function TrainerHelp({ close }) {
  return (
    <div>
      <div className="row between" style={{ alignItems: 'flex-start' }}>
        <h3 style={{ margin: 0 }}>Тренерский портал</h3>
        <button className="iconbtn" onClick={close} aria-label="Закрыть"><Icon name="xmark" /></button>
      </div>
      <div className="muted small" style={{ lineHeight: 1.5, marginBottom: 4 }}>
        Ваш личный кабинет: только ваши спортсмены, их программы, прогресс и записи на тренировки.
      </div>

      <Sec title="Вкладка «Спортсмены» — список">
        <Field name="Что вы видите">Список ваших спортсменов: имя, статус (Новый / Активен / В зоне риска / Ушёл), визиты, тренировки, серия недель, частота посещений и последняя активность. Фильтры по статусу и поиск по имени.</Field>
        <Field name="Карточка спортсмена">Клик по спортсмену открывает полную карточку: активность по неделям, лучшие результаты, вес тела, баллы лояльности и награды. Там же кнопка «Программа».</Field>
      </Sec>

      <Sec title="Вкладка «Добавить» — новые спортсмены">
        <Step n={1} title="Новый спортсмен">Создайте ссылку-приглашение и отправьте её спортсмену. Когда он зарегистрируется по ней в приложении, он автоматически появится в вашем списке.</Step>
        <Step n={2} title="Уже зарегистрирован">Найдите спортсмена по имени и нажмите «Добавить» — или «Забрать себе», если он сейчас у другого тренера. Спортсмен может быть закреплён только за одним тренером.</Step>
      </Sec>

      <Sec title="Программа спортсмена (карточка → «Программа»)">
        <Field name="Вкладка «Программа»">Дни недели и привязка программ; создание, переименование и удаление программ; добавление упражнений из каталога (пикер с поиском); правка подходы × повторения × вес прямо в списке; порядок упражнений (вверх/вниз). Не забудьте «Сохранить изменения» — после этого спортсмен увидит план в приложении.</Field>
        <Field name="Вкладка «Прогресс»">Статистика по каждому упражнению из реальных логов спортсмена: лучший вес, сколько подходов сделано из запланированных, история по датам с весами (например «24 авг. — 65 × 6, 65 × 6»).</Field>
      </Sec>

      <Sec title="Вкладка «Календарь» — расписание">
        <Field name="Часы работы">У каждого дня (Вс–Сб) свой список интервалов. «+ Интервал» добавляет ещё один (например 09:00–12:00 и 16:00–21:00), «×» убирает. Пустой день — выходной.</Field>
        <Field name="Сетка недели">Свободные и занятые слоты по дням — видно, когда спортсмены уже записаны.</Field>
        <Field name="Заявки">Спортсмены записываются сами. Вы подтверждаете или отклоняете их заявки.</Field>
        <Field name="«Записать»">Можно записать спортсмена самостоятельно — такая запись сразу подтверждена.</Field>
      </Sec>

      <Sec title="Полезные советы">
        <div className="card" style={{ marginBottom: 8 }}><b>Привлекайте спортсменов</b><div className="muted small">Дайте ссылку-приглашение из вкладки «Добавить» — новые клиенты сразу окажутся у вас в списке.</div></div>
        <div className="card" style={{ marginBottom: 8 }}><b>Задайте часы работы</b><div className="muted small">Без часов в «Календаре» спортсмены не смогут записаться к вам на занятие.</div></div>
        <div className="card" style={{ marginBottom: 8 }}><b>Ведите программы</b><div className="muted small">Составьте план упражнений — спортсмен увидит его в приложении, а вы — его прогресс по весам и подходам во вкладке «Прогресс».</div></div>
        <div className="card"><b>Безопасность</b><div className="muted small">Вы видите и редактируете только своих спортсменов. Доступ к чужим спортсменам и их программам закрыт.</div></div>
      </Sec>

      <Button variant="primary" onClick={close} style={{ marginTop: 18 }}>Понятно</Button>
    </div>
  )
}
