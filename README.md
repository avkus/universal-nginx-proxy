# Универсальный AI Прокси на Cloudflare

Этот проект представляет собой высокопроизводительную и безопасную прокси-систему для работы с различными AI API (OpenAI, Google Gemini, Anthropic и др.). Система построена на базе Cloudflare Workers для пограничных вычислений и Docker-контейнеров (Nginx + Cloudflare Tunnel) для создания защищенного бэкенда.

## 🏗️ Архитектура

Запрос проходит через несколько этапов, обеспечивающих безопасность, универсальность и логирование:

```
Клиент ➡️ Cloudflare Worker ➡️ Cloudflare Tunnel ➡️ Nginx (Docker) ➡️ Целевой AI API
```

1. **Cloudflare Worker**: Точка входа. Аутентифицирует запросы, определяет целевой API, добавляет необходимые заголовки и направляет запрос в туннель.
2. **Cloudflare Tunnel**: Создает зашифрованный и стабильный туннель от сети Cloudflare до вашего Docker-контейнера, избавляя от необходимости иметь статический IP и открывать порты.
3. **Nginx**: Работает как внутренний прокси. Проверяет подлинность запроса от Worker'а и динамически перенаправляет его на конечный API (например, `api.openai.com`).

## ✨ Ключевые возможности

- **🔄 Универсальность**: Проксируйте запросы на любой API, просто указав целевой хост в заголовке `X-Target-Host`.
- **⚙️ Режим по умолчанию**: Возможность настроить хост по умолчанию для клиентов, которые не могут отправлять кастомные заголовки (например, стандартные ноды n8n).
- **🔗 Коннектор OpenAI-to-Gemini**: Включает отдельный Worker, который на лету преобразует запросы в формате OpenAI API в формат Google Gemini API, позволяя использовать Gemini в инструментах, изначально созданных для OpenAI.
- **🔒 Безопасность**:
  - Аутентификация на уровне Worker'а по `X-Master-Key`.
  - Защищенный канал между Worker'ом и Nginx с помощью общего секрета (`NGINX_INTERNAL_SECRET`).
  - Ваш сервер остается полностью изолированным от публичного интернета.
- **🚀 Простота развертывания**: Вся бэкенд-инфраструктура разворачивается одной командой `docker-compose up -d`.

## 📁 Структура проекта

```
.
├── docker-compose.yml
├── .env
└── nginx/
    ├── Dockerfile
    ├── entrypoint.sh
    └── nginx.conf.template
```

## 🚀 Установка и развертывание

### Шаг 1: Предварительные требования

- Аккаунт [Cloudflare](https://www.cloudflare.com/)
- Собственный домен, добавленный в Cloudflare
- Сервер (VDS/VPS) с установленными [Docker](https://docs.docker.com/engine/install/) и [Docker Compose](https://docs.docker.com/compose/install/)

### Шаг 2: Настройка Cloudflare Tunnel

1. В дашборде Cloudflare перейдите в `Zero Trust`
2. Откройте `Access` → `Tunnels`
3. Нажмите `Create a tunnel`, выберите `Cloudflared` и дайте ему имя (например, `ai-proxy-tunnel`)
4. На следующем шаге вы получите токен для запуска туннеля. **Скопируйте его**. Он понадобится для `CLOUDFLARED_TOKEN`
5. Настройте `Public Hostname` для туннеля:
   - **Subdomain:** `proxy` (или любое другое имя)
   - **Domain:** `your-domain.com`
   - **Service → Type:** `HTTP`
   - **Service → URL:** `nginx:8080` (это имя Docker-сервиса и его порт)
6. Сохраните туннель

### Шаг 3: Настройка бэкенда

1. Создайте файлы и папки согласно структуре, указанной выше
2. Создайте файл `.env` в корне проекта и заполните его:

```env
# .env

# Токен из дашборда Cloudflare Tunnels
CLOUDFLARED_TOKEN=ВАШ_СКОПИРОВАННЫЙ_ТОКЕН

# Сгенерируйте длинный и сложный секрет для связи Worker -> Nginx
# Можно использовать 'openssl rand -hex 32'
NGINX_INTERNAL_SECRET=ВАШ_СЛОЖНЫЙ_СЕКРЕТ
```

3. Запустите Docker-контейнеры:
```bash
docker-compose up -d
```

### Шаг 4: Развертывание Cloudflare Workers

Вам нужно создать два Worker'а и скопировать в них соответствующий код.

#### 1. Универсальный прокси (`proxy.your-domain.com`)

1. Создайте Worker в дашборде Cloudflare
2. Перейдите в `Settings` → `Variables` и добавьте **Environment Variables**:
   - `GCP_PROXY_URL` (Plain Text): `https://proxy.your-domain.com` (URL вашего туннеля)
   - `DEFAULT_UPSTREAM_HOST` (Plain Text): `api.openai.com` (Хост для n8n)
   - `MASTER_API_KEY` (Secret): Ваш главный ключ доступа к прокси
   - `NGINX_INTERNAL_SECRET` (Secret): Тот же секрет, что и в `.env` файле
3. Перейдите во вкладку `Triggers` и привяжите Worker к вашему маршруту (например, `proxy.your-domain.com/*`)

#### 2. Коннектор OpenAI-to-Gemini (`gemini.your-domain.com`)

1. Создайте второй Worker
2. Настройте его переменные окружения:
   - `GCP_PROXY_URL` (Plain Text): `https://proxy.your-domain.com`
   - `MASTER_API_KEY` (Secret): Ваш главный ключ доступа
   - `NGINX_INTERNAL_SECRET` (Secret): Тот же секрет, что и в `.env`
   - `GOOGLE_API_KEY` (Secret): Ваш API-ключ от Google AI Studio
3. Привяжите его к другому маршруту (например, `gemini.your-domain.com/*`)

## 💻 Использование

### 1. Универсальный прокси

**Запрос на хост по умолчанию (OpenAI):**
```bash
curl https://proxy.your-domain.com/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "X-Master-Key: $MASTER_API_KEY" \
  -d '{
    "model": "gpt-4o",
    "messages": [{"role":"user", "content":"Hello"}]
  }'
```

**Запрос на произвольный хост (Anthropic):**
```bash
curl https://proxy.your-domain.com/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "X-Master-Key: $MASTER_API_KEY" \
  -H "X-Target-Host: api.anthropic.com" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-3-opus-20240229",
    "messages": [{"role":"user", "content":"Hello"}],
    "max_tokens": 100
  }'
```

### 2. Gemini-коннектор

Используйте стандартный формат OpenAI, коннектор все преобразует сам.

**Получение списка моделей Gemini:**
```bash
curl https://gemini.your-domain.com/v1/models \
  -H "X-Master-Key: $MASTER_API_KEY"
```

**Запрос к чату Gemini:**
```bash
curl https://gemini.your-domain.com/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "X-Master-Key: $MASTER_API_KEY" \
  -d '{
    "model": "gemini-1.5-flash-latest",
    "messages": [
      {"role": "user", "content": "Расскажи интересный факт о космосе."}
    ]
  }'
```

## 📝 Лицензия

Этот проект распространяется под лицензией MIT. См. файл [LICENSE](LICENSE) для получения дополнительной информации.

## 🤝 Вклад в проект

Мы приветствуем вклад в развитие проекта! Пожалуйста, создайте issue или pull request для предложения изменений.

## 📞 Поддержка

Если у вас возникли вопросы или проблемы, создайте issue в репозитории или свяжитесь с нами.