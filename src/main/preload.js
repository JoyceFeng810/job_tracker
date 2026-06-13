// src/main/preload.js
// Secure bridge — exposes only specific IPC calls to the renderer
// contextIsolation: true means renderer cannot access Node.js directly

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {

  // ── Keychain (OS keychain via keytar) ──────────────────────────────────────
  keychain: {
    set: (service, account, password) => ipcRenderer.invoke('keychain:set', service, account, password),
    get: (service, account) => ipcRenderer.invoke('keychain:get', service, account),
    delete: (service, account) => ipcRenderer.invoke('keychain:delete', service, account),
  },

  // ── Persistent prefs store ─────────────────────────────────────────────────
  store: {
    get: (key) => ipcRenderer.invoke('store:get', key),
    set: (key, value) => ipcRenderer.invoke('store:set', key, value),
    delete: (key) => ipcRenderer.invoke('store:delete', key),
  },

  // ── SQLite — Applications ──────────────────────────────────────────────────
  apps: {
    getAll: () => ipcRenderer.invoke('db:apps:getAll'),
    upsert: (app) => ipcRenderer.invoke('db:apps:upsert', app),
    delete: (id) => ipcRenderer.invoke('db:apps:delete', id),
  },

  // ── SQLite — Skills ────────────────────────────────────────────────────────
  skills: {
    getAll: () => ipcRenderer.invoke('db:skills:getAll'),
    upsert: (skill) => ipcRenderer.invoke('db:skills:upsert', skill),
    reorder: (orderedNames) => ipcRenderer.invoke('db:skills:reorder', orderedNames),
  },

  // ── Google OAuth ───────────────────────────────────────────────────────────
  gmail: {
    startAuth: () => ipcRenderer.invoke('oauth:gmail:start'),
    status: () => ipcRenderer.invoke('oauth:gmail:status'),
    disconnect: () => ipcRenderer.invoke('oauth:gmail:disconnect'),
    search: (query, maxResults) => ipcRenderer.invoke('gmail:search', query, maxResults),
    authConfig: () => ipcRenderer.invoke('gmail:auth-config'),
  },

  // ── Google OAuth credentials (client ID / secret) ─────────────────────────
  credentials: {
    save: (clientId, clientSecret) => ipcRenderer.invoke('credentials:save', clientId, clientSecret),
    get: () => ipcRenderer.invoke('credentials:get'),
  },

  // ── Web fetch (runs in Node — not restricted by renderer CSP) ────────────
  web: {
    fetchJD: (company, role) => ipcRenderer.invoke('web:fetch-jd', company, role),
  },

  // ── Resume review ──────────────────────────────────────────────────────────
  resume: {
    openFile: () => ipcRenderer.invoke('dialog:open-resume'),
  },

  // ── Scheduler (daily auto-scan + interview reminders) ──────────────────────
  schedule: {
    get: () => ipcRenderer.invoke('schedule:get'),
    set: (prefs) => ipcRenderer.invoke('schedule:set', prefs),
    onAutoScan: (cb) => ipcRenderer.on('scheduler:auto-scan', () => cb()),
  },

  // ── App controls ───────────────────────────────────────────────────────────
  app: {
    quit: () => ipcRenderer.invoke('app:quit'),
    version: () => ipcRenderer.invoke('app:version'),
    openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
    reset: () => ipcRenderer.invoke('app:reset'),
    clearData: () => ipcRenderer.invoke('app:clear-data'),
  }
});
