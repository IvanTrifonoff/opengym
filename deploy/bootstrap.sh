#!/usr/bin/env bash
# deploy/bootstrap.sh — разворачивание openGym (dev) на чистой VPS.
# Использование: bash deploy/bootstrap.sh [домен]
# Домен по умолчанию: gym.trfnv.ru (можно передать аргументом).
set -euo pipefail

DOMAIN="${1:-gym.trfnv.ru}"
APP_DIR="/opt/opengym"
BRANCH="dev"

echo "==> [1/7] Docker"
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh
fi
docker compose version >/dev/null

echo "==> [2/7] Код"
if [ ! -d "$APP_DIR" ]; then
  git clone -b "$BRANCH" https://github.com/IvanTrifonoff/opengym.git "$APP_DIR"
fi
cd "$APP_DIR"

echo "==> [3/7] .env"
if [ ! -f .env ]; then
  cat > .env <<EOF
RP_ID=$DOMAIN
ORIGIN=https://$DOMAIN
WEB_PORT=127.0.0.1:8180
RP_NAME=openGym
INVITE_ONLY=1
SESSION_DAYS=30
EOF
  echo ".env создан: впиши ADMIN_UIDS (id своего профиля после первой регистрации) и секреты."
fi

echo "==> [4/7] Postgres (отдельный контейнер в том же стеке)"
mkdir -p /opt/opengym/data
if ! docker ps --format '{{.Names}}' | grep -qx 'opengym-db-1'; then
  docker run -d --name opengym-db \
    -e POSTGRES_USER=opengym -e POSTGRES_PASSWORD="$(openssl rand -hex 16)" -e POSTGRES_DB=opengym \
    -v opengym_pgdata:/var/lib/postgresql/data --restart unless-stopped postgres:16-alpine
fi
DBURL="postgresql://opengym:\$(docker exec opengym-db printenv POSTGRES_PASSWORD)@127.0.0.1:5432/opengym?sslmode=disable"
if grep -q '^DATABASE_URL=' .env; then
  sed -i "s#^DATABASE_URL=.*#DATABASE_URL=$DBURL#" .env
else
  echo "DATABASE_URL=$DBURL" >> .env
fi

echo "==> [5/7] Сборка и запуск стека"
docker compose up -d --build

echo "==> [6/7] Nginx + TLS"
cat > /etc/nginx/sites-available/$DOMAIN.conf <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;

    location ^~ /.well-known/acme-challenge/ {
        root /var/www/letsencrypt;
        default_type text/plain;
        try_files \$uri =404;
    }

    location / {
        return 301 https://\$host\$request_uri;
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

    # Static marketing page (served by the web container)
    location = /promo {
        proxy_pass http://127.0.0.1:8180/promo.html;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-Proto https;
    }

    location / {
        proxy_pass http://127.0.0.1:8180;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
EOF
ln -sf /etc/nginx/sites-available/$DOMAIN.conf /etc/nginx/sites-enabled/$DOMAIN.conf
nginx -t && systemctl reload nginx
certbot certonly --webroot -w /var/www/letsencrypt -d $DOMAIN --non-interactive --agree-tos -m admin@$DOMAIN || echo "certbot: получи сертификат позже (DNS может быть ещё не готов)."

echo "==> [7/7] Проверка"
curl -fsS "http://127.0.0.1:8180/api/health" || true
