/**
 * EPIC AI — mock-мост и mock-backend для демо-страниц.
 *
 * Подменяет window.epicAI (IPC к Electron) и window.fetch (HTTP к backend),
 * чтобы реальный код renderer'а работал в браузере без Electron, без сервера
 * и без обращения к форуму. Используется ТОЛЬКО в demo/ — в продукт не входит.
 *
 * ⚠️ Данные — вымышленные учебные документы, НЕ официальные правила EpicRP.
 */
(function () {
  'use strict';

  /* ============================== ДАННЫЕ ============================== */

  const USER = {
    id: 1,
    username: 'Alexander',
    displayName: 'Alexander',
    avatarUrl: null,
    status: 'active',
    createdAt: '2026-03-14T18:22:00.000Z',
    lastLoginAt: new Date().toISOString(),
    roles: [{ id: 8, code: 'developer', name: 'Разработчик', color: '#E2FF3F', level: 8, isSystem: true }],
    primaryRole: { code: 'developer', name: 'Разработчик', color: '#E2FF3F', level: 8 },
    identities: [
      { provider: 'discord', providerUserId: '482913745629184011', username: 'alexander', displayName: 'Alexander', avatarUrl: null, linkedAt: '2026-03-14T18:22:00.000Z' },
      { provider: 'telegram', providerUserId: '991204477', username: 'alex_rp', displayName: 'Alexander', avatarUrl: null, linkedAt: '2026-05-02T09:11:00.000Z' },
    ],
  };

  const ALL_PERMISSIONS = [
    'ai.use', 'ai.rules', 'ai.laws', 'ai.sources', 'ai.history', 'ai.feedback', 'ai.reports.view', 'ai.reports.manage',
    'knowledge.view', 'knowledge.history', 'knowledge.sync', 'knowledge.manage',
    'users.view', 'users.edit', 'users.block', 'roles.view', 'roles.assign', 'roles.manage', 'telegram.manage',
    'permissions.view', 'permissions.manage', 'settings.view', 'settings.edit',
    'system.logs', 'system.settings', 'system.manage',
  ];

  const PERMISSION_SPECS = [
    { code: 'ai.use', category: 'ai', description: 'Отправлять запросы к AI' },
    { code: 'ai.rules', category: 'ai', description: 'Режим ПРАВИЛА' },
    { code: 'ai.laws', category: 'ai', description: 'Режим ЗАКОНЫ' },
    { code: 'ai.sources', category: 'ai', description: 'Просмотр окна источников' },
    { code: 'ai.history', category: 'ai', description: 'История своих запросов' },
    { code: 'ai.feedback', category: 'ai', description: 'Ставить 👍 / 👎' },
    { code: 'ai.reports.view', category: 'ai', description: 'Просмотр AI Reports' },
    { code: 'ai.reports.manage', category: 'ai', description: 'Обработка AI Reports' },
    { code: 'knowledge.view', category: 'knowledge', description: 'Просмотр базы знаний' },
    { code: 'knowledge.history', category: 'knowledge', description: 'История версий и diff' },
    { code: 'knowledge.sync', category: 'knowledge', description: 'Запуск синхронизации форума' },
    { code: 'knowledge.manage', category: 'knowledge', description: 'Управление документами' },
    { code: 'users.view', category: 'users', description: 'Просмотр пользователей' },
    { code: 'users.edit', category: 'users', description: 'Редактирование пользователей' },
    { code: 'users.block', category: 'users', description: 'Блокировка / разблокировка' },
    { code: 'roles.view', category: 'roles', description: 'Просмотр ролей' },
    { code: 'roles.assign', category: 'roles', description: 'Назначение ролей' },
    { code: 'roles.manage', category: 'roles', description: 'Создание и изменение ролей' },
    { code: 'telegram.manage', category: 'telegram', description: 'Управление Telegram-ботом: рассылки и уведомления' },
    { code: 'permissions.view', category: 'roles', description: 'Просмотр permissions' },
    { code: 'permissions.manage', category: 'roles', description: 'Управление permissions' },
    { code: 'settings.view', category: 'settings', description: 'Просмотр настроек' },
    { code: 'settings.edit', category: 'settings', description: 'Изменение настроек' },
    { code: 'system.logs', category: 'system', description: 'Просмотр Audit Log' },
    { code: 'system.settings', category: 'system', description: 'Системные настройки' },
    { code: 'system.manage', category: 'system', description: 'Полный технический доступ' },
  ];

  const ROLES = [
    { code: 'player', name: 'Игрок', color: '#888888', level: 1, system: false, perms: ['ai.use', 'ai.rules', 'ai.laws', 'ai.sources', 'ai.history', 'ai.feedback', 'settings.view'], users: 1284 },
    { code: 'helper', name: 'Хелпер', color: '#72CE1C', level: 2, system: false, perms: ['ai.use', 'ai.rules', 'ai.laws', 'ai.sources', 'ai.history', 'ai.feedback', 'ai.reports.view', 'knowledge.view', 'knowledge.history', 'settings.view'], users: 22 },
    { code: 'admin', name: 'Администратор', color: '#3498DB', level: 3, system: false, perms: ['ai.use', 'ai.rules', 'ai.laws', 'ai.sources', 'ai.history', 'ai.feedback', 'ai.reports.view', 'ai.reports.manage', 'knowledge.view', 'knowledge.history', 'knowledge.sync', 'users.view', 'users.edit', 'roles.view', 'roles.assign', 'permissions.view', 'settings.view', 'settings.edit', 'system.logs'], users: 11 },
    { code: 'senior_admin', name: 'Старший администратор', color: '#9B59B6', level: 4, system: false, perms: ['ai.use', 'ai.reports.view', 'ai.reports.manage', 'knowledge.view', 'knowledge.history', 'knowledge.sync', 'knowledge.manage', 'users.view', 'users.edit', 'users.block', 'roles.view', 'roles.assign', 'permissions.view', 'permissions.manage', 'settings.view', 'settings.edit', 'system.logs'], users: 5 },
    { code: 'deputy_chief', name: 'Заместитель главного администратора', color: '#E67E22', level: 5, system: false, perms: ALL_PERMISSIONS.filter((p) => p !== 'system.manage'), users: 2 },
    { code: 'chief_admin', name: 'Главный администратор', color: '#E74C3C', level: 6, system: false, perms: ALL_PERMISSIONS.filter((p) => p !== 'system.manage'), users: 1 },
    { code: 'project_lead', name: 'Руководство проекта', color: '#F1C40F', level: 7, system: false, perms: ALL_PERMISSIONS.filter((p) => p !== 'system.manage'), users: 2 },
    { code: 'developer', name: 'Разработчик', color: '#E2FF3F', level: 8, system: true, perms: ALL_PERMISSIONS.slice(), users: 1 },
  ];

  const USERS = [
    { id: 1, username: 'Alexander', displayName: 'Alexander', avatarUrl: null, status: 'active', role: 'developer', lastLoginAt: new Date().toISOString(), createdAt: '2026-03-14T18:22:00.000Z', discord: { username: 'alexander', providerUserId: '482913745629184011', displayName: 'Alexander' }, telegram: { username: 'alex_rp', providerUserId: '991204477', displayName: 'Alexander' } },
    { id: 2, username: 'Stefan_Blaide', displayName: 'Stefan Blaide', avatarUrl: null, status: 'active', role: 'chief_admin', lastLoginAt: '2026-10-05T20:14:00.000Z', createdAt: '2026-02-07T19:00:00.000Z', discord: { username: 'stefan', providerUserId: '193847562938475621', displayName: 'Stefan Blaide' }, telegram: null },
    { id: 3, username: 'Kirill_Morozov', displayName: 'Kirill Morozov', avatarUrl: null, status: 'active', role: 'admin', lastLoginAt: '2026-10-06T01:42:00.000Z', createdAt: '2026-04-11T12:00:00.000Z', discord: { username: 'kirill', providerUserId: '847362519283746512', displayName: 'Kirill' }, telegram: { username: 'kmoroz', providerUserId: '112233445', displayName: 'Kirill' } },
    { id: 4, username: 'Nikita_Volkov', displayName: 'Nikita Volkov', avatarUrl: null, status: 'active', role: 'helper', lastLoginAt: '2026-10-05T17:03:00.000Z', createdAt: '2026-06-20T10:15:00.000Z', discord: { username: 'nikita_v', providerUserId: '756483920174658392', displayName: 'Nikita' }, telegram: null },
    { id: 5, username: 'Dmitry_Sokolov', displayName: 'Dmitry Sokolov', avatarUrl: null, status: 'blocked', role: 'player', lastLoginAt: '2026-09-28T22:11:00.000Z', createdAt: '2026-07-01T08:30:00.000Z', discord: { username: 'dima_s', providerUserId: '617283940561728394', displayName: 'Dmitry' }, telegram: null, blockedReason: 'Систематический MG и оскорбления в OOC-канале', blockedAt: '2026-09-29T09:00:00.000Z', blockedBy: { id: 3, username: 'Kirill_Morozov' } },
    { id: 6, username: 'Anna_Lebedeva', displayName: 'Anna Lebedeva', avatarUrl: null, status: 'active', role: 'player', lastLoginAt: '2026-10-06T04:55:00.000Z', createdAt: '2026-08-15T14:20:00.000Z', discord: null, telegram: { username: 'anna_l', providerUserId: '556677889', displayName: 'Anna' } },
    { id: 7, username: 'Roman_D', displayName: 'Roman D.', avatarUrl: null, status: 'active', role: 'player', lastLoginAt: '2026-10-04T19:30:00.000Z', createdAt: '2026-09-02T16:45:00.000Z', discord: { username: 'roman_d', providerUserId: '918273645519283746', displayName: 'Roman' }, telegram: null },
  ];

  const roleByCode = (code) => ROLES.find((r) => r.code === code) ?? ROLES[0];

  /* --------------------- Knowledge Base (фикстуры) --------------------- */

  const KB_DOCS = [
    {
      id: 1, threadId: 13, docType: 'RULE', title: 'Правила сервера', section: 'Сервер / Правила сервера / Общие правила',
      category: 'Важно', url: 'https://forum.epic-gta.com/threads/pravila-servera.13/', postId: 13,
      sourceCreatedAt: '2026-02-07T19:00:00.000Z', sourceModifiedAt: '2026-10-05T17:14:00.000Z', status: 'active', version: 3,
      text: `1. Основные термины Roleplay
RP - (RolePlay) - игра по ролям, где игроки должны придерживаться выбранной роли.
DM - (DeathMatch) - убийство или нанесение урона игроку без весомой на то причины.
DB - (Drive By) - убийство игрока с помощью средства передвижения.
MG - (Meta Gaming) - смешивание или использование OOC информации в IC.
PG - (Power Gaming) - преувеличение возможностей своего персонажа.
NLR - (New Life Rule) - новый персонаж не может использовать знания предыдущих персонажей игрока.

3. DeathMatch (DM)
3.1. Запрещено убивать или наносить урон игрокам без весомой IC причины.
3.2. Весомой причиной считается: правильно отыгранная RP ситуация с предупреждением, самооборона при нападении, исполнение служебных обязанностей сотрудником государственной организации.
3.3. Наказание за нарушение пункта 3.1: блокировка аккаунта сроком до 7 суток с конфискацией имущества, использованного при нарушении.

4. Поведение при проверке документов
4.1. Игрок обязан предоставлять документы по первому требованию сотрудника правоохранительных органов.
4.2. Сотрудник обязан предоставить удостоверение личности при проверке, если игрок об этом попросил.
4.3. Запрещено скрываться от проверки документов, находясь в транспортном средстве.

5. Правила зелёных зон
5.1. В зелёных зонах запрещены любые противоправные действия: DM, DB, ограбления, похищения.
5.2. К зелёным зонам относятся территории государственных организаций, больницы, места проведения массовых мероприятий.
5.3. Запрещено находиться в зелёной зоне с расчехлённым оружием.`,
    },
    {
      id: 2, threadId: 12, docType: 'RULE', title: 'Правила и обязанности лидера государственной фракции', section: 'Сервер / Правила сервера / Правила для государственных фракций',
      category: 'Важно', url: 'https://forum.epic-gta.com/threads/pravila-i-obyazannosti-lidera.12/', postId: 12,
      sourceCreatedAt: '2026-02-07T19:10:00.000Z', sourceModifiedAt: '2026-09-30T12:00:00.000Z', status: 'active', version: 2,
      text: `2. Применение силы
2.1. Применение оружия допустимо только при наличии прямой угрозы жизни сотрудника или гражданских лиц.
2.2. Перед применением оружия сотрудник обязан произвести устное предупреждение и выстрел в воздух, если обстановка это позволяет.
2.3. Запрещено применять оружие к лицу, которое не оказывает сопротивления и выполнило требования сотрудника.

3. Задержание
3.1. Задержание производится только при наличии оснований, предусмотренных Penal Code штата Сан-Андреас.
3.2. Сотрудник обязан сообщить задержанному причину задержания и его права.
3.3. Запрещено задерживать лицо без оформления процессуальных документов.`,
    },
    {
      id: 3, threadId: 21, docType: 'RULE', title: 'Правила для криминальных фракций', section: 'Сервер / Правила сервера / Правила для криминальных фракций',
      category: 'Важно', url: 'https://forum.epic-gta.com/threads/pravila-kriminal.21/', postId: 21,
      sourceCreatedAt: '2026-03-01T10:00:00.000Z', sourceModifiedAt: '2026-09-18T10:00:00.000Z', status: 'active', version: 1,
      text: `2. Ограбления
2.1. Ограбление допускается только при наличии не менее двух участников организации.
2.2. Запрещено проводить ограбление без предварительного RolePlay отыгрыша подготовки.
2.3. Запрещено брать в заложники более двух человек одновременно.

3. Захват заложников
3.1. Захват заложника допускается только при наличии IC мотивации.
3.2. Запрещено использовать заложника как «живой щит» без переговоров.`,
    },
    {
      id: 4, threadId: 68, docType: 'LAW', title: 'Конституция штата Сан-Андреас', section: 'Правительство / Законодательная база',
      category: 'Важно', url: 'https://forum.epic-gta.com/threads/konstitutsiya-shtata-san-andreas.68/', postId: 68,
      sourceCreatedAt: '2026-04-09T11:32:25.000Z', sourceModifiedAt: '2026-04-09T11:32:25.000Z', status: 'active', version: 1,
      text: `Статья 2. Права и свободы человека
2.1. Каждый имеет право на жизнь, свободу и личную неприкосновенность.
2.2. Никто не может быть подвергнут аресту иначе как на основании закона и в установленном законом порядке.
2.3. Каждому гарантируется право на квалифицированную юридическую помощь.
2.4. Каждый обвиняемый считается невиновным, пока его виновность не будет установлена вступившим в законную силу решением суда.

Статья 4. Судебная власть
4.1. Правосудие в штате Сан-Андреас осуществляется только судом.
4.2. Судебная власть независима и подчиняется исключительно закону.`,
    },
    {
      id: 5, threadId: 191, docType: 'LAW', title: 'The Penal Code штата Сан-Андреас', section: 'Правительство / Законодательная база',
      category: 'Важно', url: 'https://forum.epic-gta.com/threads/the-penal-code-shtata-san-andreas.191/', postId: 191,
      sourceCreatedAt: '2026-05-02T10:00:00.000Z', sourceModifiedAt: '2026-10-05T11:20:00.000Z', status: 'active', version: 4,
      text: `Статья 12.1. Убийство первой степени
Умышленное убийство при отягчающих обстоятельствах наказывается лишением свободы сроком на 150 месяцев и штрафом в размере 200000 виртуальной валюты.

Статья 12.2. Убийство второй степени
Умышленное убийство без отягчающих обстоятельств наказывается лишением свободы сроком на 80 месяцев и штрафом в размере 90000 виртуальной валюты.

Статья 12.4. Похищение человека
Похищение человека наказывается лишением свободы сроком на 100 месяцев и штрафом в размере 120000 виртуальной валюты.

Статья 21.3. Разбой
Нападение с целью хищения имущества с применением оружия наказывается лишением свободы сроком на 110 месяцев и штрафом в размере 140000 виртуальной валюты.

Статья 31.1. Незаконный оборот оружия
Хранение и перевозка оружия без соответствующего разрешения наказывается лишением свободы сроком на 45 месяцев и штрафом в размере 60000 виртуальной валюты.`,
    },
    {
      id: 6, threadId: 189, docType: 'LAW', title: 'Судебный кодекс штата Сан-Андреас', section: 'Правительство / Законодательная база',
      category: 'Важно', url: 'https://forum.epic-gta.com/threads/sudebnyi-kodeks-shtata-san-andreas.189/', postId: 189,
      sourceCreatedAt: '2026-05-04T09:00:00.000Z', sourceModifiedAt: '2026-08-11T09:00:00.000Z', status: 'active', version: 2,
      text: `Статья 3. Порядок судебного заседания
3.1. Судебное заседание открывается оглашением состава суда и сути обвинения.
3.2. Стороны представляют свои доводы и доказательства.
3.3. Решение суда оглашается публично и вступает в силу с момента оглашения.

Статья 4. Обжалование
4.1. Решение суда первой инстанции может быть обжаловано в апелляционном суде.`,
    },
  ];

  const KB_CHANGES = [
    {
      id: 12, day: today(), documentId: 5, versionId: 55, changeKind: 'UPDATED', title: 'The Penal Code штата Сан-Андреас',
      docType: 'LAW', url: 'https://forum.epic-gta.com/threads/the-penal-code-shtata-san-andreas.191/',
      changedWords: 18, totalWords: 240, createdAt: new Date().toISOString(),
      beforeText: 'Статья 12.1. Убийство первой степени\nУмышленное убийство при отягчающих обстоятельствах наказывается лишением свободы сроком на 120 месяцев и штрафом в размере 150000 виртуальной валюты.',
      afterText: 'Статья 12.1. Убийство первой степени\nУмышленное убийство при отягчающих обстоятельствах наказывается лишением свободы сроком на 150 месяцев и штрафом в размере 200000 виртуальной валюты.',
      diff: {
        ops: [
          { kind: 'equal', text: 'Статья 12.1. Убийство первой степени\nУмышленное убийство при отягчающих обстоятельствах наказывается лишением свободы сроком на ' },
          { kind: 'del', text: '120' }, { kind: 'ins', text: '150' },
          { kind: 'equal', text: ' месяцев и штрафом в размере ' },
          { kind: 'del', text: '150000' }, { kind: 'ins', text: '200000' },
          { kind: 'equal', text: ' виртуальной валюты.' },
        ],
        removedText: '120 150000', addedText: '150 200000', changedWords: 4, totalWords: 26, changedRatio: 0.15,
      },
    },
    {
      id: 11, day: today(), documentId: 1, versionId: 54, changeKind: 'UPDATED', title: 'Правила сервера',
      docType: 'RULE', url: 'https://forum.epic-gta.com/threads/pravila-servera.13/',
      changedWords: 9, totalWords: 310, createdAt: new Date().toISOString(),
      beforeText: '4.2. Сотрудник обязан предоставить служебное удостоверение при проверке, если игрок об этом попросил.',
      afterText: '4.2. Сотрудник обязан предоставить удостоверение личности при проверке, если игрок об этом попросил.',
      diff: {
        ops: [
          { kind: 'equal', text: '4.2. Сотрудник обязан предоставить ' },
          { kind: 'del', text: 'служебное удостоверение' },
          { kind: 'ins', text: 'удостоверение личности' },
          { kind: 'equal', text: ' при проверке, если игрок об этом попросил.' },
        ],
        removedText: 'служебное удостоверение', addedText: 'удостоверение личности', changedWords: 3, totalWords: 14, changedRatio: 0.21,
      },
    },
    {
      id: 10, day: today(), documentId: 7, versionId: 53, changeKind: 'NEW', title: 'Правила проведения массовых мероприятий',
      docType: 'RULE', url: 'https://forum.epic-gta.com/threads/meropriyatiya-rules.141/',
      changedWords: 46, totalWords: 46, createdAt: new Date().toISOString(), isNew: true,
      afterText: '1. Общие положения\n1.1. Массовым мероприятием признаётся событие с участием более десяти персонажей.\n1.2. Организатор обязан согласовать мероприятие с администрацией проекта не позднее чем за 24 часа.\n\n2. Безопасность\n2.1. На территории проведения мероприятия запрещены любые противоправные действия.\n2.2. Организатор несёт ответственность за соблюдение правил участниками мероприятия.',
    },
    {
      id: 9, day: yesterday(1), documentId: 3, versionId: 52, changeKind: 'UPDATED', title: 'Правила для криминальных фракций',
      docType: 'RULE', url: 'https://forum.epic-gta.com/threads/pravila-kriminal.21/', changedWords: 12, totalWords: 180,
      beforeText: '2.3. Запрещено брать в заложники более трёх человек одновременно.',
      afterText: '2.3. Запрещено брать в заложники более двух человек одновременно.',
      diff: { ops: [{ kind: 'equal', text: '2.3. Запрещено брать в заложники более ' }, { kind: 'del', text: 'трёх' }, { kind: 'ins', text: 'двух' }, { kind: 'equal', text: ' человек одновременно.' }], removedText: 'трёх', addedText: 'двух', changedWords: 2, totalWords: 11, changedRatio: 0.18 },
    },
    {
      id: 8, day: yesterday(2), documentId: 6, versionId: 51, changeKind: 'UPDATED', title: 'Судебный кодекс штата Сан-Андреас',
      docType: 'LAW', url: 'https://forum.epic-gta.com/threads/sudebnyi-kodeks-shtata-san-andreas.189/', changedWords: 6, totalWords: 120,
      beforeText: '4.1. Решение суда первой инстанции может быть обжаловано в верховном суде.',
      afterText: '4.1. Решение суда первой инстанции может быть обжаловано в апелляционном суде.',
      diff: { ops: [{ kind: 'equal', text: '4.1. Решение суда первой инстанции может быть обжаловано в ' }, { kind: 'del', text: 'верховном' }, { kind: 'ins', text: 'апелляционном' }, { kind: 'equal', text: ' суде.' }], removedText: 'верховном', addedText: 'апелляционном', changedWords: 2, totalWords: 13, changedRatio: 0.15 },
    },
    { id: 7, day: yesterday(4), documentId: 2, versionId: 50, changeKind: 'NEW', title: 'Регламент взаимодействия государственных организаций', docType: 'RULE', url: 'https://forum.epic-gta.com/threads/reglament.140/', changedWords: 88, totalWords: 88, isNew: true, afterText: '1. Регламент определяет порядок взаимодействия государственных организаций при проведении совместных операций.\n2. Совместная операция проводится по согласованию руководителей задействованных организаций.' },
  ];

  let REPORTS = [
    {
      id: 1842, requestId: 901, userId: 6, username: 'Anna_Lebedeva', avatarUrl: null, userRole: 'Игрок',
      mode: 'rules', question: 'Обязан ли полицейский показывать удостоверение при проверке документов?',
      verdict: 'allowed', explanation: 'Да, сотрудник обязан показать удостоверение по требованию игрока.',
      basis: 'Правила сервера, пункт 4.2: «Сотрудник обязан предоставить служебное удостоверение при проверке».',
      category: 'outdated', categoryLabel: 'Устаревшая информация',
      comment: 'В редакции от 05.10.2026 формулировка изменена на «удостоверение личности», AI цитирует старую версию.',
      status: 'new', analysis: 'kb_outdated', analysisLabel: 'Устарела база', resolution: null,
      handledBy: null, handledAt: null, createdAt: new Date(Date.now() - 3600_000).toISOString(), kbVersion: '6-20261005',
      sources: [
        { index: 0, documentId: 1, version: 3, docType: 'RULE', title: 'Правила сервера', heading: '4. Поведение при проверке документов', category: 'Важно', section: 'Сервер / Правила сервера / Общие правила', content: '4.2. Сотрудник обязан предоставить служебное удостоверение при проверке, если игрок об этом попросил.', url: 'https://forum.epic-gta.com/threads/pravila-servera.13/', revisionLabel: '05.10.2026 20:14', threadId: 13, postId: 13, score: 12.4 },
      ],
    },
    {
      id: 1841, requestId: 898, userId: 7, username: 'Roman_D', avatarUrl: null, userRole: 'Игрок',
      mode: 'laws', question: 'Какой срок дают за убийство первой степени?',
      verdict: 'forbidden', explanation: 'Убийство первой степени наказывается лишением свободы.',
      basis: 'Penal Code, статья 12.1 — 120 месяцев и штраф 150000.',
      category: 'wrong_article', categoryLabel: 'Неправильная статья',
      comment: 'Срок уже изменён на 150 месяцев.', status: 'in_progress', analysis: 'kb_outdated', analysisLabel: 'Устарела база',
      resolution: 'Проверяю версию Penal Code после последней синхронизации.', handledBy: { id: 3, username: 'Kirill_Morozov' },
      handledAt: new Date(Date.now() - 7200_000).toISOString(), createdAt: new Date(Date.now() - 9000_000).toISOString(), kbVersion: '6-20261005',
      sources: [
        { index: 0, documentId: 5, version: 4, docType: 'LAW', title: 'The Penal Code штата Сан-Андреас', heading: 'Статья 12.1. Убийство первой степени', category: 'Важно', section: 'Правительство / Законодательная база', content: 'Статья 12.1. Убийство первой степени\nУмышленное убийство при отягчающих обстоятельствах наказывается лишением свободы сроком на 150 месяцев и штрафом в размере 200000 виртуальной валюты.', url: 'https://forum.epic-gta.com/threads/the-penal-code-shtata-san-andreas.191/', revisionLabel: '05.10.2026 11:20', threadId: 191, postId: 191, score: 18.9 },
      ],
    },
    {
      id: 1839, requestId: 890, userId: 4, username: 'Nikita_Volkov', avatarUrl: null, userRole: 'Хелпер',
      mode: 'rules', question: 'Можно ли грабить в зелёной зоне, если отыграл маску?',
      verdict: 'unknown', explanation: 'В официальной базе EpicRP не найдено подтверждённой информации для однозначного ответа.',
      basis: null, category: 'misinterpreted', categoryLabel: 'Неверно истолковано правило',
      comment: null, status: 'resolved', analysis: 'search_miss', analysisLabel: 'Ошибка поиска',
      resolution: 'Пункт 5.1 прямо запрещает ограбления в зелёных зонах. Улучшен поиск по заголовкам пунктов.',
      handledBy: { id: 1, username: 'Alexander' }, handledAt: new Date(Date.now() - 86400_000).toISOString(),
      createdAt: new Date(Date.now() - 96400_000).toISOString(), kbVersion: '6-20261004',
      sources: [],
    },
  ];

  const AUDIT = [
    { id: 512, actorName: 'Alexander', action: 'ai.report.status', entityType: 'ai_report', entityId: '1839', meta: { from: 'in_progress', to: 'resolved' }, createdAt: new Date(Date.now() - 86400_000).toISOString() },
    { id: 511, actorName: 'system', action: 'knowledge.sync.auto', entityType: 'sync_log', entityId: '88', meta: { new: 1, updated: 2, archived: 0, status: 'success' }, createdAt: new Date(Date.now() - 3600_000).toISOString() },
    { id: 510, actorName: 'Kirill_Morozov', action: 'user.block', entityType: 'user', entityId: '5', meta: { reason: 'Систематический MG и оскорбления в OOC-канале' }, createdAt: new Date(Date.now() - 7 * 86400_000).toISOString() },
    { id: 509, actorName: 'Stefan_Blaide', action: 'user.role.change', entityType: 'user', entityId: '4', meta: { from: 'player', to: 'helper' }, createdAt: new Date(Date.now() - 8 * 86400_000).toISOString() },
    { id: 508, actorName: 'Alexander', action: 'user.permission.add', entityType: 'user', entityId: '4', meta: { permission: 'knowledge.sync', effect: 'allow' }, createdAt: new Date(Date.now() - 8 * 86400_000).toISOString() },
    { id: 507, actorName: 'Alexander', action: 'login', entityType: 'user', entityId: '1', meta: { provider: 'discord' }, createdAt: new Date(Date.now() - 9 * 86400_000).toISOString() },
    { id: 506, actorName: 'system', action: 'system.bootstrap.developer', entityType: 'user', entityId: '1', meta: { label: 'discord:4829…' }, createdAt: new Date(Date.now() - 30 * 86400_000).toISOString() },
  ];

  function today() { return new Date().toISOString().slice(0, 10); }
  function yesterday(n) { return new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10); }

  /* ============================== СОСТОЯНИЕ ============================== */

  const SETTINGS = {
    language: 'ru', theme: 'dark', autostart: false,
    opacity: 0.82, animations: true, animationSpeed: 1,
    panelWidth: 900, panelHeight: 56, panelPosition: 'bottom-center', panelX: null, panelY: null,
    sourcesWidth: 420, sourcesHeight: 560, sourcesGap: 12,
    alwaysOnTop: true, hotkey: 'F10', comboHistory: 'Ctrl+H', comboSources: 'Ctrl+O', comboPin: 'Ctrl+P',
    hideOnOutsideClick: true, clearPreviousAnswer: true,
    rememberMode: true, defaultMode: 'rules', hardwareAcceleration: true, lowPerformanceMode: false,
    confirmAiAsk: true, streamerMode: false, streamerNick: null, micDeviceId: null,
  };

  /* Дневной лимит запросов к ИИ: 50 по умолчанию, персональный выдаёт админ. */
  let quotaUsed = 3;
  let quotaPersonal = null;
  function quotaInfo() {
    const limit = quotaPersonal ?? 50;
    return { used: quotaUsed, limit, left: Math.max(0, limit - quotaUsed), resetAt: new Date(Date.now() + 3600_000).toISOString(), personal: quotaPersonal != null };
  }

  const listeners = new Map();
  let currentRole = 'developer';
  let lastAnswer = null;
  let nextRequestId = 950;
  let nextReportId = 1850;
  const votes = new Map();
  const HISTORY = [
    { requestId: 902, mode: 'rules', question: 'Что такое DM и можно ли убивать игрока без причины?', verdict: 'forbidden', createdAt: new Date(Date.now() - 53 * 60_000).toISOString() },
    { requestId: 901, mode: 'laws', question: 'Penal Code: статья за нападение на государственного служащего', verdict: 'depends', createdAt: new Date(Date.now() - 3 * 3600_000).toISOString() },
  ];

  function permsFor(roleCode) { return roleByCode(roleCode).perms.slice(); }

  /* ============================== МОСТ epicAI ============================== */

  const bridge = {
    invoke: async (channel, ...args) => {
      switch (channel) {
        case 'epic:session:token':
          return 'demo-session-token';
        case 'epic:runtime':
          return { backendUrl: 'https://demo.epic-ai.local', version: '1.0.0', platform: 'demo', arch: 'x64', electron: '33.x', chrome: '130.x', node: '20.x', packaged: false, settings: { ...SETTINGS } };
        case 'epic:app:info':
          return { version: '1.0.0', electron: '33.4.0', chrome: '130.0.6723.191', node: '20.19.0', platform: 'win32', arch: 'x64', userData: 'C:\\Users\\Alexander\\AppData\\Roaming\\Epic AI', packaged: false, backendUrl: 'https://demo.epic-ai.local' };
        case 'epic:settings:get': return { settings: { ...SETTINGS } };
        case 'epic:settings:set': Object.assign(SETTINGS, args[0] ?? {}); emit('settings:changed', { ...SETTINGS }); return { settings: { ...SETTINGS } };
        case 'epic:settings:reset': return { settings: { ...SETTINGS } };
        case 'epic:panel:resize': resizeStage(args[0]); return { x: 0, y: 0, width: 900, height: args[0] };
        case 'epic:panel:geometry': return { x: 0, y: 0, width: 900, height: 56 };
        case 'epic:panel:move': window.__DEMO_PANEL_MOVE__ = { x: args[0], y: args[1] }; return { x: args[0], y: args[1], width: 900, height: 56 };
        case 'epic:window:toggle': case 'epic:window:show': case 'epic:window:hide': return true;
        case 'epic:sources:open': await renderInlineSources(args[0]); return true;
        case 'epic:history:open': renderInlineHistory(); return true;
        case 'epic:history:pick': emit('main:open-history-item', args[0]); return true;
        case 'epic:sources:close': { const slot = document.getElementById('demo-sources-slot'); if (slot) slot.innerHTML = ''; return true; }
        // Подтверждение вопроса — отдельное «окно» рядом с панелью (в приложении
        // это BrowserWindow confirm.html); promise ждёт клика «Спросить»/«Отмена».
        case 'epic:ask:confirm': return askConfirmDemo();
        case 'epic:ask:confirm:result': resolveConfirmDemo(Boolean(args[0])); return true;
        case 'epic:admin:open': window.open('admin.html', '_blank'); return true;
        case 'epic:auth:open': return true;
        case 'epic:account:logout': return true;
        case 'epic:external': window.open(args[0], '_blank', 'noopener'); return true;
        case 'epic:hotkey:set': return { requested: args[0], registered: args[0], ok: true };
        case 'epic:always-on-top': return Boolean(args[0]);
        case 'epic:app:relaunch': return true;
        case 'epic:app:quit': return true;
        case 'epic:backend:logs': return ['[demo] mock-backend: логи отсутствуют — демо работает без реального сервера.'];
        case 'epic:devtools': return true;
        default: console.warn('[demo] неизвестный IPC-канал:', channel); return null;
      }
    },
    on: (channel, listener) => {
      if (!listeners.has(channel)) listeners.set(channel, new Set());
      listeners.get(channel).add(listener);
      return () => listeners.get(channel)?.delete(listener);
    },
    once: (channel) => new Promise((resolve) => {
      const off = bridge.on(channel, (p) => { off(); resolve(p); });
    }),
    /** демо-переключатель роли */
    __setRole: (code) => { currentRole = code; },
    __role: () => currentRole,
  };
  window.epicAI = bridge;

  function emit(channel, payload) {
    for (const fn of listeners.get(channel) ?? []) { try { fn(payload); } catch (e) { console.error(e); } }
  }

  /**
   * В приложении main process меняет высоту BrowserWindow (панель растёт вниз).
   * В демо мы меняем высоту body — визуальный эффект тот же.
   */
  function resizeStage(height) {
    const h = Math.max(56, Number(height) || 56);
    document.body.style.height = `${h}px`;
    document.body.style.minHeight = `${h}px`;
    document.body.style.overflow = 'hidden';
    document.body.style.transition = 'height .2s cubic-bezier(.22,.61,.36,1)';
    const win = document.querySelector('.demo-window');
    if (win) win.style.height = 'auto';
  }

  /**
   * «Отдельное окно источников справа» .
   * В демо рядом с панелью рисуется живая копия окна источников;
   * полноценная версия той же вёрстки — demo/sources.html.
   */
  async function renderInlineSources(payload) {
    const slot = document.getElementById('demo-sources-slot');
    if (!slot) return;
    window.__DEMO_SOURCES_PAYLOAD__ = payload;
    slot.innerHTML = '';

    const holder = document.createElement('div');
    holder.className = 'demo-window';
    holder.style.cssText = 'width:430px;height:600px';
    const style = document.createElement('style');
    style.textContent = '__SOURCES_CSS__';
    holder.appendChild(style);
    slot.appendChild(holder);

    const link = document.createElement('a');
    link.href = 'sources.html';
    link.target = '_blank';
    link.textContent = 'Открыть окно источников в полном размере ↗';
    link.style.cssText = 'display:block;margin:8px 2px 0;font-size:10.5px;color:#888;text-align:center;text-decoration:none';
    slot.appendChild(link);

    const root = document.createElement('div');
    root.className = 'sources glass';
    root.innerHTML =
      '<header class="sources__head">' +
        '<div class="row gap-8" style="min-width:0">' +
          '<span class="section-title">Найденные источники</span>' +
          '<span class="badge">' + escapeHtmlDemo(payload.modeLabel ?? 'ПРАВИЛА') + '</span>' +
          '<span class="badge badge--accent">' + (payload.sources ?? []).length + '</span>' +
        '</div>' +
        '<span class="grow"></span>' +
        '<button class="icon-btn" data-role="close" title="Закрыть">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>' +
        '</button>' +
      '</header>' +
      '<div class="sources__question"><b>Запрос:</b> ' + escapeHtmlDemo(payload.question ?? '') + '</div>' +
      '<div class="sources__body scroll" data-role="list"></div>' +
      '<footer class="sources__foot">' +
        '<span class="subtle" style="font-size:10px">база v' + escapeHtmlDemo(payload.kbVersion ?? '—') + ' · ' + fmtDemo(payload.generatedAt) + '</span>' +
        '<span class="grow"></span>' +
        '<span class="subtle" style="font-size:10px">демо-окно</span>' +
      '</footer>';
    holder.appendChild(root);

    root.querySelector('[data-role=close]').addEventListener('click', () => { slot.innerHTML = ''; });

    const list = root.querySelector('[data-role=list]');
    if (!payload.sources || !payload.sources.length) {
      list.innerHTML = '<div class="src-nodata"><b>В официальной базе EpicRP не найдено подтверждённой информации для однозначного ответа.</b>' +
        '<div style="margin-top:6px">Система не придумывает правила и статьи: если официального источника нет — ответа нет.</div></div>';
      return;
    }
    const terms = [...new Set(String(payload.question ?? '').toLowerCase().match(/[a-zа-яё0-9]{3,}/gi) ?? [])];
    for (const src of payload.sources) {
      const card = document.createElement('article');
      card.className = 'src-card';
      card.innerHTML =
        '<div class="src-card__head">' +
          '<span class="src-card__num">' + (src.index + 1) + '</span>' +
          '<div class="src-card__titles">' +
            '<div class="src-card__doc">' + escapeHtmlDemo(src.title) + '</div>' +
            (src.heading ? '<div class="src-card__item">' + escapeHtmlDemo(src.heading) + '</div>' : '') +
          '</div>' +
          '<span class="' + (src.docType === 'LAW' ? 'badge' : 'badge badge--mid') + ' src-card__kind">' + (src.docType === 'LAW' ? 'Закон' : 'Правило') + '</span>' +
        '</div>' +
        '<div class="src-card__meta">' +
          '<span><b>Категория:</b> ' + escapeHtmlDemo(src.category ?? '—') + '</span>' +
          '<span><b>Дата редакции:</b> <span class="mono">' + escapeHtmlDemo(src.revisionLabel ?? '—') + '</span></span>' +
          '<span><b>Версия:</b> <span class="mono">v' + src.version + '</span></span>' +
          '<span><b>Тема:</b> <span class="mono">#' + src.threadId + '</span></span>' +
        '</div>' +
        '<div class="src-card__text selectable">' + highlightDemo(src.content, terms) + '</div>' +
        '<div class="src-card__foot">' +
          '<a class="src-open" href="' + escapeHtmlDemo(src.url) + '" target="_blank" rel="noopener">Открыть источник ↗</a>' +
          '<span class="grow"></span>' +
          '<span class="subtle" style="font-size:9.5px">forum.epic-gta.com</span>' +
        '</div>';
      list.appendChild(card);
    }
  }

  /**
   * История ответов в демо: отдельный «экран» рядом с панелью — как окно
   * истории в приложении (открывается в стиле окна источников).
   */
  function renderInlineHistory() {
    const slot = document.getElementById('demo-history-slot');
    if (!slot) return;
    slot.innerHTML = '';
    const holder = document.createElement('div');
    holder.className = 'demo-window';
    holder.style.cssText = 'width:460px;height:600px;display:flex;flex-direction:column;overflow:hidden';
    slot.appendChild(holder);
    const chrome = document.createElement('div');
    chrome.className = 'histwin__chrome';
    chrome.style.borderRadius = '0';
    chrome.innerHTML = '<b class="histwin__title">История ответов</b>';
    holder.appendChild(chrome);
    const root = document.createElement('div');
    root.className = 'histwin__body';
    root.style.height = 'auto';
    root.style.flex = '1 1 auto';
    holder.appendChild(root);
    root.innerHTML = '<div class="empty"><span class="spinner"></span></div>';
    void (async () => {
      let items = [];
      try { items = (await (await fetch('http://127.0.0.1:8787/api/ai/history?limit=60')).json()).items ?? []; }
      catch { root.innerHTML = '<div class="empty">История недоступна</div>'; return; }
      root.innerHTML = '';
      if (!items.length) { root.innerHTML = '<div class="empty">Истории пока нет</div>'; return; }
      const colors = { allowed: '#ACE72E', forbidden: '#E74C3C', depends: '#F1C40F', unknown: '#666' };
      for (const it of items) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'hist-item';
        b.innerHTML = `<span class="verdict-dot" style="background:${colors[it.verdict] ?? colors.unknown}"></span><span class="hist-item__q"></span><span class="hist-item__meta"><span class="badge" style="text-transform:none">${it.mode === 'laws' ? 'законы' : 'правила'}</span></span>`;
        b.querySelector('.hist-item__q').textContent = it.question;
        b.onclick = () => { window.epicAI.invoke('epic:history:pick', it.requestId); };
        root.appendChild(b);
      }
    })();
  }

  /**
   * Окно подтверждения «Спросить ИИ?» в демо: отдельная мини-карточка рядом
   * с панелью (в приложении — BrowserWindow confirm.html поверх панели).
   * Возвращает promise: «Спросить»/Enter → true, «Отмена»/Esc → false.
   */
  let confirmResolveDemo = null;
  function resolveConfirmDemo(ok) {
    const r = confirmResolveDemo;
    confirmResolveDemo = null;
    if (r) r(ok);
  }
  function askConfirmDemo() {
    return new Promise((resolve) => {
      const slot = document.getElementById('demo-confirm-slot');
      if (!slot) { resolve(true); return; }
      if (confirmResolveDemo) { confirmResolveDemo(false); confirmResolveDemo = null; }
      slot.innerHTML = '';
      const holder = document.createElement('div');
      holder.className = 'demo-window demo-confirm';
      holder.innerHTML =
        '<div class="modal" style="position:static;background:transparent">' +
          '<div class="modal__box" style="box-shadow:none">' +
            '<div class="modal__title">Спросить ИИ?</div>' +
            '<div class="modal__quota"><span>Осталось сегодня</span><b data-role="quota">…</b></div>' +
            '<div class="modal__bar"><span data-role="bar" style="width:100%"></span></div>' +
            '<div class="modal__actions">' +
              '<button class="btn btn--ghost" data-role="cancel" type="button">Отмена<span class="modal__key">Esc</span></button>' +
              '<button class="btn btn--accent" data-role="ok" type="button">Спросить<span class="modal__key">Enter</span></button>' +
            '</div>' +
          '</div>' +
        '</div>';
      slot.appendChild(holder);
      const q = quotaInfo();
      holder.querySelector('[data-role=quota]').textContent = q.left + ' из ' + q.limit;
      holder.querySelector('[data-role=bar]').style.width = (q.limit > 0 ? Math.round((q.left / q.limit) * 100) : 0) + '%';
      const finish = (ok) => {
        if (confirmResolveDemo !== resolve) return;
        confirmResolveDemo = null;
        document.removeEventListener('keydown', onKey, true);
        slot.innerHTML = '';
        resolve(ok);
      };
      const onKey = (e) => {
        if (e.key === 'Enter') { e.preventDefault(); finish(true); }
        else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      };
      holder.querySelector('[data-role=ok]').onclick = () => finish(true);
      holder.querySelector('[data-role=cancel]').onclick = () => finish(false);
      document.addEventListener('keydown', onKey, true);
      confirmResolveDemo = resolve;
    });
  }



  function escapeHtmlDemo(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function highlightDemo(text, terms) {
    let out = escapeHtmlDemo(text);
    for (const t of terms) {
      const safe = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      out = out.replace(new RegExp('(' + safe + ')', 'gi'), '<mark>$1</mark>');
    }
    return out;
  }

  function fmtDemo(v) {
    if (!v) return '—';
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return '—';
    const p = (n) => String(n).padStart(2, '0');
    return p(d.getDate()) + '.' + p(d.getMonth() + 1) + '.' + d.getFullYear() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }


  /* ============================== FETCH-ШИМ ============================== */

  /**
   * В реальном Electron 33 fetch есть всегда. Шим нужен только окружениям без
   * fetch (jsdom в тестах, старые WebView) — иначе mock-backend не поднимется.
   */
  if (typeof window.fetch !== 'function') {
    window.fetch = function (input) {
      var url = typeof input === 'string' ? input : (input && input.url);
      return Promise.reject(new Error('fetch недоступен в этом окружении: ' + url));
    };
  }
  if (typeof window.Response === 'undefined') {
    window.Response = class Response {
      constructor(body, opts) {
        opts = opts || {};
        this._body = body;
        this.status = opts.status === undefined ? 200 : opts.status;
        this.ok = this.status >= 200 && this.status < 300;
        const h = opts.headers || {};
        this.headers = { get: (k) => (h[k] === undefined ? null : h[k]) };
      }
      text() { return Promise.resolve(this._body); }
      json() { return Promise.resolve(JSON.parse(this._body)); }
    };
  }

/* ============================== MOCK BACKEND ============================== */

  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    // Демо-ассеты (css/html соседних страниц) грузим реально
    if (!/\/api\//.test(url)) return realFetch(input, init);
    await sleep(120 + Math.random() * 220);
    const method = (init.method ?? 'GET').toUpperCase();
    const body = init.body ? JSON.parse(init.body) : {};
    const path = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    const query = new URLSearchParams(url.split('?')[1] ?? '');

    try {
      const data = await route(method, path, body, query);
      return json(200, data);
    } catch (e) {
      return json(e.status ?? 500, { error: e.code ?? 'error', message: e.message });
    }
  };

  function json(status, data) {
    return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const fail = (status, code, message) => { const e = new Error(message); e.status = status; e.code = code; throw e; };

  async function route(method, path, body, query) {
    const perms = permsFor(currentRole);
    const need = (...p) => { if (!p.every((x) => perms.includes(x))) fail(403, 'forbidden', `Недостаточно прав: ${p.join(', ')}`); };

    /* ---- auth ---- */
    if (path === '/api/auth/me' && method === 'GET') {
      const u = { ...USER, primaryRole: { code: currentRole, name: roleByCode(currentRole).name, color: roleByCode(currentRole).color, level: roleByCode(currentRole).level } };
      return { authenticated: true, blocked: false, user: u, permissions: perms, maxRoleLevel: roleByCode(currentRole).level, isDeveloper: currentRole === 'developer' };
    }
    if (path === '/api/auth/logout') return { ok: true };
    if (path === '/api/auth/providers') return { telegram: true, devLogin: false, botUsername: 'EpicAIHelper_bot' };

    /* ---- AI ---- */
    if (method === 'DELETE' && /^\/api\/users\/\d+$/.test(path)) {
      const id = Number(path.split('/')[3]);
      const i = USERS.findIndex((x) => x.id === id);
      if (i >= 0) USERS.splice(i, 1);
      return { ok: true };
    }
    if (path === '/api/telegram/status' && method === 'GET') {
      return {
        enabled: true, username: 'EpicAIHelper_bot', polling: true, subscribers: 3,
        notifyKbUpdates: true,
        recent: [{ at: new Date(Date.now() - 3600_000).toISOString(), author: 'developer', text: 'Обновление правил сервера, раздел 4.3', sent: 3, failed: 0 }],
      };
    }
    if (path === '/api/telegram/settings' && method === 'PUT') return { ok: true, notifyKbUpdates: Boolean(body.notifyKbUpdates) };
    if (path === '/api/telegram/broadcast' && method === 'POST') return { ok: true, sent: 3, failed: 0, subscribers: 3 };
    if (path === '/api/ai/ask' && method === 'POST') {
      need('ai.use');
      const mode = body.mode === 'laws' ? 'laws' : 'rules';
      const found = mockSearch(String(body.question ?? ''), mode);
      const requestId = nextRequestId++;
      quotaUsed += 1;
      if (!found.length) {
        lastAnswer = { requestId, mode, question: body.question, verdict: 'unknown', status: 'no_data', sources: [] };
        HISTORY.unshift({ requestId, mode, question: String(body.question), verdict: 'unknown', createdAt: new Date().toISOString() });
        return { ...lastAnswer, verdictLabel: 'Нет подтверждённых данных', explanation: 'В официальной базе EpicRP не найдено подтверждённой информации для однозначного ответа.', basis: null, noData: true, kbVersion: '6-20261005', latencyMs: 420, provider: 'groq', model: 'llama-3.3-70b-versatile', confidence: 0, feedback: { allowed: true, vote: null }, relatedDocuments: [], quota: quotaInfo() };
      }
      const answer = mockAnswer(body.question, mode, found);
      lastAnswer = { requestId, ...answer };
      HISTORY.unshift({ requestId, mode, question: String(body.question), verdict: answer.verdict, createdAt: new Date().toISOString() });
      return { requestId, mode, question: body.question, status: 'ok', provider: 'groq', model: 'llama-3.3-70b-versatile', latencyMs: 1180, kbVersion: '6-20261005', noData: false, relatedDocuments: [], feedback: { allowed: true, vote: null }, quota: quotaInfo(), ...answer };
    }
    if (path === '/api/ai/quota' && method === 'GET') {
      need('ai.use');
      return quotaInfo();
    }
    if (path === '/api/ai/sources' && method === 'GET') {
      return { requestId: Number(query.get('requestId')), mode: lastAnswer?.mode ?? 'rules', question: lastAnswer?.question ?? '', kbVersion: '6-20261005', createdAt: new Date().toISOString(), sources: lastAnswer?.sources ?? [] };
    }
    if (path === '/api/ai/transcribe' && method === 'POST') {
      return { text: 'Можно ли красить транспорт в виниловый цвет?', provider: 'mock-whisper' };
    }
    if (path === '/api/ai/feedback/categories') {
      return {
        items: [
          { id: 'misinterpreted', label: 'Неверно истолковано правило' }, { id: 'wrong_article', label: 'Неправильная статья' },
          { id: 'outdated', label: 'Устаревшая информация' }, { id: 'wrong_source', label: 'Неверный источник' },
          { id: 'technical', label: 'Техническая ошибка' }, { id: 'other', label: 'Другое' },
        ],
        analysis: [{ id: 'kb_outdated', label: 'Устарела база' }, { id: 'search_miss', label: 'Ошибка поиска' }, { id: 'ai_error', label: 'Ошибка AI' }, { id: 'technical', label: 'Техническая ошибка' }],
      };
    }
    if (path === '/api/ai/feedback/like' && method === 'POST') { votes.set(body.requestId, 1); return { ok: true, requestId: body.requestId, vote: 1, reportCreated: false }; }
    if (path === '/api/ai/reports' && method === 'POST') {
      need('ai.feedback');
      if (!body.category) fail(400, 'bad_request', 'Категория ошибки должна быть выбрана');
      const id = nextReportId++;
      REPORTS = [{
        id, requestId: body.requestId, userId: USER.id, username: USER.username, avatarUrl: null, userRole: roleByCode(currentRole).name,
        mode: lastAnswer?.mode ?? 'rules', question: lastAnswer?.question ?? '', verdict: lastAnswer?.verdict ?? 'unknown',
        explanation: lastAnswer?.explanation ?? '', basis: lastAnswer?.basis ?? null,
        category: body.category, categoryLabel: ({ misinterpreted: 'Неверно истолковано правило', wrong_article: 'Неправильная статья', outdated: 'Устаревшая информация', wrong_source: 'Неверный источник', technical: 'Техническая ошибка', other: 'Другое' })[body.category],
        comment: body.comment ?? null, status: 'new', analysis: body.category === 'outdated' ? 'kb_outdated' : 'ai_error',
        analysisLabel: body.category === 'outdated' ? 'Устарела база' : 'Ошибка AI', resolution: null, handledBy: null, handledAt: null,
        createdAt: new Date().toISOString(), kbVersion: '6-20261005', sources: lastAnswer?.sources ?? [],
      }, ...REPORTS];
      votes.set(body.requestId, -1);
      return { ok: true, reportId: id, requestId: body.requestId, status: 'new', suggestedAnalysis: body.category === 'outdated' ? 'kb_outdated' : 'ai_error' };
    }
    if (path === '/api/ai/reports' && method === 'GET') {
      need('ai.reports.view');
      const status = query.get('status');
      const items = REPORTS.filter((r) => !status || r.status === status).map((r) => ({
        id: r.id, requestId: r.requestId, user: { id: r.userId, username: r.username, avatarUrl: r.avatarUrl, role: r.userRole },
        mode: r.mode, question: r.question, verdict: r.verdict, category: r.category, categoryLabel: r.categoryLabel,
        comment: r.comment, status: r.status, analysis: r.analysis, analysisLabel: r.analysisLabel, resolution: r.resolution,
        handledBy: r.handledBy, handledAt: r.handledAt, createdAt: r.createdAt, createdAtLabel: fmt(r.createdAt),
      }));
      return {
        total: items.length, limit: 50, offset: 0,
        counts: { new: REPORTS.filter((r) => r.status === 'new').length, inProgress: REPORTS.filter((r) => r.status === 'in_progress').length, resolved: REPORTS.filter((r) => r.status === 'resolved').length, all: REPORTS.length },
        items,
      };
    }
    if (/^\/api\/ai\/reports\/\d+$/.test(path)) {
      const id = Number(path.split('/').pop());
      const r = REPORTS.find((x) => x.id === id);
      if (!r) fail(404, 'not_found', 'Отчёт не найден');
      if (method === 'GET') {
        need('ai.reports.view');
        return {
          id: r.id, user: { id: r.userId, username: r.username, avatarUrl: r.avatarUrl, role: r.userRole, status: 'active' },
          question: r.question, mode: r.mode, modeLabel: r.mode === 'laws' ? 'Законы' : 'Правила',
          aiAnswer: { verdict: r.verdict, explanation: r.explanation, basis: r.basis, model: 'llama-3.3-70b-versatile', provider: 'groq', createdAt: r.createdAt },
          sources: r.sources, category: r.category, categoryLabel: r.categoryLabel, comment: r.comment,
          status: r.status, statusLabel: { new: 'Новая', in_progress: 'На проверке', resolved: 'Решена' }[r.status],
          analysis: r.analysis, analysisLabel: r.analysisLabel, resolution: r.resolution, handledBy: r.handledBy, handledAt: r.handledAt,
          kbVersion: r.kbVersion, createdAt: r.createdAt, createdAtLabel: fmt(r.createdAt),
        };
      }
      if (method === 'PATCH') {
        need('ai.reports.manage');
        if (body.status) { r.status = body.status; r.handledBy = { id: USER.id, username: USER.username }; r.handledAt = new Date().toISOString(); }
        if (body.analysis !== undefined) { r.analysis = body.analysis; r.analysisLabel = ({ kb_outdated: 'Устарела база', search_miss: 'Ошибка поиска', ai_error: 'Ошибка AI', technical: 'Техническая ошибка' })[body.analysis] ?? null; }
        if (body.resolution !== undefined) r.resolution = body.resolution;
        return { ok: true, id: r.id, status: r.status, analysis: r.analysis, resolution: r.resolution };
      }
    }
    if (path === '/api/ai/history') return { items: HISTORY.slice(0, Number(query.get('limit') ?? 40)) };
    if (/^\/api\/ai\/request\/\d+$/.test(path)) {
      const id = Number(path.split('/').pop());
      const item = HISTORY.find((x) => x.requestId === id);
      if (!item) fail(404, 'not_found', 'Запрос не найден');
      const found = mockSearch(item.question, item.mode);
      const answer = found.length
        ? mockAnswer(item.question, item.mode, found)
        : { verdict: 'unknown', explanation: 'В официальной базе EpicRP не найдено подтверждённой информации для однозначного ответа.', basis: null, sources: [], confidence: 0 };
      return { requestId: id, mode: item.mode, question: item.question, status: 'ok', provider: 'groq', model: 'llama-3.3-70b-versatile', latencyMs: 1180, kbVersion: '6-20261005', noData: !found.length, relatedDocuments: [], feedback: { allowed: true, vote: null }, ...answer };
    }
    if (path === '/api/ai/meta') return { kbVersion: '6-20261005', provider: 'groq', model: 'llama-3.3-70b-versatile', configured: true, configReason: null };

    /* ---- Knowledge Base ---- */
    if (path === '/api/kb/status') {
      return {
        state: 'updates', stateLabel: 'Есть обновления', stateColor: '#F87171',
        lastSyncAt: new Date(Date.now() - 42 * 60_000).toISOString(), lastSyncLabel: fmt(Date.now() - 42 * 60_000),
        lastSyncStatus: 'success', lastError: null, nextSyncAt: new Date(Date.now() + 18 * 60_000).toISOString(),
        intervalMinutes: 30, documents: { total: 64, active: 58, archive: 6, rules: 27, laws: 31 },
        versions: 143, chunks: 812, today: { newCount: 1, updatedCount: 2, archivedCount: 0 },
        kbVersion: '6-20261005', crawlerEnabled: false,
      };
    }
    if (path === '/api/kb/sync' && method === 'POST') return { ok: true, message: 'Синхронизация запущена (демо)' };
    if (path === '/api/kb/sync/logs') {
      return {
        running: false,
        items: [
          { id: 88, startedAt: new Date(Date.now() - 42 * 60_000).toISOString(), finishedAt: new Date(Date.now() - 40 * 60_000).toISOString(), triggerType: 'auto', status: 'success', docsNew: 1, docsUpdated: 2, docsArchived: 0, docsUnchanged: 55, pagesFetched: 63, error: null },
          { id: 87, startedAt: new Date(Date.now() - 72 * 60_000).toISOString(), finishedAt: new Date(Date.now() - 70 * 60_000).toISOString(), triggerType: 'auto', status: 'success', docsNew: 0, docsUpdated: 1, docsArchived: 0, docsUnchanged: 57, pagesFetched: 61, error: null },
          { id: 86, startedAt: new Date(Date.now() - 102 * 60_000).toISOString(), finishedAt: new Date(Date.now() - 101 * 60_000).toISOString(), triggerType: 'manual', status: 'error', docsNew: 0, docsUpdated: 0, docsArchived: 0, docsUnchanged: 0, pagesFetched: 4, error: 'forum.epic-gta.com: timeout after 20000 ms' },
        ],
      };
    }
    if (path === '/api/kb/changes/today') return changesFor(today());
    if (path === '/api/kb/changes/history') {
      const byDay = {};
      for (const c of KB_CHANGES) { byDay[c.day] = byDay[c.day] ?? { day: c.day, newCount: 0, updatedCount: 0, archivedCount: 0, total: 0 }; byDay[c.day].total++; if (c.changeKind === 'NEW') byDay[c.day].newCount++; if (c.changeKind === 'UPDATED') byDay[c.day].updatedCount++; }
      return { items: Object.values(byDay).sort((a, b) => (a.day < b.day ? 1 : -1)).map((d) => ({ ...d, summary: `${d.newCount} новых · ${d.updatedCount} изменений` })) };
    }
    if (path === '/api/kb/changes') return changesFor(query.get('day') ?? today());
    if (/^\/api\/kb\/changes\/\d+$/.test(path)) {
      const id = Number(path.split('/').pop());
      const c = KB_CHANGES.find((x) => x.id === id);
      if (!c) fail(404, 'not_found', 'Изменение не найдено');
      const doc = KB_DOCS.find((d) => d.id === c.documentId) ?? KB_DOCS[0];
      return {
        change: c,
        document: { id: doc.id, title: c.title, docType: c.docType, section: doc.section, category: doc.category, url: c.url, threadId: doc.threadId, postId: doc.postId, status: doc.status, sourceCreatedAt: doc.sourceCreatedAt, sourceModifiedAt: doc.sourceModifiedAt },
        before: c.beforeText ? { versionId: c.versionId - 1, version: doc.version - 1, text: c.beforeText, createdAt: doc.sourceCreatedAt } : null,
        after: { versionId: c.versionId, version: doc.version, text: c.afterText, createdAt: new Date().toISOString() },
        diff: c.diff ?? null,
        isNew: Boolean(c.isNew),
      };
    }
    if (path === '/api/kb/documents') {
      const items = KB_DOCS.filter((d) => !query.get('type') || d.docType === query.get('type')).map((d) => ({
        id: d.id, docType: d.docType, title: d.title, section: d.section, category: d.category, url: d.url, threadId: d.threadId,
        status: d.status, sourceModifiedAt: d.sourceModifiedAt, updatedAt: d.sourceModifiedAt, contentHash: 'a1b2c3', versions: d.version, currentVersion: d.version,
      }));
      return { total: items.length, items };
    }
    if (/^\/api\/kb\/documents\/\d+$/.test(path)) {
      const id = Number(path.split('/').pop());
      const d = KB_DOCS.find((x) => x.id === id) ?? KB_DOCS[0];
      return { ...d, content: d.text, wordCount: d.text.split(/\s+/).length, versions: Array.from({ length: d.version }, (_, i) => ({ versionId: id * 100 + i + 1, version: i + 1, title: d.title, wordCount: d.text.split(/\s+/).length, contentHash: 'h' + i, changeKind: i === 0 ? 'NEW' : 'UPDATED', sourceModifiedAt: d.sourceModifiedAt, fetchedAt: d.sourceModifiedAt, createdAt: d.sourceCreatedAt })) };
    }
    if (/^\/api\/kb\/documents\/\d+\/versions$/.test(path)) {
      const d = await route('GET', path.replace(/\/versions$/, ''), {}, new URLSearchParams());
      return { items: d.versions };
    }
    if (/^\/api\/kb\/documents\/\d+\/diff$/.test(path)) {
      const c = KB_CHANGES.find((x) => x.documentId === Number(path.split('/')[4])) ?? KB_CHANGES[0];
      return { documentId: Number(path.split('/')[4]), from: Number(query.get('from')), to: Number(query.get('to')), diff: c.diff ?? { ops: [{ kind: 'equal', text: 'Изменений нет' }], removedText: '', addedText: '', changedWords: 0, totalWords: 10, changedRatio: 0 } };
    }
    if (path === '/api/kb/nodes') {
      return { items: [{ nodeId: 38, parentNodeId: 30, title: 'Общие правила', url: 'https://forum.epic-gta.com/forums/obshchiye-pravila.38/', depth: 3, docType: 'RULE', isArchive: false, crawlEnabled: true, syncedAt: new Date().toISOString() }, { nodeId: 66, parentNodeId: 62, title: 'Законодательная база', url: 'https://forum.epic-gta.com/forums/zakonodatel-naya-baza.66/', depth: 2, docType: 'LAW', isArchive: false, crawlEnabled: true, syncedAt: new Date().toISOString() }, { nodeId: 121, parentNodeId: 120, title: 'Архив', url: 'https://forum.epic-gta.com/forums/arkhiv.121/', depth: 3, docType: null, isArchive: true, crawlEnabled: false, syncedAt: null }] };
    }

    /* ---- users / roles / permissions ---- */
    if (path === '/api/users/me') {
      return { ...USER, primaryRole: { code: currentRole, name: roleByCode(currentRole).name, color: roleByCode(currentRole).color, level: roleByCode(currentRole).level }, permissions: perms, extraPermissions: currentRole === 'helper' ? ['knowledge.sync'] : [], deniedPermissions: [], maxRoleLevel: roleByCode(currentRole).level, isDeveloper: currentRole === 'developer', createdAtLabel: fmt(USER.createdAt), lastLoginLabel: fmt(USER.lastLoginAt) };
    }
    if (path === '/api/users') {
      need('users.view');
      const q = (query.get('search') ?? '').toLowerCase();
      const items = USERS
        .filter((u) => !q || u.username.toLowerCase().includes(q) || String(u.id) === q || (u.discord?.username ?? '').toLowerCase().includes(q) || (u.telegram?.username ?? '').toLowerCase().includes(q))
        .filter((u) => !query.get('role') || u.role === query.get('role'))
        .filter((u) => !query.get('status') || u.status === query.get('status'))
        .map(mapUser);
      return { total: items.length, items };
    }
    if (path === '/api/users/blocked') {
      need('users.view');
      return { items: USERS.filter((u) => u.status === 'blocked').map((u) => ({ id: u.id, username: u.username, avatarUrl: u.avatarUrl, reason: u.blockedReason, blockedAt: u.blockedAt, blockedAtLabel: fmt(u.blockedAt), blockedBy: u.blockedBy })) };
    }
    if (/^\/api\/users\/\d+\/quota$/.test(path) && method === 'PUT') {
      need('users.edit');
      const v = body.dailyLimit;
      if (v != null && (!Number.isFinite(Number(v)) || Number(v) < 0)) fail(400, 'bad_request', 'Лимит должен быть неотрицательным числом (или null для общего лимита)');
      quotaPersonal = v == null ? null : Number(v);
      return { ok: true, userId: Number(path.split('/')[3]), quota: quotaInfo() };
    }
    if (/^\/api\/users\/\d+$/.test(path) && method === 'GET') {
      need('users.view');
      const u = USERS.find((x) => x.id === Number(path.split('/').pop()));
      if (!u) fail(404, 'not_found', 'Пользователь не найден');
      const m = mapUser(u);
      return { ...m, permissions: roleByCode(u.role).perms, permissionsDetail: { fromRoles: roleByCode(u.role).perms, extra: u.role === 'helper' ? ['knowledge.sync'] : [], denied: u.role === 'player' ? ['ai.laws'] : [] }, maxRoleLevel: roleByCode(u.role).level, isDeveloper: u.role === 'developer', history: AUDIT.filter((a) => String(a.entityId) === String(u.id)).map((a) => ({ ...a, createdAtLabel: fmt(a.createdAt) })), sessions: [{ id: 11, createdAt: u.lastLoginAt, lastSeenAt: u.lastLoginAt, expiresAt: new Date(Date.now() + 30 * 86400_000).toISOString(), revokedAt: u.status === 'blocked' ? new Date().toISOString() : null, ip: '10.0.0.14', userAgent: 'EpicAI/1.0.0 (Windows)' }], availableActions: { canEdit: true, canBlock: true, canAssignRole: true, canManagePermissions: true, assignableRoles: [] }, quota: quotaInfo() };
    }
    if (/^\/api\/users\/\d+\/role$/.test(path) && method === 'PATCH') { need('roles.assign'); const u = USERS.find((x) => x.id === Number(path.split('/')[3])); if (u) u.role = body.role; return { ok: true, userId: u?.id, role: { code: body.role, name: roleByCode(body.role).name, color: roleByCode(body.role).color, level: roleByCode(body.role).level } }; }
    if (/^\/api\/users\/\d+\/status$/.test(path) && method === 'PATCH') { need('users.block'); const u = USERS.find((x) => x.id === Number(path.split('/')[3])); if (u) { u.status = body.blocked ? 'blocked' : 'active'; u.blockedReason = body.reason ?? null; u.blockedAt = body.blocked ? new Date().toISOString() : null; } return { ok: true, userId: u?.id, status: u?.status }; }
    if (/^\/api\/users\/\d+\/permissions$/.test(path)) {
      if (method === 'GET') { need('permissions.view'); const u = USERS.find((x) => x.id === Number(path.split('/')[3])); return { userId: u?.id, effective: roleByCode(u?.role ?? 'player').perms, fromRoles: roleByCode(u?.role ?? 'player').perms, extra: [], denied: [], roles: [], maxLevel: roleByCode(u?.role ?? 'player').level, isDeveloper: u?.role === 'developer' }; }
      if (method === 'PUT') { need('permissions.manage'); return { ok: true, userId: Number(path.split('/')[3]), allow: body.effect === 'allow' ? [body.permission] : [], deny: body.effect === 'deny' ? [body.permission] : [] }; }
    }
    if (/^\/api\/users\/\d+\/sessions\/revoke$/.test(path)) { need('users.edit'); return { ok: true, revoked: 1 }; }
    if (path === '/api/roles') {
      need('roles.view');
      const myLevel = roleByCode(currentRole).level;
      return { items: ROLES.map((r) => ({ id: r.level, code: r.code, name: r.name, color: r.color, level: r.level, isSystem: r.system, permissions: r.perms, userCount: r.users, assignable: !r.system && r.level < myLevel, visible: r.level <= myLevel || currentRole === 'developer' })), spec: ROLES, actor: { maxLevel: myLevel, isDeveloper: currentRole === 'developer' } };
    }
    if (path === '/api/roles/assignable') { need('roles.assign'); const myLevel = roleByCode(currentRole).level; return { items: ROLES.filter((r) => !r.system && r.level < myLevel).map((r) => ({ code: r.code, name: r.name, color: r.color, level: r.level })) }; }
    if (path === '/api/permissions') { need('permissions.view'); const groups = {}; for (const p of PERMISSION_SPECS) { groups[p.category] = groups[p.category] ?? []; groups[p.category].push(p); } return { items: PERMISSION_SPECS, groups: Object.entries(groups).map(([category, items]) => ({ category, items })), spec: PERMISSION_SPECS }; }
    if (path === '/api/permissions/matrix') {
      need('permissions.view');
      const matrix = [];
      ROLES.forEach((r, ri) => r.perms.forEach((code) => { const p = PERMISSION_SPECS.find((x) => x.code === code); if (p) matrix.push(`${ri + 1}:${PERMISSION_SPECS.indexOf(p) + 1}`); }));
      return { roles: ROLES.map((r, i) => ({ id: i + 1, code: r.code, name: r.name, color: r.color, level: r.level, isSystem: r.system })), permissions: PERMISSION_SPECS.map((p, i) => ({ id: i + 1, code: p.code, category: p.category })), matrix: matrix.map((s) => s.split(':').map(Number)) };
    }
    if (path === '/api/permissions/sync' && method === 'POST') { need('permissions.manage'); return { ok: true, total: PERMISSION_SPECS.length }; }

    /* ---- audit ---- */
    if (path === '/api/audit-logs') {
      need('system.logs');
      const q = (query.get('search') ?? '').toLowerCase();
      const items = AUDIT.filter((a) => !query.get('action') || a.action === query.get('action'))
        .filter((a) => !q || a.action.includes(q) || (a.actorName ?? '').toLowerCase().includes(q))
        .map((a) => ({ ...a, createdAtLabel: fmt(a.createdAt) }));
      return { total: items.length, limit: 100, offset: 0, items };
    }
    if (path === '/api/audit-logs/actions') { need('system.logs'); const c = {}; for (const a of AUDIT) c[a.action] = (c[a.action] ?? 0) + 1; return { items: Object.entries(c).map(([action, count]) => ({ action, count })) }; }

    /* ---- settings ---- */
    if (path === '/api/settings/me' && method === 'GET') return { settings: { ...SETTINGS }, defaults: { ...SETTINGS }, schema: Object.keys(SETTINGS) };
    if (path === '/api/settings/me' && method === 'PUT') { Object.assign(SETTINGS, body); return { ok: true, applied: body, settings: { ...SETTINGS } }; }
    if (path === '/api/settings/me/reset' && method === 'POST') return { ok: true, settings: { ...SETTINGS } };
    if (path === '/api/settings/system' && method === 'GET') { need('system.settings'); return { items: [{ key: 'sync.interval_minutes', value: 30, updatedAt: new Date().toISOString(), updatedBy: 1 }, { key: 'sync.automatic', value: true, updatedAt: new Date().toISOString(), updatedBy: 1 }, { key: 'crawler.enabled', value: false, updatedAt: new Date().toISOString(), updatedBy: 1 }, { key: 'kb.version', value: '6-20261005', updatedAt: new Date().toISOString(), updatedBy: null }] }; }
    if (path === '/api/settings/system' && method === 'PUT') { need('system.settings'); return { ok: true, key: body.key, value: body.value }; }

    /* ---- admin ---- */
    if (path === '/api/admin/nav') {
      const nav = [
        { id: 'overview', label: 'Обзор', permission: 'users.view' },
        { id: 'users', label: 'Пользователи', permission: 'users.view' },
        { id: 'roles', label: 'Роли', permission: 'roles.view' },
        { id: 'permissions', label: 'Permissions', permission: 'permissions.view' },
        { id: 'blocks', label: 'Блокировки', permission: 'users.view' },
        { id: 'ai', label: 'AI', permission: 'ai.reports.view', children: [{ id: 'ai-reports', label: 'Ошибки AI', permission: 'ai.reports.view' }] },
        { id: 'kb', label: 'Knowledge Base', permission: 'knowledge.view', children: [{ id: 'kb-documents', label: 'Документы', permission: 'knowledge.view' }, { id: 'kb-versions', label: 'Версии', permission: 'knowledge.history' }, { id: 'kb-changes', label: 'Изменения', permission: 'knowledge.view' }, { id: 'kb-sync', label: 'Синхронизация', permission: 'knowledge.sync' }] },
        { id: 'telegram', label: 'Telegram bot', permission: 'telegram.manage' },
        { id: 'audit', label: 'Audit Log', permission: 'system.logs' },
        { id: 'system', label: 'System', permission: 'system.settings' },
      ];
      const filter = (items) => items.filter((i) => perms.includes(i.permission)).map((i) => ({ ...i, children: i.children ? filter(i.children) : undefined }));
      return { items: filter(nav), authenticated: true };
    }
    if (path === '/api/admin/overview') {
      need('users.view');
      return {
        users: { total: USERS.length, blocked: USERS.filter((u) => u.status === 'blocked').length, active7d: 4 },
        aiReports: { total: REPORTS.length, new: REPORTS.filter((r) => r.status === 'new').length, inProgress: REPORTS.filter((r) => r.status === 'in_progress').length, resolved: REPORTS.filter((r) => r.status === 'resolved').length },
        feedback: { likes: 412, dislikes: 37 },
        requests: { total: 1874, noData: 96 },
        roles: ROLES.map((r) => ({ code: r.code, name: r.name, color: r.color, count: r.users })),
        kb: { state: 'updates', stateLabel: 'Есть обновления', stateColor: '#F87171', lastSyncLabel: fmt(Date.now() - 42 * 60_000), documents: { total: 64, active: 58, archive: 6, rules: 27, laws: 31 }, versions: 143, chunks: 812, today: { newCount: 1, updatedCount: 2, archivedCount: 0 }, kbVersion: '6-20261005', intervalMinutes: 30 },
        system: { env: 'production', db: 'postgres', aiProvider: 'groq', aiModel: 'llama-3.3-70b-versatile', aiConfigured: true, aiConfigReason: null, crawlerEnabled: false, syncRunning: false, discordEnabled: true, telegramEnabled: true, serverTime: fmt(Date.now()) },
        recentAudit: AUDIT.slice(0, 8).map((a) => ({ ...a, createdAtLabel: fmt(a.createdAt) })),
        permissions: perms,
      };
    }
    if (path === '/api/health') return { ok: true, service: 'epic-ai-backend', version: '1.0.0', env: 'demo', db: { status: 'ok', driver: 'postgres', engine: 'pg' }, ai: { provider: 'groq', model: 'llama-3.3-70b-versatile' }, crawler: { enabled: false, respectRobots: true, running: false }, time: new Date().toISOString() };

    fail(404, 'not_found', `Маршрут не найден: ${method} ${path}`);
  }

  function mapUser(u) {
    const r = roleByCode(u.role);
    return {
      id: u.id, username: u.username, displayName: u.displayName, avatarUrl: u.avatarUrl, status: u.status,
      blockedReason: u.blockedReason ?? null, createdAt: u.createdAt, lastLoginAt: u.lastLoginAt,
      createdAtLabel: fmt(u.createdAt), lastLoginLabel: fmt(u.lastLoginAt),
      roles: [{ id: r.level, code: r.code, name: r.name, color: r.color, level: r.level, isSystem: r.system }],
      primaryRole: { code: r.code, name: r.name, color: r.color, level: r.level },
      identities: [u.discord ? { provider: 'discord', ...u.discord } : null, u.telegram ? { provider: 'telegram', ...u.telegram } : null].filter(Boolean),
      discord: u.discord ?? null, telegram: u.telegram ?? null,
    };
  }

  function changesFor(day) {
    const items = KB_CHANGES.filter((c) => c.day === day).map((c) => ({ id: c.id, day: c.day, documentId: c.documentId, versionId: c.versionId, changeKind: c.changeKind, title: c.title, docType: c.docType, url: c.url, changedWords: c.changedWords, totalWords: c.totalWords, createdAt: c.createdAt }));
    return { day, items, counts: { new: items.filter((i) => i.changeKind === 'NEW').length, updated: items.filter((i) => i.changeKind === 'UPDATED').length, archived: items.filter((i) => i.changeKind === 'ARCHIVED').length } };
  }

  function fmt(v) {
    if (!v) return '—';
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return '—';
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  /* ----------------------- упрощённый «RAG» для демо ----------------------- */

  const STOP = new Set(['что', 'такое', 'можно', 'нельзя', 'ли', 'какой', 'какая', 'как', 'это', 'или', 'если', 'при', 'для', 'по', 'в', 'на', 'и', 'а', 'не', 'с', 'о', 'к', 'из', 'до', 'за', 'то', 'бы', 'же', 'вы', 'мы', 'он', 'она', 'они', 'есть', 'мне', 'меня', 'его', 'её', 'их', 'чем', 'когда', 'где', 'почему', 'зачем', 'какие', 'каких', 'этом', 'этот', 'эта', 'эти', 'мне', 'вас']);

  function tokens(s) {
    return String(s ?? '').toLowerCase().match(/[a-zа-яё0-9]{2,}/gi)?.filter((t) => !STOP.has(t)) ?? [];
  }
  function stemOf(t) { return t.length > 5 ? t.slice(0, Math.max(3, t.length - 2)) : t; }

  function mockSearch(question, mode) {
    const q = tokens(question);
    const stems = q.map(stemOf);
    const docType = mode === 'laws' ? 'LAW' : 'RULE';
    const scored = [];
    for (const d of KB_DOCS) {
      if (d.docType !== docType || d.status !== 'active') continue;
      const text = `${d.title}\n${d.text}`.toLowerCase();
      let score = 0;
      const matched = new Set();
      for (let i = 0; i < q.length; i++) {
        const t = q[i]; const st = stems[i];
        const hits = (text.match(new RegExp(st.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length;
        if (hits) { score += Math.log(1 + hits) * (t.length > 4 ? 1.4 : 1); matched.add(t); }
      }
      if (score > 0) scored.push({ doc: d, score, matched: [...matched] });
    }
    scored.sort((a, b) => b.score - a.score);

    const out = [];
    for (const s of scored.slice(0, 3)) {
      // выбираем наиболее релевантный фрагмент (по номеру пункта/статьи)
      const paras = s.doc.text.split(/\n\n+/);
      let best = paras[0]; let bestScore = -1;
      for (const p of paras) {
        const lower = p.toLowerCase();
        let sc = 0;
        for (const st of s.matched.map(stemOf)) sc += (lower.match(new RegExp(st.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length;
        if (sc > bestScore) { bestScore = sc; best = p; }
      }
      const heading = best.split('\n')[0].slice(0, 90);
      out.push({
        index: out.length, chunkId: s.doc.id * 10 + out.length, documentId: s.doc.id, versionId: s.doc.version, version: s.doc.version,
        docType: s.doc.docType, docTypeLabel: s.doc.docType === 'LAW' ? 'Законодательная база' : 'Правила',
        title: s.doc.title, category: s.doc.category, section: s.doc.section, heading,
        content: best, url: s.doc.url, revisionLabel: fmt(s.doc.sourceModifiedAt), sourceModifiedAt: s.doc.sourceModifiedAt,
        threadId: s.doc.threadId, postId: s.doc.postId, score: Number(s.score.toFixed(2)), matchedTerms: s.matched, openLabel: 'Открыть источник ↗',
      });
    }
    return out;
  }

  function mockAnswer(question, mode, sources) {
    const q = String(question).toLowerCase();
    const first = sources[0];
    const cite = `${first.title}${first.heading ? `, ${first.heading}` : ''}`;

    let verdict = 'depends';
    let explanation;
    if (/запрещ|нельзя|запрещено/.test(first.content)) verdict = 'forbidden';
    else if (/обязан|разреш|допускается/.test(first.content)) verdict = 'allowed';

    if (/dm|deathmatch|без причин|убивать/.test(q)) {
      verdict = 'forbidden';
      explanation = 'Убивать игрока или наносить ему урон без весомой IC причины запрещено — это DM (DeathMatch). Весомой причиной считается правильно отыгранная RP ситуация с предупреждением, самооборона при нападении или исполнение служебных обязанностей сотрудником государственной организации.';
    } else if (/удостовер|документ/.test(q)) {
      verdict = 'allowed';
      explanation = 'Да: сотрудник обязан предоставить удостоверение личности при проверке, если игрок об этом попросил. Игрок, в свою очередь, обязан предоставить документы по первому требованию сотрудника.';
    } else if (/зелён|зелен/.test(q)) {
      verdict = 'forbidden';
      explanation = 'В зелёных зонах запрещены любые противоправные действия, включая DM, DB, ограбления и похищения. Отыгрыш маски или другой подготовки это ограничение не отменяет.';
    } else if (/убийств|статья 12/.test(q)) {
      verdict = 'forbidden';
      explanation = 'Убийство первой степени наказывается лишением свободы сроком на 150 месяцев и штрафом 200000 виртуальной валюты. Убийство второй степени — 80 месяцев и штраф 90000.';
    } else if (/заложн/.test(q)) {
      verdict = 'depends';
      explanation = 'Захват заложника допускается только при наличии IC мотивации и отыгрыша. Использовать заложника как «живой щит» без переговоров запрещено, а одновременно можно удерживать не более двух человек.';
    } else {
      explanation = `По вашему вопросу найден официальный документ. ${first.content.split('\n').slice(-1)[0].slice(0, 220)}`;
    }

    return {
      verdict,
      verdictLabel: { allowed: 'Разрешено', forbidden: 'Запрещено', depends: 'Зависит от обстоятельств', unknown: 'Нет подтверждённых данных' }[verdict],
      explanation,
      basis: `${cite}: «${first.content.split('\n').slice(-1)[0].slice(0, 240)}»`,
      confidence: 0.82,
      sources,
    };
  }

  /* ------------------------------ CSS для inline-источников ------------------------------ */

  /* ------------------------------ демо-переключатель роли ------------------------------ */

  function mountRoleSwitcher() {
    if (document.querySelector('.demo-role-switch')) return;
    const box = document.createElement('div');
    box.className = 'demo-role-switch';
    box.style.cssText = 'position:fixed;right:14px;top:12px;z-index:9999;display:flex;gap:6px;align-items:center;padding:6px 9px;border-radius:10px;background:rgba(18,20,22,.9);border:1px solid rgba(238,249,244,.12);font-family:inherit';
    const label = document.createElement('span');
    label.textContent = 'Роль в демо:';
    label.style.cssText = 'font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:#666';
    const sel = document.createElement('select');
    sel.style.cssText = 'background:#1A1A1A;color:#EEF9F4;border:1px solid rgba(238,249,244,.14);border-radius:6px;height:24px;font-size:11px;padding:0 6px';
    for (const r of ROLES) {
      const o = document.createElement('option');
      o.value = r.code; o.textContent = r.name;
      if (r.code === currentRole) o.selected = true;
      sel.appendChild(o);
    }
    sel.addEventListener('change', () => { currentRole = sel.value; location.reload(); });
    box.append(label, sel);
    document.body.appendChild(box);
  }

  document.addEventListener('DOMContentLoaded', () => {
    mountRoleSwitcher();
    // splash-демо: транслируем события драйвера в канал preload'а
    window.addEventListener('demo-splash-step', (e) => emit('splash:step', e.detail));
    window.addEventListener('demo-splash-done', () => emit('splash:done', {}));
    // окно источников в демо: отдаём payload по событию
    if (window.__DEMO_SOURCES_AUTOLOAD__) {
      setTimeout(() => emit('sources:data', window.__DEMO_SOURCES_PAYLOAD__ ?? DEMO_SOURCES_PAYLOAD), 60);
    }
  });

  const DEMO_SOURCES_PAYLOAD = (() => {
    const src = mockSearch('что такое DM и можно ли убивать без причины', 'rules');
    const a = mockAnswer('что такое DM и можно ли убивать без причины', 'rules', src);
    return { requestId: 901, question: 'Что такое DM и можно ли убивать игрока без причины?', mode: 'rules', modeLabel: 'ПРАВИЛА', verdict: a.verdict, verdictLabel: a.verdictLabel, kbVersion: '6-20261005', generatedAt: new Date().toISOString(), sources: src, relatedDocuments: [], noData: false, feedbackAllowed: true };
  })();
  window.__DEMO_SOURCES_PAYLOAD__ = DEMO_SOURCES_PAYLOAD;
})();
