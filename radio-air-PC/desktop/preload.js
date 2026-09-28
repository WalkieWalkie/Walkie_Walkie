'use strict';

/* Мост между страницей приёмника и приложением: только то, что странице действительно нужно. */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('radioDesktop', {
  hostStart: (options) => ipcRenderer.invoke('host:start', options),
  hostStop: () => ipcRenderer.invoke('host:stop'),
  hostStatus: () => ipcRenderer.invoke('host:status'),

  // Горячие клавиши из любого окна: ptt-down / ptt-up / ptt-toggle / ab / chUp / chDown / mute / view
  setHotkeysActive: (on) => ipcRenderer.invoke('hotkeys:active', on),
  hotkeys: () => ipcRenderer.invoke('hotkeys:get'),
  setHotkey: (action, combo) => ipcRenderer.invoke('hotkeys:set', action, combo),
  setPttMode: (mode) => ipcRenderer.invoke('hotkeys:mode', mode),
  captureHotkey: () => ipcRenderer.invoke('hotkeys:capture'),
  cancelCapture: () => ipcRenderer.invoke('hotkeys:cancel'),
  onHotkey: (callback) => {
    ipcRenderer.on('hotkey', (_e, action) => callback(action));
  },

  // Окна: большой приёмник ↔ рация ↔ полоска
  windowState: () => ipcRenderer.invoke('window:get'),
  switchMode: (mode) => ipcRenderer.invoke('window:mode', mode),
  setView: (view) => ipcRenderer.invoke('view:set', view),
  setBarPanel: (open) => ipcRenderer.invoke('bar:panel', open),
  setBarSettings: (settings) => ipcRenderer.invoke('bar:settings', settings),
  onBarAlt: (callback) => {
    ipcRenderer.on('bar:alt', (_e, held) => callback(held));
  },
  setOnTop: (on) => ipcRenderer.invoke('window:on-top', on),
  minimize: () => ipcRenderer.invoke('window:minimize'),
  quit: () => ipcRenderer.invoke('window:close'),

  // Автообновление из релизов GitHub
  onUpdaterStatus: (callback) => {
    ipcRenderer.on('updater:status', (_e, state) => callback(state));
  },
  updaterGet: () => ipcRenderer.invoke('updater:get'),
  updaterCheck: () => ipcRenderer.invoke('updater:check'),
  updaterInstall: () => ipcRenderer.invoke('updater:install'),
  setAutoUpdate: (on) => ipcRenderer.invoke('updater:auto', on),
  autoUpdate: () => ipcRenderer.invoke('app:auto-update'),
  appVersion: () => ipcRenderer.invoke('app:version'),

  // Телеграм-бот управления станцией
  telegramGet: () => ipcRenderer.invoke('telegram:get'),
  telegramSet: (cfg) => ipcRenderer.invoke('telegram:set', cfg),
  onBotCommand: (callback) => {
    ipcRenderer.on('bot:command', (_e, m) => callback(m));
  },
  botAnswer: (id, text) => ipcRenderer.invoke('bot:answer', { id, text }),
});
