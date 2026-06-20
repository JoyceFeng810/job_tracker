// src/main/main.js
// Main Electron process — handles window, IPC bridges, OAuth, keychain, SQLite

const { app, BrowserWindow, ipcMain, shell, session, Tray, Menu, Notification, nativeImage, dialog } = require('electron');
const path = require('path');
const Store = require('electron-store');
const { google } = require('googleapis');

// ─── Persistent encrypted store (for non-secret prefs) ───────────────────────
const store = new Store({ name: 'job-tracker-prefs' });

// ─── Keytar (OS keychain) — for secrets ──────────────────────────────────────
let keytar;
try {
  keytar = require('keytar');
} catch (e) {
  // Keytar not available in dev without native build — use store as fallback
  console.warn('keytar not available, using encrypted store as fallback');
  keytar = {
    setPassword: (svc, acc, pw) => store.set(`keytar.${svc}.${acc}`, pw),
    getPassword: (svc, acc) => Promise.resolve(store.get(`keytar.${svc}.${acc}`) || null),
    deletePassword: (svc, acc) => { store.delete(`keytar.${svc}.${acc}`); return Promise.resolve(true); }
  };
}

// ─── SQLite ───────────────────────────────────────────────────────────────────
let db;
try {
  const Database = require('better-sqlite3');
  const dbPath = path.join(app.getPath('userData'), 'job-tracker.db');
  db = new Database(dbPath);
  initDB(db);
  console.log('SQLite ready at', dbPath);
} catch (e) {
  console.warn('SQLite not available:', e.message);
  db = null;
}

function initDB(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS applications (
      id TEXT PRIMARY KEY,
      company TEXT NOT NULL,
      role TEXT NOT NULL,
      status TEXT DEFAULT 'applied',
      applied_date TEXT,
      screening_date TEXT,
      interview_date TEXT,
      final_date TEXT,
      offer_date TEXT,
      updated_date TEXT,
      notes TEXT,
      skills TEXT DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS skills (
      name TEXT PRIMARY KEY,
      tip TEXT,
      roles TEXT DEFAULT '[]',
      prepared INTEGER DEFAULT 0,
      sort_order INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS reminders (
      id TEXT PRIMARY KEY,
      app_id TEXT,
      remind_at TEXT,
      sent INTEGER DEFAULT 0
    );
  `);

  // ── Migrations (add new columns to existing databases) ──────────────────────
  const cols = db.prepare("PRAGMA table_info(applications)").all().map(c => c.name);
  if (!cols.includes('interview_time')) {
    db.exec("ALTER TABLE applications ADD COLUMN interview_time TEXT");
  }
  if (!cols.includes('interview_datetime')) {
    // Absolute UTC instant of the next scheduled event, so it can be displayed
    // in any timezone. interview_time is kept as a human-readable label/fallback.
    db.exec("ALTER TABLE applications ADD COLUMN interview_datetime TEXT");
  }
  if (!cols.includes('event_locked')) {
    // 1 = the user manually set this entry's schedule; Gmail scans must never
    // overwrite its dates, time, or status.
    db.exec("ALTER TABLE applications ADD COLUMN event_locked INTEGER DEFAULT 0");
  }
}

// ─── Window ───────────────────────────────────────────────────────────────────
let mainWindow;
let tray = null;
app.isQuitting = false;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: 'hiddenInset', // macOS native feel
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    },
    icon: path.join(__dirname, '../../assets/icon.png')
  });

  const isDev = process.env.NODE_ENV === 'development';
  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  if (isDev) {
    mainWindow.webContents.openDevTools();
  }

  // Closing the window hides to the tray so scheduled scans/reminders keep running.
  // The app only truly quits via the in-app Quit button or the tray's Quit item.
  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

function showWindow() {
  if (!mainWindow) createWindow();
  else { mainWindow.show(); mainWindow.focus(); }
}

function createTray() {
  if (tray) return;
  let img = nativeImage.createFromPath(path.join(__dirname, '../../assets/tray-icon.png'));
  if (!img.isEmpty()) img = img.resize({ width: 16, height: 16 });
  tray = new Tray(img);
  tray.setToolTip('Job Tracker');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Job Tracker', click: showWindow },
    { label: 'Scan Gmail now', click: triggerAutoScan },
    { type: 'separator' },
    { label: 'Quit Job Tracker', click: () => fullQuit() },
  ]));
  tray.on('click', showWindow);
}

// Single-instance lock: never run two copies. A second launch just focuses the
// existing window instead of spawning another tray instance with stale data.
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.whenReady().then(() => {
    createWindow();
    createTray();
    startScheduler();
  });
}

// Fully quit the app: tear down the tray and exit for real (used by both the
// in-app Quit button and the tray's Quit item).
function fullQuit() {
  app.isQuitting = true;
  try { if (tray) { tray.destroy(); tray = null; } } catch (_) {}
  app.quit();
  // Hard fallback in case something keeps the loop alive
  setTimeout(() => app.exit(0), 600);
}

// Keep running in the tray when all windows are closed (don't auto-quit).
app.on('window-all-closed', () => { /* stay alive in tray */ });
app.on('before-quit', () => { app.isQuitting = true; });
app.on('activate', () => { showWindow(); });

// ─── IPC: Keychain ────────────────────────────────────────────────────────────
ipcMain.handle('keychain:set', async (_, service, account, password) => {
  await keytar.setPassword(service, account, password);
  return true;
});

ipcMain.handle('keychain:get', async (_, service, account) => {
  return await keytar.getPassword(service, account);
});

ipcMain.handle('keychain:delete', async (_, service, account) => {
  return await keytar.deletePassword(service, account);
});

// ─── IPC: Prefs store ─────────────────────────────────────────────────────────
ipcMain.handle('store:get', (_, key) => store.get(key));
ipcMain.handle('store:set', (_, key, value) => { store.set(key, value); return true; });
ipcMain.handle('store:delete', (_, key) => { store.delete(key); return true; });

// ─── IPC: SQLite — Applications ──────────────────────────────────────────────
ipcMain.handle('db:apps:getAll', () => {
  if (!db) return [];
  const rows = db.prepare('SELECT * FROM applications ORDER BY updated_date DESC').all();
  return rows.map(r => ({ ...r, skills: JSON.parse(r.skills || '[]') }));
});

ipcMain.handle('db:apps:upsert', (_, app) => {
  if (!db) return false;
  // Provide null defaults so better-sqlite3 named params are always satisfied
  const row = {
    applied_date: null, screening_date: null, interview_date: null,
    final_date: null, offer_date: null, updated_date: null, notes: null,
    interview_time: null, interview_datetime: null, event_locked: 0,
    ...app,
    skills: JSON.stringify(app.skills || []),
    event_locked: app.event_locked ? 1 : 0
  };
  db.prepare(`
    INSERT INTO applications (id, company, role, status, applied_date, screening_date,
      interview_date, final_date, offer_date, updated_date, notes, skills, interview_time, interview_datetime, event_locked)
    VALUES (@id, @company, @role, @status, @applied_date, @screening_date,
      @interview_date, @final_date, @offer_date, @updated_date, @notes, @skills, @interview_time, @interview_datetime, @event_locked)
    ON CONFLICT(id) DO UPDATE SET
      status=excluded.status, screening_date=excluded.screening_date,
      interview_date=excluded.interview_date, final_date=excluded.final_date,
      offer_date=excluded.offer_date, updated_date=excluded.updated_date,
      notes=excluded.notes, skills=excluded.skills, interview_time=excluded.interview_time,
      interview_datetime=excluded.interview_datetime, event_locked=excluded.event_locked
  `).run(row);
  return true;
});

ipcMain.handle('db:apps:delete', (_, id) => {
  if (!db) return false;
  db.prepare('DELETE FROM applications WHERE id = ?').run(id);
  return true;
});

// ─── IPC: SQLite — Skills ────────────────────────────────────────────────────
ipcMain.handle('db:skills:getAll', () => {
  if (!db) return [];
  const rows = db.prepare('SELECT * FROM skills ORDER BY sort_order ASC').all();
  return rows.map(r => ({ ...r, roles: JSON.parse(r.roles || '[]'), prepared: !!r.prepared }));
});

ipcMain.handle('db:skills:upsert', (_, skill) => {
  if (!db) return false;
  db.prepare(`
    INSERT INTO skills (name, tip, roles, prepared, sort_order)
    VALUES (@name, @tip, @roles, @prepared, @sort_order)
    ON CONFLICT(name) DO UPDATE SET
      tip=excluded.tip, roles=excluded.roles,
      prepared=excluded.prepared, sort_order=excluded.sort_order
  `).run({ ...skill, roles: JSON.stringify(skill.roles || []), prepared: skill.prepared ? 1 : 0 });
  return true;
});

ipcMain.handle('db:skills:reorder', (_, orderedNames) => {
  if (!db) return false;
  const update = db.prepare('UPDATE skills SET sort_order = ? WHERE name = ?');
  const updateAll = db.transaction((names) => {
    names.forEach((name, i) => update.run(i, name));
  });
  updateAll(orderedNames);
  return true;
});

// ─── IPC: Credentials (Google OAuth client ID/secret) ────────────────────────
ipcMain.handle('credentials:save', async (_, clientId, clientSecret) => {
  await keytar.setPassword('job-tracker', 'google-client-id', clientId);
  await keytar.setPassword('job-tracker', 'google-client-secret', clientSecret);
  return true;
});

ipcMain.handle('credentials:get', async () => {
  const clientId = await keytar.getPassword('job-tracker', 'google-client-id');
  const clientSecret = await keytar.getPassword('job-tracker', 'google-client-secret');
  return { clientId, clientSecret };
});

// ─── IPC: Google OAuth ────────────────────────────────────────────────────────
const REDIRECT_URI = 'http://localhost:3742/oauth/callback';
const { DEFAULT_CLIENT_ID, DEFAULT_CLIENT_SECRET } = require('./oauth-config');

// Prefer the user's own saved credentials (Advanced); otherwise fall back to the
// OAuth client bundled with the app so end-users skip Google Cloud setup entirely.
async function getGoogleCredentials() {
  const savedId = await keytar.getPassword('job-tracker', 'google-client-id');
  const savedSecret = await keytar.getPassword('job-tracker', 'google-client-secret');
  if (savedId && savedSecret) return { clientId: savedId, clientSecret: savedSecret, source: 'user' };
  if (DEFAULT_CLIENT_ID && DEFAULT_CLIENT_SECRET) {
    return { clientId: DEFAULT_CLIENT_ID, clientSecret: DEFAULT_CLIENT_SECRET, source: 'bundled' };
  }
  return { clientId: null, clientSecret: null, source: 'none' };
}

// Tells the renderer whether sign-in works out-of-the-box (bundled creds present
// or user-saved), so onboarding can hide the manual Google Cloud instructions.
ipcMain.handle('gmail:auth-config', async () => {
  const { clientId, clientSecret, source } = await getGoogleCredentials();
  return { ready: !!(clientId && clientSecret), source };
});

ipcMain.handle('oauth:gmail:start', async () => {
  const { clientId, clientSecret } = await getGoogleCredentials();
  if (!clientId || !clientSecret) return { error: 'no-credentials' };
  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/gmail.readonly'],
    prompt: 'consent'
  });

  // Open auth URL in default browser
  shell.openExternal(authUrl);

  // Start a local server to catch the OAuth callback
  return new Promise((resolve) => {
    const http = require('http');
    const server = http.createServer(async (req, res) => {
      if (!req.url.startsWith('/oauth/callback')) {
        res.writeHead(200); res.end(); return;
      }
      const url = new URL(req.url, 'http://localhost:3742');
      const oauthError = url.searchParams.get('error');
      const code = url.searchParams.get('code');

      if (oauthError) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<h2 style="font-family:sans-serif;padding:40px;color:#c00;">OAuth error: ${oauthError}</h2><p style="font-family:sans-serif;padding:0 40px;color:#666;">You can close this tab and check the app for details.</p>`);
        server.close();
        resolve({ error: oauthError });
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<h2 style="font-family:sans-serif;padding:40px;">&#10003; Gmail connected! You can close this tab.</h2>');
      server.close();

      try {
        const { tokens } = await oauth2Client.getToken(code);
        if (!tokens.access_token) {
          resolve({ error: 'no-access-token' });
          return;
        }
        await keytar.setPassword('job-tracker', 'gmail-access-token', tokens.access_token);
        if (tokens.refresh_token) {
          await keytar.setPassword('job-tracker', 'gmail-refresh-token', tokens.refresh_token);
        }
        store.set('gmail.connected', true);
        resolve({ success: true });
      } catch (e) {
        resolve({ error: e.message });
      }
    });

    server.on('error', (e) => {
      if (e.code === 'EADDRINUSE') {
        resolve({ error: 'port-in-use' });
      } else {
        resolve({ error: e.message });
      }
    });

    server.listen(3742);
    setTimeout(() => { server.close(); resolve({ error: 'timeout' }); }, 120000);
  });
});

ipcMain.handle('oauth:gmail:status', () => ({
  connected: store.get('gmail.connected', false)
}));

ipcMain.handle('oauth:gmail:disconnect', async () => {
  await keytar.deletePassword('job-tracker', 'gmail-access-token');
  await keytar.deletePassword('job-tracker', 'gmail-refresh-token');
  store.delete('gmail.connected');
  return true;
});

// ─── IPC: Web — fetch job description via Jina search ────────────────────────
ipcMain.handle('web:fetch-jd', async (_, company, role) => {
  const https = require('https');
  const query = encodeURIComponent(`${company} "${role}" job description requirements qualifications`);
  return new Promise((resolve) => {
    const req = https.get(
      `https://s.jina.ai/${query}`,
      { headers: { 'Accept': 'text/plain', 'User-Agent': 'JobTrackerApp/1.0' } },
      (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve({ text: data.slice(0, 8000) }));
      }
    );
    req.on('error', e => resolve({ error: e.message }));
    req.setTimeout(20000, () => { req.destroy(); resolve({ error: 'timeout' }); });
  });
});

// Refresh token expired/revoked (very common while the OAuth consent screen is
// in Google "Testing" mode — refresh tokens there expire after 7 days). Clear the
// stale tokens so the app prompts a clean reconnect.
async function clearGmailAuth() {
  try { await keytar.deletePassword('job-tracker', 'gmail-access-token'); } catch (_) {}
  try { await keytar.deletePassword('job-tracker', 'gmail-refresh-token'); } catch (_) {}
  try { store.delete('gmail.connected'); } catch (_) {}
}
const isAuthExpired = (msg) => /invalid_grant|invalid_token|invalid_rapt|expired or revoked|expired|revoked|unauthorized/i.test(String(msg || ''));

// ─── IPC: Gmail API — fetch emails ───────────────────────────────────────────
ipcMain.handle('gmail:search', async (_, query, maxResults = 50) => {
  const { clientId, clientSecret } = await getGoogleCredentials();
  if (!clientId || !clientSecret) return { error: 'no-credentials' };

  const accessToken = await keytar.getPassword('job-tracker', 'gmail-access-token');
  const refreshToken = await keytar.getPassword('job-tracker', 'gmail-refresh-token');
  if (!accessToken) return { error: 'Not authenticated' };

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);
  oauth2Client.setCredentials({ access_token: accessToken, refresh_token: refreshToken });

  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

  try {
    // Search for job-related emails
    const list = await gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults
    });

    if (!list.data.messages) return { messages: [] };

    // Use metadata format to avoid Gmail quota issues (5 units/msg for full vs 1 for metadata)
    // The snippet (~200 chars) is enough: subject has company, snippet has role name
    const messages = await Promise.all(
      list.data.messages.slice(0, maxResults).map(async m => {
        const msg = await gmail.users.messages.get({
          userId: 'me', id: m.id,
          format: 'metadata',
          metadataHeaders: ['Subject', 'From', 'Date']
        });
        const headers = msg.data.payload.headers || [];
        const get = name => headers.find(h => h.name === name)?.value || '';
        return {
          id: m.id,
          subject: get('Subject'),
          from: get('From'),
          date: get('Date'),
          snippet: msg.data.snippet || ''
        };
      })
    );
    return { messages };
  } catch (e) {
    // Expired/revoked token surfaced on the request itself → reconnect needed
    if (isAuthExpired(e && e.message)) {
      await clearGmailAuth();
      return { error: 'reauth-required' };
    }
    // Otherwise the access token may just be stale — refresh once and ask to retry
    try {
      const { credentials } = await oauth2Client.refreshAccessToken();
      await keytar.setPassword('job-tracker', 'gmail-access-token', credentials.access_token);
      return { error: 'Token refreshed — please retry scan' };
    } catch (e2) {
      if (isAuthExpired(e2 && e2.message)) {
        await clearGmailAuth();
        return { error: 'reauth-required' };
      }
      return { error: (e2 && e2.message) || (e && e.message) || 'gmail-error' };
    }
  }
});

// ─── Scheduler: daily auto-scan + night-before interview reminders ───────────
// Desktop app: schedules only fire while the app is running (it stays alive in
// the tray). A 1-minute ticker is resilient across sleep/wake, and a per-day
// guard key prevents a schedule from firing twice in the same matched minute.
let schedulerTimer = null;

function getSchedulePrefs() {
  return {
    autoScanEnabled: store.get('autoScanEnabled', false),
    autoScanTime: store.get('autoScanTime', '08:00'),
    remindersEnabled: store.get('remindersEnabled', false),
    reminderTime: store.get('reminderTime', '18:30'),
  };
}

const hhmm = (d = new Date()) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function triggerAutoScan() {
  if (mainWindow && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send('scheduler:auto-scan');
  }
}

function fireInterviewReminders() {
  if (!db || !Notification.isSupported()) return;
  const tomorrow = dayKey(new Date(Date.now() + 86400000));
  let rows = [];
  try {
    // Notify for interviews AND scheduled screening/final-round calls happening tomorrow
    rows = db.prepare(
      `SELECT company, role, interview_time, interview_datetime,
              CASE WHEN interview_date = @d THEN 'Interview'
                   WHEN screening_date = @d THEN 'Screening call'
                   WHEN final_date = @d THEN 'Final round' END AS kind
         FROM applications
        WHERE interview_date = @d OR screening_date = @d OR final_date = @d`
    ).all({ d: tomorrow });
  } catch (_) { return; }
  const tz = store.get('displayTimezone') || undefined;  // undefined = system local
  rows.forEach(r => {
    let at = r.interview_time ? ` at ${r.interview_time}` : '';
    if (r.interview_datetime) {
      const dt = new Date(r.interview_datetime);
      if (!isNaN(dt)) {
        try {
          at = ' at ' + dt.toLocaleString('en-US',
            { hour: 'numeric', minute: '2-digit', timeZoneName: 'short', ...(tz ? { timeZone: tz } : {}) });
        } catch (_) {}
      }
    }
    const n = new Notification({
      title: `${r.kind || 'Interview'} tomorrow — ${r.company}`,
      body: `${r.role}${at}. Review your prep tonight — you've got this!`,
      silent: false,
    });
    n.on('click', showWindow);
    n.show();
  });
}

function tickScheduler() {
  const p = getSchedulePrefs();
  const now = new Date();
  const cur = hhmm(now);
  const today = dayKey(now);

  if (p.autoScanEnabled && cur === p.autoScanTime && store.get('lastAutoScanDay') !== today) {
    store.set('lastAutoScanDay', today);
    triggerAutoScan();
  }
  if (p.remindersEnabled && cur === p.reminderTime && store.get('lastReminderDay') !== today) {
    store.set('lastReminderDay', today);
    fireInterviewReminders();
  }
}

function startScheduler() {
  if (schedulerTimer) clearInterval(schedulerTimer);
  schedulerTimer = setInterval(tickScheduler, 60 * 1000);
  tickScheduler();
}

ipcMain.handle('schedule:get', () => getSchedulePrefs());
ipcMain.handle('schedule:set', (_, prefs) => {
  if (!prefs || typeof prefs !== 'object') return false;
  const validTime = t => /^\d{2}:\d{2}$/.test(t);
  if (typeof prefs.autoScanEnabled === 'boolean') store.set('autoScanEnabled', prefs.autoScanEnabled);
  if (validTime(prefs.autoScanTime)) store.set('autoScanTime', prefs.autoScanTime);
  if (typeof prefs.remindersEnabled === 'boolean') store.set('remindersEnabled', prefs.remindersEnabled);
  if (validTime(prefs.reminderTime)) store.set('reminderTime', prefs.reminderTime);
  return getSchedulePrefs();
});

// ─── IPC: Quit ────────────────────────────────────────────────────────────────
ipcMain.handle('app:quit', async () => {
  // Clear in-memory OAuth/session storage (keychain entries persist — intentional)
  if (mainWindow) {
    try { await mainWindow.webContents.session.clearStorageData({ storages: ['cookies', 'localstorage', 'sessionstorage'] }); } catch (_) {}
  }
  fullQuit();
});

ipcMain.handle('app:version', () => app.getVersion());

// Clear tracked DATA only (applications, skills, reminders) while keeping the
// Gmail connection, API key, and all settings — and reset the scan watermarks so
// the next scan is a fresh FULL scan. Ideal for demos / starting the pipeline over.
ipcMain.handle('app:clear-data', () => {
  if (db) {
    try { db.exec('DELETE FROM applications; DELETE FROM skills; DELETE FROM reminders;'); } catch (_) {}
  }
  ['lastScanTime', 'lastSkillScanTime', 'lastAutoScanDay', 'lastReminderDay'].forEach(k => {
    try { store.delete(k); } catch (_) {}
  });
  return true;
});

// Full reset: wipe tracked data + settings and disconnect Gmail, so the user
// starts over from onboarding. Keeps the Google client ID/secret (so they don't
// have to recreate the OAuth app) but clears the sign-in tokens.
ipcMain.handle('app:reset', async () => {
  if (db) {
    try { db.exec('DELETE FROM applications; DELETE FROM skills; DELETE FROM reminders;'); } catch (_) {}
  }
  for (const acc of ['apiKey', 'gmail-access-token', 'gmail-refresh-token']) {
    try { await keytar.deletePassword('job-tracker', acc); } catch (_) {}
  }
  try { store.clear(); } catch (_) {}
  return true;
});

// Open a URL in the user's default browser (resources, links)
ipcMain.handle('app:open-external', async (_, url) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
    await shell.openExternal(url);
    return true;
  }
  return false;
});

// Resume review: let the user pick a PDF, Word .docx, or plain-text resume. PDFs
// (pdf-parse) and .docx (mammoth) are parsed to text in the main process.
function tidyResumeText(t) {
  return String(t || '')
    .replace(/[ \t]+\n/g, '\n')      // strip trailing spaces (PDF extractors pad lines)
    .replace(/[ \t]{2,}/g, ' ')      // collapse runs of spaces
    .replace(/\n{3,}/g, '\n\n')      // collapse excess blank lines
    .trim();
}

ipcMain.handle('dialog:open-resume', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose your resume',
    properties: ['openFile'],
    filters: [{ name: 'Resume', extensions: ['pdf', 'docx', 'txt', 'md', 'markdown', 'text'] }],
  });
  if (res.canceled || !res.filePaths.length) return { canceled: true };
  const fp = res.filePaths[0];
  const fs = require('fs');
  try {
    if (/\.pdf$/i.test(fp)) {
      const pdf = require('pdf-parse');
      const data = await pdf(fs.readFileSync(fp));
      const text = tidyResumeText(data.text);
      if (!text || text.length < 30) {
        return { error: 'Could not read text from this PDF (it may be a scanned image). Please copy the text and paste it in.' };
      }
      return { name: path.basename(fp), text };
    }
    if (/\.docx$/i.test(fp)) {
      const mammoth = require('mammoth');
      const { value } = await mammoth.extractRawText({ buffer: fs.readFileSync(fp) });
      const text = tidyResumeText(value);
      if (!text || text.length < 30) {
        return { error: 'Could not read text from this document. Please copy the text and paste it in.' };
      }
      return { name: path.basename(fp), text };
    }
    if (/\.(txt|md|markdown|text)$/i.test(fp)) {
      return { name: path.basename(fp), text: tidyResumeText(fs.readFileSync(fp, 'utf8')) };
    }
    if (/\.doc$/i.test(fp)) {
      return { error: 'Legacy .doc isn\'t supported — re-save it as .docx or PDF, or paste the text.' };
    }
    return { error: 'Unsupported file type. Use a PDF, Word .docx, or .txt/.md file — or paste the text.' };
  } catch (e) {
    return { error: 'Failed to read file: ' + e.message };
  }
});
