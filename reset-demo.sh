#!/bin/bash
# reset-demo.sh — сброс демо-стенда (demo.gym.trfnv.ru) в эталонное состояние.
#
# Зачем: перед показом инвестору/клиенту демо должно быть ЧИСТЫМ — ни одного
# клона, ни одной сессии, ни тестовых данных. Раньше это делалось SQL вручную;
# теперь одна команда, ~2 секунды.
#
# Что делает (по слоям хранилища, см. docs/AGENT_GUIDE.md «Где что лежит»):
#   1. Останавливает api + web (БД и redis остаются жить) — чтобы in-memory
#      db.json у api не перезаписал файлы после очистки.
#   2. TRUNCATE всех таблиц PostgreSQL демо (admin/loyalty/аналитика/расписание).
#   3. Обнуляет db.json (users/creds/subs/invites) и удаляет state-*.json
#      (состояния атлетов). secret и vapid.json НЕ трогаем — это ключи.
#      Файлы в data/ принадлежат root (api-контейнер пишет от root) — поэтому
#      файловые операции идут через sudo.
#   4. Поднимает api + web и проверяет /api/config.
#
# Безопасность: скрипт привязан к демо-каталогу (/opt/opengym-demo) и
# работает ТОЛЬКО с его композом (docker-compose.demo.yml) и его БД
# (opengym-demo-db-1). Прод gym.trfnv.ru не задевается никогда.
set -euo pipefail
cd "$(dirname "$0")"

# ── Защита от человеческого фактора (v1.4.1) ──
# reset-demo.sh ТРОГАЕТ данные (TRUNCATE + удаление state-файлов). Он обязан
# запускаться из /opt/opengym-demo — из прод-чекаута /opt/opengym он
# остановил бы и почистил бы ПРОД-стек.
EXPECT_DIR="/opt/opengym-demo"
if [ "$(pwd)" != "$EXPECT_DIR" ]; then
  echo "ОШИБКА: reset-demo.sh запущен из $(pwd). Демо-каталог: ${EXPECT_DIR}. Прервано." >&2
  exit 1
fi
if ! grep -q '^DEMO_MODE=1' .env 2>/dev/null; then
  echo "ОШИБКА: в $(pwd)/.env нет DEMO_MODE=1 — это не демо-окружение. Прервано." >&2
  exit 1
fi
BRANCH_GUARD="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo not-a-repo)"
if [ "$BRANCH_GUARD" != "demo" ]; then
  echo "ОШИБКА: ожидалась ветка demo, сейчас: $BRANCH_GUARD. Прервано." >&2
  exit 1
fi

echo "── [1/5] Остановка api + web (БД/redis остаются) ──"
docker compose -f docker-compose.demo.yml stop api web

echo "── [2/5] Очистка PostgreSQL демо ──"
docker exec opengym-demo-db-1 psql -U "${POSTGRES_USER:-opengym}" -d "${POSTGRES_DB:-opengym}" -c "
TRUNCATE TABLE
  access_events, admin_credentials, admin_invites, admin_users, app_notifications,
  app_settings, athlete_metrics, branches, coach_bookings, demo_sessions, demo_tokens,
  external_member_bindings, loyalty_accounts, loyalty_achievements, loyalty_events,
  loyalty_ledger, loyalty_outbox, loyalty_redemptions, loyalty_rewards, loyalty_rules,
  loyalty_unlocks, private_codes, promo_leads, recurring_bookings, recurring_skips,
  trainer_assignments, trainer_availability, visits
RESTART IDENTITY CASCADE;" | tail -1

echo "── [3/5] Очистка файлового хранилища (db.json + state-*.json) ──"
sudo python3 - <<'EOF'
import json, glob, os
data = 'data'
p = os.path.join(data, 'db.json')
d = json.load(open(p, encoding='utf-8'))
for k in ('users', 'creds', 'subs', 'invites'):
    d[k] = []
json.dump(d, open(p, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
removed = 0
for f in glob.glob(os.path.join(data, 'state-*.json')):
    os.remove(f); removed += 1
print(f'db.json обнулён, state-файлов удалено: {removed}')
EOF

echo "── [4/5] Запуск api + web ──"
docker compose -f docker-compose.demo.yml up -d api web | tail -2

echo "── [5/5] Проверка ──"
for i in $(seq 1 30); do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' https://demo.gym.trfnv.ru/api/config 2>/dev/null || echo 000)
  [ "$CODE" = "200" ] && break
  sleep 2
done
echo "config: HTTP $CODE"
CNT=$(docker exec opengym-demo-db-1 psql -U "${POSTGRES_USER:-opengym}" -d "${POSTGRES_DB:-opengym}" -tAc "SELECT count(*) FROM admin_users")
echo "админов в демо-БД: $CNT (ожидаем 0)"
echo "✓ Демо-стенд сброшен в эталонное состояние"