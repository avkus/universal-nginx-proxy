#!/bin/sh
# nginx/entrypoint.sh

set -e

# Подставляем переменные окружения в шаблон и создаем финальный конфиг
envsubst '${NGINX_INTERNAL_SECRET}' < /etc/nginx/nginx.conf.template > /etc/nginx/nginx.conf

exit 0