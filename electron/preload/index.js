/**
 * EPIC AI — preload: единственный мост между renderer и main (contextBridge).
 *
 * renderer не имеет доступа к Node/Electron API: всё, что ему позволено,
 * перечислено здесь явно. Это требование безопасности.
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/** Каналы, которые renderer может ВЫЗВАТЬ (invoke). */
const INVOKE = new Set([
  'epic:runtime',
  'epic:session:token',
  'epic:settings:get',
  'epic:settings:set',
  'epic:settings:reset',
  'epic:panel:resize',
  'epic:panel:geometry',
  'epic:panel:move',
  'epic:window:toggle',
  'epic:window:hide',
  'epic:window:show',
  'epic:sources:open',
  'epic:kb:open',
  'epic:history:open',
  'epic:history:pick',
  'epic:sources:close',
  'epic:settings:toggle',
  'epic:ask:confirm',
  'epic:ask:confirm:result',
  'epic:admin:open',
  'epic:auth:done',
  'epic:auth:claim',
  'epic:auth:open',
  'epic:account:logout',
  'epic:account:recheck',
  'epic:external',
  'epic:hotkey:set',
  'epic:always-on-top',
  'epic:app:info',
  'epic:app:relaunch',
  'epic:app:quit',
  'epic:backend:logs',
  'epic:devtools',
]);

/** Каналы, на которые renderer может ПОДПИСАТЬСЯ (on). */
const RECEIVE = new Set([
  'splash:step',
  'splash:done',
  'sources:data',
  'main:open-kb',
  'main:open-history-item',
  'history:refresh',
  'main:init',
  'main:open-settings',
  'overlay:visibility',
  'settings:changed',
  'app:before-quit',
]);

const api = {
  invoke: (channel,...args) => {
    if (!INVOKE.has(channel)) return Promise.reject(new Error(`IPC channel not allowed: ${channel}`));
    return ipcRenderer.invoke(channel,...args);
  },
  on: (channel, listener) => {
    if (!RECEIVE.has(channel)) return () => {};
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
  once: (channel) => new Promise((resolve) => {
    if (!RECEIVE.has(channel)) return resolve(null);
    ipcRenderer.once(channel, (_e, payload) => resolve(payload));
  }),
};

contextBridge.exposeInMainWorld('epicAI', api);
