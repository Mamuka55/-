/**
 * EPIC AI — HTTP-клиент renderer'а.
 *
 * Renderer ходит ТОЛЬКО на backend. Cookie сессии живёт в партиции
 * Electron и подставляется автоматически. Заголовок X-Epic-Client обязателен
 * для мутирующих запросов (защита от CSRF).
 */

let backendUrl = 'http://127.0.0.1:8787';

/**
 * Токен сессии для заголовка Authorization.
 *
 * Окна renderer'а работают с file://, а Chromium не отправляет cookie
 * с непрозрачного origin — поэтому токен приходит из main process через IPC
 * (канал epic:session:token) и передаётся заголовком. В браузере
 * (например, /ui/admin.html с самого backend) токена нет — работают cookie.
 */
let authToken = null;

export function setBackendUrl(url) {
  backendUrl = String(url || '').replace(/\/$/, '');
}
export function getBackendUrl() { return backendUrl; }

export async function initAuth() {
  try {
    authToken = (await window.epicAI?.invoke('epic:session:token')) ?? null;
  } catch { authToken = null; }
  return authToken;
}
export function getAuthToken() { return authToken; }

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message || `HTTP ${status}`);
    this.status = status;
    this.code = code;
  }
}

async function request(method, path, body, opts = {}) {
  const headers = { 'X-Epic-Client': 'desktop',...(opts.headers || {}) };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let res;
  try {
    res = await fetch(`${backendUrl}${path}`, {
      method,
      headers,
      credentials: 'include',
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeout ?? 60_000),
    });
  } catch (e) {
    throw new ApiError(0, 'network_error', `Backend недоступен: ${e.message}`);
  }

  // Сессия могла появиться/обновиться уже после старта окна (вход в другом
  // окне) — один раз перечитываем токен и повторяем запрос.
  if (res.status === 401 && !opts._retried) {
    const token = await initAuth();
    if (token) return request(method, path, body, {...opts, _retried: true });
  }

  const text = await res.text();
  let json = null;
  if (text) { try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 500) }; } }

  if (!res.ok) {
    throw new ApiError(res.status, json?.error ?? 'error', json?.message ?? `HTTP ${res.status}`);
  }
  return json;
}

export const api = {
  get: (p, o) => request('GET', p, undefined, o),
  post: (p, b, o) => request('POST', p, b ?? {}, o),
  put: (p, b, o) => request('PUT', p, b ?? {}, o),
  patch: (p, b, o) => request('PATCH', p, b ?? {}, o),
  del: (p, o) => request('DELETE', p, undefined, o),
};

/* ---------------- Типовые вызовы ---------------- */

export const Auth = {
  me: () => api.get('/api/auth/me'),
  logout: () => api.post('/api/auth/logout'),
  providers: () => api.get('/api/auth/providers'),
};

export const Ai = {
  ask: (mode, question) => api.post('/api/ai/ask', { mode, question }, { timeout: 90_000 }),
  search: (mode, q) => api.get(`/api/ai/search?mode=${encodeURIComponent(mode)}&q=${encodeURIComponent(q)}`),
  sources: (requestId) => api.get(`/api/ai/sources?requestId=${requestId}`),
  history: (limit = 20) => api.get(`/api/ai/history?limit=${limit}`),
  request: (id) => api.get(`/api/ai/request/${id}`),
  meta: () => api.get('/api/ai/meta'),
  /**
   * Голосовой ввод: сырая аудиозапись (Blob audio/webm) → текст.
   * Распознаёт backend (Groq Whisper); ключ API в клиент не передаётся.
   */
  transcribe: async (blob) => {
    const headers = { 'X-Epic-Client': 'desktop' };
    // П.2 раунда 34: ArrayBuffer-тело (раунд 28) не несёт неявного
    // Content-Type, а Fastify без него отвечает 415 Unsupported Media Type —
    // тип аудио ставим явно.
    headers['Content-Type'] = blob.type || 'audio/webm';
    if (authToken) headers.Authorization = `Bearer ${authToken}`;
    let res;
    try {
      res = await fetch(`${backendUrl}/api/ai/transcribe`, {
        method: 'POST', headers,
        // ArrayBuffer вместо Blob: известный Content-Length убирает chunked
        // data-pipe upload, из-за которого Chromium логил
        // «chunked_data_pipe_upload_data_stream.cc OnSizeReceived failed» (п.1 раунда 28).
        body: await blob.arrayBuffer(),
        credentials: 'include',
        signal: AbortSignal.timeout(90_000),
      });
    } catch (e) {
      throw new ApiError(0, 'network_error', `Backend недоступен: ${e.message}`);
    }
    const text = await res.text();
    let json = null;
    if (text) { try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 300) }; } }
    if (!res.ok) throw new ApiError(res.status, json?.error ?? 'error', json?.message ?? `HTTP ${res.status}`);
    return json;
  },
  /** Дневной лимит запросов: { used, limit, left, resetAt, personal }. */
  quota: () => api.get('/api/ai/quota'),
  feedbackCategories: () => api.get('/api/ai/feedback/categories'),
  like: (requestId) => api.post('/api/ai/feedback/like', { requestId }),
  report: (requestId, category, comment) => api.post('/api/ai/reports', { requestId, category, comment }),
};

export const Kb = {
  status: () => api.get('/api/kb/status'),
  sync: (full = false) => api.post('/api/kb/sync', { full }),
  today: () => api.get('/api/kb/changes/today'),
  changes: (day) => api.get(`/api/kb/changes${day ? `?day=${encodeURIComponent(day)}` : ''}`),
  history: (limit = 60) => api.get(`/api/kb/changes/history?limit=${limit}`),
  change: (id) => api.get(`/api/kb/changes/${id}`),
  logs: (limit = 20) => api.get(`/api/kb/sync/logs?limit=${limit}`),
};

export const Users = {
  me: () => api.get('/api/users/me'),
  // Самостоятельное переименование УДАЛЕНО по требованию пользователя:
  // никнейм приходит из Discord/Telegram при входе и синхронизируется
  // backend'ом (users/service.ts). Ручная правка — только через CLI.
};

export const Settings = {
  get: () => api.get('/api/settings/me'),
  save: (patch) => api.put('/api/settings/me', patch),
  reset: () => api.post('/api/settings/me/reset'),
};
