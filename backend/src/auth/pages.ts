/**
 * EPIC AI — серверные страницы авторизации.
 * Отдаются backend'ом и показываются в отдельном окне Electron «Auth».
 * Стили — инлайновые, чтобы не зависеть от внешних ресурсов.
 */
import { COLORS, GLASS } from '../shared.js';

const base = (title: string, body: string): string => `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline' https://telegram.org; connect-src 'self' https://api.telegram.org; img-src https: data:; frame-src https://oauth.telegram.org;" />
<title>${title}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; }
  body {
    background: ${COLORS.bgBase};
    color: ${COLORS.textPrimary};
    font-family: "Segoe UI", "Inter", system-ui, -apple-system, sans-serif;
    display: flex; align-items: center; justify-content: center;
    overflow: hidden; user-select: none;
  }
 .card {
    width: 420px; padding: 34px 32px 28px;
    background: ${GLASS.panel};
    border: 1px solid ${GLASS.stroke};
    border-radius: 14px;
    backdrop-filter: blur(18px); -webkit-backdrop-filter: blur(18px);
    box-shadow: 0 24px 60px rgba(0,0,0,.55);
    text-align: center;
  }
 .logo { font-size: 26px; font-weight: 700; letter-spacing:.18em; }
 .logo b { color: ${COLORS.accent}; font-weight: 700; }
 .sub { margin-top: 8px; font-size: 12px; color: ${COLORS.textMuted}; letter-spacing:.04em; }
 .divider { height: 1px; background: ${GLASS.stroke}; margin: 24px 0 20px; }
 .btn {
    display: flex; align-items: center; justify-content: center; gap: 10px;
    width: 100%; height: 44px; margin-bottom: 12px;
    border-radius: 10px; border: 1px solid ${GLASS.stroke};
    background: ${COLORS.bgSurface}; color: ${COLORS.textPrimary};
    font-size: 13px; font-weight: 600; letter-spacing:.06em;
    text-decoration: none; cursor: pointer; transition:.16s ease;
  }
 .btn:hover { border-color: ${COLORS.accentBright}; color: ${COLORS.accentBright}; }
 .btn.telegram:hover { border-color: #2AABEE; color: #58c6f5; }
 .btn svg { width: 18px; height: 18px; flex: none; }
 .foot { margin-top: 20px; font-size: 11px; color: ${COLORS.textSubtle}; line-height: 1.6; }
 .ok { color: ${COLORS.accent}; font-size: 34px; margin-bottom: 10px; }
 .err { color: ${COLORS.danger}; font-size: 30px; margin-bottom: 10px; }
 .msg { font-size: 13px; color: ${COLORS.textMuted}; line-height: 1.6; }
 .disabled { opacity:.38; pointer-events: none; }
  #tg-wrap { display:flex; justify-content:center; min-height: 46px; }
</style>
</head>
<body>
  ${body}
</body>
</html>`;


const telegramIcon = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1.171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/></svg>`;

export function renderDonePage(message: string, autoClose: boolean): string {
  return base('EPIC AI', `
  <div class="card">
    <div class="ok">✓</div>
    <div class="logo" style="font-size:20px">EPIC <b>AI</b></div>
    <div class="divider"></div>
    <div class="msg">${message}</div>
    <div class="foot">${autoClose ? 'Вкладку можно закрыть: приложение завершит вход само.' : ''}</div>
  </div>`);
}

export function renderErrorPage(message: string): string {
  return base('EPIC AI — Ошибка', `
  <div class="card">
    <div class="err">✕</div>
    <div class="logo" style="font-size:20px">EPIC <b>AI</b></div>
    <div class="divider"></div>
    <div class="msg" style="color:${COLORS.warning}">${message}</div>
    <div class="foot">Вкладку можно закрыть и повторить вход из приложения.</div>
  </div>`);
}
