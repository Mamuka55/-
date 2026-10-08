-- 005_telegram.common.sql — управление Telegram-ботом из админ-панели.
--
-- Разрешение telegram.manage: рассылки по подписчикам и тумблер
-- «уведомлять об обновлениях базы знаний». Выдаётся Developer; остальные
-- роли получают его через редактор ролей (админка → Роли).

INSERT INTO permissions (code, category, description)
VALUES ('telegram.manage', 'telegram', 'Управление Telegram-ботом: рассылки и уведомления')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id, created_at)
SELECT r.id, p.id, {NOW}
FROM roles r JOIN permissions p ON p.code = 'telegram.manage'
WHERE r.code = 'developer'
  AND NOT EXISTS (
    SELECT 1 FROM role_permissions rp
     WHERE rp.role_id = r.id AND rp.permission_id = p.id
  );
