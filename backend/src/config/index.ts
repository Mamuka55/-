/**
 * EPIC AI — конфиг backend.
 *
 * Все секреты живут ТОЛЬКО здесь. Electron-клиент не получает
 * ни AI_API_KEY, ни DISCORD_CLIENT_SECRET, ни DB_PASSWORD.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
/** backend/ */
export const BACKEND_ROOT = resolve(__dirname, '../..');
/** epic-ai/ */
export const PROJECT_ROOT = resolve(BACKEND_ROOT, '..');

/** Минимальный.env-парсер (без внешних зависимостей). */
function loadDotEnv(file: string): void {
  if (!existsSync(file)) return;
  const txt = readFileSync(file, 'utf8');
  for (const rawLine of txt.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv(resolve(BACKEND_ROOT, '.env'));

const env = process.env;
const str = (k: string, d = ''): string => (env[k] === undefined || env[k] === '' ? d : (env[k] as string));
const int = (k: string, d: number): number => {
  const v = parseInt(str(k, String(d)), 10);
  return Number.isFinite(v) ? v : d;
};
const bool = (k: string, d: boolean): boolean => {
  const v = str(k, String(d)).toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
};
const list = (k: string, d = ''): string[] => str(k, d).split(',').map((s) => s.trim()).filter(Boolean);
const abs = (p: string): string => (p.startsWith('.') ? resolve(BACKEND_ROOT, p) : p);

export const config = {
  env: str('NODE_ENV', 'development'),
  isProd: str('NODE_ENV', 'development') === 'production',
  logLevel: str('LOG_LEVEL', 'info'),

  host: str('HOST', '127.0.0.1'),
  port: int('PORT', 8787),
  publicUrl: str('PUBLIC_URL', `http://127.0.0.1:${int('PORT', 8787)}`).replace(/\/$/, ''),

  db: {
    driver: (str('DB_DRIVER', 'sqlite') === 'postgres' ? 'postgres' : 'sqlite') as 'sqlite' | 'postgres',
    sqlitePath: abs(str('DB_SQLITE_PATH', './data/epic-ai.sqlite')),
    pg: {
      host: str('DB_HOST', '127.0.0.1'),
      port: int('DB_PORT', 5432),
      database: str('DB_NAME', 'epic_ai'),
      user: str('DB_USER', 'epic_ai'),
      password: str('DB_PASSWORD', ''),
    },
    migrationsDir: resolve(PROJECT_ROOT, 'database/migrations'),
    seedsDir: resolve(PROJECT_ROOT, 'database/seeds'),
  },

  session: {
    cookie: str('SESSION_COOKIE', 'epic_ai_session'),
    ttlDays: int('SESSION_TTL_DAYS', 30),
    secret: str('SESSION_SECRET', 'change-me'),
  },

  telegram: {
    enabled: bool('TELEGRAM_ENABLED', false),
    botUsername: str('TELEGRAM_BOT_USERNAME'),
    botToken: str('TELEGRAM_BOT_TOKEN'),
    hashMaxAge: int('TELEGRAM_HASH_MAX_AGE', 900),
    // auto: виджет на https, deep-link на http; widget/deeplink — форсировать.
    loginMode: str('TELEGRAM_LOGIN_MODE', 'auto') as 'auto' | 'widget' | 'deeplink',
  },

  ai: {
    provider: str('AI_PROVIDER', 'mock') as 'groq' | 'openai_compatible' | 'ollama' | 'gigachat' | 'mock',
    apiKey: str('AI_API_KEY'),
    baseUrl: str('AI_BASE_URL', 'https://api.groq.com/openai/v1'),
    model: str('AI_MODEL', 'llama-3.3-70b-versatile'),
    // Цепочка запасных моделей: при 404/429/503 провайдер переходит к следующей.
    // Для OpenRouter это страховка от ротации free-моделей.
    fallbackModels: list('AI_MODEL_FALLBACK'),
    // Folder ID Yandex Cloud: openai-совместимый endpoint требует модель
    // в формате gpt://<folder>/<model>/latest — заворачиваем сами (раунд 35).
    yandexFolderId: str('YANDEX_FOLDER_ID'),
    temperature: parseFloat(str('AI_TEMPERATURE', '0.1')),
    maxTokens: int('AI_MAX_TOKENS', 1200),
    timeoutMs: int('AI_TIMEOUT_MS', 45000),
    embedding: {
      enabled: bool('EMBEDDING_ENABLED', false),
      model: str('EMBEDDING_MODEL'),
      baseUrl: str('EMBEDDING_BASE_URL'),
      dim: int('EMBEDDING_DIM', 0),
    },
    ollamaBaseUrl: str('OLLAMA_BASE_URL', 'http://127.0.0.1:11434'),
    gigachat: {
      baseUrl: str('GIGACHAT_BASE_URL', 'https://gigachat.devices.sberbank.ru/api/v1'),
      oauthUrl: str('GIGACHAT_OAUTH_URL', 'https://ngw.devices.sberbank.ru:9443/api/v2/oauth'),
      scope: str('GIGACHAT_SCOPE', 'GIGACHAT_API_PERS'),
      // Либо личный токен физлица в AI_API_KEY (Bearer как есть),
      // либо клиентские данные «client_id:client_secret» здесь — тогда
      // провайдер сам получает и обновляет токен через OAuth.
      credentials: str('GIGACHAT_CREDENTIALS'),
    },
    // PEM российского НУЦ Минцифры (Root + Sub CA): цепочку GigaChat Node.js
    // по умолчанию не доверяет. Бандл лежит в репозитории
    // (backend/certs/russian_trusted_root_ca.pem, источник — gu-st.ru по
    // ссылке из документации Сбера); AI_CA_CERT переопределяет путь.
    caCert: str('AI_CA_CERT', './certs/russian_trusted_root_ca.pem'),
    // Аварийный режим для тестов: отключить проверку TLS. Не для продакшена.
    tlsInsecure: bool('AI_TLS_INSECURE', false),
  },

  rag: {
    topK: int('RAG_TOP_K', 6),
    maxCandidates: int('RAG_MAX_CANDIDATES', 40),
    chunkChars: int('RAG_CHUNK_CHARS', 1200),
    chunkOverlap: int('RAG_CHUNK_OVERLAP', 180),
  },

  crawler: {
    enabled: bool('CRAWLER_ENABLED', false),
    baseUrl: str('FORUM_BASE_URL', 'https://forum.epic-gta.com').replace(/\/$/, ''),
    userAgent: str('CRAWLER_USER_AGENT', 'EpicAI-KnowledgeBot/1.0'),
    intervalMinutes: int('CRAWLER_INTERVAL_MINUTES', 30),
    delayMs: int('CRAWLER_DELAY_MS', 2500),
    concurrency: int('CRAWLER_CONCURRENCY', 1),
    maxPagesPerRun: int('CRAWLER_MAX_PAGES_PER_RUN', 400),
    timeoutMs: int('CRAWLER_TIMEOUT_MS', 20000),
    respectRobots: bool('CRAWLER_RESPECT_ROBOTS', true),
    cacheDir: abs(str('CRAWLER_CACHE_DIR', './data/crawler-cache')),
    rulesNodes: list('CRAWLER_RULES_NODES', '38,39,40,41').map(Number),
    lawsNodes: list('CRAWLER_LAWS_NODES', '66,67,68,116,117,118,113').map(Number),
    archiveMarkers: list('CRAWLER_ARCHIVE_MARKER', 'arkhiv,архив,archive'),
  },

  bootstrap: {
    token: str('BOOTSTRAP_TOKEN'),
    discordId: str('BOOTSTRAP_DISCORD_ID'),
    telegramId: str('BOOTSTRAP_TELEGRAM_ID'),
  },

  paths: {
    backendRoot: BACKEND_ROOT,
    projectRoot: PROJECT_ROOT,
    dataDir: abs('./data'),
    rendererDir: resolve(PROJECT_ROOT, 'renderer'),
    sharedDir: resolve(PROJECT_ROOT, 'shared'),
  },
} as const;

export type AppConfig = typeof config;
export default config;
