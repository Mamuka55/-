/**
 * EPIC AI — каталог permissions  и вычисление эффективных прав.
 */
import type { DbClient, Row } from '../db/index.js';
import { toBool } from '../db/index.js';

/** Полный каталог разрешений. Используется для синхронизации таблицы permissions. */
export const PERMISSION_CATALOG: { code: string; category: string; description: string }[] = [
  { code: 'ai.use',             category: 'ai',        description: 'Отправлять запросы к AI' },
  { code: 'ai.rules',           category: 'ai',        description: 'Режим ПРАВИЛА' },
  { code: 'ai.laws',            category: 'ai',        description: 'Режим ЗАКОНЫ' },
  { code: 'ai.sources',         category: 'ai',        description: 'Просмотр окна источников' },
  { code: 'ai.history',         category: 'ai',        description: 'История своих запросов' },
  { code: 'ai.feedback',        category: 'ai',        description: 'Ставить 👍 / 👎' },
  { code: 'ai.reports.view',    category: 'ai',        description: 'Просмотр AI Reports' },
  { code: 'ai.reports.manage',  category: 'ai',        description: 'Обработка AI Reports' },

  { code: 'knowledge.view',     category: 'knowledge', description: 'Просмотр базы знаний' },
  { code: 'knowledge.history',  category: 'knowledge', description: 'История версий и diff' },
  { code: 'knowledge.sync',     category: 'knowledge', description: 'Запуск синхронизации форума' },
  { code: 'knowledge.manage',   category: 'knowledge', description: 'Управление документами' },

  { code: 'users.view',         category: 'users',     description: 'Просмотр пользователей' },
  { code: 'users.edit',         category: 'users',     description: 'Редактирование пользователей' },
  { code: 'users.block',        category: 'users',     description: 'Блокировка / разблокировка' },

  { code: 'roles.view',         category: 'roles',     description: 'Просмотр ролей' },
  { code: 'roles.assign',       category: 'roles',     description: 'Назначение ролей' },
  { code: 'roles.manage',       category: 'roles',     description: 'Управление ролями' },
  { code: 'permissions.view',   category: 'roles',     description: 'Просмотр permissions' },
  { code: 'permissions.manage', category: 'roles',     description: 'Управление permissions и overrides' },

  { code: 'settings.view',      category: 'settings',  description: 'Просмотр настроек' },
  { code: 'settings.edit',      category: 'settings',  description: 'Изменение настроек' },

  { code: 'telegram.manage',    category: 'telegram',  description: 'Управление Telegram-ботом: рассылки и уведомления' },

  { code: 'system.logs',        category: 'system',    description: 'Просмотр Audit Log' },
  { code: 'system.settings',    category: 'system',    description: 'Системные настройки' },
  { code: 'system.manage',      category: 'system',    description: 'Полный технический доступ' },
];

export const ALL_PERMISSION_CODES = PERMISSION_CATALOG.map((p) => p.code);

/** Идемпотентная синхронизация каталога с таблицей permissions. */
export async function syncPermissionCatalog(db: DbClient): Promise<void> {
  for (const p of PERMISSION_CATALOG) {
    await db.run(
      'INSERT INTO permissions (code, category, description) VALUES (?, ?, ?) ON CONFLICT (code) DO UPDATE SET category = EXCLUDED.category, description = EXCLUDED.description',
      [p.code, p.category, p.description],
    );
  }
}

export interface EffectivePermissions {
  /** Все разрешённые коды (роли + allow-override − deny-override). */
  codes: Set<string>;
  /** Разрешения, выданные ролями. */
  fromRoles: string[];
  /** Индивидуально добавленные разрешения. */
  extra: string[];
  /** Индивидуально запрещённые разрешения. */
  denied: string[];
  /** Роли пользователя. */
  roles: { id: number; code: string; name: string; color: string; level: number; isSystem: boolean }[];
  /** Максимальный уровень роли — для иерархии назначения. */
  maxLevel: number;
  /** Является ли разработчиком. */
  isDeveloper: boolean;
}

/**
 * Вычисляет эффективные permissions пользователя.
 * Приоритет: user override (deny > allow) > permissions роли.
 */
export async function computeEffectivePermissions(db: DbClient, userId: number): Promise<EffectivePermissions> {
  const roles = await db.all<Row>(
    `SELECT r.id, r.code, r.name, r.color, r.level, r.is_system
       FROM user_roles ur JOIN roles r ON r.id = ur.role_id
      WHERE ur.user_id = ?
      ORDER BY r.level DESC`,
    [userId],
  );

  const rolePermRows = roles.length
    ? await db.all<Row>(
        `SELECT DISTINCT p.code
           FROM role_permissions rp
           JOIN permissions p ON p.id = rp.permission_id
          WHERE rp.role_id IN (${roles.map(() => '?').join(', ')})`,
        roles.map((r) => r.id),
      )
    : [];

  const overrides = await db.all<Row>(
    `SELECT p.code, uo.effect FROM user_permission_overrides uo
       JOIN permissions p ON p.id = uo.permission_id
      WHERE uo.user_id = ?`,
    [userId],
  );

  const fromRoles = rolePermRows.map((r) => String(r.code));
  const extra = overrides.filter((o) => o.effect === 'allow' && !fromRoles.includes(String(o.code))).map((o) => String(o.code));
  const denied = overrides.filter((o) => o.effect === 'deny').map((o) => String(o.code));

  const codes = new Set<string>([...fromRoles,...extra]);
  for (const d of denied) codes.delete(d); // deny имеет приоритет 

  const maxLevel = roles.reduce((m, r) => Math.max(m, Number(r.level) || 0), 0);

  return {
    codes,
    fromRoles,
    extra,
    denied,
    roles: roles.map((r) => ({
      id: Number(r.id),
      code: String(r.code),
      name: String(r.name),
      color: String(r.color),
      level: Number(r.level),
      isSystem: toBool(r.is_system),
    })),
    maxLevel,
    isDeveloper: roles.some((r) => r.code === 'developer'),
  };
}

export function hasPermission(perms: EffectivePermissions | Set<string> | string[], code: string): boolean {
  if (perms instanceof Set) return perms.has(code);
  if (Array.isArray(perms)) return perms.includes(code);
  return perms.codes.has(code);
}

/** Проверка иерархии: можно ли назначить роль targetLevel. */
export function canAssignRole(actor: EffectivePermissions, targetLevel: number, targetIsSystem: boolean): boolean {
  if (!actor.codes.has('roles.assign')) return false;
  // Developer не назначается из обычной панели.
  if (targetIsSystem) return false;
  // Администратор не может назначить роль выше своего разрешённого уровня.
  return targetLevel < actor.maxLevel || (actor.isDeveloper && targetLevel <= actor.maxLevel);
}
