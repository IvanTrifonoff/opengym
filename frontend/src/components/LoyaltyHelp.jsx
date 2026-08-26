import { useUI } from '../store/useUI.js'
import Icon from './Icon.jsx'
import { Button } from './ui.jsx'

// Detailed in-app instruction for the loyalty program builder (admin).
// Opens as a bottom sheet from the "Loyalty" and "Rewards" tabs of the admin.

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

export function loyaltyHelpSheet() {
  useUI.getState().openSheet(close => <LoyaltyHelp close={close} />)
}

function LoyaltyHelp({ close }) {
  return (
    <div>
      <div className="row between" style={{ alignItems: 'flex-start' }}>
        <h3 style={{ margin: 0 }}>Программа лояльности</h3>
        <button className="iconbtn" onClick={close} aria-label="Закрыть"><Icon name="xmark" /></button>
      </div>
      <div className="muted small" style={{ lineHeight: 1.5, marginBottom: 4 }}>
        Конструктор настраивает схему поощрения спортсменов без кода: за какие действия начислять баллы и что спортсмен сможет получить взамен.
      </div>

      <Sec title="Как это работает — 3 шага">
        <Step n={1} title="Событие">Клуб присылает события: посещение (СКУД/турникет), завершённая тренировка в приложении, реферал. Вебхук обрабатывает их автоматически.</Step>
        <Step n={2} title="Правило">На каждое событие срабатывают включённые правила: начисляют баллы, выдают достижения и награды, отправляют push-уведомление.</Step>
        <Step n={3} title="Награда">Спортсмен в приложении (Настройки → Лояльность) видит свой баланс и обменивает баллы на награды из каталога.</Step>
      </Sec>

      <Sec title="Вкладка «Loyalty» — правила начисления">
        <Field name="Шаблоны">Кнопки «Посещение», «Тренировка», «Streak», «Реферал» заполняют форму типовыми значениями — останется подправить и сохранить.</Field>
        <Field name="Название">Понятное имя правила. Видно в списке и в истории начислений спортсмена.</Field>
        <Field name="Событие">Тип события, на которое реагирует правило:
          <div style={{ marginTop: 4 }}>
            • <b>Посещение</b> — вход в клуб (СКУД / вебхук доступа);<br />
            • <b>Завершение тренировки</b> — тренировка, завершённая в приложении;<br />
            • <b>Серия тренировок</b> — серия занятий без пропусков;<br />
            • <b>Реферал</b> — новый спортсмен по вашей ссылке;<br />
            • <b>Ручное событие</b> — для внешних интеграций и ручных начислений.
          </div>
        </Field>
        <Field name="Филиал (branch_key)">Если в сети несколько залов: пусто = правило работает во всех филиалах; указанный ключ = только в этом филиале.</Field>
        <Field name="Баллы">Сколько баллов начислить за одно срабатывание. 0 — баллы не начисляются (правило работает только на достижения/уведомления).</Field>
        <Field name="Лимит">Защита от злоупотреблений: сколько раз правило может сработать за день / неделю / месяц. Пример: «Посещение» — 1 раз в день, «Тренировка» — 2 раза в день.</Field>
        <Field name="Ключ достижения">Уникальный ключ (например weekly-streak). Достижение выдаётся спортсмену один раз за всё время — удобно для серий и целей.</Field>
        <Field name="Ключ награды">Ключ награды, которую спортсмен разблокирует один раз (например free-session). Появляется в его профиле как доступная опция.</Field>
        <Field name="Уведомление">Push-сообщение спортсмену при срабатывании правила — мотивирует возвращаться.</Field>
        <Field name="Правило включено">Выключенные правила не срабатывают, но сохраняются в списке — удобно для сезонных акций.</Field>
      </Sec>

      <Sec title="Вкладка «Награды» — каталог">
        <Field name="Название и описание">Название и описание видит спортсмен в приложении. В описание можно добавить инструкцию для сотрудника («выдать абонемент на 1 занятие»).</Field>
        <Field name="Вид">Скидка / Тренировка / Товар (мерч) / Гостевой пропуск / Произвольная — категория для наглядности в каталоге.</Field>
        <Field name="Стоимость">Цена награды в баллах.</Field>
        <Field name="Запас">Сколько штук осталось; пусто = безлимит. Списывается при каждой выдаче.</Field>
        <Field name="Способ выдачи">
          <div style={{ marginTop: 4 }}>
            • <b>Подтверждение сотрудником</b> — спортсмен отправляет заявку, сотрудник выдаёт награду на ресепшене;<br />
            • <b>Автоматический одноразовый код</b> — код генерируется мгновенно при обмене, спортсмен показывает его сотруднику.
          </div>
        </Field>
        <Field name="Выключить награду">Награду можно скрыть из каталога (off), не удаляя — история заявок сохранится.</Field>
      </Sec>

      <Sec title="Заявки на выдачу">
        <Step n={1} title="Спортсмен обменял баллы">В блоке «Заявки на выдачу» появляется заявка со статусом pending и стоимостью в баллах.</Step>
        <Step n={2} title="Выдать">Подтвердить выдачу. Для наград с авто-кодом здесь показан сгенерированный одноразовый код.</Step>
        <Step n={3} title="Отклонить">Заявка отменяется, а баллы возвращаются спортсмену на счёт.</Step>
      </Sec>

      <Sec title="Откуда берутся события">
        <div className="muted small" style={{ lineHeight: 1.5 }}>
          Посещения — из СКУД/турникетов через вебхук доступа; тренировки — из приложения; рефералы — по пригласительным ссылкам; любые другие события — через универсальный вебхук <span className="dim">/api/integrations/loyalty/events</span> (требует секрет интеграции).
        </div>
      </Sec>

      <Sec title="Примеры готовых сценариев">
        <div className="card" style={{ marginBottom: 8 }}><b>Ежедневное посещение</b><div className="muted small">Событие «Посещение», 10 баллов, лимит 1 раз в день — поощряет регулярные визиты.</div></div>
        <div className="card" style={{ marginBottom: 8 }}><b>Регулярность</b><div className="muted small">«Завершение тренировки», 25 баллов, лимит 2 раза в день — за каждую полноценную тренировку.</div></div>
        <div className="card" style={{ marginBottom: 8 }}><b>Серия недели</b><div className="muted small">«Серия тренировок», 100 баллов + достижение weekly-streak, лимит 1 раз в неделю — удерживает ритм.</div></div>
        <div className="card" style={{ marginBottom: 8 }}><b>Приведи друга</b><div className="muted small">«Реферал», 200 баллов + награда referral-bonus (бесплатная тренировка) — приводит новых клиентов.</div></div>
        <div className="card"><b>Мотивация</b><div className="muted small">В любом правиле добавьте уведомление: «Отличная неделя! Вы получили бонус» — спортсмен получит push при срабатывании.</div></div>
      </Sec>

      <Button variant="primary" onClick={close} style={{ marginTop: 18 }}>Понятно</Button>
    </div>
  )
}
