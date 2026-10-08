/**
 * EPIC AI — пользовательские и системные настройки.
 *
 * Клиентские настройки (прозрачность, blur, размеры, always-on-top, хоткей,
 * аппаратное ускорение…) хранятся на сервере, чтобы не теряться при переустановке
 * и синхронизироваться между машинами. Электрон также держит локальный кэш.
 */
import type { FastifyInstance } from 'fastify';
import { getDb, parseJson, type Row } from '../db/index.js';
import { requirePermission, BadRequestError } from '../http/guards.js';
import { getSetting, setSetting } from '../knowledge/service.js';
import { audit, AUDIT_ACTIONS } from '../audit/index.js';
import { DEFAULTS } from '../shared.js';

/** Разрешённые ключи клиентских настроек и их валидаторы. */
const SCHEMA: Record<string, (v: unknown) => unknown> = {
  language: (v) => ['ru', 'en'].includes(String(v)) ? String(v) : DEFAULTS.settings.language,
  theme: (v) => ['dark'].includes(String(v)) ? String(v) : 'dark',
  autostart: (v) => Boolean(v),

  opacity: (v) => clamp(Number(v), 0.35, 1, DEFAULTS.settings.opacity),
  blur: (v) => Boolean(v),
  blurRadius: (v) => Math.round(clamp(Number(v), 0, 40, DEFAULTS.settings.blurRadius)),
  animations: (v) => Boolean(v),
  animationSpeed: (v) => clamp(Number(v), 0.25, 3, DEFAULTS.settings.animationSpeed),
  panelWidth: (v) => Math.round(clamp(Number(v), DEFAULTS.main.minWidth, DEFAULTS.main.maxWidth, DEFAULTS.main.width)),
  panelHeight: (v) => Math.round(clamp(Number(v), DEFAULTS.main.minHeight, DEFAULTS.main.maxHeight, DEFAULTS.main.height)),
  panelPosition: (v) => ['top-left', 'top-center', 'top-right', 'bottom-left', 'bottom-center', 'bottom-right', 'custom'].includes(String(v)) ? String(v) : DEFAULTS.settings.panelPosition,
  panelX: (v) => Number.isFinite(Number(v)) ? Math.round(Number(v)) : null,
  panelY: (v) => Number.isFinite(Number(v)) ? Math.round(Number(v)) : null,
  sourcesWidth: (v) => Math.round(clamp(Number(v), 320, 720, DEFAULTS.sources.width)),
  sourcesHeight: (v) => Math.round(clamp(Number(v), 240, 900, DEFAULTS.sources.height)),
  sourcesGap: (v) => Math.round(clamp(Number(v), 0, 80, DEFAULTS.sources.gap)),

  alwaysOnTop: (v) => Boolean(v),
  hotkey: (v) => validateHotkey(String(v)),
  hideOnOutsideClick: (v) => Boolean(v),
  clearPreviousAnswer: (v) => Boolean(v),
  rememberMode: (v) => Boolean(v),
  defaultMode: (v) => ['rules', 'laws'].includes(String(v)) ? String(v) : 'rules',

  hardwareAcceleration: (v) => Boolean(v),
  lowPerformanceMode: (v) => Boolean(v),
};

function clamp(n: number, min: number, max: number, fallback: number): number {
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/** Простейшая валидация акселератора Electron: "F10", "CommandOrControl+Shift+K"… */
export function validateHotkey(v: string): string {
  const s = String(v ?? '').trim();
  if (!s) return DEFAULTS.hotkey;
  const parts = s.split('+').map((x) => x.trim()).filter(Boolean);
  if (!parts.length || parts.length > 4) return DEFAULTS.hotkey;
  const mods = new Set(['commandorcontrol', 'cmdorctrl', 'control', 'ctrl', 'command', 'cmd', 'super', 'alt', 'option', 'shift', 'altgr']);
  const keyOk = /^(f([1-9]|1[0-9]|2[0-4])|[a-z0-9]|space|tab|enter|esc|escape|minus|equal|plus|home|end|pageup|pagedown|insert|delete|left|right|up|down|numadd|numsub|num0|num[1-9])$/i;
  const last = parts[parts.length - 1]!;
  if (!keyOk.test(last)) return DEFAULTS.hotkey;
  for (const p of parts.slice(0, -1)) if (!mods.has(p.toLowerCase())) return DEFAULTS.hotkey;
  return parts.join('+');
}

export function defaultSettings(): Record<string, unknown> {
  return {...DEFAULTS.settings, panelWidth: DEFAULTS.main.width, panelHeight: DEFAULTS.main.height, hotkey: DEFAULTS.hotkey, sourcesWidth: DEFAULTS.sources.width, sourcesHeight: DEFAULTS.sources.height, sourcesGap: DEFAULTS.sources.gap, defaultMode: 'rules' };
}

export async function registerSettingsRoutes(app: FastifyInstance): Promise<void> {
  /** GET /api/settings/me — все настройки текущего пользователя (со значениями по умолчанию). */
  app.get('/api/settings/me', { preHandler: [requirePermission('settings.view')] }, async (req, reply) => {
    const db = await getDb();
    const rows = await db.all<Row>('SELECT key, value FROM user_settings WHERE user_id = ?', [req.auth!.user.id]);
    const stored: Record<string, unknown> = {};
    for (const r of rows) stored[String(r.key)] = parseJson(r.value, r.value);
    return reply.send({ settings: {...defaultSettings(),...stored }, defaults: defaultSettings(), schema: Object.keys(SCHEMA) });
  });

  /** PUT /api/settings/me — сохранить настройки (частичное обновление). */
  app.put('/api/settings/me', { preHandler: [requirePermission('settings.view')] }, async (req, reply) => {
    const db = await getDb();
    const body = (req.body ?? {}) as Record<string, unknown>;
    const applied: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body)) {
      const validator = SCHEMA[k];
      if (!validator) continue; // неизвестные ключи молча игнорируем
      applied[k] = validator(v);
    }
    if (!Object.keys(applied).length) throw new BadRequestError('Нет допустимых ключей настроек');

    for (const [k, v] of Object.entries(applied)) {
      await db.run(
        `INSERT INTO user_settings (user_id, key, value, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
        [req.auth!.user.id, k, JSON.stringify(v), new Date().toISOString()],
      );
    }
    const rows = await db.all<Row>('SELECT key, value FROM user_settings WHERE user_id = ?', [req.auth!.user.id]);
    const stored: Record<string, unknown> = {};
    for (const r of rows) stored[String(r.key)] = parseJson(r.value, r.value);
    return reply.send({ ok: true, applied, settings: {...defaultSettings(),...stored } });
  });

  /** POST /api/settings/me/reset — сброс к значениям по умолчанию. */
  app.post('/api/settings/me/reset', { preHandler: [requirePermission('settings.view')] }, async (req, reply) => {
    const db = await getDb();
    await db.run('DELETE FROM user_settings WHERE user_id = ?', [req.auth!.user.id]);
    return reply.send({ ok: true, settings: defaultSettings() });
  });

  /** GET /api/settings/system — серверные настройки (system.settings). */
  app.get('/api/settings/system', { preHandler: [requirePermission('system.settings')] }, async (_req, reply) => {
    const db = await getDb();
    const rows = await db.all<Row>('SELECT key, value, updated_at, updated_by FROM app_settings ORDER BY key');
    return reply.send({
      items: rows.map((r) => ({ key: String(r.key), value: parseJson(r.value, r.value), updatedAt: r.updated_at, updatedBy: r.updated_by })),
    });
  });

  /** PUT /api/settings/system — изменить серверную настройку. */
  app.put('/api/settings/system', { preHandler: [requirePermission('system.settings')] }, async (req, reply) => {
    const body = (req.body ?? {}) as { key?: string; value?: unknown };
    const key = String(body.key ?? '');
    if (!key) throw new BadRequestError('Укажите key');
    const allowed = ['sync.interval_minutes', 'sync.automatic', 'crawler.enabled', 'kb.version'];
    if (!allowed.includes(key)) throw new BadRequestError(`Недопустимый ключ. Разрешены: ${allowed.join(', ')}`);
    await setSetting(key, body.value as any, req.auth!.user.id);
    await audit({ actorId: req.auth!.user.id, actorName: req.auth!.user.username, action: AUDIT_ACTIONS.SETTINGS_CHANGE, entityType: 'app_setting', entityId: key, meta: { value: body.value }, ip: req.ip });
    return reply.send({ ok: true, key, value: await getSetting(key) });
  });
}
