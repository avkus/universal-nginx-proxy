#!/bin/sh
# nginx/entrypoint.sh (ИСПРАВЛЕННЫЙ)

set -e

# Подставляем ОДНУ переменную в шаблон
envsubst '${MASTER_API_KEY}' < /etc/nginx/nginx.conf.template > /etc/nginx/nginx.conf

# Запускаем nginx в foreground
exec nginx -g "daemon off;"