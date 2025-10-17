// Cloudflare Worker (Универсальный прокси с fallback-логикой)

const CONFIG = {
  allowedMethods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedOrigins: ['*'],
  enableLogging: true,
};

export default {
  async fetch(request, env, ctx) {
    // --- ПЕРЕМЕННЫЕ ОКРУЖЕНИЯ (SECRETS) ---
    const GCP_PROXY_URL = env.GCP_PROXY_URL;
    const MASTER_API_KEY = env.MASTER_API_KEY;
    const NGINX_INTERNAL_SECRET = env.NGINX_INTERNAL_SECRET;
    // ИЗМЕНЕНИЕ: Добавляем переменную для хоста по умолчанию
    const DEFAULT_UPSTREAM_HOST = env.DEFAULT_UPSTREAM_HOST;
    
    // --- API КЛЮЧИ ПРОВАЙДЕРОВ ---
    const API_KEYS = {
      'api.openai.com': env.OPENAI_API_KEY,
      'generativelanguage.googleapis.com': env.GEMINI_API_KEY,
      // Добавьте другие хосты и ключи по аналогии
    };

    if (!GCP_PROXY_URL || !NGINX_INTERNAL_SECRET) {
      return new Response('Configuration Error: Required environment variables are missing.', { status: 500 });
    }

    // Обработка CORS preflight
    if (request.method === 'OPTIONS') {
      return handleCORS(request);
    }

    // --- 1. АУТЕНТИКАЦИЯ И ОПРЕДЕЛЕНИЕ ЦЕЛИ ---
    const clientMasterKey = request.headers.get('X-Master-Key');
    if (MASTER_API_KEY && clientMasterKey !== MASTER_API_KEY) {
      return new Response('Unauthorized: Missing or invalid X-Master-Key header.', { status: 401, headers: addCORSHeaders(new Headers(), request.headers.get('Origin')) });
    }
    
    // ИЗМЕНЕНИЕ: Гибкое определение целевого хоста
    // 1. Проверяем заголовок X-Target-Host (высший приоритет).
    // 2. Если его нет, используем хост по умолчанию из переменных окружения.
    let targetHost = request.headers.get('X-Target-Host') || DEFAULT_UPSTREAM_HOST;

    const url = new URL(request.url);

    // Специальная обработка для health-чека
    if (url.pathname === '/health') {
      targetHost = new URL(GCP_PROXY_URL).hostname;
    }

    // ИЗМЕНЕНИЕ: Проверяем, что хост определен (либо из заголовка, либо по умолчанию)
    if (!targetHost) {
      return new Response('Bad Request: Target host is not defined. Set X-Target-Host header or configure DEFAULT_UPSTREAM_HOST in Worker settings.', { status: 400, headers: addCORSHeaders(new Headers(), request.headers.get('Origin')) });
    }
    
    if (CONFIG.enableLogging) {
      const source = request.headers.get('X-Target-Host') ? 'Header' : 'Default';
      console.log(`[${new Date().toISOString()}] ${request.method} ${url.pathname} -> ${targetHost} (Source: ${source})`);
    }

    // --- 2. ПОДГОТОВКА ЗАГОЛОВКОВ ДЛЯ NGINX ---
    const headers = new Headers(request.headers);
    
    headers.delete('X-Master-Key');
    headers.delete('X-Target-Host');
    
    headers.set('X-Worker-Auth', NGINX_INTERNAL_SECRET);
    headers.set('X-Proxy-Target', targetHost);
    
    if (!headers.has('Authorization') && API_KEYS[targetHost]) {
      headers.set('Authorization', `Bearer ${API_KEYS[targetHost]}`);
    }

    // --- 3. ВЫПОЛНЯЕМ ЗАПРОС К ПРОКСИ (NGINX) ---
    const proxyUrl = `${GCP_PROXY_URL}${url.pathname}${url.search}`;
    
    try {
      const proxyResponse = await fetch(proxyUrl, {
        method: request.method,
        headers: headers,
        body: request.body,
        redirect: 'follow',
      });

      // --- 4. ПОДГОТОВКА ОТВЕТА КЛИЕНТУ ---
      const responseHeaders = new Headers(proxyResponse.headers);
      addCORSHeaders(responseHeaders, request.headers.get('Origin'));
      responseHeaders.set('X-Proxy-Via', 'CF-Worker-Universal-Fallback');
      responseHeaders.set('X-Proxy-Target', targetHost);

      return new Response(proxyResponse.body, {
        status: proxyResponse.status,
        statusText: proxyResponse.statusText,
        headers: responseHeaders,
      });

    } catch (error) {
      console.error(`Fatal error:`, error.message);
      const errorHeaders = new Headers({ 'Content-Type': 'application/json' });
      addCORSHeaders(errorHeaders, request.headers.get('Origin'));
      
      return new Response(JSON.stringify({ error: 'Proxy Error', message: error.message }), { 
        status: 502, 
        headers: errorHeaders 
      });
    }
  },
};

// Вспомогательные функции CORS (без изменений)
function isOriginAllowed(requestOrigin) {
  if (!requestOrigin) return CONFIG.allowedOrigins.includes('*');
  return CONFIG.allowedOrigins.includes('*') || CONFIG.allowedOrigins.includes(requestOrigin);
}
function handleCORS(request) {
  const requestOrigin = request.headers.get('Origin');
  if (!isOriginAllowed(requestOrigin)) return new Response('CORS Forbidden', { status: 403 });
  const headers = new Headers();
  headers.set('Access-Control-Allow-Origin', requestOrigin || '*');
  headers.set('Access-Control-Allow-Methods', CONFIG.allowedMethods.join(', '));
  headers.set('Access-Control-Max-Age', '86400');
  const requestedHeaders = request.headers.get('Access-Control-Request-Headers');
  headers.set('Access-Control-Allow-Headers', requestedHeaders || 'Content-Type, Authorization, X-Master-Key, X-Target-Host');
  return new Response(null, { status: 204, headers });
}
function addCORSHeaders(headers, requestOrigin) {
  if (isOriginAllowed(requestOrigin)) {
    headers.set('Access-Control-Allow-Origin', requestOrigin || '*');
  }
  return headers;
}