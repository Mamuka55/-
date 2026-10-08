/**
 * EPIC AI — RAG-конвейер.
 *
 *   Запрос пользователя → режим Rules/Laws → поиск по Knowledge Base
 *   → фильтрация актуальных документов → релевантные chunks → AI
 *   → ответ + источники
 *
 * Ключевое: если поиск ничего не дал, модель НЕ вызывается вовсе —
 * возвращается стандартная формулировка из Это дешевле и полностью
 * исключает галлюцинации на пустом контексте.
 */
import { getDb, insertReturningId } from '../../db/index.js';
import { config } from '../../config/index.js';
import { getProvider, type ChatMessage } from '../providers/index.js';
import { buildSystemPrompt, buildUserPrompt, NO_DATA_ANSWER, VERDICTS, type Verdict } from './prompts.js';
import { retrieve, type RetrievedSource } from './retrieval.js';

export interface AiAnswer {
  requestId: number;
  verdict: Verdict;
  verdictLabel: string;
  explanation: string;
  basis: string | null;
  sources: RetrievedSource[];
  relatedDocuments: { documentId: number; title: string }[];
  status: 'ok' | 'no_data' | 'error';
  confidence: number;
  model: string;
  provider: string;
  latencyMs: number;
  kbVersion: string;
  error?: string;
}

export interface AskParams {
  userId: number | null;
  mode: 'rules' | 'laws';
  question: string;
  includeArchive?: boolean;
}

export async function ask(params: AskParams): Promise<AiAnswer> {
  const db = await getDb();
  const started = Date.now();
  const question = String(params.question ?? '').trim();

  const retrieval = await retrieve({
    query: question,
    mode: params.mode,
    includeArchive: params.includeArchive,
  });

  // -------- 1. Нет источников → модель не вызываем  --------
  if (!retrieval.sources.length) {
    const requestId = await persistRequest({
      userId: params.userId, mode: params.mode, question,
      answerText: NO_DATA_ANSWER, verdict: 'unknown', explanation: NO_DATA_ANSWER, basis: null,
      sources: [], status: 'no_data', model: 'none', provider: 'none',
      latencyMs: Date.now() - started, kbVersion: retrieval.kbVersion,
    });
    return {
      requestId,
      verdict: 'unknown',
      verdictLabel: VERDICTS.unknown,
      explanation: NO_DATA_ANSWER,
      basis: null,
      sources: [],
      relatedDocuments: retrieval.relatedDocuments,
      status: 'no_data',
      confidence: 0,
      model: 'none',
      provider: 'none',
      latencyMs: Date.now() - started,
      kbVersion: retrieval.kbVersion,
    };
  }

  // -------- 2. RAG-запрос к модели --------
  const provider = getProvider();
  const modeLabel = params.mode === 'laws' ? 'ЗАКОНЫ' : 'ПРАВИЛА';
  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt(params.mode) },
    { role: 'user', content: buildUserPrompt(question, retrieval.sources, retrieval.kbVersion, modeLabel) },
  ];

  let parsed: ParsedAnswer;
  let model = provider.model;
  let provName = provider.name;
  let latency = Date.now() - started;

  try {
    const check = provider.isConfigured();
    if (!check.ok) throw new Error(`AI-провайдер не настроен: ${check.reason}`);
    const res = await provider.chat(messages, { json: true, temperature: config.ai.temperature, maxTokens: config.ai.maxTokens });
    parsed = parseAnswer(res.content, retrieval.sources);
    model = res.model; provName = res.provider; latency = Date.now() - started;
  } catch (e: any) {
    // Техническая ошибка AI — пользователю показываем честное сообщение,
    // но найденные источники всё равно отдаём: они важнее формулировки.
    const explanation = `AI-сервис временно недоступен (${String(e?.message ?? e).slice(0, 160)}). Ниже показаны найденные официальные источники — вы можете прочитать норму самостоятельно.`;
    const requestId = await persistRequest({
      userId: params.userId, mode: params.mode, question,
      answerText: explanation, verdict: 'unknown', explanation, basis: null,
      sources: retrieval.sources, status: 'error', model: provider.model, provider: provider.name,
      latencyMs: Date.now() - started, kbVersion: retrieval.kbVersion, error: String(e?.message ?? e),
    });
    return {
      requestId, verdict: 'unknown', verdictLabel: VERDICTS.unknown, explanation, basis: null,
      sources: retrieval.sources, relatedDocuments: retrieval.relatedDocuments, status: 'error',
      confidence: 0, model: provider.model, provider: provider.name,
      latencyMs: Date.now() - started, kbVersion: retrieval.kbVersion, error: String(e?.message ?? e),
    };
  }

  const requestId = await persistRequest({
    userId: params.userId, mode: params.mode, question,
    answerText: parsed.explanation, verdict: parsed.verdict, explanation: parsed.explanation, basis: parsed.basis,
    sources: parsed.sources, status: 'ok', model, provider: provName, latencyMs: latency,
    kbVersion: retrieval.kbVersion, confidence: parsed.confidence,
  });

  return {
    requestId,
    verdict: parsed.verdict,
    verdictLabel: VERDICTS[parsed.verdict],
    explanation: parsed.explanation,
    basis: parsed.basis,
    sources: parsed.sources,
    relatedDocuments: retrieval.relatedDocuments,
    status: 'ok',
    confidence: parsed.confidence,
    model,
    provider: provName,
    latencyMs: latency,
    kbVersion: retrieval.kbVersion,
  };
}

interface ParsedAnswer {
  verdict: Verdict;
  explanation: string;
  basis: string | null;
  sources: RetrievedSource[];
  confidence: number;
}

/**
 * Разбор ответа модели. Терпим к markdown-обёрткам и к «прозе» вместо JSON:
 * клиент не должен падать из-за капризов модели.
 */
function parseAnswer(raw: string, allSources: RetrievedSource[]): ParsedAnswer {
  const maxSources = allSources.length;
  const json = extractJson(raw);
  if (!json) {
    return { verdict: 'unknown', explanation: String(raw ?? '').trim() || NO_DATA_ANSWER, basis: null, sources: [], confidence: 0 };
  }
  const verdictRaw = String(json.verdict ?? '').toLowerCase();
  const verdict: Verdict = (['allowed', 'forbidden', 'depends', 'unknown'] as const).includes(verdictRaw as Verdict)
    ? (verdictRaw as Verdict)
    : 'unknown';

  let explanation = String(json.explanation ?? '').trim();
  const basis = json.basis == null || json.basis === '' ? null : String(json.basis).trim();

  if (verdict === 'unknown' && !explanation) explanation = NO_DATA_ANSWER;
  if (!explanation) explanation = NO_DATA_ANSWER;

  // source_indexes — только валидные индексы, иначе модель «придумала» источник 
  const rawIndexes = Array.isArray(json.source_indexes) ? json.source_indexes : [];
  const idxs = [...new Set(rawIndexes.map((x: unknown) => Number(x)).filter((n: number) => Number.isInteger(n) && n >= 0 && n < maxSources))] as number[];

  const confidenceRaw = Number(json.confidence);
  const confidence = Number.isFinite(confidenceRaw) ? Math.min(1, Math.max(0, confidenceRaw)) : (verdict === 'unknown' ? 0 : 0.5);

  return {
    verdict,
    explanation,
    basis: verdict === 'unknown' ? null : basis,
    // Источники берутся ТОЛЬКО из фактически найденных: если модель вернула
    // индекс вне диапазона, он отбрасывается.
    sources: idxs.map((i) => allSources[i]).filter((s): s is RetrievedSource => Boolean(s)),
    confidence,
  };
}

export function extractJson(text: string): any | null {
  const s = String(text ?? '').trim();
  if (!s) return null;
  // 1) снимем markdown-обёртку
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence ? fence[1]!.trim() : s;
  // 2) прямой парсинг
  try { return JSON.parse(candidate); } catch { /* continue */ }
  // 3) первый сбалансированный объект
  const start = candidate.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { try { return JSON.parse(candidate.slice(start, i + 1)); } catch { return null; } } }
  }
  return null;
}

async function persistRequest(d: {
  userId: number | null; mode: string; question: string; answerText: string;
  verdict: string; explanation: string; basis: string | null; sources: RetrievedSource[];
  status: string; model: string; provider: string; latencyMs: number; kbVersion: string;
  error?: string; confidence?: number; tokensPrompt?: number; tokensCompletion?: number;
}): Promise<number> {
  const db = await getDb();
  return insertReturningId(db, 'ai_requests', {
    user_id: d.userId,
    mode: d.mode,
    question: d.question,
    answer_text: d.answerText,
    verdict: d.verdict,
    explanation: d.explanation,
    basis: d.basis,
    sources_json: JSON.stringify(d.sources.map((s) => ({
      index: s.index, documentId: s.documentId, versionId: s.versionId, version: s.version,
      docType: s.docType, title: s.title, category: s.category, section: s.section,
      heading: s.heading, content: s.content, url: s.url, revisionLabel: s.revisionLabel,
      threadId: s.threadId, postId: s.postId, score: s.score,
    }))),
    model: d.model,
    provider: d.provider,
    tokens_prompt: d.tokensPrompt ?? null,
    tokens_completion: d.tokensCompletion ?? null,
    latency_ms: d.latencyMs,
    status: d.status,
    error: d.error ?? null,
    kb_version: d.kbVersion,
    created_at: new Date().toISOString(),
  });
}

export { NO_DATA_ANSWER, VERDICTS };
