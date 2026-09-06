import { useUI } from '../store/useUI.js'
import Icon from './Icon.jsx'
import { Button } from './ui.jsx'

// In-app instruction for the «Удержание» (Retention) analytics tab.
// Opens as a bottom sheet from the Retention view header — explains what the
// snapshot is, how the levels (активен/риск/ушёл/новый) are computed, what the
// funnel means, and how to read the per-athlete reasons.

const Field = ({ name, children }) => (
  <div style={{ marginBottom: 10 }}>
    <div className="small" style={{ fontWeight: 600, marginBottom: 2 }}>{name}</div>
    <div className="muted small" style={{ lineHeight: 1.45 }}>{children}</div>
  </div>
)

const Sec = ({ title, children }) => (
  <>
    <h4 className="sec" style={{ marginTop: 18 }}>{title}</h4>
    {children}
  </>
)

export function retentionHelpSheet() {
  useUI.getState().openSheet(close => <RetentionHelp close={close} />)
}

function RetentionHelp({ close }) {
  return (
    <div>
      <div className="row between" style={{ alignItems: 'flex-start' }}>
        <h3 style={{ margin: 0 }}>Удержание спортсменов</h3>
        <button className="iconbtn" onClick={close} aria-label="Закрыть"><Icon name="xmark" /></button>
      </div>
      <div className="muted small" style={{ lineHeight: 1.5, marginBottom: 4 }}>
        Вкладка показывает, кто из спортсменов держится в зале, а кто затухает — чтобы вы успели
        среагировать до того, как клиент уйдёт.
      </div>

      <Sec title="Откуда данные — ночной снимок">
        <Field name="Снимок раз в сутки">Все цифры пересчитываются автоматически ночью (по умолчанию в 04:00) и сохраняются в снимок. Днём вкладка читает только готовый файл — без нагрузки на базу. Сверху показано, когда был сделан снимок.</Field>
      </Sec>

      <Sec title="Статусы спортсмена">
        <Field name="Активен">Тренировался менее 14 дней назад — всё в порядке.</Field>
        <Field name="В зоне риска">Не было активности 14–30 дней, либо активность снизилась. Стоит написать, предложить тренировку, напомнить о постоянных слотах.</Field>
        <Field name="Ушёл">Нет активности больше 30 дней. Клиента можно попробовать вернуть — например, акцией или персональным предложением.</Field>
        <Field name="Новый">Зарегистрировался, но ни разу не тренировался. Главная задача — помочь сделать первую тренировку: без неё новичок чаще всего уходит.</Field>
        <Field name="Постоянник">Если у спортсмена закреплены постоянные слоты («постоянные клиенты» в календаре тренера), он никогда не помечается «Ушёл» — максимум «В зоне риска», ведь его время в расписании держится за ним.</Field>
      </Sec>

      <Sec title="Причины риска (⚠)">
        <Field name="Что это">Под статусом перечислены конкретные причины: «нет активности 2+ недели», «снижение частоты», «прогресс остановился», «меньше подходов». Это подсказки — с чего начать разговор со спортсменом.</Field>
      </Sec>

      <Sec title="Воронка удержания">
        <Field name="Как читать">Из всех, кто начал тренироваться, сколько дотянули до 4 и до 8 недель. Первый провал обычно на 2–4 неделе — именно тогда спортсмен теряет мотивацию. Если процент «доживших до 4 недель» низкий — усиливайте вовлечение новичков.</Field>
      </Sec>

      <Sec title="Фильтры">
        <Field name="По статусу">Кнопки «Все / Активен / В зоне риска / Ушёл / Новый» отфильтровывают список. Поиск по имени работает внутри выбранного статуса.</Field>
      </Sec>

      <Button variant="primary" onClick={close} style={{ marginTop: 18 }}>Понятно</Button>
    </div>
  )
}