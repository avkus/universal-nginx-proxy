# nginx/Dockerfile

# Используем alpine-версию Nginx
FROM nginx:alpine

# Устанавливаем gettext для утилиты envsubst
RUN apk add --no-cache gettext

# Копируем шаблон конфигурации
COPY nginx.conf.template /etc/nginx/nginx.conf.template

# Копируем скрипт запуска
COPY entrypoint.sh /docker-entrypoint.d/20-envsubst-on-templates.sh

# Даем права на выполнение
RUN chmod +x /docker-entrypoint.d/20-envsubst-on-templates.sh