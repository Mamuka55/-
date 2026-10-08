/**
 * EPIC AI — абстракция LLM-провайдера.
 *
 * Провайдер меняется одной строкой в.env (AI_PROVIDER), бизнес-логика
 * RAG от него не зависит. Ключ API живёт только на backend.
 *
 * Поддерживаются:
 *   groq               — бесплатный API, OpenAI-совместимый (llama-3.3-70b-versatile)
 *   openai_compatible  — любой OpenAI-совместимый endpoint (OpenRouter, vLLM, LM Studio…)
 *   ollama             — полностью локально, без ключей и интернета
 *   mock               — детерминированная заглушка для разработки и тестов
 */
import { config } from '../../config/index.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Agent } from 'undici';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  /** Требовать JSON-ответ (если провайдер поддерживает response_format). */
  json?: boolean;
  signal?: AbortSignal;
}

export interface ChatResult {
  content: string;
  model: string;
  provider: string;
  tokensPrompt?: number;
  tokensCompletion?: number;
  latencyMs: number;
}

export interface EmbeddingResult {
  vectors: number[][];
  model: string;
  dim: number;
}

export interface LLMProvider {
  readonly name: string;
  readonly model: string;
  chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResult>;
  embed?(texts: string[]): Promise<EmbeddingResult>;
  isConfigured(): { ok: boolean; reason?: string };
}

export class ProviderError extends Error {
  constructor(message: string, public cause?: unknown) { super(message); }
}

/* ------------------------------------------------------------------ */
/*  OpenAI-совместимый провайдер (Groq, OpenAI, OpenRouter, vLLM)       */
/* ------------------------------------------------------------------ */

export class OpenAICompatibleProvider implements LLMProvider {
  readonly name: string;
  readonly model: string;
  constructor(
    name: string,
    private baseUrl: string,
    private apiKey: string,
    model: string,
    private defaults: { temperature: number; maxTokens: number; timeoutMs: number },
    private fallbackModels: string[] = [],
    private yandexFolderId: string = '',
  ) {
    this.name = name;
    this.model = model;
  }

  /**
   * Yandex Cloud AI Studio (openai-совместимый endpoint) принимает модель
   * только как URI `gpt://<folder_id>/<model>/latest`: голое имя даёт
   * 400 «Failed to parse model URI». Заворачиваем сами, если задан
   * YANDEX_FOLDER_ID; готовый `gpt://…` пропускаем как есть.
   */
  private resolveModel(m: string): string {
    if (!/ai\.api\.cloud\.yandex\.net/i.test(this.baseUrl)) return m;
    if (m.startsWith('gpt://')) return m;
    if (!this.yandexFolderId) return m;
    return `gpt://${this.yandexFolderId}/${m}/latest`;
  }

  isConfigured() {
    if (!this.baseUrl) return { ok: false, reason: 'Не задан AI_BASE_URL' };
    if (!this.apiKey) return { ok: false, reason: `Не задан AI_API_KEY для провайдера ${this.name}` };
    if (!this.model) return { ok: false, reason: 'Не задана AI_MODEL' };
    return { ok: true };
  }

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
    const started = Date.now();
    const url = `${this.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
    };
    // OpenRouter просит атрибуцию приложения — это не влияет на цену, но
    // помогает поддержке и статистике ключа.
    if (/openrouter\.ai/i.test(this.baseUrl)) {
      headers['X-Title'] = 'Epic AI';
      headers['HTTP-Referer'] = 'https://epicrp.example';
    }
    const models = [this.model, ...this.fallbackModels.filter((m) => m && m !== this.model)].map((m) => this.resolveModel(m));
    let lastError: ProviderError | null = null;

    for (let i = 0; i < models.length; i++) {
      const model = models[i];
      const body: Record<string, unknown> = {
        model,
        messages,
        temperature: opts.temperature ?? this.defaults.temperature,
        max_tokens: opts.maxTokens ?? this.defaults.maxTokens,
        stream: false,
      };
      if (opts.json) body.response_format = { type: 'json_object' };

      let res: Response;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: opts.signal ?? AbortSignal.timeout(this.defaults.timeoutMs),
        });
      } catch (e: any) {
        throw new ProviderError(`Сетевая ошибка AI-провайдера ${this.name}: ${e.message}`, e);
      }

      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        const retryable = res.status === 404 || res.status === 429 || res.status === 503
          || /model_not_found|rate_limit|not available/i.test(txt);
        // SiliconFlow и другие OpenAI-совместимые площадки не на всех моделях
        // держат response_format: при 400 с упоминанием json/response_format
        // повторяем тот же запрос БЕЗ флага (JSON-дисциплину держит промпт).
        const jsonUnsupported = res.status === 400 && body.response_format
          && /response_format|json/i.test(txt);
        if (jsonUnsupported) {
          delete body.response_format;
          try {
            res = await fetch(url, {
              method: 'POST', headers, body: JSON.stringify(body),
              signal: opts.signal ?? AbortSignal.timeout(this.defaults.timeoutMs),
            });
          } catch (e2: any) {
            throw new ProviderError(`Сетевая ошибка AI-провайдера ${this.name}: ${e2.message}`, e2);
          }
          if (res.ok) {
            const data2: any = await res.json();
            return {
              content: String(data2?.choices?.[0]?.message?.content ?? ''),
              model: data2?.model ?? model,
              provider: this.name,
              tokensPrompt: data2?.usage?.prompt_tokens,
              tokensCompletion: data2?.usage?.completion_tokens,
              latencyMs: Date.now() - started,
            };
          }
        }
        lastError = new ProviderError(`AI-провайдер ${this.name} вернул ${res.status} на модели ${model}: ${txt.slice(0, 300)}`);
        // Модель снята с free-пула или упёрлась в лимит — пробуем следующую
        // в цепочке AI_MODEL_FALLBACK.
        if (retryable && i < models.length - 1) continue;
        throw lastError;
      }
      const data: any = await res.json();
      const content: string = data?.choices?.[0]?.message?.content ?? '';
      if (i > 0) console.log(`[epic-ai] AI: модель ${this.model} недоступна, ответ получен с ${model}`);
      return {
        content,
        model: data?.model ?? model,
        provider: this.name,
        tokensPrompt: data?.usage?.prompt_tokens,
        tokensCompletion: data?.usage?.completion_tokens,
        latencyMs: Date.now() - started,
      };
    }
    throw lastError ?? new ProviderError(`AI-провайдер ${this.name}: нет доступных моделей`);
  }

  async embed(texts: string[]): Promise<EmbeddingResult> {
    if (!config.ai.embedding.enabled || !config.ai.embedding.model) {
      throw new ProviderError('Embeddings отключены (EMBEDDING_ENABLED=false)');
    }
    const base = (config.ai.embedding.baseUrl || this.baseUrl).replace(/\/$/, '');
    const res = await fetch(`${base}/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ model: config.ai.embedding.model, input: texts }),
      signal: AbortSignal.timeout(this.defaults.timeoutMs),
    });
    if (!res.ok) throw new ProviderError(`Embeddings API вернул ${res.status}`);
    const data: any = await res.json();
    const vectors: number[][] = (data?.data ?? []).map((d: any) => d.embedding as number[]);
    return { vectors, model: config.ai.embedding.model, dim: vectors[0]?.length ?? 0 };
  }
}

/* ------------------------------------------------------------------ */
/*  Ollama (локально, без ключей)                                       */
/* ------------------------------------------------------------------ */

export class OllamaProvider implements LLMProvider {
  readonly name = 'ollama';
  readonly model: string;
  constructor(model: string, private baseUrl = config.ai.ollamaBaseUrl) { this.model = model; }
  isConfigured() {
    if (!this.model) return { ok: false, reason: 'Не задана AI_MODEL для ollama' };
    return { ok: true };
  }
  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
    const started = Date.now();
    const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages,
        stream: false,
        format: opts.json ? 'json' : undefined,
        options: { temperature: opts.temperature ?? 0.1, num_predict: opts.maxTokens ?? 1200 },
      }),
      signal: opts.signal ?? AbortSignal.timeout(config.ai.timeoutMs),
    });
    if (!res.ok) throw new ProviderError(`Ollama вернул ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data: any = await res.json();
    return {
      content: String(data?.message?.content ?? ''),
      model: this.model,
      provider: this.name,
      tokensPrompt: data?.prompt_eval_count,
      tokensCompletion: data?.eval_count,
      latencyMs: Date.now() - started,
    };
  }
  async embed(texts: string[]): Promise<EmbeddingResult> {
    const vectors: number[][] = [];
    for (const t of texts) {
      const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: config.ai.embedding.model || this.model, prompt: t }),
        signal: AbortSignal.timeout(config.ai.timeoutMs),
      });
      if (!res.ok) throw new ProviderError(`Ollama embeddings вернул ${res.status}`);
      const data: any = await res.json();
      vectors.push(data.embedding as number[]);
    }
    return { vectors, model: config.ai.embedding.model || this.model, dim: vectors[0]?.length ?? 0 };
  }
}

/* ------------------------------------------------------------------ */
/*  Mock — детерминированная заглушка (разработка / тесты / офлайн)      */
/* ------------------------------------------------------------------ */

export class MockProvider implements LLMProvider {
  readonly name = 'mock';
  readonly model = 'mock-epic-ai';
  constructor(private opts: { sourcesCount?: number } = {}) {}
  isConfigured() { return { ok: true }; }
  async chat(messages: ChatMessage[]): Promise<ChatResult> {
    const started = Date.now();
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    // В mock-режиме честно отвечаем «нет подтверждённых данных», если контекст пуст.
    const hasContext = /ДОКУМЕНТ:/i.test(lastUser);
    const payload = hasContext
      ? {
          verdict: 'depends',
          explanation: 'Тестовый режим (AI_PROVIDER=mock). Ответ сформирован по найденным фрагментам официальной базы EpicRP без обращения к внешней модели.',
          basis: 'Фрагменты, переданные в контексте запроса.',
          source_indexes: Array.from({ length: Math.min(this.opts.sourcesCount ?? 3, 3) }, (_, i) => i),
          confidence: 0.5,
        }
      : {
          verdict: 'unknown',
          explanation: 'В официальной базе EpicRP не найдено подтверждённой информации для однозначного ответа.',
          basis: null,
          source_indexes: [],
          confidence: 0,
        };
    return {
      content: JSON.stringify(payload, null, 2),
      model: this.model,
      provider: this.name,
      latencyMs: Date.now() - started,
    };
  }
}

/* ------------------------------------------------------------------ */
/*  Фабрика                                                             */
/* ------------------------------------------------------------------ */

let cached: LLMProvider | null = null;

/* ------------------------------------------------------------------ */
/*  GigaChat (Сбер) — российский провайдер, раунд 36                    */
/* ------------------------------------------------------------------ */

let tlsAgent: Agent | null | undefined;

/**
 * TLS-агент для российских сертификатов: цепочка GigaChat выдана российским
 * корневым УЦ, которого нет в доверенных хранилищах Node.js. AI_CA_CERT —
 * путь к PEM (относительно backend/); AI_TLS_INSECURE=1 — аварийный тест.
 */
function tlsDispatcher(): Agent | undefined {
  if (tlsAgent !== undefined) return tlsAgent ?? undefined;
  tlsAgent = null;
  try {
    if (config.ai.tlsInsecure) {
      tlsAgent = new Agent({ connect: { rejectUnauthorized: false } });
      console.warn('[epic-ai] AI_TLS_INSECURE=1: проверка TLS ОТКЛЮЧЕНА — только для тестов, не для продакшена');
    } else if (config.ai.caCert) {
      const pem = readFileSync(resolve(config.paths.backendRoot, config.ai.caCert), 'utf8');
      tlsAgent = new Agent({ connect: { ca: pem } });
    }
  } catch (e: any) {
    console.warn(`[epic-ai] не удалось настроить TLS-агент: ${e?.message ?? e}`);
    tlsAgent = null;
  }
  return tlsAgent ?? undefined;
}

export class GigaChatProvider implements LLMProvider {
  readonly name = 'gigachat';
  readonly model: string;
  private token: string | null = null;
  private tokenExp = 0;

  private authMode: 'bearer' | 'oauth';

  constructor(
    model: string,
    private defaults: { temperature: number; maxTokens: number; timeoutMs: number },
    private fallbackModels: string[] = [],
  ) {
    this.model = model;
    // Ключ из кабинета Сбера — это OAuth-credential (Basic), а не Bearer:
    // прямой Bearer даёт 401. Провайдер сам подбирает режим: сначала Bearer,
    // при 401 — обмен через ngw/oauth и кэш токена (раунд 38).
    this.authMode = config.ai.gigachat.credentials ? 'oauth' : 'bearer';
  }

  /** Basic-credential: «id:secret» кодируем, готовый base64-ключ берём как есть. */
  private basicCredential(): string | null {
    const raw = config.ai.gigachat.credentials || config.ai.apiKey;
    if (!raw) return null;
    return raw.includes(':') ? Buffer.from(raw, 'utf8').toString('base64') : raw;
  }

  private async oauthToken(): Promise<string> {
    const basic = this.basicCredential();
    if (!basic) throw new ProviderError('GigaChat: не задан ключ (AI_API_KEY или GIGACHAT_CREDENTIALS)');
    const res = await fetch(config.ai.gigachat.oauthUrl, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        RqUID: randomUUID(),
      },
      body: new URLSearchParams({ scope: config.ai.gigachat.scope }),
      signal: AbortSignal.timeout(15_000),
      dispatcher: tlsDispatcher(),
    } as RequestInit);
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new ProviderError(`GigaChat OAuth вернул ${res.status}: ${txt.slice(0, 200)} — проверьте ключ авторизации и scope (${config.ai.gigachat.scope})`);
    }
    const j = (await res.json()) as { access_token?: string; expires_at?: number };
    if (!j.access_token) throw new ProviderError('GigaChat OAuth: в ответе нет access_token');
    this.token = j.access_token;
    this.tokenExp = Number(j.expires_at ?? 0) || Date.now() + 25 * 60_000;
    return this.token;
  }

  isConfigured() {
    if (!config.ai.apiKey && !config.ai.gigachat.credentials) {
      return { ok: false, reason: 'Не задан AI_API_KEY (личный токен) или GIGACHAT_CREDENTIALS (client_id:client_secret)' };
    }
    if (!this.model) return { ok: false, reason: 'Не задана AI_MODEL (GigaChat-Lite|Pro|Max)' };
    return { ok: true };
  }

  private async authHeader(): Promise<string> {
    if (this.authMode === 'oauth') {
      if (this.token && Date.now() < this.tokenExp - 60_000) return `Bearer ${this.token}`;
      return `Bearer ${await this.oauthToken()}`;
    }
    return `Bearer ${config.ai.apiKey}`;
  }

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
    const started = Date.now();
    const url = `${config.ai.gigachat.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const models = [this.model, ...this.fallbackModels.filter((m) => m && m !== this.model)];
    let lastError: ProviderError | null = null;

    for (let i = 0; i < models.length; i++) {
      const model = models[i];
      // GigaChat не поддерживает response_format — JSON-дисциплину держит промпт
      const body: Record<string, unknown> = {
        model,
        messages,
        temperature: opts.temperature ?? this.defaults.temperature,
        max_tokens: opts.maxTokens ?? this.defaults.maxTokens,
        stream: false,
      };
      let res: Response;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: await this.authHeader(),
            'X-Request-ID': randomUUID(),
          },
          body: JSON.stringify(body),
          signal: opts.signal ?? AbortSignal.timeout(this.defaults.timeoutMs),
          dispatcher: tlsDispatcher(),
        } as RequestInit);
      } catch (e: any) {
        const raw = String(e?.cause?.message ?? e?.message ?? e);
        const hint = /certificate|TLS|SSL|self.signed|unable to verify/i.test(raw)
          ? ' — нужен AI_CA_CERT с PEM российского корневого УЦ (или AI_TLS_INSECURE=1 для теста)'
          : '';
        throw new ProviderError(`Сетевая ошибка GigaChat: ${raw.slice(0, 200)}${hint}`, e);
      }
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        // Ключ Сбера — OAuth-credential: при 401 один раз обмениваем его на
        // access_token и повторяем запрос модели.
        if (res.status === 401 && this.authMode === 'bearer') {
          this.authMode = 'oauth';
          this.token = null;
          let hdr: string;
          try { hdr = await this.authHeader(); }
          catch (e: any) { throw new ProviderError(`GigaChat OAuth не удался: ${String(e?.message ?? e).slice(0, 200)}`); }
          const r2 = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: hdr, 'X-Request-ID': randomUUID() },
            body: JSON.stringify(body),
            signal: opts.signal ?? AbortSignal.timeout(this.defaults.timeoutMs),
            dispatcher: tlsDispatcher(),
          } as RequestInit);
          if (r2.ok) {
            const d2: any = await r2.json();
            console.log('[epic-ai] GigaChat: Bearer отклонён, ключ принят через OAuth — дальше работаем с токеном');
            return {
              content: String(d2?.choices?.[0]?.message?.content ?? ''),
              model: d2?.model ?? model,
              provider: this.name,
              tokensPrompt: d2?.usage?.prompt_tokens,
              tokensCompletion: d2?.usage?.completion_tokens,
              latencyMs: Date.now() - started,
            };
          }
          const t2 = await r2.text().catch(() => '');
          throw new ProviderError(`GigaChat вернул ${r2.status} на модели ${model} после OAuth: ${t2.slice(0, 300)}`);
        }
        lastError = new ProviderError(`GigaChat вернул ${res.status} на модели ${model}: ${txt.slice(0, 300)}`);
        if ((res.status === 404 || res.status === 429 || res.status === 503) && i < models.length - 1) continue;
        throw lastError;
      }
      const data: any = await res.json();
      if (i > 0) console.log(`[epic-ai] AI: модель ${this.model} недоступна, ответ получен с ${model}`);
      return {
        content: String(data?.choices?.[0]?.message?.content ?? ''),
        model: data?.model ?? model,
        provider: this.name,
        tokensPrompt: data?.usage?.prompt_tokens,
        tokensCompletion: data?.usage?.completion_tokens,
        latencyMs: Date.now() - started,
      };
    }
    throw lastError ?? new ProviderError('GigaChat: нет доступных моделей');
  }
}

export function getProvider(): LLMProvider {
  if (cached) return cached;
  const d = {
    temperature: config.ai.temperature,
    maxTokens: config.ai.maxTokens,
    timeoutMs: config.ai.timeoutMs,
  };
  switch (config.ai.provider) {
    case 'groq':
      cached = new OpenAICompatibleProvider('groq', config.ai.baseUrl || 'https://api.groq.com/openai/v1', config.ai.apiKey, config.ai.model || 'llama-3.3-70b-versatile', d, config.ai.fallbackModels, config.ai.yandexFolderId);
      break;
    case 'openai_compatible':
      cached = new OpenAICompatibleProvider('openai_compatible', config.ai.baseUrl, config.ai.apiKey, config.ai.model, d, config.ai.fallbackModels, config.ai.yandexFolderId);
      break;
    case 'gigachat':
      cached = new GigaChatProvider(config.ai.model || 'GigaChat-Pro', d, config.ai.fallbackModels);
      break;
    case 'ollama':
      cached = new OllamaProvider(config.ai.model);
      break;
    case 'mock':
    default:
      cached = new MockProvider();
      break;
  }
  return cached;
}

export function resetProviderCache(): void { cached = null; }
