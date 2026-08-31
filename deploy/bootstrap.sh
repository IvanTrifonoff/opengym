#!/usr/bin/env bash
# deploy/bootstrap.sh — разворачивание openGym prod (main) на чистой VPS.
#
# Предназначение: подготовить прод-стек для impulse.trfnv.ru на отдельной VPS.
# Стек самодостаточен (deploy/docker-compose.prod.yml: db+redis+api+web),
# наружу торчит только host-nginx → web (127.0.0.1:8180).
#
# Использование:
#   bash deploy/bootstrap.sh [домен] [git-ref]
#   домен по умолчанию: impulse.trfnv.ru
#   git-ref по умолчанию: main (только проверенные релизы через тег)
# Пример ручного деплоя конкретного тега:
#   bash deploy/bootstrap.sh impulse.trfnv.ru v1.0.0
set -euo pipefail

DOMAIN="${1:-impulse.trfnv.ru}"
REF="${2:-main}"
APP_DIR="/opt/opengym-prod"
BRANCH_SPEC="${REF}"

echo "==> [1/9] Docker"
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh
fi
docker compose version >/dev/null
command -v nginx >/dev/null || { apt-get update -qq && apt-get install -y -qq nginx; }
command -v certbot >/dev/null || apt-get install -y -qq certbot python3-certbot-nginx
mkdir -p /var/www/letsencrypt /var/lib/letsencrypt

echo "==> [2/9] Код (ref: $REF)"
if [ ! -d "$APP_DIR" ]; then
  git clone https://github.com/IvanTrifonoff/opengym.git "$APP_DIR"
fi
cd "$APP_DIR"
git fetch origin --tags --force
git checkout "$BRANCH_SPEC" || git checkout -B "$BRANCH_SPEC" origin/"$BRANCH_SPEC"

echo "==> [3/9] .env ($DOMAIN)"
if [ ! -f .env ]; then
  POSTGRES_PASSWORD="$(openssl rand -hex 16)"
  cat > .env <<EOF
RP_ID=$DOMAIN
ORIGIN=https://$DOMAIN
WEB_PORT=127.0.0.1:8180
RP_NAME=openGym
INVITE_ONLY=1
SESSION_DAYS=30
POSTGRES_USER=opengym
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
POSTGRES_DB=opengym
EOF
  chmod 600 .env
  echo "  .env создан: POSTGRES_PASSWORD сгенерирован. Впиши ADMIN_UIDS после первой регистрации."
elif ! grep -q '^POSTGRES_PASSWORD=' .env; then
  echo "POSTGRES_PASSWORD=$(openssl rand -hex 16)" >> .env
fi

echo "==> [4/9] Каталог данных и медиа"
mkdir -p data
# медиа уже закоммичены в репозиторий (media/img, media/gif) — копий не нужно.
# Первый вызов копирует секреты data/ если их ещё нет.
if [ ! -f data/secret ] && [ -n "${SEED_DATA_FROM:-}" ]; then
  scp -q -r "${SEED_DATA_FROM}:/opt/opengym/data/." data/ 2>/dev/null || echo "  (нет SEED_DATA_FROM — пропуск копии секретов)"
fi

echo "==> [5/9] Сборка и запуск прод-стека"
docker compose -f docker-compose.prod.yml up -d --build
echo "  Ожидание health api…"
for i in $(seq 1 12); do
  sleep 5
  if curl -fsS "http://127.0.0.1:8180/api/health" >/dev/null 2>&1; then
    echo "  ✓ api healthy"; break
  fi
done

echo "==> [6/9] Nginx (host) — сайт $DOMAIN"
cat > /etc/nginx/sites-available/$DOMAIN.conf <<EOF
# openGym prod: $DOMAIN
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;

    location ^~ /.well-known/acme-challenge/ {
        root /var/www/letsencrypt;
        default_type text/plain;
        try_files \\$uri =404;
    }

    location / {
        return 301 https://\\$host\\$request_uri;
    }
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name $DOMAIN;

    ssl_certificate /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;
    include /etc/letsencrypt/options-ssl-dhparams.pem;

    client_max_body_size 6m;

    location = /promo {
        proxy_pass http://127.0.0.1:8180/promo.html;
        proxy_set_header Host \\$host;
        proxy_set_header X-Forwarded-Proto https;
    }

    location / {
        proxy_pass http://127.0.0.1:8180;
        proxy_http_version 1.1;
        proxy_set_header Host \\$host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header Upgrade \\$http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
EOF
ln -sf /etc/nginx/sites-available/$DOMAIN.conf /etc/nginx/sites-enabled/$DOMAIN.conf

echo "==> [7/9] TLS ($DOMAIN)"
# Сначала http-конфиг без ssl, чтобы acme-challenge работал
if [ ! -d "/etc/letsencrypt/live/$DOMAIN" ]; then
  curl -fsS -o /dev/null "http://$DOMAIN/.well-known/acme-challenge/probe" || true  # убеждаемся что 80 открыт
  certbot certonly --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "admin@$DOMAIN" \
    || certbot certonly --webroot -w /var/www/letsencrypt -d "$DOMAIN" \
       --non-interactive --agree-tos -m "admin@$DOMAIN" \
    || echo "!!! certbot: выпусти сертификат вручную, когда DNS будет резолвить на этот сервер."
fi
nginx -t && systemctl reload nginx || systemctl restart nginx

echo "==> [8/9] Проверка"
curl -fsS "http://127.0.0.1:8180/api/health" && echo "" || echo "(!) api не отвечает — смотри docker logs"
curl -fsSI "https://$DOMAIN" | head -3 || true
echo "  ↳ домен: $DOMAIN | стек: opengym-prod | БД/Redis внутри compose"

echo "==> [9/9] Готово"
echo "  Дальше: зарегистрируй владельца → впиши ADMIN_UIDS в /opt/opengym-prod/.env → перезапусти стек."