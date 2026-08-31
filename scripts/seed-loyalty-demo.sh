#!/usr/bin/env bash
# seed_loyalty.sh — наполнение лояльности демо-данными (презентация).
# Сценарии:
#   Artem     — активный лоялист: регулярные визиты+тренировки, стрики, реферал (привёл Maxim), погашает награду
#   Testuser1 — угасший: редкие визиты без тренировок и стриков
#   Maxim     — новичок: приветственный реферальный бонус + стартовые визиты/тренировки
set -euo pipefail

BASE="http://127.0.0.1:8180"
SECRET=$(grep ACCESS_WEBHOOK_SECRET /opt/opengym/.env | cut -d= -f2)
ARTEM="i8W5X7j1Gquql7uE"
TESTU="VAd_XBGcCxvmffXf"
MAXIM="0trlLXDB5FsP5EYKzze39"

post() { # event_id user_id event_type occurred_at
  curl -s -X POST "$BASE/api/integrations/loyalty/events" \
    -H 'Content-Type: application/json' \
    -H "x-opengym-webhook-secret: $SECRET" \
    -d "{\"event_id\":\"$1\",\"user_id\":\"$2\",\"event_type\":\"$3\",\"occurred_at\":\"$4\"}" >/dev/null
}

echo "==> Artem (активный): 10 визитов + 6 тренировок + стрик + реферал"
# визиты — понедельник/среда/пятница 3 недели + ещё один
post "art-visit-01" "$ARTEM" "visit" "2026-08-10T09:00:00Z"
post "art-visit-02" "$ARTEM" "visit" "2026-08-12T09:05:00Z"
post "art-visit-03" "$ARTEM" "visit" "2026-08-14T18:30:00Z"
post "art-visit-04" "$ARTEM" "visit" "2026-08-17T09:10:00Z"
post "art-visit-05" "$ARTEM" "visit" "2026-08-19T18:00:00Z"
post "art-visit-06" "$ARTEM" "visit" "2026-08-21T09:00:00Z"
post "art-visit-07" "$ARTEM" "visit" "2026-08-24T18:15:00Z"
post "art-visit-08" "$ARTEM" "visit" "2026-08-26T09:05:00Z"
post "art-visit-09" "$ARTEM" "visit" "2026-08-28T18:20:00Z"
post "art-visit-10" "$ARTEM" "visit" "2026-08-29T09:00:00Z"
# тренировки (workout_completed) — совпадают с днями визитов
post "art-wk-01" "$ARTEM" "workout_completed" "2026-08-10T10:00:00Z"
post "art-wk-02" "$ARTEM" "workout_completed" "2026-08-12T10:05:00Z"
post "art-wk-03" "$ARTEM" "workout_completed" "2026-08-17T10:10:00Z"
post "art-wk-04" "$ARTEM" "workout_completed" "2026-08-19T19:00:00Z"
post "art-wk-05" "$ARTEM" "workout_completed" "2026-08-24T19:15:00Z"
post "art-wk-06" "$ARTEM" "workout_completed" "2026-08-28T19:20:00Z"
# стрик — 3+ тренировки подряд на прошлой неделе
post "art-streak-1" "$ARTEM" "streak" "2026-08-25T08:00:00Z"
# реферал — привёл Maxim
post "art-ref-maxim" "$ARTEM" "referral" "2026-08-20T12:00:00Z"

echo "==> Testuser1 (угасший): 3 визита за месяц, без тренировок"
post "tu-visit-01" "$TESTU" "visit" "2026-08-05T11:00:00Z"
post "tu-visit-02" "$TESTU" "visit" "2026-08-15T11:30:00Z"
post "tu-visit-03" "$TESTU" "visit" "2026-08-28T11:10:00Z"

echo "==> Maxim (новичок): приветственный реферальный бонус + 3 визита + 3 тренировки"
post "mx-visit-01" "$MAXIM" "visit" "2026-08-22T10:00:00Z"
post "mx-visit-02" "$MAXIM" "visit" "2026-08-24T10:30:00Z"
post "mx-visit-03" "$MAXIM" "visit" "2026-08-26T10:15:00Z"
post "mx-wk-01" "$MAXIM" "workout_completed" "2026-08-22T11:00:00Z"
post "mx-wk-02" "$MAXIM" "workout_completed" "2026-08-24T11:30:00Z"
post "mx-wk-03" "$MAXIM" "workout_completed" "2026-08-26T11:15:00Z"

echo "==> Готово. Итоги по кошелькам:"
docker exec -e PGPASSWORD=$(docker exec retail_db printenv POSTGRES_PASSWORD) retail_db \
  psql -U opengym -d opengym -tAc \
  "SELECT user_id, balance FROM loyalty_accounts WHERE user_id IN ('$ARTEM','$TESTU','$MAXIM') ORDER BY balance DESC" 2>/dev/null || true