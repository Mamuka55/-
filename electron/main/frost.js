/**
 * EPIC AI — «стеклянная» подложка: живой blur того, что ПОД окном.
 *
 * Chromium умеет blur (backdrop-filter) только собственное содержимое
 * страницы — пиксели рабочего стола и игры за прозрачным окном ему
 * недоступны. Поэтому делаем честно: несколько раз в секунду снимаем
 * уменьшенную копию области экрана под панелью (desktopCapturer), обрезает
 * её по границам окна и отдаём renderer'у, где она лежит подложкой с
 * CSS filter: blur(Npx). Радиус регулируется настройкой «Сила blur»
 * мгновенно, без пересъёмки; прозрачность поверхностей определяет,
 * насколько подложка видна сквозь панель.
 *
 * Снимок делается в уменьшенном масштабе (1/4) и сжимается в JPEG —
 * это дешёво для GPU и не влияет на FPS игры.
 */
'use strict';

const { desktopCapturer, screen } = require('electron');

/** Период съёмки, мс (~5 кадров/с достаточно для размытого фона). */
const INTERVAL_MS = 200;
/** Масштаб миниатюры экрана: полная не нужна, фон всё равно размывается. */
const THUMB_SCALE = 0.25;

let win = null;
let timer = null;
let busy = false;

/** Окно, под которое снимаем подложку (только основная панель). */
function setWindow(target) {
  win = target && !target.isDestroyed() ? target : null;
  if (!win) stop();
}

function start() {
  if (timer == null) {
    timer = setInterval(() => { void tick(); }, INTERVAL_MS);
    // не держим event loop ради подложки (тесты, завершение приложения)
    if (typeof timer.unref === 'function') timer.unref();
  }
}

function stop() {
  if (timer != null) { clearInterval(timer); timer = null; }
}

async function tick() {
  if (busy || !win || win.isDestroyed()) { if (!win) stop(); return; }
  if (!win.isVisible() || win.isMinimized()) return;
  busy = true;
  try {
    const bounds = win.getBounds();
    const display = screen.getDisplayMatching(bounds);
    const db = display.bounds;
    const thumbnailSize = {
      width: Math.max(64, Math.round(db.width * THUMB_SCALE)),
      height: Math.max(64, Math.round(db.height * THUMB_SCALE)),
    };
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize });
    if (!win || win.isDestroyed()) return;
    const source = sources.find((s) => String(s.display_id) === String(display.id)) ?? sources[0];
    const thumb = source?.thumbnail;
    if (!thumb || thumb.isEmpty()) return;

    const ts = thumb.getSize();
    const kx = ts.width / db.width;
    const ky = ts.height / db.height;
    let x = Math.round((bounds.x - db.x) * kx);
    let y = Math.round((bounds.y - db.y) * ky);
    let w = Math.round(bounds.width * kx);
    let h = Math.round(bounds.height * ky);
    x = Math.min(Math.max(0, x), ts.width - 1);
    y = Math.min(Math.max(0, y), ts.height - 1);
    w = Math.min(w, ts.width - x);
    h = Math.min(h, ts.height - y);
    if (w < 8 || h < 8) return;

    const crop = thumb.crop({ x, y, width: w, height: h });
    const dataUrl = `data:image/jpeg;base64,${crop.toJPEG(70).toString('base64')}`;
    if (win && !win.isDestroyed()) win.webContents.send('frost:frame', dataUrl);
  } catch {
    // Съёмка экрана недоступна (headless, нет прав) — тихо пропускаем кадр.
  } finally {
    busy = false;
  }
}

module.exports = { setWindow, start, stop };
