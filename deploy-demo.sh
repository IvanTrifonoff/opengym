#!/usr/bin/env bash
# ============================================================================
# deploy-demo.sh — обновление демо-развёртывания (demo.gym.trfnv.ru)
# ============================================================================
# Демо-стек живёт в /opt/opengym-demo как git-чекаут ВЕТКИ demo репозитория.
# Ветка demo получает ТОЛЬКО стабильные релизы из dev (см. docs/demo-branch.md):
#   git checkout dev && git pull
#   git checkout demo && git merge dev && git push origin demo   # после релиза
# Затем здесь:
#   ./deploy-demo.sh
# Скрипт подтягивает demo, пересобирает api+web и перезапускает стек.
# .env, ./data (БД-файлы) и ./media (симлинк на прод-медиа) НЕ трогаются —
# они вне git (в .gitignore), поэтому git pull их не затирает.
# ============================================================================
set -euo pipefail

cd "$(dirname "$0")"

COMPOSE_FILE="docker-compose.demo.yml"
# Локальные правки в рабочем дереве, которые нельзя терять при pull
KEEP=(".env" "data" "media")

echo "── [1/4] git: обновление ветки demo"
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Ошибка: каталог не является git-репозиторием (ожидается чекаут demo-ветки)." >&2
  exit 1
fi
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$BRANCH" != "demo" ]; then
  echo "Ошибка: ожидалась ветка demo, сейчас: $BRANCH (git checkout demo)." >&2
  exit 1
fi
git fetch origin demo
# hard reset на origin/demo — локальные правки кода здесь не ведутся,
# а служебные каталоги (.env, data, media) в git не отслеживаются.
git reset --hard origin/demo
git clean -fd --exclude=.env --exclude=data --exclude=media --exclude=frontend/dist --exclude=node_modules --exclude=api/node_modules

echo "── [2/4] контроль: .env и data на месте"
test -f .env || { echo "Нет .env — скопируйте из .env.example (DEMO_MODE=1!)." >&2; exit 1; }
test -d data || { echo "Нет data/ — будет создан."; mkdir -p data; }
grep -q '^DEMO_MODE=1' .env || echo "⚠  ВНИМАНИЕ: DEMO_MODE не равен 1 в .env — проверьте!"

echo "── [3/4] docker: пересборка api+web"
docker compose -f "$COMPOSE_FILE" build api web

echo "── [4/4] docker: перезапуск стека"
docker compose -f "$COMPOSE_FILE" up -d

echo ""
echo "✓ Демо обновлено до $(git log --oneline -1)"
echo "  Проверка: curl -s https://demo.gym.trfnv.ru/api/config  →  {\"demo\":true,...}"
