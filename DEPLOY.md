# Развёртывание openGym на новом VPS

Пошаговая инструкция переноса production с текущего сервера (82.202.141.81,
`/opt/opengym`, домен gym.trfnv.ru) на чистую VPS.

## 0. Что переносим

| Компонент | Где сейчас | Куда на новом VPS |
|---|---|---|
| Код | `/opt/opengym` (git, ветка `dev`) | `/opt/opengym` (git clone) |
| Секреты | `.env` (не коммитится), `data/secret`, `data/vapid.json` | перенести как есть |
| PostgreSQL | отдельный контейнер в том же стеке | отдельный контейнер `opengym-db` |
| Nginx + TLS | `/etc/nginx/sites-enabled/gym.trfnv.ru.conf`, Let's Encrypt | те же файлы, Let's Encrypt |
| Медиа (GIF/упражнения) | `/opt/opengym/media` (img/gif, ~140 МБ) | тот же путь, докачивается контейнером `media` |

## 1. Установка Docker

```bash
curl -fsSL https://get.docker.com | sh
```

## 2. Код

```bash
git clone -b dev https://github.com/IvanTrifonoff/opengym.git /opt/opengym
cd /opt/opengym
```

## 3. Секреты (.env не коммитится)

Скопировать со старого сервера:

```bash
scp admssh@<СТАРЫЙ>:/opt/opengym/.env /opt/opengym/.env
scp -r admssh@<СТАРЫЙ>:/opt/opengym/data /opt/opengym/data
```

В `.env` (не коммитится):

```
RP_ID=gym.trfnv.ru
ORIGIN=https://gym.trfnv.ru
WEB_PORT=127.0.0.1:8180
RP_NAME=openGym
INVITE_ONLY=1
SESSION_DAYS=30
VAPID_SUBJECT=mailto:admin@gym.trfnv.ru
DATABASE_URL=postgresql://opengym:<пароль>@<host>:5432/opengym
```

Важно: `RP_ID`/`ORIGIN` — это домен, по которому реально открывают приложение.
Passkey привязаны к RP_ID: смена домена инвалидизирует существующие passkey
(пользователям придётся регистрироваться заново). При переезде с сохранением
домена (смена DNS A-записи) passkey продолжают работать.

## 4. PostgreSQL (отдельный контейнер в том же стеке)

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
