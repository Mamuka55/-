-- seeds/001_roles_permissions.sql
-- Начальное наполнение: роли (ТЗ §39) и permissions (ТЗ §42).
-- Раннер сидов исполняет файл целиком, поэтому здесь используется идемпотентный upsert.

INSERT INTO roles (code, name, color, level, is_system) VALUES
  ('player',       'Игрок',                               '#888888', 1, 0),
  ('helper',       'Хелпер',                              '#72CE1C', 2, 0),
  ('admin',        'Администратор',                       '#3498DB', 3, 0),
  ('senior_admin', 'Старший администратор',               '#9B59B6', 4, 0),
  ('deputy_chief', 'Заместитель главного администратора', '#E67E22', 5, 0),
  ('chief_admin',  'Главный администратор',               '#E74C3C', 6, 0),
  ('project_lead', 'Руководство проекта',                 '#F1C40F', 7, 0),
  ('developer',    'Разработчик',                         '#E2FF3F', 8, 1)
ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, color = EXCLUDED.color, level = EXCLUDED.level, is_system = EXCLUDED.is_system;

INSERT INTO permissions (code, category, description) VALUES
  -- AI
  ('ai.use',            'ai',        'Отправлять запросы к AI'),
  ('ai.rules',          'ai',        'Режим ПРАВИЛА'),
  ('ai.laws',           'ai',        'Режим ЗАКОНЫ'),
  ('ai.sources',        'ai',        'Просмотр окна источников'),
  ('ai.history',        'ai',        'История своих запросов'),
  ('ai.feedback',       'ai',        'Ставить 👍 / 👎'),
  ('ai.reports.view',   'ai',        'Просмотр AI Reports'),
  ('ai.reports.manage', 'ai',        'Обработка AI Reports (статусы, анализ)'),
  -- Knowledge base
  ('knowledge.view',    'knowledge', 'Просмотр базы знаний'),
  ('knowledge.history', 'knowledge', 'Просмотр истории версий и diff'),
  ('knowledge.sync',    'knowledge', 'Запуск синхронизации форума'),
  ('knowledge.manage',  'knowledge', 'Управление документами (правка, архив, удаление)'),
  -- Users / roles
  ('users.view',        'users',     'Просмотр списка пользователей'),
  ('users.edit',        'users',     'Редактирование пользователей'),
  ('users.block',       'users',     'Блокировка / разблокировка'),
  ('roles.view',        'roles',     'Просмотр ролей'),
  ('roles.assign',      'roles',     'Назначение ролей'),
  ('roles.manage',      'roles',     'Создание и изменение ролей'),
  ('permissions.view',  'roles',     'Просмотр permissions'),
  ('permissions.manage','roles',     'Управление permissions и overrides'),
  -- Settings / system
  ('settings.view',     'settings',  'Просмотр настроек'),
  ('settings.edit',     'settings',  'Изменение настроек'),
  ('system.logs',       'system',    'Просмотр Audit Log'),
  ('system.settings',   'system',    'Системные настройки'),
  ('system.manage',     'system',    'Полный технический доступ')
ON CONFLICT (code) DO UPDATE SET category = EXCLUDED.category, description = EXCLUDED.description;

-- ---------- Матрица роль → permissions ----------
-- Игрок: только пользоваться AI.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.code = 'player'
  AND p.code IN ('ai.use','ai.rules','ai.laws','ai.sources','ai.history','ai.feedback','settings.view')
ON CONFLICT DO NOTHING;

-- Хелпер: + просмотр ошибок AI и базы знаний (ТЗ §39: первая административная роль).
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.code = 'helper'
  AND p.code IN ('ai.use','ai.rules','ai.laws','ai.sources','ai.history','ai.feedback',
                 'ai.reports.view','knowledge.view','knowledge.history','settings.view')
ON CONFLICT DO NOTHING;

-- Администратор: + обработка отчётов, пользователи, синхронизация.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.code = 'admin'
  AND p.code IN ('ai.use','ai.rules','ai.laws','ai.sources','ai.history','ai.feedback',
                 'ai.reports.view','ai.reports.manage',
                 'knowledge.view','knowledge.history','knowledge.sync',
                 'users.view','users.edit','roles.view','roles.assign','permissions.view',
                 'settings.view','settings.edit','system.logs')
ON CONFLICT DO NOTHING;

-- Старший администратор: + блокировки и управление базой.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.code = 'senior_admin'
  AND p.code IN ('ai.use','ai.rules','ai.laws','ai.sources','ai.history','ai.feedback',
                 'ai.reports.view','ai.reports.manage',
                 'knowledge.view','knowledge.history','knowledge.sync','knowledge.manage',
                 'users.view','users.edit','users.block','roles.view','roles.assign',
                 'permissions.view','permissions.manage','settings.view','settings.edit','system.logs')
ON CONFLICT DO NOTHING;

-- Заместитель главного администратора / Главный администратор / Руководство проекта: всё, кроме system.manage.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.code IN ('deputy_chief','chief_admin','project_lead')
  AND p.code <> 'system.manage'
ON CONFLICT DO NOTHING;

-- Developer: полный технический доступ (ТЗ §45).
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.code = 'developer'
ON CONFLICT DO NOTHING;

-- ---------- Серверные настройки по умолчанию ----------
INSERT INTO app_settings (key, value) VALUES
  ('sync.interval_minutes', '30'),
  ('sync.automatic', 'true'),
  ('crawler.enabled', 'false'),
  ('kb.version', '0')
ON CONFLICT (key) DO NOTHING;
