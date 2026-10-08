/**
 * EPIC AI — дневной лимит запросов к AI.
 *
 * Всем пользователям выдаётся DEFAULT_DAILY_LIMIT (50) запросов в сутки.
 * Администратор может выдать персональный лимит (админ-панель → карточка
 * пользователя → «Лимит запросов к ИИ»): он хранится в ai_quotas; отсутствие
 * строки означает лимит по умолчанию.
 *
 * Расход считается по таблице ai_requests за текущие локальные сутки —
 * отдельные счётчики не нужны: каждый запрос уже пишется в историю.
 */
import { getDb, type Row } from '../db/index.js';

export const DEFAULT_DAILY_LIMIT = 50;

export interface QuotaInfo {
  /** Сколько запросов уже использовано сегодня. */
  used: number;
  /** Дневной лимит (персональный или по умолчанию). */
  limit: number;
  /** Остаток на сегодня. */
  left: number;
  /** ISO-метка начала следующих суток (когда лимит обновится). */
  resetAt: string;
  /** true, если лимит выдан персонально (иначе — общий по умолчанию). */
  personal: boolean;
}

/** Начало текущих локальных суток в ISO (сравнение created_at лексикографией). */
export function dayStartIso(d: Date = new Date()): string {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x.toISOString();
}

/** Конец текущих локальных суток (момент сброса лимита). */
export function dayResetIso(d: Date = new Date()): string {
  const x = new Date(d);
  x.setHours(24, 0, 0, 0);
  return x.toISOString();
}

async function getUsed(userId: number): Promise<number> {
  const db = await getDb();
  const row = await db.get<Row>(
    'SELECT COUNT(*) AS c FROM ai_requests WHERE user_id = ? AND created_at >= ?',
    [userId, dayStartIso()],
  );
  return Number(row?.c ?? 0);
}

async function getPersonalLimit(userId: number): Promise<number | null> {
  const db = await getDb();
  const row = await db.get<Row>('SELECT daily_limit FROM ai_quotas WHERE user_id = ?', [userId]);
  if (!row) return null;
  const n = Number(row.daily_limit);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Полная сводка лимита пользователя (для клиента и админки). */
export async function getQuota(userId: number): Promise<QuotaInfo> {
  const personal = await getPersonalLimit(userId);
  const limit = personal ?? DEFAULT_DAILY_LIMIT;
  const used = await getUsed(userId);
  return {
    used,
    limit,
    left: Math.max(0, limit - used),
    resetAt: dayResetIso(),
    personal: personal != null,
  };
}

/**
 * Проверка перед выполнением запроса. Возвращает null, если лимит позволяет,
 * иначе — сводку (вызывающий отдаёт HTTP 429).
 */
export async function checkQuota(userId: number): Promise<QuotaInfo | null> {
  const q = await getQuota(userId);
  return q.left > 0 ? null : q;
}

/**
 * Выдать персональный лимит (null/пусто — вернуть общий по умолчанию).
 * Значение ограничивается сверху, чтобы лимит нельзя было сделать отрицательным.
 */
export async function setQuotaLimit(
  userId: number,
  dailyLimit: number | null,
  actorId?: number | null,
): Promise<QuotaInfo> {
  const db = await getDb();
  if (dailyLimit == null) {
    await db.run('DELETE FROM ai_quotas WHERE user_id = ?', [userId]);
  } else {
    const v = Math.min(Math.max(Math.round(dailyLimit), 0), 100000);
    await db.run(
      `INSERT INTO ai_quotas (user_id, daily_limit, updated_at, updated_by)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET daily_limit = EXCLUDED.daily_limit,
         updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by`,
      [userId, v, new Date().toISOString(), actorId ?? null],
    );
  }
  return getQuota(userId);
}
