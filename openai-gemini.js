// Cloudflare Worker: OpenAI-to-Gemini Connector v2.1
// Интегрирован с Nginx прокси и поддерживает эндпоинты /models, /chat/completions, /embeddings

// --- Вспомогательные классы и функции ---

class HttpError extends Error {
  constructor(message, status) {
    super(message);
    this.name = this.constructor.name;
    this.status = status;
  }
}

const fixCors = ({ headers, status, statusText }) => {
  headers = new Headers(headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Master-Key, x-goog-api-key");
  return { headers, status, statusText };
};

const assert = (success) => {
  if (!success) {
    throw new HttpError("The specified HTTP method is not allowed for the requested resource", 400);
  }
};

const generateId = () => {
  const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const randomChar = () => characters[Math.floor(Math.random() * characters.length)];
  return Array.from({ length: 29 }, randomChar).join("");
};

// --- Функция для перенаправления запросов через Nginx ---

async function forwardToNginxProxy(url, options = {}, env) {
  const { GCP_PROXY_URL, NGINX_INTERNAL_SECRET } = env;

  if (!GCP_PROXY_URL || !NGINX_INTERNAL_SECRET) {
    throw new HttpError("Proxy configuration error: GCP_PROXY_URL or NGINX_INTERNAL_SECRET is not set.", 500);
  }

  const targetUrl = new URL(url);
  const proxyTargetHost = targetUrl.hostname;
  const nginxUrl = `${GCP_PROXY_URL}${targetUrl.pathname}${targetUrl.search}`;

  const newHeaders = new Headers(options.headers);
  newHeaders.set('X-Proxy-Target', proxyTargetHost);
  newHeaders.set('X-Worker-Auth', NGINX_INTERNAL_SECRET);

  const newOptions = { ...options, headers: newHeaders };

  return fetch(nginxUrl, newOptions);
}

// --- Функции-трансформеры ---

const makeGoogleHeaders = (googleApiKey, more) => {
  const headers = new Headers(more);
  headers.set("x-goog-api-client", "genai-js/0.21.0");
  if (googleApiKey) {
    headers.set("x-goog-api-key", googleApiKey);
  }
  return headers;
};

const harmCategory = [
    "HARM_CATEGORY_HATE_SPEECH", "HARM_CATEGORY_SEXUALLY_EXPLICIT",
    "HARM_CATEGORY_DANGEROUS_CONTENT", "HARM_CATEGORY_HARASSMENT"
];
const safetySettings = harmCategory.map((category) => ({ category, threshold: "BLOCK_NONE" }));

const fieldsMap = {
    frequency_penalty: "frequencyPenalty", max_tokens: "maxOutputTokens", n: "candidateCount",
    presence_penalty: "presencePenalty", seed: "seed", stop: "stopSequences",
    temperature: "temperature", top_k: "topK", top_p: "topP"
};

const adjustProps = (schemaPart) => {
    if (typeof schemaPart !== "object" || schemaPart === null) return;
    if (Array.isArray(schemaPart)) {
        schemaPart.forEach(adjustProps);
    } else {
        delete schemaPart.$schema;
        delete schemaPart.additionalProperties;
        delete schemaPart.strict;
        Object.values(schemaPart).forEach(adjustProps);
    }
};

const adjustSchema = (schema) => {
    adjustProps(schema);
    return schema;
};

const transformConfig = (req) => {
    let cfg = {};
    for (let key in req) {
        const matchedKey = fieldsMap[key];
        if (matchedKey) cfg[matchedKey] = req[key];
    }
    if (req.response_format?.type === "json_object") {
        cfg.responseMimeType = "application/json";
    }
    return cfg;
};

const parseImg = async (url, env) => {
    let mimeType, data;
    if (url.startsWith("http")) {
        const response = await forwardToNginxProxy(url, {}, env);
        if (!response.ok) throw new Error(`Image fetch failed: ${response.status}`);
        mimeType = response.headers.get("content-type") || "application/octet-stream";
        data = btoa(String.fromCharCode(...new Uint8Array(await response.arrayBuffer())));
    } else {
        const match = url.match(/^data:(?<mimeType>.*?)(;base64)?,(?<data>.*)$/);
        if (!match?.groups) throw new HttpError("Invalid image data", 400);
        ({ mimeType, data } = match.groups);
    }
    return { inlineData: { mimeType, data } };
};

const transformMsg = async (item, env) => {
    if (typeof item.content === "string") return [{ text: item.content }];
    const parts = [];
    for (const sub of item.content) {
        if (sub.type === "text") parts.push({ text: sub.text });
        if (sub.type === "image_url") parts.push(await parseImg(sub.image_url.url, env));
    }
    return parts;
};

const transformMessages = async (messages, env) => {
    const contents = [];
    let system_instruction;
    for (const item of messages) {
        switch (item.role) {
            case "system":
                system_instruction = { parts: await transformMsg(item, env) };
                continue;
            case "assistant":
                item.role = "model";
                break;
            case "user": break;
            default: throw new HttpError(`Unknown role: ${item.role}`, 400);
        }
        contents.push({ role: item.role, parts: await transformMsg(item, env) });
    }
    return { contents, system_instruction };
};

const transformTools = (req) => {
    let tools;
    const declarations = [];

    if (req.tools) {
        const funcs = req.tools.filter(tool => tool.type === "function");
        if (funcs.length > 0) {
            funcs.forEach(adjustSchema);
            declarations.push({ function_declarations: funcs.map(f => f.function) });
        }
    }

    if (req.use_grounding === true) {
        declarations.push({ "googleSearch": {} });
        delete req.use_grounding;
    }

    if (declarations.length > 0) {
        tools = declarations;
    }
    
    let tool_config;
    // Note: tool_choice logic can be expanded here if needed
    
    return { tools, tool_config };
};

const transformRequest = async (req, env) => ({
    ...await transformMessages(req.messages, env),
    safetySettings,
    generationConfig: transformConfig(req),
    ...transformTools(req),
});

const transformCandidates = (key, cand) => {
    const message = { role: "assistant", content: null };
    if (cand.content?.parts) {
      const texts = [];
      for (const part of cand.content.parts) {
        if (part.text) texts.push(part.text);
        if (part.functionCall) {
          message.tool_calls = message.tool_calls || [];
          message.tool_calls.push({
            id: `call_${generateId()}`, type: "function",
            function: { name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args) }
          });
        }
      }
      if(texts.length > 0) message.content = texts.join('');
    }
    const finishReasonMap = {
        "STOP": "stop",
        "MAX_TOKENS": "length",
        "SAFETY": "content_filter",
        "RECITATION": "content_filter",
    };
    return {
        index: cand.index || 0,
        [key]: message,
        finish_reason: message.tool_calls ? "tool_calls" : (finishReasonMap[cand.finishReason] || cand.finishReason?.toLowerCase())
    };
};
const transformCandidatesMessage = transformCandidates.bind(null, "message");

const processCompletionsResponse = (data, model) => {
    const obj = {
        id: "chatcmpl-" + generateId(),
        choices: (data.candidates || []).map(transformCandidatesMessage),
        created: Math.floor(Date.now() / 1000),
        model, object: "chat.completion",
    };
    if (data.usageMetadata) {
        obj.usage = {
            completion_tokens: data.usageMetadata.candidatesTokenCount,
            prompt_tokens: data.usageMetadata.promptTokenCount,
            total_tokens: data.usageMetadata.totalTokenCount
        };
    }
    return JSON.stringify(obj);
};

// --- Основные обработчики эндпоинтов ---

async function handleModels(env) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models`;
    const response = await forwardToNginxProxy(url, { headers: makeGoogleHeaders(env.GOOGLE_API_KEY) }, env);
    
    if (!response.ok) return new Response(response.body, fixCors(response));
    
    const { models } = await response.json();
    const body = JSON.stringify({
        object: "list",
        data: models.map(({ name }) => ({ id: name.replace("models/", ""), object: "model", created: 0, owned_by: "google" }))
    });
    return new Response(body, fixCors(response));
}

async function handleCompletions(req, env) {
    let model = req.model || "gemini-1.5-flash-latest";
    model = model.replace(/^models\//, "");

    const body = await transformRequest(req, env);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

    const response = await forwardToNginxProxy(url, {
        method: "POST",
        headers: makeGoogleHeaders(env.GOOGLE_API_KEY, { "Content-Type": "application/json" }),
        body: JSON.stringify(body)
    }, env);

    if (!response.ok) return new Response(response.body, fixCors(response));

    const responseBody = processCompletionsResponse(await response.json(), model);
    return new Response(responseBody, fixCors(response));
}

async function handleEmbeddings(req, env) {
    const model = req.model || "text-embedding-004";
    const inputs = Array.isArray(req.input) ? req.input : [req.input];

    const body = {
      requests: inputs.map(text => ({
        model: `models/${model}`,
        content: { parts: [{ text }] }
      }))
    };
    
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:batchEmbedContents`;

    const response = await forwardToNginxProxy(url, {
        method: "POST",
        headers: makeGoogleHeaders(env.GOOGLE_API_KEY, { "Content-Type": "application/json" }),
        body: JSON.stringify(body)
    }, env);

    if (!response.ok) return new Response(response.body, fixCors(response));

    const { embeddings } = await response.json();
    const responseBody = JSON.stringify({
      object: "list",
      data: embeddings.map(({ values }, index) => ({
        object: "embedding",
        index,
        embedding: values
      })),
      model,
      usage: {
        prompt_tokens: 0, // Gemini API doesn't provide token usage for embeddings
        total_tokens: 0
      }
    });
    return new Response(responseBody, fixCors(response));
}

// --- Главный обработчик Worker'а ---

export default {
    async fetch(request, env) {
        const ts = new Date().toISOString();
        const logPrefix = `[GEMINI-CONNECTOR][${ts}]`;

        // 1. Аутентификация
        const clientMasterKey = request.headers.get('X-Master-Key');
        if (!env.MASTER_API_KEY || clientMasterKey !== env.MASTER_API_KEY) {
            console.log(`${logPrefix}[AUTH_FAIL] Unauthorized: Invalid X-Master-Key.`);
            return new Response('Unauthorized: Missing or invalid X-Master-Key for proxy.', { status: 401 });
        }
        console.log(`${logPrefix}[AUTH_SUCCESS] Proxy Authorization successful via X-Master-Key.`);

        // 2. Обработка CORS
        if (request.method === "OPTIONS") {
            return new Response(null, fixCors({ headers: new Headers() }));
        }

        const errHandler = (err) => {
            console.error(`${logPrefix}[ERROR]`, err);
            return new Response(err.message, fixCors({ status: err.status ?? 500 }));
        };

        // 3. Маршрутизация запроса
        try {
            const { pathname } = new URL(request.url);
            console.log(`${logPrefix}[REQUEST_IN] Path: ${pathname}`);

            switch (true) {
                case pathname.endsWith("/chat/completions"):
                    assert(request.method === "POST");
                    return handleCompletions(await request.json(), env).catch(errHandler);
                
                case pathname.endsWith("/models"):
                    assert(request.method === "GET");
                    return handleModels(env).catch(errHandler);
                
                case pathname.endsWith("/embeddings"):
                    assert(request.method === "POST");
                    return handleEmbeddings(await request.json(), env).catch(errHandler);
                
                default:
                    throw new HttpError(`Not Found: The requested endpoint does not exist.`, 404);
            }
        } catch (err) {
            return errHandler(err);
        }
    }
};