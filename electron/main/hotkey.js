/**
 * EPIC AI — глобальная горячая клавиша.
 *
 * По умолчанию F10: показывает и скрывает overlay. Пользователь может
 * изменить сочетание в настройках; невалидное значение откатывается к F10.
 */
'use strict';

const { globalShortcut } = require('electron');

const DEFAULT_HOTKEY = 'F10';
const MODIFIERS = new Set(['commandorcontrol', 'cmdorctrl', 'control', 'ctrl', 'command', 'cmd', 'super', 'alt', 'option', 'shift', 'altgr']);
const KEY_RE = /^(f([1-9]|1[0-9]|2[0-4])|[a-z0-9]|space|tab|enter|esc|escape|minus|equal|plus|home|end|pageup|pagedown|insert|delete|left|right|up|down|numadd|numsub|num[0-9])$/i;

let current = null;
let handler = null;

function normalizeAccelerator(value) {
  const s = String(value ?? '').trim();
  if (!s) return DEFAULT_HOTKEY;
  const parts = s.split('+').map((x) => x.trim()).filter(Boolean);
  if (!parts.length || parts.length > 4) return DEFAULT_HOTKEY;
  const last = parts[parts.length - 1];
  if (!KEY_RE.test(last)) return DEFAULT_HOTKEY;
  for (const p of parts.slice(0, -1)) {
    if (!MODIFIERS.has(String(p).toLowerCase())) return DEFAULT_HOTKEY;
  }
  return parts.join('+');
}

function registerHotkey(accelerator, onToggle) {
  handler = onToggle;
  unregisterHotkey();
  const acc = normalizeAccelerator(accelerator);
  try {
    const ok = globalShortcut.register(acc, () => { if (handler) handler(); });
    current = ok ? acc : null;
    return { requested: acc, registered: current, ok };
  } catch (e) {
    return { requested: acc, registered: null, ok: false, error: e.message };
  }
}

function unregisterHotkey() {
  if (current) {
    try { globalShortcut.unregister(current); } catch { /* ignore */ }
    current = null;
  }
}

function unregisterAll() {
  try { globalShortcut.unregisterAll(); } catch { /* ignore */ }
  current = null;
  unregisterCombos();
}

function getCurrentHotkey() { return current; }

/* ------------------------------------------------------------------ */
/*  Локальные сочетания (Ctrl+H/O/P) — теперь ГЛОБАЛЬНЫЕ                */
/* ------------------------------------------------------------------ */

/**
 * Сочетания «История» / «Источники» / «Закрепить» регистрируются через
 * globalShortcut, поэтому работают даже когда фокус в игре (требование
 * пользователя). Ранее их обрабатывал только renderer панели — без фокуса
 * на панели сочетания не срабатывали.
 */
const combos = new Map();   // name → accelerator

/**
 * @param {Record<string, {accelerator: string, callback: () => void}>} named
 */
function registerCombos(named) {
  unregisterCombos();
  const results = {};
  for (const [name, item] of Object.entries(named ?? {})) {
    const acc = normalizeAccelerator(item?.accelerator);
    try {
      const ok = globalShortcut.register(acc, () => {
        try { item?.callback?.(); } catch (e) { console.error(`[epic-ai] combo ${name}:`, e.message); }
      });
      if (ok) combos.set(name, acc);
      results[name] = { requested: acc, ok };
    } catch (e) {
      results[name] = { requested: acc, ok: false, error: e.message };
    }
  }
  return results;
}

function unregisterCombos() {
  for (const acc of combos.values()) {
    try { globalShortcut.unregister(acc); } catch { /* ignore */ }
  }
  combos.clear();
}

function getCurrentCombos() { return Object.fromEntries(combos); }

module.exports = {
  DEFAULT_HOTKEY,
  normalizeAccelerator,
  registerHotkey,
  unregisterHotkey,
  unregisterAll,
  getCurrentHotkey,
  registerCombos,
  unregisterCombos,
  getCurrentCombos,
};
