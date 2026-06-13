// src/renderer/app.js
// All UI logic — runs in Electron renderer process
// Communicates with main process only via window.electronAPI (preload bridge)

// ─── State ────────────────────────────────────────────────────────────────────
const state = {
  provider: 'claude',
  apiKey: '',       // in-memory only, never persisted
  startDate: '',
  digestEmail: '',
  apps: [],
  skills: [],
  selRoleId: null,
  dragSrc: null,
  sortBy: 'date-desc',
  skillSort: 'importance',
  displayTimezone: '',   // '' = use the user's local timezone
  gmailBannerDismissed: false,
};

const isElectron = typeof window.electronAPI !== 'undefined';

// ─── Storage abstraction (Electron SQLite vs browser fallback) ────────────────
const DB = {
  async loadApps() {
    if (isElectron) return await window.electronAPI.apps.getAll();
    try { return JSON.parse(localStorage.getItem('jt_apps') || '[]'); } catch { return []; }
  },
  async saveApp(app) {
    if (isElectron) return await window.electronAPI.apps.upsert(app);
    const apps = await DB.loadApps();
    const idx = apps.findIndex(a => a.id === app.id);
    if (idx >= 0) apps[idx] = app; else apps.unshift(app);
    localStorage.setItem('jt_apps', JSON.stringify(apps));
  },
  async deleteApp(id) {
    if (isElectron) return await window.electronAPI.apps.delete(id);
    const apps = (await DB.loadApps()).filter(a => a.id !== id);
    localStorage.setItem('jt_apps', JSON.stringify(apps));
  },
  async loadSkills() {
    if (isElectron) return await window.electronAPI.skills.getAll();
    try { return JSON.parse(localStorage.getItem('jt_skills') || '[]'); } catch { return []; }
  },
  async saveSkill(skill) {
    if (isElectron) return await window.electronAPI.skills.upsert(skill);
    const skills = await DB.loadSkills();
    const idx = skills.findIndex(s => s.name === skill.name);
    if (idx >= 0) skills[idx] = skill; else skills.push(skill);
    localStorage.setItem('jt_skills', JSON.stringify(skills));
  },
  async reorderSkills(names) {
    if (isElectron) return await window.electronAPI.skills.reorder(names);
    const skills = await DB.loadSkills();
    const map = Object.fromEntries(skills.map(s => [s.name, s]));
    const reordered = names.map((n, i) => ({ ...map[n], sort_order: i }));
    localStorage.setItem('jt_skills', JSON.stringify(reordered));
  },
  async getPref(key) {
    if (isElectron) return await window.electronAPI.store.get(key);
    return localStorage.getItem('pref_' + key);
  },
  async setPref(key, val) {
    if (isElectron) return await window.electronAPI.store.set(key, val);
    localStorage.setItem('pref_' + key, typeof val === 'string' ? val : JSON.stringify(val));
  },
  async getSecret(key) {
    if (isElectron) return await window.electronAPI.keychain.get('job-tracker', key);
    return sessionStorage.getItem('secret_' + key);
  },
  async setSecret(key, val) {
    if (isElectron) return await window.electronAPI.keychain.set('job-tracker', key, val);
    sessionStorage.setItem('secret_' + key, val);
  },
};

// ─── Resources DB ─────────────────────────────────────────────────────────────
const RESOURCES = {
  'Machine learning': [
    { t: 'yt', title: 'Stanford CS229 — full lecture series', meta: 'Andrew Ng · 20hrs', tag: 'Foundations' },
    { t: 'hf', title: 'HuggingFace ML course — free & practical', meta: 'HuggingFace.co', tag: 'Practical' },
  ],
  'Python': [
    { t: 'yt', title: 'Python patterns for ML engineers', meta: 'NeetCode · 3hrs', tag: 'Coding' },
    { t: 'gh', title: 'Python interview prep — 200 problems', meta: 'GitHub · 18k⭐', tag: 'Practice' },
  ],
  'SQL': [
    { t: 'yt', title: 'Advanced SQL for data scientists', meta: 'Mode Analytics', tag: 'SQL' },
    { t: 'med', title: 'Window functions with real examples', meta: 'Towards Data Science', tag: 'SQL' },
  ],
  'Statistics': [
    { t: 'yt', title: 'A/B testing & hypothesis testing deep dive', meta: 'StatQuest · YouTube', tag: 'Stats' },
    { t: 'hf', title: 'StatQuest companion notebooks', meta: 'HuggingFace', tag: 'Stats' },
  ],
  'System design': [
    { t: 'yt', title: 'ML system design — fraud detection walkthrough', meta: 'Exponent · 45min', tag: 'System design' },
    { t: 'med', title: 'Real-time fraud ML pipeline design', meta: 'Netflix Tech Blog', tag: 'Fraud ML' },
  ],
  'Fraud detection': [
    { t: 'med', title: 'Building fraud ML systems at scale', meta: 'Stripe Engineering Blog', tag: 'Fraud' },
    { t: 'yt', title: 'Fraud detection with graph neural networks', meta: 'YouTube · 1hr', tag: 'GNN' },
  ],
  'XGBoost': [
    { t: 'hf', title: 'XGBoost fine-tuning guide', meta: 'HuggingFace Docs', tag: 'Boosting' },
    { t: 'med', title: 'Gradient boosting from scratch', meta: 'Towards Data Science', tag: 'Boosting' },
  ],
  'default': [
    { t: 'yt', title: 'ML engineer interview prep — full guide', meta: 'TechLead · YouTube', tag: 'General' },
    { t: 'med', title: 'How to land an ML role in 2026', meta: 'Medium · Towards AI', tag: 'Career' },
    { t: 'hf', title: 'HuggingFace free ML course', meta: 'HuggingFace.co', tag: 'ML' },
    { t: 'gh', title: 'Coding interview university', meta: 'GitHub · 250k⭐', tag: 'Practice' },
  ],
};

// ─── Utilities ────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const delay = ms => new Promise(r => setTimeout(r, ms));

function bHtml(s) {
  const m = { applied: ['b-app','Applied'], screening: ['b-scr','Screening'], interview: ['b-int','Interview'], offer: ['b-off','Offer'], rejected: ['b-rej','Rejected'] };
  const [c, l] = m[s] || m.applied;
  return `<span class="badge ${c}">${l}</span>`;
}

function groupByCompany(apps, sortBy = state.sortBy || 'date-desc') {
  const map = {};
  apps.forEach(a => {
    if (!map[a.company]) map[a.company] = { company: a.company, roles: [] };
    map[a.company].roles.push(a);
  });
  const groups = Object.values(map);
  // Keep roles inside each company ordered newest-first for a consistent read
  const roleDate = r => new Date(r.applied_date || r.appliedDate || 0).getTime();
  groups.forEach(g => g.roles.sort((a, b) => roleDate(b) - roleDate(a)));
  if (sortBy === 'company-asc') return groups.sort((a, b) => a.company.localeCompare(b.company));
  if (sortBy === 'company-desc') return groups.sort((a, b) => b.company.localeCompare(a.company));
  // date-desc / date-asc: sort by most recent applied_date in each group
  const latestDate = g => Math.max(...g.roles.map(roleDate));
  if (sortBy === 'date-asc') return groups.sort((a, b) => latestDate(a) - latestDate(b));
  return groups.sort((a, b) => latestDate(b) - latestDate(a)); // date-desc default
}

function weekAgo() { const d = new Date(); d.setDate(d.getDate() - 7); return d; }

// ─── AI calls ─────────────────────────────────────────────────────────────────
function getEndpoint() {
  if (state.provider === 'openai') return 'https://api.openai.com/v1/chat/completions';
  if (state.provider === 'gemini') return `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${state.apiKey}`;
  return 'https://api.anthropic.com/v1/messages';
}

function buildBody(sys, prompt, maxTok = 1000) {
  if (state.provider === 'openai') return { model: 'gpt-4o', max_tokens: maxTok, messages: [{ role: 'system', content: sys }, { role: 'user', content: prompt }] };
  if (state.provider === 'gemini') return { contents: [{ parts: [{ text: sys + '\n\n' + prompt }] }] };
  return { model: 'claude-sonnet-4-20250514', max_tokens: maxTok, system: sys, messages: [{ role: 'user', content: prompt }] };
}

function extractText(data) {
  if (state.provider === 'openai') return data.choices?.[0]?.message?.content || '';
  if (state.provider === 'gemini') return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  return data.content?.filter(b => b.type === 'text').map(b => b.text).join('') || '';
}

async function callAI(sys, prompt, maxTok = 1000) {
  const headers = { 'Content-Type': 'application/json' };
  if (state.provider === 'openai') {
    headers['Authorization'] = 'Bearer ' + state.apiKey;
  } else if (state.provider === 'claude') {
    headers['x-api-key'] = state.apiKey;
    headers['anthropic-version'] = '2023-06-01';
  }
  const res = await fetch(getEndpoint(), { method: 'POST', headers, body: JSON.stringify(buildBody(sys, prompt, maxTok)) });
  if (res.status === 401) throw new Error('api-401');
  if (!res.ok) throw new Error('API error ' + res.status);
  return extractText(await res.json());
}

// ─── INIT ─────────────────────────────────────────────────────────────────────
async function init() {
  const savedStart = await DB.getPref('startDate');
  if (savedStart) {
    state.startDate = savedStart;
  } else {
    // Default: 6 months back so first scan catches everything
    const d = new Date(); d.setMonth(d.getMonth() - 6);
    state.startDate = d.toISOString().split('T')[0];
    await DB.setPref('startDate', state.startDate);
  }
  state.digestEmail = await DB.getPref('digestEmail') || '';
  state.provider = await DB.getPref('provider') || 'claude';
  state.sortBy = await DB.getPref('sortBy') || 'date-desc';
  state.skillSort = await DB.getPref('skillSort') || 'importance';
  state.displayTimezone = await DB.getPref('displayTimezone') || '';

  state.apps = await DB.loadApps();
  state.skills = await DB.loadSkills();

  // Scheduled auto-scan trigger from the main process (fires while app runs in tray)
  if (isElectron && window.electronAPI.schedule?.onAutoScan) {
    window.electronAPI.schedule.onAutoScan(() => {
      if (!state.apiKey || state.autoScanInFlight) return;  // not set up, or already scanning
      state.autoScanInFlight = true;
      showTab('pipeline');
      Promise.resolve(scanGmail()).finally(() => { state.autoScanInFlight = false; });
    });
    // Keep the "last scan" label current as time passes (and after background scans)
    setInterval(renderLastScan, 60000);
  }

  // Refresh the daily quote at the day rollover even when the app stays open in
  // the tray for days, and whenever the window regains focus.
  setInterval(renderDailyQuote, 60 * 60 * 1000);  // hourly catches midnight
  window.addEventListener('focus', () => {
    renderDailyQuote();
    if (isElectron) renderLastScan();
  });

  const defaultStart = new Date(); defaultStart.setMonth(defaultStart.getMonth() - 3);
  $('start-date').value = state.startDate || defaultStart.toISOString().split('T')[0];
  $('f-date').value = new Date().toISOString().split('T')[0];

  if (state.apiKey || (await DB.getSecret('apiKey'))) {
    state.apiKey = await DB.getSecret('apiKey') || '';
  }

  // Pre-populate Step 1 credential state
  if (isElectron) {
    // Quick-connect: if sign-in works out of the box (bundled credentials, or the
    // user already saved their own), hide the Google Cloud setup and just let them
    // sign in. Otherwise fall back to the manual credential flow.
    const authCfg = await window.electronAPI.gmail.authConfig();
    const enableSignIn = () => {
      const btn = $('gmail-btn');
      if (btn) { btn.disabled = false; btn.style.opacity = ''; btn.style.cursor = ''; }
    };
    if (authCfg && authCfg.ready) {
      enableSignIn();
      const easy = $('easy-creds'); if (easy) easy.style.display = 'block';
      // Only collapse the manual block when creds are bundled (source: 'bundled').
      // If the user supplied their own earlier, keep it visible but pre-filled state shown.
      if (authCfg.source === 'bundled') {
        const manual = $('manual-creds'); if (manual) manual.style.display = 'none';
      } else {
        const savedEl = $('cred-saved'); if (savedEl) savedEl.style.display = 'flex';
      }
    } else {
      const creds = await window.electronAPI.credentials.get();
      if (creds && creds.clientId && creds.clientSecret) {
        enableSignIn();
        const savedEl = $('cred-saved'); if (savedEl) savedEl.style.display = 'flex';
      }
    }
  }
  const gmailConnected = await DB.getPref('gmailConnected');
  if (gmailConnected) {
    const btn = $('gmail-btn');
    if (btn) {
      btn.className = 'gmail-btn connected';
      btn.innerHTML = '&#10003; Gmail connected — read-only access';
      btn.disabled = false; btn.style.opacity = ''; btn.style.cursor = '';
    }
    const ok = $('gmail-ok'); if (ok) ok.style.display = 'flex';
    const next = $('step1-next'); if (next) next.disabled = false;
  }

  // If API key already set, setup was completed in a prior session — go straight to the app
  if (state.apiKey) {
    launch(true);
    return;
  }

  render();
}

function render() {
  renderPipeline();
  renderSkills();
  renderReminders();
  updateWeekStats();
  renderDailyQuote();
  renderLastScan();
}

// ─── SCREEN NAV ───────────────────────────────────────────────────────────────
function goTo(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(id)?.classList.add('active');
}

function showTab(t) {
  ['pipeline', 'skills', 'resume', 'reminders', 'settings'].forEach(id => {
    const el = $('tab-' + id);
    if (el) el.style.display = id === t ? 'block' : 'none';
  });
  document.querySelectorAll('.nav-item[data-tab]').forEach(el => {
    el.classList.toggle('active', el.dataset.tab === t);
  });
  if (t === 'skills') { renderSkills(); populateSkillsAppSelect(); }
  if (t === 'resume') renderResume();
  if (t === 'reminders') renderReminders();
  if (t === 'settings') renderSettings();
}

// ─── ONBOARDING — Step 1 ──────────────────────────────────────────────────────
async function saveGoogleCredentials() {
  const clientId = $('google-client-id').value.trim();
  const clientSecret = $('google-client-secret').value.trim();
  if (!clientId || !clientSecret) { alert('Please enter both Client ID and Client Secret.'); return; }
  const sp = $('cred-sp');
  sp.classList.add('on');
  try {
    if (isElectron) {
      await window.electronAPI.credentials.save(clientId, clientSecret);
    }
    sp.classList.remove('on');
    const savedEl = $('cred-saved');
    savedEl.style.display = 'flex';
    const btn = $('gmail-btn');
    btn.disabled = false; btn.style.opacity = ''; btn.style.cursor = '';
  } catch (e) {
    sp.classList.remove('on');
    alert('Failed to save credentials: ' + e.message);
  }
}

function toggleFieldVis(fieldId) {
  $(fieldId).classList.toggle('fi-pw');
}

async function connectGmail() {
  const btn = $('gmail-btn');
  const gIcon = '<span style="width:18px;height:18px;border-radius:50%;background:#ea4335;display:inline-flex;align-items:center;justify-content:center;font-size:10px;color:#fff;font-weight:700;flex-shrink:0;">G</span>';
  btn.innerHTML = gIcon + ' Opening browser for Google sign-in...';
  btn.disabled = true;

  try {
    if (isElectron) {
      const result = await window.electronAPI.gmail.startAuth();
      const resetBtn = () => {
        btn.innerHTML = gIcon + ' Sign in with Google (read-only)';
        btn.disabled = false;
      };
      if (result.error === 'no-credentials') {
        resetBtn();
        alert('Please save your Google credentials first (Client ID and Client Secret above).');
        return;
      }
      if (result.error === 'port-in-use') {
        resetBtn();
        alert('Port 3742 is already in use.\n\nClose any other instances of this app and try again.');
        return;
      }
      if (result.error === 'redirect_uri_mismatch') {
        resetBtn();
        alert('Redirect URI mismatch.\n\nIn Google Cloud Console, edit your OAuth client and add this exact redirect URI:\n\nhttp://localhost:3742/oauth/callback\n\nThen try again.');
        return;
      }
      if (result.error === 'access_denied') {
        resetBtn();
        alert('Sign-in was cancelled or denied. Please try again.\n\nIf you see a "Google hasn\'t verified this app" warning, click Advanced → Go to [your app name] (unsafe) to continue.');
        return;
      }
      if (result.error === 'timeout') {
        resetBtn();
        alert('Sign-in timed out (2 minutes). Please try again.');
        return;
      }
      if (result.error) {
        resetBtn();
        alert('OAuth failed: ' + result.error + '\n\nOpen DevTools (Cmd+Option+I) → Console for details.');
        return;
      }
      if (result.success) {
        btn.className = 'gmail-btn connected';
        btn.innerHTML = '&#10003; Gmail connected — read-only access';
        $('gmail-ok').style.display = 'flex';
        $('step1-next').disabled = false;
        await DB.setPref('gmailConnected', true);
      }
    } else {
      await delay(1200);
      btn.className = 'gmail-btn connected';
      btn.innerHTML = '&#10003; Gmail connected (demo mode)';
      $('gmail-ok').style.display = 'flex';
      $('step1-next').disabled = false;
    }
  } catch (e) {
    const gIcon2 = '<span style="width:18px;height:18px;border-radius:50%;background:#ea4335;display:inline-flex;align-items:center;justify-content:center;font-size:10px;color:#fff;font-weight:700;flex-shrink:0;">G</span>';
    btn.innerHTML = gIcon2 + ' Sign in with Google (read-only)';
    btn.disabled = false;
    alert('OAuth failed: ' + e.message);
  }
}

async function step1Next() {
  state.startDate = $('start-date').value;
  await DB.setPref('startDate', state.startDate);
  goTo('s-step2');
}

function skipGmailSetup() {
  step1Next();
}

function toggleAdvancedCreds() {
  const manual = $('manual-creds');
  if (manual) manual.style.display = manual.style.display === 'none' ? 'block' : 'none';
}

// ─── ONBOARDING — Step 2 ──────────────────────────────────────────────────────
function selProv(p) {
  state.provider = p;
  ['claude', 'openai', 'gemini'].forEach(id => $('prov-' + id).classList.toggle('active', id === p));

  // Show inline guide for selected provider
  ['claude', 'openai', 'gemini'].forEach(id => {
    const g = $('guide-' + id);
    if (g) g.style.display = id === p ? 'block' : 'none';
  });

  const labels = { claude: 'Anthropic', openai: 'OpenAI', gemini: 'Google' };
  $('prov-label').textContent = labels[p] || p;

  // Reset validation state when provider changes
  const statusEl = $('key-validation-status');
  if (statusEl) statusEl.style.display = 'none';
  const nextBtn = $('step2-next');
  if (nextBtn) nextBtn.disabled = true;
}

function toggleKeyVis() {
  $('api-key').classList.toggle('fi-pw');
}

async function validateKey() {
  const k = $('api-key').value.trim();
  if (!k) { alert('Please paste your API key.'); return; }

  const sp = $('val-sp');
  const statusEl = $('key-validation-status');
  sp.classList.add('on');
  statusEl.style.display = 'none';

  try {
    let valid = false;

    if (state.provider === 'claude') {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': k, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] })
      });
      valid = res.status !== 401 && res.status !== 403;
    } else if (state.provider === 'openai') {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + k },
        body: JSON.stringify({ model: 'gpt-4o-mini', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] })
      });
      valid = res.status !== 401 && res.status !== 403;
    } else if (state.provider === 'gemini') {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${k}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: 'hi' }] }], generationConfig: { maxOutputTokens: 1 } })
      });
      valid = res.ok || res.status === 429;
    }

    if (valid) {
      state.apiKey = k;
      await DB.setSecret('apiKey', k);
      await DB.setPref('provider', state.provider);
      statusEl.className = 'note note-g';
      statusEl.innerHTML = '&#10003; Key valid — ready to go!';
      statusEl.style.display = 'block';
      $('step2-next').disabled = false;
    } else {
      statusEl.className = 'note note-r';
      statusEl.innerHTML = '&#10007; Invalid key — check and retry';
      statusEl.style.display = 'block';
    }
  } catch (e) {
    statusEl.className = 'note note-r';
    statusEl.innerHTML = '&#10007; Validation failed — check your connection and try again';
    statusEl.style.display = 'block';
  }

  sp.classList.remove('on');
}

async function launch(skipSetup = false) {
  if (!skipSetup) {
    state.digestEmail = $('digest-email')?.value || state.digestEmail;
    if (state.digestEmail) await DB.setPref('digestEmail', state.digestEmail);
  }
  const labels = { claude: 'Claude', openai: 'GPT-4o', gemini: 'Gemini Flash' };
  $('key-pill').textContent = '&#10003; ' + (labels[state.provider] || 'Claude') + ' key active';
  $('scan-from-date').value = state.startDate || '';
  goTo('s-app');
  showTab('pipeline');
  render();
  refreshGmailBanner();
}

// Show a prompt on the pipeline page when Gmail isn't connected, so the user
// isn't dropped into the app only to have scans silently fail.
async function refreshGmailBanner() {
  const banner = $('gmail-banner');
  if (!banner || !isElectron) return;
  if (state.gmailBannerDismissed) { banner.style.display = 'none'; return; }
  let connected = false;
  try { connected = (await window.electronAPI.gmail.status())?.connected; } catch (_) {}
  if (connected) { banner.style.display = 'none'; return; }
  $('gb-title').textContent = "Gmail isn't connected";
  $('gb-sub').textContent = 'Connect your Gmail to auto-scan your job application emails.';
  $('gb-btn').firstChild.textContent = 'Connect Gmail ';
  banner.style.display = 'flex';
}

// Flip the banner into a "reconnect" state (e.g. after a scan auth failure)
function showReconnectBanner() {
  const banner = $('gmail-banner');
  if (!banner) return;
  state.gmailBannerDismissed = false;
  $('gb-title').textContent = 'Gmail access expired';
  $('gb-sub').textContent = 'Your Gmail connection needs to be renewed before scanning.';
  $('gb-btn').firstChild.textContent = 'Reconnect Gmail ';
  banner.style.display = 'flex';
}

function dismissGmailBanner() {
  state.gmailBannerDismissed = true;
  const banner = $('gmail-banner');
  if (banner) banner.style.display = 'none';
}

async function bannerConnectGmail() {
  const btn = $('gb-btn'), sp = $('gb-sp');
  btn.disabled = true; sp.classList.add('on');
  try {
    const result = await window.electronAPI.gmail.startAuth();
    if (result.error === 'no-credentials') {
      alert('No Google credentials found. Go to Settings → Google OAuth Credentials to add them, then try again.');
    } else if (result.error) {
      alert('Gmail connection failed: ' + result.error);
    } else if (result.success) {
      await DB.setPref('gmailConnected', true);
      const banner = $('gmail-banner'); if (banner) banner.style.display = 'none';
    }
  } catch (e) {
    alert('Gmail connection failed: ' + e.message);
  }
  btn.disabled = false; sp.classList.remove('on');
}

async function updateScanDate(val) {
  if (!val) return;
  state.startDate = val;
  await DB.setPref('startDate', val);
  // Also keep Settings tab in sync
  const settingsEl = $('settings-start-date');
  if (settingsEl) settingsEl.value = val;
}

function devSkip() {
  state.provider = 'claude';
  state.apiKey = 'demo';
  state.startDate = new Date(Date.now() - 90 * 864e5).toISOString().split('T')[0];
  state.digestEmail = 'dev@example.com';
  launch(true);
}

async function quitApp() {
  if (!confirm('Quit Job Tracker completely?\n\nThis fully exits the app (including the menu-bar / tray icon), so any scheduled auto-scans and interview reminders will stop until you reopen it.\n\nTo keep automation running, just close the window instead — the app stays in your tray.\n\nYour data and keychain credentials stay saved for next time.')) return;
  state.apiKey = '';
  if (isElectron) {
    await window.electronAPI.app.quit();
  } else {
    sessionStorage.clear();
    goTo('s-welcome');
  }
}

async function clearData() {
  if (!confirm('Clear all tracked data?\n\nThis deletes every application, skill, and reminder, but KEEPS your Gmail connection and API key. The next scan will be a fresh full scan.\n\nGood for starting over / demos. This cannot be undone.')) return;
  if (isElectron) await window.electronAPI.app.clearData();
  else { try { localStorage.removeItem('jt_apps'); localStorage.removeItem('jt_skills'); } catch (_) {} }
  state.apps = [];
  state.skills = [];
  state.selRoleId = null;
  const dp = $('detail-panel'); if (dp) dp.style.display = 'none';
  render();
  showTab('pipeline');
  const txt = $('sbar-text');
  if (txt) txt.textContent = 'Cleared. Click "Scan Gmail" to rebuild your pipeline.';
}

async function resetApp() {
  if (!confirm('Reset Job Tracker?\n\nThis permanently deletes ALL tracked applications, skills, and settings, and disconnects Gmail. You will go through setup again, including the Google sign-in.\n\nThis cannot be undone.')) return;
  if (isElectron) {
    await window.electronAPI.app.reset();
  } else {
    localStorage.clear(); sessionStorage.clear();
  }
  // Reload the renderer so it boots fresh into onboarding
  location.reload();
}

// ─── SETTINGS ─────────────────────────────────────────────────────────────────
async function renderSettings() {
  const labels = { claude: 'Claude', openai: 'GPT-4o', gemini: 'Gemini Flash' };
  $('settings-provider-display').textContent = labels[state.provider] || 'Claude';

  const key = await DB.getSecret('apiKey');
  if (key) $('settings-api-key').value = key;

  if (isElectron) {
    const creds = await window.electronAPI.credentials.get();
    if (creds) {
      if (creds.clientId) $('settings-client-id').value = creds.clientId;
      if (creds.clientSecret) $('settings-client-secret').value = creds.clientSecret;
    }
    const gmailStatus = await window.electronAPI.gmail.status();
    const statusEl = $('settings-gmail-status');
    const discBtn = $('settings-disconnect-btn');
    if (gmailStatus.connected) {
      statusEl.innerHTML = '<span class="note note-g" style="display:inline-flex;">&#10003; Gmail connected — read-only access</span>';
      discBtn.style.display = 'inline-flex';
    } else {
      statusEl.innerHTML = '<span class="note note-r" style="display:inline-flex;">&#10007; Gmail not connected</span>';
      discBtn.style.display = 'none';
    }
  }

  $('settings-start-date').value = state.startDate;
  $('settings-digest-email').value = state.digestEmail;
  populateTimezones();

  // Automation (scheduler) prefs live in the main process
  if (isElectron && window.electronAPI.schedule) {
    const s = await window.electronAPI.schedule.get();
    if (s) {
      $('auto-scan-enabled').checked = !!s.autoScanEnabled;
      $('auto-scan-time').value = s.autoScanTime || '08:00';
      $('reminders-enabled').checked = !!s.remindersEnabled;
      $('reminder-time').value = s.reminderTime || '18:30';
    }
    const iso = await DB.getPref('lastScanTime');
    const lastEl = $('auto-last-scan');
    if (lastEl) lastEl.innerHTML = iso
      ? `&#128340; Last Gmail scan: <strong>${relTime(iso)}</strong> — ${new Date(iso).toLocaleString()}`
      : '&#128340; No Gmail scan has run yet.';
  }
}

async function saveAutomation() {
  if (!isElectron || !window.electronAPI.schedule) return;
  await window.electronAPI.schedule.set({
    autoScanEnabled: $('auto-scan-enabled').checked,
    autoScanTime: $('auto-scan-time').value || '08:00',
    remindersEnabled: $('reminders-enabled').checked,
    reminderTime: $('reminder-time').value || '18:30',
  });
  const el = $('automation-status');
  el.style.display = 'block';
  setTimeout(() => { el.style.display = 'none'; }, 2500);
}

async function updateProviderKey() {
  const newKey = $('settings-api-key').value.trim();
  if (!newKey) { alert('Please enter an API key.'); return; }
  state.apiKey = newKey;
  await DB.setSecret('apiKey', newKey);
  const labels = { claude: 'Claude', openai: 'GPT-4o', gemini: 'Gemini Flash' };
  $('key-pill').textContent = '&#10003; ' + (labels[state.provider] || 'Claude') + ' key active';
  const el = $('settings-key-status');
  el.className = 'note note-g'; el.textContent = '&#10003; API key updated';
  el.style.display = 'block';
  setTimeout(() => { el.style.display = 'none'; }, 3000);
}

async function updateGoogleCreds() {
  const clientId = $('settings-client-id').value.trim();
  const clientSecret = $('settings-client-secret').value.trim();
  if (!clientId || !clientSecret) { alert('Please enter both Client ID and Client Secret.'); return; }
  if (isElectron) await window.electronAPI.credentials.save(clientId, clientSecret);
  const el = $('settings-google-creds-status');
  el.className = 'note note-g'; el.textContent = '&#10003; Credentials saved to keychain';
  el.style.display = 'block';
  setTimeout(() => { el.style.display = 'none'; }, 3000);
}

async function disconnectGmailFromSettings() {
  if (!confirm('Disconnect Gmail? You\'ll need to sign in again to scan emails.')) return;
  if (isElectron) await window.electronAPI.gmail.disconnect();
  await DB.setPref('gmailConnected', false);
  state.gmailBannerDismissed = false;
  renderSettings();
  refreshGmailBanner();
}

const TIMEZONES = [
  ['Pacific Time', 'America/Los_Angeles'],
  ['Mountain Time', 'America/Denver'],
  ['Central Time', 'America/Chicago'],
  ['Eastern Time', 'America/New_York'],
  ['UTC', 'UTC'],
  ['London', 'Europe/London'],
  ['Central Europe', 'Europe/Berlin'],
  ['India', 'Asia/Kolkata'],
  ['China', 'Asia/Shanghai'],
  ['Japan', 'Asia/Tokyo'],
  ['Sydney', 'Australia/Sydney'],
];

function localTimezone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (_) { return ''; }
}

// Populate every timezone <select> in the app (Settings + Reminders page).
function populateTimezones() {
  const local = localTimezone();
  const opts = [[`Local — automatic${local ? ' (' + local + ')' : ''}`, '']]
    .concat(TIMEZONES.filter(([, z]) => z !== local));
  const html = opts.map(([label, z]) => `<option value="${z}">${label}</option>`).join('');
  ['settings-timezone', 'reminders-timezone'].forEach(id => {
    const sel = $(id);
    if (sel) { sel.innerHTML = html; sel.value = state.displayTimezone || ''; }
  });
}

async function setTimezone(val) {
  state.displayTimezone = val || '';
  await DB.setPref('displayTimezone', state.displayTimezone);
  populateTimezones();   // keep both selects in sync
  renderReminders();
}

async function saveSettings() {
  state.startDate = $('settings-start-date').value;
  state.digestEmail = $('settings-digest-email').value;
  await DB.setPref('startDate', state.startDate);
  await DB.setPref('digestEmail', state.digestEmail);
  $('scan-from-date').value = state.startDate || '';
  const el = $('settings-save-status');
  el.style.display = 'block';
  setTimeout(() => { el.style.display = 'none'; }, 3000);
}

// Merge a freshly-scanned record into an existing one WITHOUT erasing data.
// Dates/times the scan didn't return (null/empty) never overwrite values we
// already have — this protects manual edits and previously-captured meetings,
// and keeps the most-advanced status.
function mergeScanFields(existing, f) {
  const out = { ...existing, ...f };
  const sticky = ['applied_date', 'screening_date', 'interview_date', 'final_date',
                  'offer_date', 'interview_time', 'interview_datetime'];
  for (const k of sticky) {
    if (f[k] == null || f[k] === '') out[k] = existing[k] ?? null;
  }
  const RANK = { applied: 0, screening: 1, interview: 2, offer: 3, rejected: 3 };
  if ((RANK[existing.status] || 0) > (RANK[f.status] || 0)) out.status = existing.status;
  return out;
}

// ─── GMAIL SCAN ───────────────────────────────────────────────────────────────
async function scanGmail() {
  const dot = $('sdot'), txt = $('sbar-text'), sp = $('scan-sp');
  dot.className = 'sdot dot-busy';
  txt.textContent = 'Scanning Gmail from ' + state.startDate + '...';
  sp.classList.add('on');

  try {
    let emailData = '';
    let rawCount = 0;
    let fetchedMsgs = [];  // kept for subject preview in diagnostics

    if (isElectron) {
      // First scan ever → full history from startDate; subsequent → last 2 days only
      const lastScan = await DB.getPref('lastScanTime');
      const fallback = (() => { const d = new Date(); d.setMonth(d.getMonth() - 6); return d.toISOString().split('T')[0]; })();
      let scanFrom, isIncremental;
      if (lastScan) {
        const d = new Date(lastScan); d.setDate(d.getDate() - 1);  // 1 day overlap to catch late emails
        scanFrom = d.toISOString().split('T')[0];
        isIncremental = true;
      } else {
        scanFrom = state.startDate || fallback;
        isIncremental = false;
      }
      const dateStr = scanFrom.replace(/-/g, '/');

      txt.textContent = isIncremental ? `Incremental scan since ${scanFrom}...` : `Full scan from ${scanFrom}...`;

      // Three focused queries merged client-side:
      //  q1 — subject keywords
      //  q2 — known ATS / recruiting sender domains
      //  q3 — body-text application phrases (catches emails from individual
      //       recruiters, e.g. "Greetings from Google!" whose body says
      //       "Thanks so much for applying for …")
      const q1 = `after:${dateStr} subject:(application OR applied OR applying OR interview OR offer OR rejected OR "thank you for")`;
      const q2 = `after:${dateStr} from:(greenhouse-mail.io OR greenhouse.io OR lever.co OR workday.com OR smartrecruiters.com OR ashbyhq.com OR taleo.net OR jobvite.com OR icims.com OR myworkdayjobs.com OR recruiting OR recruiter OR careers)`;
      const q3 = `after:${dateStr} ("thank you for applying" OR "thanks for applying" OR "applying for" OR "your application" OR "application for the" OR "formally apply" OR "phone screen" OR "recruiting coordinator" OR "moving forward" OR "schedule a call" OR "schedule an interview" OR "next steps in" OR subject:(invitation OR "updated invitation" OR interview) OR "added to your calendar" OR "google meet")`;

      const [r1, r2, r3] = await Promise.all([
        window.electronAPI.gmail.search(q1, 20),
        window.electronAPI.gmail.search(q2, 20),
        window.electronAPI.gmail.search(q3, 20),
      ]);

      for (const r of [r1, r2, r3]) {
        if (r.error === 'no-credentials') {
          txt.textContent = 'Gmail not set up — go to Settings to add your Google credentials';
          dot.className = 'sdot dot-ok'; sp.classList.remove('on'); return;
        }
        if (r.error === 'Not authenticated') {
          txt.textContent = 'Gmail not connected — connect it using the banner above.';
          showReconnectBanner();
          dot.className = 'sdot dot-ok'; sp.classList.remove('on'); return;
        }
        if (r.error) throw new Error(r.error);
      }

      // Merge and deduplicate by message id
      const seen = new Set();
      const allMsgs = [...(r1.messages || []), ...(r2.messages || []), ...(r3.messages || [])].filter(m => {
        if (seen.has(m.id)) return false; seen.add(m.id); return true;
      });

      fetchedMsgs = allMsgs;
      rawCount = allMsgs.length;
      if (rawCount === 0) {
        txt.textContent = `No matching emails found since ${scanFrom}. ` +
          `Try an earlier start date in Settings (currently ${scanFrom}).`;
        dot.className = 'sdot dot-ok'; sp.classList.remove('on');
        renderPipeline(); return;
      }

      txt.textContent = `Fetched ${rawCount} email${rawCount !== 1 ? 's' : ''} — asking AI to parse...`;

      emailData = allMsgs.map((m, i) =>
        `[Email ${i + 1}]\nSubject: ${m.subject}\nFrom: ${m.from}\nDate: ${m.date}\nPreview: ${m.snippet}`
      ).join('\n\n');
    } else {
      emailData = `Subject: Application received - ML Engineer, Risk\nFrom: no-reply@greenhouse.io\nDate: Mon, 2 Jun 2026\nSnippet: Thank you for applying to Stripe for the position of ML Engineer, Risk.\n---\nSubject: Interview Invitation - Data Scientist, Payments\nFrom: recruiting@stripe.com\nDate: Thu, 5 Jun 2026\nSnippet: We'd like to invite you to a technical screening for the Data Scientist role. Available: June 10, 11am or June 11, 2pm.\n---\nSubject: Your application at Anthropic\nFrom: jobs@anthropic.com\nDate: Wed, 4 Jun 2026\nSnippet: Thank you for applying for Trust & Safety Machine Learning Engineer. We'll review your application.\n---\nSubject: Update on your application - Discord\nFrom: recruiting@discord.com\nDate: Fri, 6 Jun 2026\nSnippet: After careful consideration, we will not be moving forward with your application for SCAR ML Engineer at this time.\n---\nSubject: Exciting opportunity at Perplexity\nFrom: recruiter@perplexity.ai\nDate: Tue, 3 Jun 2026\nSnippet: We came across your profile and think you'd be a great fit for our Data Scientist role. Interview scheduled June 18.`;
    }

    const today = new Date().toISOString().split('T')[0];
    const sysprompt =
      `You extract job application records from Gmail email data (Subject, From, Date, Preview).

KEY PATTERNS:
- Subject "Thank you for applying to [Company]" → company=[Company], status=applied, look for role in Preview
- Subject "Your application for [Role] at [Company]" → extract both from subject
- "applying for [Role]" / "for the [Role] role" from a recruiter (even if the subject is generic, e.g. "Greetings from Google!") → extract company from the sender's domain/signature and role from the body
- "interview" / "we'd like to schedule" / "schedule a call" / "add time to my calendar" → status=screening or interview
- "not moving forward" / "regret to inform" / "other candidates" → status=rejected
- "offer" / "pleased to offer" → status=offer

RULES:
1. ONE record per unique (company + role) pair — never duplicate.
2. Multiple emails about same role → ONE record, most advanced status wins:
   offer = rejected > interview > screening > applied
3. If the role title is not mentioned anywhere, use "(role not specified)" — NEVER skip an application just because the role is missing.
4. INCLUDE recruiter conversations the candidate is actively engaged in — if they replied, discussed fit, or are arranging a call/interview about a SPECIFIC role, record it (status=screening; use applied if they formally applied). Only skip truly cold, mass outreach the candidate never responded to.
5. The company may come from the sender's email domain (e.g. someone@google.com → Google) when not stated in the subject.
6. If the thread mentions a DIFFERENT/updated role than the original subject (e.g. "we have another role — Threat Investigations Manager"), use the most recent role being discussed.
7. CALENDAR INVITES & SCHEDULING: a calendar invite (subject like "Event confirmed: Meeting with Ashley Ciaburri @ Mon Jun 15, 2026 9:30am - 9:45am (CDT)", or a body with "When: Monday Jun 15, 2026 9:30am – 9:45am") sets the meeting date and time.
   - Put the date in screening_date (recruiter/HR call) or interview_date (interview), and the start time + timezone into interview_time EXACTLY as written (e.g. "9:30 AM CDT"). Resolve weekdays/relative dates to YYYY-MM-DD using the email Date header.
   - ALSO output interview_datetime as a full ISO-8601 timestamp WITH the timezone offset for the meeting start (e.g. "2026-06-15T09:30:00-05:00" for 9:30am CDT). This is required whenever a specific time is known.
   - Company comes from the organizer's email domain (ashleyobrien@google.com → Google).
   - CORRELATE BY PERSON: if the invite's organizer/attendee name matches a recruiter discussing a SPECIFIC role in another email (e.g. Ashley Ciaburri about "Threat Investigations Manager"), this meeting belongs to THAT application — output ONE record using that company + role, with the meeting's date/time. Do NOT create a separate "(role not specified)" / "Meeting with [name]" record when it can be linked this way.

Return ONLY a raw JSON array, no markdown, no prose:
[{"id":"company_role_slug","company":"Company Name","role":"Exact Role Title","status":"applied|screening|interview|offer|rejected","applied_date":"YYYY-MM-DD or null","screening_date":"YYYY-MM-DD or null","interview_date":"YYYY-MM-DD or null","interview_time":"e.g. 7:30 AM PST or null","interview_datetime":"ISO-8601 with offset e.g. 2026-06-15T09:30:00-05:00, or null","offer_date":"YYYY-MM-DD or null","updated_date":"YYYY-MM-DD","notes":"one sentence"}]

Today is ${today}. Dates come from the email Date header. Use null for unknown dates.`;

    // Process in batches of 8 so the AI response never exceeds token limits
    const BATCH = 8;
    const allEmails = isElectron ? fetchedMsgs : emailData.split('\n\n');
    const found = [];
    const seenKey = new Set();

    for (let i = 0; i < (isElectron ? fetchedMsgs.length : 1); i += BATCH) {
      const batch = isElectron
        ? fetchedMsgs.slice(i, i + BATCH).map((m, j) =>
            `[Email ${i + j + 1}]\nSubject: ${m.subject}\nFrom: ${m.from}\nDate: ${m.date}\nPreview: ${m.snippet}`)
          .join('\n\n')
        : emailData;  // demo mode: send all at once

      txt.textContent = `Parsing emails ${i + 1}–${Math.min(i + BATCH, fetchedMsgs.length)} of ${fetchedMsgs.length}...`;

      let parsed = '';
      try {
        // 1200 tokens is enough for 8 emails (≈150 tokens per record)
        parsed = await callAI(sysprompt, `Extract all job applications from these emails:\n\n${batch}`, 1200);
        console.log(`[scan] batch ${i / BATCH + 1} response:`, parsed);
      } catch (e) {
        console.error(`[scan] batch ${i / BATCH + 1} AI call failed:`, e.message);
        continue;
      }

      let batchFound = [];
      try {
        batchFound = JSON.parse(parsed.replace(/```json|```/g, '').trim());
        if (!Array.isArray(batchFound)) batchFound = [];
      } catch (e) {
        console.error(`[scan] batch ${i / BATCH + 1} JSON parse failed:`, e.message, '\nRaw:', parsed);
        continue;
      }

      for (const f of batchFound) {
        const key = (f.company + '|' + f.role).toLowerCase();
        const existIdx = found.findIndex(e => (e.company + '|' + e.role).toLowerCase() === key);
        if (existIdx === -1) {
          found.push(f);
        } else {
          // Same role seen in another batch — merge without erasing captured dates
          found[existIdx] = mergeScanFields(found[existIdx], f);
        }
      }

      if (!isElectron) break;  // demo mode only has one pass
    }

    let added = 0;
    for (const f of found) {
      if (!f.id) f.id = (f.company + '_' + f.role).toLowerCase().replace(/\s+/g, '_');
      // Normalize the AI's offset timestamp (e.g. 2026-06-15T09:30:00-05:00) to UTC
      if (f.interview_datetime) {
        const dt = new Date(f.interview_datetime);
        f.interview_datetime = isNaN(dt) ? null : dt.toISOString();
      }
      const existing = state.apps.find(a => a.id === f.id || (a.company === f.company && a.role === f.role));
      if (!existing) {
        const app = { ...f, skills: [] };
        state.apps.unshift(app);
        await DB.saveApp(app);
        added++;
      } else {
        const updated = { ...mergeScanFields(existing, f), skills: existing.skills || [] };
        const idx = state.apps.findIndex(a => a.id === existing.id);
        if (idx >= 0) state.apps[idx] = updated;
        await DB.saveApp(updated);
      }
    }

    if (isElectron) await DB.setPref('lastScanTime', new Date().toISOString());

    const rawNote = rawCount > 0 ? ` (from ${rawCount} emails)` : '';
    if (found.length === 0 && rawCount > 0) {
      // Show the actual subjects so user can verify Gmail is returning the right emails
      const subjectPreview = fetchedMsgs.slice(0, 4).map(m => `"${m.subject}"`).join(', ');
      txt.textContent = `Fetched ${rawCount} emails but AI extracted 0 applications.` +
        (subjectPreview ? ` Subjects: ${subjectPreview}` : '');
    } else {
      txt.textContent = `Found ${found.length} application${found.length !== 1 ? 's' : ''}${rawNote} · ${added} new · ${found.length - added} updated`;
    }
  } catch (e) {
    console.error(e);
    if (e.message === 'api-401') {
      txt.textContent = 'API key invalid — go to Settings → Update key';
    } else {
      txt.textContent = 'Scan failed: ' + e.message;
    }
  }

  dot.className = 'sdot dot-ok';
  sp.classList.remove('on');
  renderPipeline();
  updateWeekStats();
  renderReminders();
  renderLastScan();

  // Auto-rank skills across all known applications after every scan
  if (state.apps.length > 0 && isElectron) {
    batchExtractSkills(state.apps, txt, dot, sp);  // async, scan bar shows progress
  }
}

async function batchExtractSkills(apps, txt, dot, sp) {
  dot.className = 'sdot dot-busy';
  sp.classList.add('on');

  const now = Date.now();

  // ── Incremental vs full ────────────────────────────────────────────────────
  // First time (no prior skill scan / no skills yet): rank across everything.
  // After that: only analyze applications added or updated since the last skill
  // review, then merge — preserving prepared flags and manual ordering.
  const lastSkillScan = isElectron ? await DB.getPref('lastSkillScanTime') : null;
  const isIncremental = !!lastSkillScan && state.skills.length > 0;

  let targetApps = apps;
  if (isIncremental) {
    // 1-day overlap so same-day additions (whose dates are midnight-only) aren't missed.
    // Re-analyzing a few already-seen apps is harmless — the merge unions roles idempotently.
    const cutoffDate = new Date(lastSkillScan); cutoffDate.setDate(cutoffDate.getDate() - 1);
    const cutoff = cutoffDate.getTime();
    targetApps = apps.filter(a => {
      const d = new Date(a.updated_date || a.applied_date || a.appliedDate || 0).getTime();
      return d >= cutoff;
    });
    if (!targetApps.length) {
      txt.textContent = '✓ Skill list up to date — no new applications since last review';
      await DB.setPref('lastSkillScanTime', new Date().toISOString());
      dot.className = 'sdot dot-ok'; sp.classList.remove('on');
      populateSkillsAppSelect();
      return;
    }
  }

  // ── 1. Sort by recency — most recent applications are highest priority ─────
  const sorted = [...targetApps].sort((a, b) => {
    const da = new Date(a.applied_date || a.appliedDate || 0).getTime();
    const db = new Date(b.applied_date || b.appliedDate || 0).getTime();
    return db - da;
  });

  // ── 2. Company repetition count ────────────────────────────────────────────
  const companyCount = {};
  apps.forEach(a => { companyCount[a.company] = (companyCount[a.company] || 0) + 1; });

  // ── 3. Title similarity cluster — most common significant words ────────────
  const stopWords = new Set(['and','the','for','with','senior','junior','lead','staff','principal','manager','engineer','scientist','analyst','associate','specialist']);
  const titleWords = targetApps.flatMap(a =>
    a.role.toLowerCase().split(/[\s,\-\/]+/).filter(w => w.length > 3 && !stopWords.has(w))
  );
  const wordFreq = {};
  titleWords.forEach(w => { wordFreq[w] = (wordFreq[w] || 0) + 1; });
  const topTitleWords = Object.entries(wordFreq)
    .sort((a, b) => b[1] - a[1]).slice(0, 6).map(([w]) => w);

  const limit = Math.min(sorted.length, 12);
  // Exact role titles the AI is allowed to assign skills to (for a real freq count)
  const analyzedRoles = sorted.slice(0, limit).map(a => a.role);
  const roleCanon = new Map(analyzedRoles.map(r => [r.toLowerCase().trim(), r]));
  txt.textContent = `Fetching job descriptions (0/${limit})…`;

  // ── 4. Fetch JDs sequentially; annotate each with priority signals ─────────
  const jdParts = [];
  for (let i = 0; i < limit; i++) {
    const app = sorted[i];
    const daysAgo = Math.round((now - new Date(app.applied_date || app.appliedDate || 0).getTime()) / 86400000);
    const recency = daysAgo <= 14 ? '🔴 very recent (last 2 wks)' : daysAgo <= 45 ? '🟡 recent (last 6 wks)' : '⚪ older';
    const repeatNote = companyCount[app.company] > 1 ? `, applied ${companyCount[app.company]}× to this company` : '';

    txt.textContent = `Fetching JD ${i + 1}/${limit}: ${app.company}…`;
    let content = '';
    try {
      const r = await window.electronAPI.web.fetchJD(app.company, app.role);
      content = r.text && r.text.length > 100 ? r.text.slice(0, 2000) : '';
    } catch (_) {}

    jdParts.push(
      `=== ROLE TITLE: "${app.role}" | [${recency}${repeatNote}] ${app.company} ===\n` +
      (content || '(no job description found — infer from role title)')
    );
  }

  // ── 5. Single AI call with full weighting context ─────────────────────────
  txt.textContent = isIncremental
    ? `Reviewing ${limit} new application${limit !== 1 ? 's' : ''} for skills…`
    : 'Ranking skills for interview prep…';
  const titleCluster = topTitleWords.length
    ? `The candidate most frequently applies for roles involving: ${topTitleWords.join(', ')}.`
    : '';

  try {
    const raw = await callAI(
      `You are a career coach extracting interview-prep skills from job postings.

Context about this candidate's job search:
- ${titleCluster || 'Roles vary across the applications.'}
- Company repetition signals high interest — weight those skills higher.
- Recency signals: 🔴 very recent = highest priority, 🟡 recent = high priority, ⚪ older = lower priority.

For each skill, list the EXACT role titles (copied verbatim from the "ROLE TITLE:" labels) that genuinely require it. Only use role titles that appear in the input — never invent one.

Rank skills from most to least important for interviews (weight by how many roles need it, recency, and company repetition).

Return ONLY a valid JSON array, no markdown, max 15 skills:
[{"name":"Skill Name","tip":"one concrete interview tip for this skill","roles":["Exact Role Title", "Another Exact Role Title"]}]`,
      `Analyze these ${jdParts.length} job postings:\n\n${jdParts.join('\n\n')}`,
      1800
    );

    let extracted = [];
    try {
      extracted = JSON.parse(raw.replace(/```json|```/g, '').trim());
      if (!Array.isArray(extracted)) extracted = [];
    } catch (_) {}

    // Map AI-returned roles back to canonical titles; drop anything not analyzed
    const cleanRoles = (arr) => {
      const out = [];
      (Array.isArray(arr) ? arr : []).forEach(r => {
        const canon = roleCanon.get(String(r).toLowerCase().trim());
        if (canon && !out.includes(canon)) out.push(canon);
      });
      return out;
    };

    extracted = extracted.filter(sk => sk && sk.name).map(sk => {
      let roles = cleanRoles(sk.roles);
      if (!roles.length) roles = [analyzedRoles[0]].filter(Boolean); // fallback: at least the top role
      return { name: sk.name, tip: sk.tip || '', roles };
    });

    if (extracted.length) {
      if (isIncremental) {
        // Merge into the existing list: union roles, refresh tips, keep order/prepared
        for (const sk of extracted) {
          const existing = state.skills.find(s => s.name.toLowerCase() === sk.name.toLowerCase());
          if (existing) {
            existing.roles = [...new Set([...existing.roles, ...sk.roles])];
            if (sk.tip) existing.tip = sk.tip;
            await DB.saveSkill(existing);
          } else {
            const skill = { name: sk.name, tip: sk.tip, roles: sk.roles, prepared: false, sort_order: state.skills.length };
            state.skills.push(skill);
            await DB.saveSkill(skill);
          }
        }
        txt.textContent = `✓ Skills reviewed — merged ${extracted.length} from ${limit} new application${limit !== 1 ? 's' : ''}`;
      } else {
        // First full ranking — replace the list entirely
        state.skills = [];
        await Promise.all(extracted.map(async (sk, idx) => {
          const skill = { name: sk.name, tip: sk.tip, roles: sk.roles, prepared: false, sort_order: idx };
          state.skills.push(skill);
          await DB.saveSkill(skill);
        }));
        txt.textContent = `✓ ${extracted.length} skills ranked by interview importance across ${jdParts.length} applications`;
      }
      if (isElectron) await DB.setPref('lastSkillScanTime', new Date().toISOString());
      renderSkills();
    } else {
      txt.textContent = 'Scan complete — skill extraction returned empty (try Skills tab manually)';
    }
  } catch (e) {
    txt.textContent = 'Scan complete — skill ranking failed: ' + e.message;
  }

  dot.className = 'sdot dot-ok';
  sp.classList.remove('on');
  populateSkillsAppSelect();
}

// ─── PIPELINE RENDER ──────────────────────────────────────────────────────────
async function setSortBy(val) {
  state.sortBy = val;
  await DB.setPref('sortBy', val);
  renderPipeline();
}

function renderPipeline() {
  const list = $('company-list');
  const sortSel = $('sort-select');
  if (sortSel && sortSel.value !== state.sortBy) sortSel.value = state.sortBy;
  const groups = groupByCompany(state.apps, state.sortBy);
  if (!groups.length) { list.innerHTML = '<div class="empty">No applications yet — click "Scan Gmail" or add manually</div>'; return; }

  const ago = weekAgo();
  list.innerHTML = '';

  groups.forEach(g => {
    const div = document.createElement('div');
    div.className = 'company-group';
    const hasInterview = g.roles.some(r => r.interview_date || r.interviewDate);
    const isNew = g.roles.some(r => new Date(r.applied_date || r.appliedDate) >= ago);
    const statuses = [...new Set(g.roles.map(r => r.status))];

    div.innerHTML = `
      <div class="company-header" onclick="toggleCompany(this)">
        <div>
          <div class="co-name">${g.company}${isNew ? ' <span class="badge b-new">New</span>' : ''}</div>
          <div class="co-meta">${g.roles.length} role${g.roles.length !== 1 ? 's' : ''} · ${statuses.map(s => bHtml(s)).join(' ')}</div>
        </div>
        <div class="co-right">
          ${hasInterview ? '<span class="badge b-int">&#128197; Interview</span>' : ''}
          <span class="chevron">&#9662;</span>
        </div>
      </div>
      <div class="role-list" style="display:none;">
        ${g.roles.map(r => {
          const idate = r.interview_date || r.interviewDate;
          const sdate = r.screening_date || r.screeningDate;
          const adate = r.applied_date || r.appliedDate;
          const isRej = r.status === 'rejected';
          const isSel = state.selRoleId === r.id;
          return `<div class="role-row${isSel ? ' sel' : ''}${isRej ? ' rej' : ''}" onclick="selectRole('${r.id}')">
            <div>
              <div class="role-name">${r.role}</div>
              <div class="role-meta">
                <span>Applied ${adate || '—'}</span>
                ${sdate ? `<span>&#128222; Screening ${sdate}</span>` : ''}
                ${idate ? `<span>&#128197; Interview ${idate}</span>` : ''}
              </div>
            </div>
            ${bHtml(r.status)}
          </div>`;
        }).join('')}
      </div>`;
    list.appendChild(div);
  });
}

function toggleCompany(header) {
  const rl = header.nextElementSibling;
  const ch = header.querySelector('.chevron');
  const open = rl.style.display !== 'none';
  rl.style.display = open ? 'none' : 'block';
  ch.classList.toggle('open', !open);
}

// ─── EDIT / DELETE an application ─────────────────────────────────────────────
function openEdit() {
  const app = state.apps.find(a => a.id === state.selRoleId);
  if (!app) return;
  $('e-co').value = app.company || '';
  $('e-role').value = app.role || '';
  $('e-status').value = app.status || 'applied';
  $('e-applied').value = app.applied_date || app.appliedDate || '';
  $('e-screening').value = app.screening_date || app.screeningDate || '';
  $('e-interview').value = app.interview_date || app.interviewDate || '';
  $('e-final').value = app.final_date || app.finalDate || '';
  // Derive local HH:MM from the stored UTC instant
  let t = '';
  if (app.interview_datetime) {
    const d = new Date(app.interview_datetime);
    if (!isNaN(d)) t = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  $('e-time').value = t;
  $('edit-form').style.display = 'block';
}

function cancelEdit() { $('edit-form').style.display = 'none'; }

async function saveEdit() {
  const app = state.apps.find(a => a.id === state.selRoleId);
  if (!app) return;
  const co = $('e-co').value.trim(), role = $('e-role').value.trim();
  if (!co || !role) { alert('Company and role are required.'); return; }

  app.company = co;
  app.role = role;
  app.status = $('e-status').value;
  app.applied_date = $('e-applied').value || null;
  app.screening_date = $('e-screening').value || null;
  app.interview_date = $('e-interview').value || null;
  app.final_date = $('e-final').value || null;

  // Pair the time with the soonest set event date (interview → screening → final)
  const eventDate = app.interview_date || app.screening_date || app.final_date;
  const time = $('e-time').value || '';
  if (eventDate && time) {
    const d = new Date(`${eventDate}T${time}`);  // local time
    app.interview_datetime = isNaN(d) ? null : d.toISOString();
    app.interview_time = isNaN(d) ? null : d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
  } else {
    app.interview_datetime = null;
    app.interview_time = null;
  }
  app.updated_date = new Date().toISOString().split('T')[0];

  await DB.saveApp(app);
  $('edit-form').style.display = 'none';
  renderPipeline(); updateWeekStats(); renderReminders();
  selectRole(app.id);  // refresh the detail/timeline with new values
}

async function deleteApplication() {
  const app = state.apps.find(a => a.id === state.selRoleId);
  if (!app) return;
  if (!confirm(`Delete "${app.company} — ${app.role}"?\n\nThis removes it from your pipeline permanently.`)) return;
  await DB.deleteApp(app.id);
  state.apps = state.apps.filter(a => a.id !== app.id);
  state.selRoleId = null;
  $('detail-panel').style.display = 'none';
  renderPipeline(); updateWeekStats(); renderReminders();
}

function selectRole(id) {
  state.selRoleId = id;
  const app = state.apps.find(a => a.id === id);
  if (!app) return;
  renderPipeline();

  const panel = $('detail-panel');
  panel.style.display = 'block';
  $('detail-heading').textContent = app.company + ' · ' + app.role;
  const ef = $('edit-form'); if (ef) ef.style.display = 'none';  // collapse stale edit form

  // Clear and wire up JD paste hint
  const jdEl = $('jd-paste');
  if (jdEl) {
    jdEl.value = '';
    const hint = $('jd-hint');
    jdEl.oninput = () => {
      if (!hint) return;
      const len = jdEl.value.trim().length;
      hint.textContent = len > 50
        ? `&#10003; JD ready (${len} chars) — extraction will be accurate`
        : 'Paste a JD above for accurate results';
      hint.style.color = len > 50 ? 'var(--green-dark)' : 'var(--text3)';
    };
  }

  const isRej = app.status === 'rejected';
  const idate = app.interview_date || app.interviewDate;
  const sdate = app.screening_date || app.screeningDate;
  const adate = app.applied_date || app.appliedDate;
  const odate = app.offer_date || app.offerDate;

  const evts = [
    { label: 'Application submitted', date: adate, done: true },
    { label: 'Recruiter / Screening', date: sdate, done: !!sdate, active: !sdate && !isRej, type: 'warn' },
    { label: 'Technical interview', date: idate, done: !!idate, active: !!sdate && !idate && !isRej },
    { label: 'Final round', date: app.final_date, done: !!app.final_date },
    { label: isRej ? 'Rejected' : 'Offer received', date: odate, done: app.status === 'offer', danger: isRej },
  ];

  $('timeline').innerHTML = evts.map(e => `
    <div class="tl-item">
      <div class="tl-dot ${e.done ? 'done' : e.danger ? 'danger' : e.active ? (e.type || 'active') : ''}"></div>
      <div>
        <div class="tl-text">${e.label}</div>
        <div class="tl-date">${e.date || 'Pending'}</div>
      </div>
    </div>`).join('');
}

// ─── DAILY QUOTE ──────────────────────────────────────────────────────────────
const DAILY_QUOTES = [
  // Job search encouragement
  { q: "Every 'no' you receive is clearing the path to a better 'yes'.", attr: '', tag: '✦ Job search' },
  { q: "The job you want is also looking for you.", attr: '', tag: '✦ Job search' },
  { q: "Rejection is redirection. Every door that closes is steering you somewhere better.", attr: '', tag: '✦ Job search' },
  { q: "Your experience is one-of-a-kind. No one else has your exact combination of skills, story, and perspective.", attr: '', tag: '✦ Job search' },
  { q: "An interview is a two-way street. You're evaluating them just as much as they're evaluating you.", attr: '', tag: '✦ Job search' },
  { q: "Networking isn't about collecting contacts — it's about planting seeds.", attr: '', tag: '✦ Job search' },
  { q: "Keep sending. Keep showing up. The right team is looking for exactly what you bring.", attr: '', tag: '✦ Job search' },
  { q: "Skills can be taught. Drive and curiosity are rarer. You have all three.", attr: '', tag: '✦ Job search' },
  { q: "Every application is momentum. You're further along than you were yesterday.", attr: '', tag: '✦ Job search' },
  { q: "The best cover letter sounds like you — not like a template.", attr: '', tag: '✦ Job search' },
  // Career wisdom
  { q: "The secret of getting ahead is getting started.", attr: 'Mark Twain', tag: '☕ Career' },
  { q: "In the middle of every difficulty lies opportunity.", attr: 'Albert Einstein', tag: '☕ Career' },
  { q: "Opportunities don't happen. You create them.", attr: 'Chris Grosser', tag: '☕ Career' },
  { q: "It always seems impossible until it's done.", attr: 'Nelson Mandela', tag: '☕ Career' },
  { q: "Success is not final, failure is not fatal: it is the courage to continue that counts.", attr: 'Winston Churchill', tag: '☕ Career' },
  { q: "The only way to do great work is to love what you do.", attr: 'Steve Jobs', tag: '☕ Career' },
  { q: "You miss 100% of the shots you don't take.", attr: 'Wayne Gretzky', tag: '☕ Career' },
  { q: "Start where you are. Use what you have. Do what you can.", attr: 'Arthur Ashe', tag: '☕ Career' },
  { q: "Don't watch the clock; do what it does. Keep going.", attr: 'Sam Levenson', tag: '☕ Career' },
  { q: "Hard work beats talent when talent doesn't work hard.", attr: 'Tim Notke', tag: '☕ Career' },
  { q: "Act as if what you do makes a difference. It does.", attr: 'William James', tag: '☕ Career' },
  { q: "I find that the harder I work, the more luck I seem to have.", attr: 'Thomas Jefferson', tag: '☕ Career' },
  { q: "Whatever you are, be a good one.", attr: 'Abraham Lincoln', tag: '☕ Career' },
  { q: "Energy and persistence conquer all things.", attr: 'Benjamin Franklin', tag: '☕ Career' },
  // Food for thought
  { q: "The measure of intelligence is the ability to change.", attr: 'Albert Einstein', tag: '🍵 Food for thought' },
  { q: "Not all those who wander are lost.", attr: 'J.R.R. Tolkien', tag: '🍵 Food for thought' },
  { q: "What lies behind us and what lies before us are tiny matters compared to what lies within us.", attr: 'Ralph Waldo Emerson', tag: '🍵 Food for thought' },
  { q: "Life is what happens when you're busy making other plans.", attr: 'John Lennon', tag: '🍵 Food for thought' },
  { q: "The best time to plant a tree was 20 years ago. The second best time is now.", attr: 'Chinese Proverb', tag: '🍵 Food for thought' },
  { q: "You are braver than you believe, stronger than you seem, and smarter than you think.", attr: 'A.A. Milne', tag: '🍵 Food for thought' },
  { q: "It does not matter how slowly you go, as long as you do not stop.", attr: 'Confucius', tag: '🍵 Food for thought' },
  { q: "Two roads diverged in a wood, and I took the one less traveled by, and that has made all the difference.", attr: 'Robert Frost', tag: '🍵 Food for thought' },
  { q: "Believe you can and you're halfway there.", attr: 'Theodore Roosevelt', tag: '🍵 Food for thought' },
  { q: "The future depends on what you do today.", attr: 'Mahatma Gandhi', tag: '🍵 Food for thought' },
  { q: "Every expert was once a beginner who refused to quit.", attr: '', tag: '🍵 Food for thought' },
  { q: "The journey of a thousand miles begins with a single step.", attr: 'Laozi', tag: '🍵 Food for thought' },
  // Random / fun facts
  { q: "The average person changes careers 5–7 times in their lifetime. Reinvention is the norm, not the exception.", attr: '', tag: '🌱 Did you know' },
  { q: "LinkedIn has over 15 million job postings at any given moment. Your role is out there.", attr: '', tag: '🌱 Did you know' },
  { q: "The word 'salary' comes from the Latin 'salarium' — Roman soldiers were sometimes paid in salt.", attr: '', tag: '🌱 Did you know' },
  { q: "Honey never spoils. Archaeologists found 3,000-year-old honey in Egyptian tombs that was still edible.", attr: '', tag: '🌱 Did you know' },
  { q: "Bees can recognize human faces. They're probably rooting for you.", attr: '', tag: '🌱 Did you know' },
  { q: "Octopuses have three hearts. Maybe that's why they're so good at multitasking under pressure.", attr: '', tag: '🌱 Did you know' },
  { q: "Coffee was once banned in several countries. Perseverance prevailed. So will you.", attr: '', tag: '🌱 Did you know' },
  { q: "The average person spends 90,000 hours at work over a lifetime. It's worth finding the right fit.", attr: '', tag: '🌱 Did you know' },
  { q: "Many Fortune 500 CEOs were laid off or fired before their breakthrough. Setbacks are part of the story.", attr: '', tag: '🌱 Did you know' },
  { q: "A day without laughter is a day wasted. Even on the hardest job-search days, find something that makes you smile.", attr: 'Charlie Chaplin', tag: '🌱 Did you know' },
  { q: "Sharks are older than trees. Some problems only look insurmountable because they're unfamiliar.", attr: '', tag: '🌱 Did you know' },
  { q: "The dot over the letter 'i' is called a tittle. Knowing this will win you at least one trivia night.", attr: '', tag: '🌱 Did you know' },
  { q: "A group of flamingos is called a 'flamboyance.' Don't be afraid to be a little flamboyant in your interviews.", attr: '', tag: '🌱 Did you know' },
  { q: "The shortest war in history lasted 38–45 minutes. Some battles end faster than you expect.", attr: '', tag: '🌱 Did you know' },
];

function renderDailyQuote() {
  const card = $('daily-quote-card');
  if (!card) return;
  const dayIndex = Math.floor(Date.now() / 86400000) % DAILY_QUOTES.length;
  const { q, attr, tag } = DAILY_QUOTES[dayIndex];
  $('daily-quote-text').textContent = '“' + q + '”';
  $('daily-quote-attr').textContent = attr ? '— ' + attr : '';
  $('daily-quote-tag').textContent = tag;
}

function relTime(iso) {
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hour${h > 1 ? 's' : ''} ago`;
  const days = Math.floor(h / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return d.toLocaleDateString();
}

async function renderLastScan() {
  const el = $('last-scan-note');
  if (!el) return;
  const iso = await DB.getPref('lastScanTime');
  if (!iso) { el.textContent = 'Never scanned'; el.title = ''; return; }
  const d = new Date(iso);
  el.textContent = `Last scan: ${relTime(iso)}`;
  el.title = `Last scanned ${d.toLocaleString()}`;
}

function updateWeekStats() { renderStats(); }  // alias kept for existing call sites

function renderStats() {
  const cutoff = state.startDate ? new Date(state.startDate) : new Date(0);
  const apps = state.apps.filter(a => {
    const d = new Date(a.applied_date || a.appliedDate || a.updated_date || '');
    return d >= cutoff;
  });

  const total = apps.length;
  const interviews = apps.filter(a => ['interview', 'offer'].includes(a.status)).length;
  const offers = apps.filter(a => a.status === 'offer').length;
  const rejected = apps.filter(a => a.status === 'rejected').length;
  const responded = apps.filter(a => ['screening', 'interview', 'offer', 'rejected'].includes(a.status)).length;
  const rate = total ? Math.round(responded / total * 100) : 0;

  $('st-total').textContent = total;
  $('st-int').textContent = interviews;
  $('st-offer').textContent = offers;
  $('st-rej').textContent = rejected;
  $('st-rate').textContent = rate + '%';

  // Weekly trend — last 8 weeks, clamped to startDate
  const now = new Date();
  const weeks = Array.from({ length: 8 }, (_, i) => {
    const end = new Date(now); end.setDate(end.getDate() - i * 7);
    const start = new Date(end); start.setDate(start.getDate() - 7);
    const label = end.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const count = start < cutoff && end < cutoff ? -1 : apps.filter(a => {  // -1 = before startDate
      const d = new Date(a.applied_date || a.appliedDate || a.updated_date || '');
      return d >= start && d < end;
    }).length;
    return { label, count };
  }).reverse();

  const maxCount = Math.max(...weeks.map(w => w.count > 0 ? w.count : 0), 1);
  $('trend-chart').innerHTML = weeks.map(w => {
    const before = w.count === -1;
    const pct = before ? 0 : Math.round(w.count / maxCount * 100);
    return `<div class="trend-col${before ? ' trend-before' : ''}">
      <div class="trend-bar-wrap">
        ${before ? '' : `<div class="trend-bar" style="height:${pct}%" title="${w.count} applications"></div>`}
      </div>
      <div class="trend-val">${before ? '' : (w.count || '')}</div>
      <div class="trend-week">${w.label}</div>
    </div>`;
  }).join('');
}

// ─── MANUAL ADD ───────────────────────────────────────────────────────────────
function toggleAdd() { $('add-form').classList.toggle('open'); }

async function addManual() {
  const co = $('f-co').value.trim(), role = $('f-role').value.trim();
  if (!co || !role) return;
  const status = $('f-status').value;
  const dateVal = $('f-intdate').value || null;
  const timeVal = $('f-inttime').value || '';  // "HH:MM" in the user's local timezone

  // Build an absolute instant from the local date + time when both are given
  let interview_datetime = null, interview_time = null;
  if (dateVal && timeVal) {
    const d = new Date(`${dateVal}T${timeVal}`);  // interpreted as local time
    if (!isNaN(d)) {
      interview_datetime = d.toISOString();
      interview_time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
    }
  }
  // A screening status puts the date on screening_date; otherwise interview_date
  const dateField = status === 'screening' ? 'screening_date' : 'interview_date';

  const app = {
    id: (co + '_' + role + '_' + Date.now()).toLowerCase().replace(/\s+/g, '_'),
    company: co, role,
    applied_date: $('f-date').value,
    status,
    [dateField]: dateVal,
    interview_time,
    interview_datetime,
    updated_date: new Date().toISOString().split('T')[0],
    skills: [],
  };
  state.apps.unshift(app);
  await DB.saveApp(app);
  updateWeekStats(); renderPipeline(); renderReminders(); toggleAdd();
  ['f-co', 'f-role', 'f-inttime'].forEach(id => $(id).value = '');
}

// ─── SKILL EXTRACTION ─────────────────────────────────────────────────────────
async function extractSkills() {
  if (!state.selRoleId) return;
  const app = state.apps.find(a => a.id === state.selRoleId);
  if (!app) return;
  const sp = $('ex-sp'); sp.classList.add('on');
  $('extract-btn').disabled = true;

  const jdText = ($('jd-paste')?.value || '').trim();
  const hasJD = jdText.length > 50;

  const sysprompt = `You are a career coach. Extract the 7 most important required skills from the information below. Rank by importance. Return ONLY a valid JSON array, no markdown:
[{"name":"skill name","tip":"one concrete prep tip specific to this role","roles":["${app.role}"]}]`;

  const userprompt = hasJD
    ? `Role: ${app.role} at ${app.company}\n\nJob description:\n${jdText.slice(0, 6000)}`
    : `Role: ${app.role} at ${app.company}\n\nNo job description was provided. Based on your training knowledge of what ${app.company} typically requires for ${app.role} positions, suggest the 7 most likely required skills. Be specific to this company and role type, not generic.`;

  try {
    const txt = await callAI(sysprompt, userprompt);

    let extracted = [];
    try { extracted = JSON.parse(txt.replace(/```json|```/g, '').trim()); } catch (e) {}

    if (!extracted.length) throw new Error('Could not parse skills');

    for (const sk of extracted) {
      const existing = state.skills.find(s => s.name === sk.name);
      if (existing) {
        if (!existing.roles.includes(app.role)) existing.roles.push(app.role);
        await DB.saveSkill(existing);
      } else {
        const newSkill = { name: sk.name, tip: sk.tip, roles: [app.role], prepared: false, sort_order: state.skills.length };
        state.skills.push(newSkill);
        await DB.saveSkill(newSkill);
      }
    }

    app.skills = extracted.map(s => s.name);
    await DB.saveApp(app);

  } catch (e) {
    if (e.message === 'api-401') {
      sp.classList.remove('on'); $('extract-btn').disabled = false;
      alert('API key invalid — go to Settings → Update key');
      return;
    }
    // Fallback demo skills
    const demo = [
      { name: 'Machine learning', tip: 'Focus on model evaluation, drift detection, and production deployment gaps.' },
      { name: 'Python', tip: 'Practice ML-specific patterns: data pipelines, feature engineering, model wrappers.' },
      { name: 'SQL', tip: 'Master window functions, CTEs, and query optimization for large datasets.' },
      { name: 'Statistics', tip: 'A/B testing design, causal inference, and hypothesis testing fundamentals.' },
      { name: 'System design', tip: 'Study ML system design patterns — real-time scoring, feature stores, monitoring.' },
      { name: 'Fraud detection', tip: 'Graph-based models, sequence models, and imbalanced classification techniques.' },
      { name: 'XGBoost', tip: 'Hyperparameter tuning, SHAP values, and calibration for production models.' },
    ];
    for (const sk of demo) {
      const existing = state.skills.find(s => s.name === sk.name);
      if (existing) {
        if (!existing.roles.includes(app.role)) existing.roles.push(app.role);
        await DB.saveSkill(existing);
      } else {
        const ns = { ...sk, roles: [app.role], prepared: false, sort_order: state.skills.length };
        state.skills.push(ns);
        await DB.saveSkill(ns);
      }
    }
    app.skills = demo.map(s => s.name);
    await DB.saveApp(app);
  }

  state.skills.sort((a, b) => b.roles.length - a.roles.length);
  sp.classList.remove('on'); $('extract-btn').disabled = false;
  showTab('skills');
}

// ─── SKILLS RENDER ────────────────────────────────────────────────────────────
function populateSkillsAppSelect() {
  const sel = $('skills-app-select');
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = '<option value="">— choose an application —</option>' +
    state.apps.map(a =>
      `<option value="${a.id}">${a.company} — ${a.role}</option>`
    ).join('');
  if (prev) sel.value = prev;
}

async function extractSkillsFromTab() {
  const sel = $('skills-app-select');
  const appId = sel?.value;
  if (!appId) { alert('Please select an application first.'); return; }

  const app = state.apps.find(a => a.id === appId);
  if (!app) return;

  const btn = $('skills-extract-btn'), sp = $('skills-ex-sp'), status = $('skills-extract-status');
  btn.disabled = true;
  sp.classList.add('on');

  // Use manually pasted JD if provided; otherwise auto-search online
  let jdText = ($('skills-jd')?.value || '').trim();
  let jdSource = 'pasted';

  if (jdText.length < 50 && isElectron) {
    status.textContent = `Searching for "${app.role}" at ${app.company} online…`;
    try {
      const result = await window.electronAPI.web.fetchJD(app.company, app.role);
      if (result.text && result.text.length > 100) {
        jdText = result.text;
        jdSource = 'web';
        status.textContent = 'Job description found — extracting skills…';
      } else {
        jdSource = 'ai-knowledge';
        status.textContent = 'No posting found online — using AI knowledge of this role…';
      }
    } catch (e) {
      jdSource = 'ai-knowledge';
      status.textContent = 'Search unavailable — using AI knowledge…';
    }
  } else if (jdText.length >= 50) {
    status.textContent = 'Using your pasted job description — extracting skills…';
  }

  const sysprompt = `You are a career coach. Extract the 7 most important required skills from the information below. Rank by importance. Return ONLY a valid JSON array, no markdown:
[{"name":"Skill Name","tip":"one sentence on how to demonstrate this skill in an interview"}]`;

  const userprompt = jdSource === 'ai-knowledge'
    ? `Role: ${app.role} at ${app.company}\n\nNo job description available. Based on your training knowledge, list the 7 skills most commonly required for this type of role.`
    : `Role: ${app.role} at ${app.company}\n\n${jdSource === 'web' ? 'Web search results for this job posting' : 'Job description'}:\n${jdText.slice(0, 7000)}`;

  try {
    const raw = await callAI(sysprompt, userprompt, 800);
    let extracted = [];
    try { extracted = JSON.parse(raw.replace(/```json|```/g, '').trim()); } catch (e) {}
    if (!extracted.length) throw new Error('AI returned no skills — try again');

    for (const sk of extracted) {
      if (!sk.name) continue;
      const existing = state.skills.find(s => s.name === sk.name);
      const roles = existing ? [...new Set([...existing.roles, app.role])] : [app.role];
      const updated = { name: sk.name, tip: sk.tip || '', roles, prepared: existing?.prepared || false, sort_order: existing?.sort_order ?? state.skills.length };
      if (!existing) state.skills.push(updated);
      else Object.assign(existing, updated);
      await DB.saveSkill(updated);
    }
    app.skills = extracted.map(s => s.name);
    await DB.saveApp(app);

    const sourceNote = jdSource === 'web' ? ' (from job posting)' : jdSource === 'pasted' ? ' (from your JD)' : ' (AI estimate)';
    status.textContent = `✓ ${extracted.length} skills extracted for ${app.company}${sourceNote}`;
    renderSkills();
  } catch (e) {
    status.textContent = '✗ ' + e.message;
  }
  sp.classList.remove('on');
  btn.disabled = false;
}

async function setSkillSort(val) {
  state.skillSort = val;
  await DB.setPref('skillSort', val);
  renderSkills();
}

const RES_ICON = { yt: { c: 'ri-yt', i: '&#9654;' }, med: { c: 'ri-med', i: '&#9998;' }, hf: { c: 'ri-hf', i: '&#11041;' }, gh: { c: 'ri-gh', i: '&#8997;' } };

function renderSkills() {
  const list = $('skill-list');
  if (!list) return;

  const sortSel = $('skill-sort-select');
  if (sortSel && sortSel.value !== state.skillSort) sortSel.value = state.skillSort;

  if (!state.skills.length) {
    list.innerHTML = '<div class="empty">No skills yet — pick an application above and click "Extract skills"</div>';
    return;
  }

  // Default: importance — most-required skills first. Manual: user's drag order.
  const manual = state.skillSort === 'manual';
  if (manual) state.skills.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  else state.skills.sort((a, b) => (b.roles.length - a.roles.length) || a.name.localeCompare(b.name));

  list.innerHTML = '';
  state.skills.forEach((sk, i) => {
    const div = document.createElement('div');
    div.className = 'skill-item' + (sk.prepared ? ' prepared' : '');
    div.draggable = manual;
    div.dataset.idx = i;

    const freq = sk.roles.length;
    const freqClass = freq >= 4 ? 'high' : freq >= 2 ? 'mid' : '';

    const resCards = resourcesForSkill(sk.name).map(r => {
      const i2 = RES_ICON[r.t] || RES_ICON.med;
      const url = linkFor(r, sk.name).replace(/'/g, "\\'");
      return `<div class="res-card" onclick="openLink('${url}')" title="Open in browser">
        <div class="ri ${i2.c}">${i2.i}</div>
        <div class="res-body"><div class="res-t">${r.title}</div><div class="res-m">${r.meta}</div></div>
        <span class="tag">${r.tag}</span>
      </div>`;
    }).join('');

    div.innerHTML = `
      <div class="skill-row">
        ${manual ? '<span class="drag-handle" title="Drag to reorder">&#10783;</span>' : ''}
        <div class="freq-circle ${freqClass}" title="Required by ${freq} role(s)">${freq}</div>
        <div class="skill-body">
          <div class="skill-name">${sk.name}${sk.prepared ? ' <span style="font-size:11px;color:#1a6b30;font-weight:500;">&#10003; Ready</span>' : ''}</div>
          <div class="skill-roles">${sk.roles.slice(0, 3).join(' · ')}${sk.roles.length > 3 ? ` +${sk.roles.length - 3}` : ''}</div>
          <div class="skill-tip">${sk.tip || ''}</div>
          <button class="res-toggle" onclick="toggleSkillRes(${i}, this)">&#128218; Prep resources <span class="res-chevron">&#9662;</span></button>
        </div>
        <button class="check-btn ${sk.prepared ? 'done' : ''}" onclick="togglePrepared(${i})" title="${sk.prepared ? 'Mark unprepared' : 'Mark prepared'}">
          ${sk.prepared ? '&#10003;' : '&#9675;'}
        </button>
      </div>
      <div class="skill-res" id="skill-res-${i}" style="display:none;">${resCards}</div>`;

    if (manual) {
      div.addEventListener('dragstart', e => { state.dragSrc = i; div.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });
      div.addEventListener('dragend', () => div.classList.remove('dragging'));
      div.addEventListener('dragover', e => { e.preventDefault(); div.classList.add('drag-over'); });
      div.addEventListener('dragleave', () => div.classList.remove('drag-over'));
      div.addEventListener('drop', async e => {
        e.preventDefault(); div.classList.remove('drag-over');
        if (state.dragSrc === null || state.dragSrc === i) return;
        const moved = state.skills.splice(state.dragSrc, 1)[0];
        state.skills.splice(i, 0, moved);
        state.skills.forEach((s, idx) => s.sort_order = idx);
        state.dragSrc = null;
        await DB.reorderSkills(state.skills.map(s => s.name));
        renderSkills();
      });
    }

    list.appendChild(div);
  });
}

function toggleSkillRes(i, btn) {
  const panel = $('skill-res-' + i);
  if (!panel) return;
  const open = panel.style.display !== 'none';
  panel.style.display = open ? 'none' : 'block';
  const ch = btn.querySelector('.res-chevron');
  if (ch) ch.classList.toggle('open', !open);
}

async function togglePrepared(i) {
  state.skills[i].prepared = !state.skills[i].prepared;
  await DB.saveSkill(state.skills[i]);
  renderSkills();
  renderReminders();
}

// Open a link in the user's default browser (Electron) or a new tab (browser fallback)
function openLink(url) {
  if (!url) return;
  if (isElectron && window.electronAPI.app.openExternal) window.electronAPI.app.openExternal(url);
  else window.open(url, '_blank');
}

// Build a working URL for a resource based on its type, anchored to the skill.
function linkFor(r, skill) {
  if (r.url) return r.url;
  const q = encodeURIComponent(`${skill} ${r.title}`.trim());
  switch (r.t) {
    case 'yt':  return `https://www.youtube.com/results?search_query=${encodeURIComponent(skill + ' interview tutorial')}`;
    case 'gh':  return `https://github.com/search?q=${encodeURIComponent(skill + ' interview')}&type=repositories`;
    case 'hf':  return `https://huggingface.co/search/full-text?q=${encodeURIComponent(skill)}`;
    default:    return `https://www.google.com/search?q=${q}`;
  }
}

// Return tailored resources for a skill — curated where we have them, otherwise
// generated search links so every skill (not just the hardcoded ones) gets help.
function resourcesForSkill(name) {
  if (RESOURCES[name]) return RESOURCES[name];
  const enc = encodeURIComponent(name);
  return [
    { t: 'yt',  title: `${name} — top interview tutorials`, meta: 'YouTube search', tag: 'Video',
      url: `https://www.youtube.com/results?search_query=${encodeURIComponent(name + ' interview preparation')}` },
    { t: 'med', title: `${name} interview questions & answers`, meta: 'Google', tag: 'Q&A',
      url: `https://www.google.com/search?q=${encodeURIComponent(name + ' interview questions and answers')}` },
    { t: 'gh',  title: `${name} — hands-on practice & examples`, meta: 'GitHub', tag: 'Practice',
      url: `https://github.com/search?q=${enc}&type=repositories` },
  ];
}

// ─── RESUME REVIEW ────────────────────────────────────────────────────────────
async function renderResume() {
  const ta = $('resume-text');
  if (ta && !ta.value) {
    const saved = await DB.getPref('resumeText');
    if (saved) ta.value = saved;
  }
  // Re-show the last analysis if we have one cached
  const cached = await DB.getPref('resumeAnalysis');
  if (cached) {
    try { renderResumeResult(typeof cached === 'string' ? JSON.parse(cached) : cached); } catch (_) {}
  }
}

function onResumeInput() {
  const s = $('resume-status');
  if (s) { s.textContent = 'Unsaved changes'; s.style.color = 'var(--text3)'; }
}

async function saveResumeText() {
  const ta = $('resume-text');
  await DB.setPref('resumeText', ta.value);
  const s = $('resume-status');
  if (s) { s.textContent = '✓ Resume saved on this device'; s.style.color = 'var(--green-dark)'; }
}

async function loadResumeFile() {
  if (!isElectron || !window.electronAPI.resume) return;
  const res = await window.electronAPI.resume.openFile();
  if (!res || res.canceled) return;
  if (res.error) { alert(res.error); return; }
  $('resume-text').value = res.text || '';
  await saveResumeText();
  const s = $('resume-status');
  if (s) { s.textContent = `✓ Loaded ${res.name}`; s.style.color = 'var(--green-dark)'; }
}

async function runResumeReview() {
  const resume = ($('resume-text')?.value || '').trim();
  if (resume.length < 80) { alert('Please paste your resume text first (at least a few lines).'); return; }
  await saveResumeText();

  const btn = $('resume-run-btn'), sp = $('resume-sp'), status = $('resume-status');
  btn.disabled = true; sp.classList.add('on');
  status.textContent = 'Analyzing against your applications and skills…'; status.style.color = 'var(--text3)';

  // Build context from the user's pipeline + ranked skills
  const roles = [...new Set(state.apps.map(a => a.role).filter(Boolean))].slice(0, 15);
  const companies = [...new Set(state.apps.map(a => a.company).filter(Boolean))].slice(0, 15);
  const skills = state.skills.map(s => s.name).slice(0, 18);

  const sys = `You are a demanding, objective technical recruiter reviewing a resume against the specific roles the candidate is targeting and the skills they will be interviewed on.

Be OBJECTIVE and CRITICAL — this is the candidate's competitive edge, not a pep talk:
- Do NOT flatter, and do NOT default to encouragement or agreement. Praise only what genuinely stands out.
- Call out real weaknesses plainly: vague or unquantified bullets, missing keywords for the target roles, weak structure, filler, gaps, over-claiming, or poor alignment.
- Score honestly. A weak or poorly-aligned resume should get a low score (it's fine to score below 50). Reserve 80+ for resumes that are genuinely strong for these specific roles.
- Be concrete and specific to THIS resume — quote or paraphrase real lines. No generic advice that could apply to any resume.

Return ONLY a valid JSON object, no markdown:
{
  "score": <integer 0-100 — overall fit for the target roles>,
  "summary": "1-2 sentences on overall alignment with the target roles",
  "strengths": ["specific strength tied to the resume", "..."],
  "gaps": [{"area":"skill or section name","issue":"what's missing/weak vs target roles","fix":"a concrete action"}],
  "bullets": [{"before":"a weak bullet paraphrased from the resume","after":"a stronger, quantified rewrite"}],
  "keywords": ["important keyword from target roles missing or under-emphasized in the resume"]
}
Limit: max 5 strengths, 6 gaps, 4 bullet rewrites, 10 keywords.`;

  const ctx = `TARGET ROLES (applied to): ${roles.join('; ') || 'not specified'}
COMPANIES: ${companies.join(', ') || 'n/a'}
SKILLS THEY WILL BE INTERVIEWED ON (ranked): ${skills.join(', ') || 'n/a'}

RESUME:
${resume.slice(0, 8000)}`;

  try {
    const raw = await callAI(sys, ctx, 2000);
    let data;
    try { data = JSON.parse(raw.replace(/```json|```/g, '').trim()); } catch (_) { data = null; }
    if (!data || typeof data !== 'object') throw new Error('Could not parse the analysis — try again.');
    await DB.setPref('resumeAnalysis', JSON.stringify(data));
    renderResumeResult(data);
    status.textContent = '✓ Analysis complete';
    status.style.color = 'var(--green-dark)';
  } catch (e) {
    if (e.message === 'api-401') { status.textContent = 'API key invalid — go to Settings → Update key'; }
    else { status.textContent = '✗ ' + e.message; }
    status.style.color = 'var(--red, #b91c1c)';
  }
  sp.classList.remove('on'); btn.disabled = false;
}

function renderResumeResult(d) {
  const el = $('resume-result');
  if (!el) return;
  const esc = s => String(s ?? '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const score = Math.max(0, Math.min(100, parseInt(d.score, 10) || 0));
  const scoreClass = score >= 75 ? 'good' : score >= 50 ? 'mid' : 'low';

  const strengths = (d.strengths || []).map(s => `<li>${esc(s)}</li>`).join('');
  const gaps = (d.gaps || []).map(g =>
    `<div class="rr-gap"><div class="rr-gap-area">${esc(g.area || 'Gap')}</div>
      <div class="rr-gap-issue">${esc(g.issue)}</div>
      <div class="rr-gap-fix">&#10148; ${esc(g.fix)}</div></div>`).join('');
  const bullets = (d.bullets || []).map(b =>
    `<div class="rr-bullet"><div class="rr-before"><span class="rr-tag-b">Before</span>${esc(b.before)}</div>
      <div class="rr-after"><span class="rr-tag-a">After</span>${esc(b.after)}</div></div>`).join('');
  const kws = (d.keywords || []).map(k => `<span class="rr-kw">${esc(k)}</span>`).join('');

  el.innerHTML = `
    <div class="card rr-head">
      <div class="rr-score ${scoreClass}">${score}<span>/100</span></div>
      <div class="rr-summary"><div class="rr-summary-label">Overall fit for your target roles</div>${esc(d.summary)}</div>
    </div>
    ${strengths ? `<div class="card"><div class="rr-h">&#9989; Strengths</div><ul class="rr-list">${strengths}</ul></div>` : ''}
    ${gaps ? `<div class="card"><div class="rr-h">&#128269; Gaps vs your target roles</div>${gaps}</div>` : ''}
    ${bullets ? `<div class="card"><div class="rr-h">&#9999;&#65039; Stronger bullet points</div>${bullets}</div>` : ''}
    ${kws ? `<div class="card"><div class="rr-h">&#127919; Keywords to add</div><div class="rr-kws">${kws}</div></div>` : ''}`;
}

// ─── REMINDERS RENDER ─────────────────────────────────────────────────────────
// Find an app's next upcoming scheduled event (screening call, interview, or
// final round) on or after today — whichever comes soonest.
// Parse a YYYY-MM-DD string as LOCAL midnight (not UTC) to avoid off-by-one days.
function parseLocalDate(s) {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return new Date(s);
  return new Date(+m[1], +m[2] - 1, +m[3]);
}

function nextEvent(app) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const candidates = [];
  // A precise timestamp (calendar invite / manual time) is the source of truth.
  if (app.interview_datetime) {
    const d = new Date(app.interview_datetime);
    if (!isNaN(d)) {
      const label = app.status === 'interview' ? 'Interview' : app.status === 'screening' ? 'Screening call' : 'Scheduled';
      candidates.push({ label, date: app.interview_datetime, when: d });
    }
  }
  // Date-only fields (no specific time)
  [['Screening call', app.screening_date || app.screeningDate],
   ['Interview', app.interview_date || app.interviewDate],
   ['Final round', app.final_date || app.finalDate]]
    .forEach(([label, ds]) => { if (ds) candidates.push({ label, date: ds, when: parseLocalDate(ds) }); });

  const upcoming = candidates.filter(e => e.when >= today).sort((a, b) => a.when - b.when);
  return upcoming[0] || null;
}

// Format an event's date/time. If we have an absolute instant (interview_datetime),
// render it in the user's chosen display timezone (or local by default). Otherwise
// fall back to the date plus any free-text time label.
function formatEventWhen(app, evt) {
  const tz = state.displayTimezone || undefined;  // undefined → system local
  if (app.interview_datetime) {
    const dt = new Date(app.interview_datetime);
    if (!isNaN(dt)) {
      try {
        return dt.toLocaleString('en-US', {
          weekday: 'short', month: 'short', day: 'numeric',
          hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
          ...(tz ? { timeZone: tz } : {}),
        });
      } catch (_) {}
    }
  }
  const when = parseLocalDate(evt.date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  return when + (app.interview_time ? ` at ${app.interview_time}` : '');
}

function renderReminders() {
  const list = $('reminder-list');
  if (!list) return;
  populateTimezones();  // fill the reminders-page timezone selector
  const tzNote = $('reminders-tz-note');
  if (tzNote) tzNote.textContent = 'Times shown in ' + (state.displayTimezone || localTimezone() || 'your local timezone') + '.';

  const upcoming = state.apps
    .map(a => ({ app: a, evt: nextEvent(a) }))
    .filter(x => x.evt)
    .sort((a, b) => new Date(a.evt.date) - new Date(b.evt.date));

  if (!upcoming.length) {
    list.innerHTML = '<div class="empty">No upcoming interviews or calls detected.<br>Scan Gmail, or use + Add to enter a company, role, date and time.</div>';
    return;
  }

  list.innerHTML = '';
  upcoming.forEach(({ app, evt }) => {
    const when = formatEventWhen(app, evt);
    const roleSkills = state.skills.filter(s => (app.skills || []).includes(s.name) || s.roles.includes(app.role));
    const div = document.createElement('div');
    div.className = 'reminder-card';
    div.innerHTML = `
      <div style="display:flex;align-items:flex-start;justify-content:space-between;">
        <div>
          <div class="rc-co">${app.company}</div>
          <div class="rc-role">${app.role}</div>
          <div class="rc-date">&#128197; ${evt.label}: ${when} · Reminder the evening before (if enabled in Settings)</div>
        </div>
        <span class="badge b-int">${evt.label}</span>
      </div>
      ${roleSkills.length ? `<div class="rc-skills">${roleSkills.slice(0, 6).map(s => `<span class="badge ${s.prepared ? 'b-off' : 'b-app'}">${s.prepared ? '&#10003; ' : ''}${s.name}</span>`).join('')}</div>` : ''}
      <button class="btn btn-sm" style="margin-top:10px;" onclick="previewReminder(this,'${app.id}')">Preview reminder email</button>
      <div class="reminder-preview" id="prev-${app.id}"></div>`;
    list.appendChild(div);
  });
}

async function previewReminder(btn, id) {
  const app = state.apps.find(a => a.id === id);
  if (!app) return;
  const prev = $('prev-' + id);
  if (prev.style.display === 'block') { prev.style.display = 'none'; btn.textContent = 'Preview reminder email'; return; }
  btn.textContent = 'Generating...'; btn.disabled = true;

  const idate = app.interview_date || app.interviewDate;
  const roleSkills = state.skills.filter(s => s.roles.includes(app.role)).map(s => s.name);

  try {
    const txt = await callAI(
      'You are a warm, encouraging career coach. Write a short interview reminder email. Plain text only, no markdown. Max 150 words. Be personal, warm, and confidence-boosting. Include the specific skills to review.',
      `Write a night-before interview reminder for: ${app.role} at ${app.company} (interview tomorrow, ${idate}).
Skills to highlight: ${roleSkills.slice(0, 5).join(', ') || 'general ML and Python'}.
The candidate has been preparing hard. Make them feel ready and confident.`
    );
    prev.textContent = txt;
  } catch (e) {
    if (e.message === 'api-401') {
      prev.textContent = 'API key invalid — go to Settings → Update key';
      prev.style.display = 'block';
      btn.textContent = 'Hide preview'; btn.disabled = false;
      return;
    }
    prev.textContent = `Subject: Interview tomorrow — ${app.company}\n\nHey!\n\nQuick reminder: your interview for ${app.role} at ${app.company} is tomorrow (${idate}).\n\nTop skills to review tonight:\n${roleSkills.slice(0, 5).map(s => '  · ' + s).join('\n') || '  · Your key projects and problem-solving approach'}\n\nYou've put in the work. Trust your preparation, stay curious, and let your experience speak for itself.\n\nYou've got this!`;
  }

  prev.style.display = 'block';
  btn.textContent = 'Hide preview'; btn.disabled = false;
}

// ─── BOOTSTRAP ────────────────────────────────────────────────────────────────
document.getElementById('app').innerHTML = `
<!-- TITLEBAR -->
<div class="titlebar">
  <div class="titlebar-center">Job Tracker</div>
  <div class="titlebar-right"></div>
</div>

<!-- SCREENS -->
<div style="flex:1;overflow:hidden;display:flex;flex-direction:column;">

<!-- Welcome -->
<div class="screen active" id="s-welcome" style="overflow-y:auto;padding:24px;">
  <div class="ob-container">
    <div class="ob-hero">
      <span class="ob-emoji">&#128188;</span>
      <div class="ob-title">Job Search Tracker</div>
      <div class="ob-sub">Your AI-powered co-pilot for job hunting. Auto-scans Gmail, tracks every application, builds your skill prep list, and sends interview reminders the night before.</div>
    </div>

    <!-- Feature grid -->
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:18px;">
      <div style="background:var(--bg2);border:1px solid var(--border);border-radius:var(--radius);padding:14px 16px;box-shadow:var(--shadow);">
        <div style="font-size:20px;margin-bottom:6px;">&#128211;</div>
        <div style="font-size:12px;font-weight:700;color:var(--text);margin-bottom:3px;">Auto-scan Gmail</div>
        <div style="font-size:11px;color:var(--text2);line-height:1.5;">Reads job emails and builds your pipeline automatically</div>
      </div>
      <div style="background:var(--bg2);border:1px solid var(--border);border-radius:var(--radius);padding:14px 16px;box-shadow:var(--shadow);">
        <div style="font-size:20px;margin-bottom:6px;">&#128200;</div>
        <div style="font-size:12px;font-weight:700;color:var(--text);margin-bottom:3px;">Pipeline tracking</div>
        <div style="font-size:11px;color:var(--text2);line-height:1.5;">Every role, every status, every timeline in one place</div>
      </div>
      <div style="background:var(--bg2);border:1px solid var(--border);border-radius:var(--radius);padding:14px 16px;box-shadow:var(--shadow);">
        <div style="font-size:20px;margin-bottom:6px;">&#129504;</div>
        <div style="font-size:12px;font-weight:700;color:var(--text);margin-bottom:3px;">Skill prep plan</div>
        <div style="font-size:11px;color:var(--text2);line-height:1.5;">AI extracts required skills ranked by how often they appear</div>
      </div>
      <div style="background:var(--bg2);border:1px solid var(--border);border-radius:var(--radius);padding:14px 16px;box-shadow:var(--shadow);">
        <div style="font-size:20px;margin-bottom:6px;">&#128276;</div>
        <div style="font-size:12px;font-weight:700;color:var(--text);margin-bottom:3px;">Interview reminders</div>
        <div style="font-size:11px;color:var(--text2);line-height:1.5;">AI-written night-before reminder with your skill checklist</div>
      </div>
    </div>

    <div class="note note-g" style="margin-bottom:16px;"><span>&#128274;</span><div>Everything stays on your device. Keys live in your OS keychain. Nothing goes through our servers.</div></div>
    <div style="display:flex;flex-direction:column;gap:8px;">
      <button class="btn btn-p btn-full" style="padding:12px 16px;font-size:14px;" onclick="goTo('s-step1')">Get started &#8594; 3 quick steps</button>
      <button class="btn btn-ghost btn-full" onclick="devSkip()">Dev mode — explore with sample data</button>
    </div>
  </div>
</div>

<!-- Step 1: Gmail credentials + connect -->
<div class="screen" id="s-step1" style="overflow-y:auto;padding:24px;">
  <div class="ob-container">
    <div class="step-row"><div class="sp active">1</div><div class="step-line"></div><div class="sp">2</div><div class="step-line"></div><div class="sp">3</div></div>

    <!-- Quick connect (shown when the app ships with built-in credentials) -->
    <div class="card" id="easy-creds" style="display:none;">
      <div class="card-title">&#9889; Quick connect</div>
      <div class="card-sub">No Google Cloud setup needed. Just sign in below to grant read-only access — that's it.</div>
      <button class="btn btn-ghost btn-sm" style="margin-top:6px;font-size:11px;color:var(--text3);" onclick="toggleAdvancedCreds()">Advanced: use my own Google credentials &#9662;</button>
    </div>

    <!-- Manual credentials (hidden in quick-connect mode) -->
    <div id="manual-creds">
    <!-- Part A: Setup guide -->
    <div class="card">
      <div class="card-title">Create your Google OAuth credentials</div>
      <div class="card-sub">Free, ~5 minutes, one time. This is an <strong>OAuth Client</strong> (not a service account) — the only way an app can read your own Gmail.</div>
      <ol style="margin:10px 0 0 18px;display:flex;flex-direction:column;gap:8px;font-size:12px;color:var(--text2);line-height:1.65;">
        <li><strong>Create a project.</strong> Go to <strong>console.cloud.google.com</strong> &#8594; create a new project (any name) &#8594; make sure it's selected in the top dropdown.</li>
        <li><strong>Enable the Gmail API.</strong> Sidebar &#8594; <strong>APIs &amp; Services &#8594; Library</strong> &#8594; search <strong>Gmail API</strong> &#8594; <strong>Enable</strong>.</li>
        <li><strong>Configure the consent screen.</strong> Sidebar &#8594; <strong>OAuth consent screen</strong> &#8594; choose <strong>External</strong> &#8594; fill in App name and your support email &#8594; Save &amp; Continue.</li>
        <li><strong>Add yourself as a Test user (required).</strong> On the consent screen, find <strong>Test users</strong> &#8594; <strong>Add Users</strong> &#8594; enter your own Gmail address. The app stays in &ldquo;Testing&rdquo; mode, so <em>only</em> emails listed here can sign in.</li>
        <li><strong>Create the client.</strong> Sidebar &#8594; <strong>Credentials</strong> &#8594; <strong>+ Create Credentials</strong> &#8594; <strong>OAuth client ID</strong> &#8594; Application type: <strong>Desktop app</strong> &#8594; Create.</li>
        <li><strong>Copy both values.</strong> Your <strong>Client ID</strong> and <strong>Client Secret</strong> appear &#8594; copy them into the fields below.</li>
      </ol>
      <div class="note note-a" style="margin-top:10px;"><span>&#9432;</span><div><strong>Pick &ldquo;Desktop app&rdquo;.</strong> It automatically allows this app's loopback sign-in (<code style="background:var(--bg3);padding:1px 5px;border-radius:4px;font-size:11px;">http://localhost:3742/oauth/callback</code>) — you do <strong>not</strong> need to add a redirect URI. (Avoid &ldquo;Web application&rdquo;.)</div></div>
      <div class="note note-a" style="margin-top:8px;"><span>&#9888;&#65039;</span><div>On first sign-in Google shows an <strong>&ldquo;unverified app&rdquo;</strong> warning (expected — it's your own app). Click <strong>Advanced &#8594; Go to [project] (unsafe)</strong> to continue.</div></div>
    </div>

    <!-- Part B: Credential inputs -->
    <div class="card">
      <div class="card-title">Save your credentials</div>
      <div class="card-sub">Paste the Client ID and Client Secret from the step above. They are saved directly to your OS keychain.</div>
      <div class="fl">Client ID</div>
      <div style="display:flex;gap:8px;margin-bottom:10px;">
        <input class="fi fi-pw" id="google-client-id" placeholder="Paste your Client ID" style="flex:1;">
        <button class="btn btn-sm" onclick="toggleFieldVis('google-client-id')">&#128065;</button>
      </div>
      <div class="fl">Client Secret</div>
      <div style="display:flex;gap:8px;margin-bottom:12px;">
        <input class="fi fi-pw" id="google-client-secret" placeholder="Paste your Client Secret" style="flex:1;">
        <button class="btn btn-sm" onclick="toggleFieldVis('google-client-secret')">&#128065;</button>
      </div>
      <button class="btn btn-p btn-sm" onclick="saveGoogleCredentials()">Save to keychain <div class="spinner" id="cred-sp"></div></button>
      <div id="cred-saved" class="note note-g" style="display:none;margin-top:10px;"><span>&#10003;</span><div>Saved securely to Mac keychain</div></div>
    </div>
    </div><!-- /manual-creds -->

    <!-- Part C: Sign in + start date -->
    <div class="card">
      <div class="card-title">Connect Gmail</div>
      <div class="card-sub">Sign in with Google to grant read-only access. Enabled after credentials are saved above.</div>
      <button class="gmail-btn" id="gmail-btn" onclick="connectGmail()" disabled style="opacity:0.4;cursor:not-allowed;">
        <span style="width:18px;height:18px;border-radius:50%;background:#ea4335;display:inline-flex;align-items:center;justify-content:center;font-size:10px;color:#fff;font-weight:700;flex-shrink:0;">G</span>
        Sign in with Google (read-only)
      </button>
      <div id="gmail-ok" style="display:none;" class="note note-g"><span>&#10003;</span><div>Gmail connected — read-only access granted.</div></div>
      <div class="fl" style="margin-top:12px;">Scan emails from this date forward</div>
      <input class="fi" type="date" id="start-date">
      <div style="font-size:11px;color:var(--text3);margin-top:4px;">Set this to when you started your job search.</div>
    </div>

    <div class="note note-a"><span>&#8505;&#65039;</span><div>We only read emails — we never send, delete, or modify anything in your Gmail.</div></div>
    <div style="display:flex;gap:8px;justify-content:space-between;align-items:center;">
      <button class="btn btn-ghost" style="font-size:12px;color:var(--text3);padding:6px 10px;" onclick="skipGmailSetup()">Skip — I'll add jobs manually</button>
      <div style="display:flex;gap:8px;">
        <button class="btn" onclick="goTo('s-welcome')">Back</button>
        <button class="btn btn-p" id="step1-next" onclick="step1Next()" disabled>Next &#8594;</button>
      </div>
    </div>
  </div>
</div>

<!-- Step 2: AI provider -->
<div class="screen" id="s-step2" style="overflow-y:auto;padding:24px;">
  <div class="ob-container">
    <div class="step-row"><div class="sp done">&#10003;</div><div class="step-line done"></div><div class="sp active">2</div><div class="step-line"></div><div class="sp">3</div></div>
    <div class="card">
      <div class="card-title">Choose your AI provider</div>
      <div class="card-sub">All AI features use your own key — Gmail parsing, skill extraction, and interview reminders. You control the cost and privacy.</div>
      <div class="prov-row">
        <div class="prov-card active" id="prov-claude" onclick="selProv('claude')"><div class="prov-name">Claude</div><div class="prov-sub">Best extraction quality</div><div class="prov-cost">~$0.003/scan</div></div>
        <div class="prov-card" id="prov-openai" onclick="selProv('openai')"><div class="prov-name">GPT-4o</div><div class="prov-sub">Widely trusted</div><div class="prov-cost">~$0.005/scan</div></div>
        <div class="prov-card" id="prov-gemini" onclick="selProv('gemini')"><div class="prov-name">Gemini Flash</div><div class="prov-sub">Fastest &amp; cheapest</div><div class="prov-cost">~$0.0001/scan</div></div>
      </div>

      <!-- Inline guides per provider -->
      <div id="guide-claude" style="margin-bottom:10px;background:var(--blue-bg);border-radius:var(--radius-sm);padding:10px 12px;font-size:12px;color:#004fc4;">
        <div style="font-weight:600;margin-bottom:5px;">How to get your Claude (Anthropic) API key:</div>
        <ol style="margin:0 0 0 16px;display:flex;flex-direction:column;gap:4px;line-height:1.6;">
          <li>Go to <strong>console.anthropic.com</strong> &#8594; sign up or log in</li>
          <li>Left sidebar &#8594; <strong>API Keys</strong> &#8594; <strong>Create Key</strong></li>
          <li>Copy the key — it starts with <code style="background:rgba(0,79,196,.12);padding:1px 4px;border-radius:3px;">sk-ant-</code></li>
        </ol>
        <div style="margin-top:6px;font-size:11px;opacity:.8;">Cost: ~$0.003 per scan &middot; New accounts get $5 free credit</div>
      </div>
      <div id="guide-openai" style="display:none;margin-bottom:10px;background:var(--blue-bg);border-radius:var(--radius-sm);padding:10px 12px;font-size:12px;color:#004fc4;">
        <div style="font-weight:600;margin-bottom:5px;">How to get your OpenAI API key:</div>
        <ol style="margin:0 0 0 16px;display:flex;flex-direction:column;gap:4px;line-height:1.6;">
          <li>Go to <strong>platform.openai.com</strong> &#8594; sign up or log in</li>
          <li>Top-right menu &#8594; <strong>API keys</strong> &#8594; <strong>Create new secret key</strong></li>
          <li>Copy the key — it starts with <code style="background:rgba(0,79,196,.12);padding:1px 4px;border-radius:3px;">sk-</code></li>
        </ol>
        <div style="margin-top:6px;font-size:11px;opacity:.8;">Cost: ~$0.005 per scan &middot; New accounts get $5 free credit</div>
      </div>
      <div id="guide-gemini" style="display:none;margin-bottom:10px;background:var(--blue-bg);border-radius:var(--radius-sm);padding:10px 12px;font-size:12px;color:#004fc4;">
        <div style="font-weight:600;margin-bottom:5px;">How to get your Gemini API key:</div>
        <ol style="margin:0 0 0 16px;display:flex;flex-direction:column;gap:4px;line-height:1.6;">
          <li>Go to <strong>aistudio.google.com</strong> &#8594; sign in with your Google account</li>
          <li>Click <strong>Get API key</strong> &#8594; <strong>Create API key</strong> &#8594; select your project</li>
          <li>Copy the key</li>
        </ol>
        <div style="margin-top:6px;font-size:11px;opacity:.8;">Cost: Free tier (60 req/min) &#8594; cheapest option overall</div>
      </div>

      <div class="fl">Your <span id="prov-label">Anthropic</span> API key</div>
      <div style="display:flex;gap:8px;margin-bottom:10px;">
        <input class="fi fi-pw" id="api-key" placeholder="Paste key — stored in OS keychain, never on disk" style="flex:1;">
        <button class="btn btn-sm" onclick="toggleKeyVis()">&#128065;</button>
      </div>
      <div class="note note-g" style="margin-bottom:10px;"><span>&#128274;</span><div>Stored in your Mac/Windows keychain. Goes directly to the AI provider, never through our servers.</div></div>
      <div style="display:flex;align-items:center;gap:8px;">
        <button class="btn btn-p btn-sm" onclick="validateKey()">Validate key <div class="spinner" id="val-sp"></div></button>
      </div>
      <div id="key-validation-status" style="display:none;margin-top:10px;" class="note"></div>
    </div>
    <div style="display:flex;gap:8px;justify-content:flex-end;">
      <button class="btn" onclick="goTo('s-step1')">Back</button>
      <button class="btn btn-p" id="step2-next" onclick="goTo('s-step3')" disabled>Next &#8594;</button>
    </div>
  </div>
</div>

<!-- Step 3: Digest email -->
<div class="screen" id="s-step3" style="overflow-y:auto;padding:24px;">
  <div class="ob-container">
    <div class="step-row"><div class="sp done">&#10003;</div><div class="step-line done"></div><div class="sp done">&#10003;</div><div class="step-line done"></div><div class="sp active">3</div></div>
    <div class="card">
      <div class="card-title">Interview reminders &amp; weekly digest</div>
      <div class="card-sub">Enter your email to receive interview reminders the night before at 6:30 PM and an optional weekly pipeline digest every Monday.</div>
      <div class="fl">Your email address</div>
      <input class="fi" id="digest-email" type="email" placeholder="you@gmail.com">
      <div class="note note-b"><span>&#128236;</span><div>Reminders are AI-generated using your key and sent via the app&rsquo;s SendGrid integration. Your email is never shared.</div></div>
    </div>
    <div style="display:flex;gap:8px;justify-content:flex-end;">
      <button class="btn" onclick="goTo('s-step2')">Back</button>
      <button class="btn btn-ghost" onclick="launch()">Skip</button>
      <button class="btn btn-p" onclick="launch()">&#128640; Launch app</button>
    </div>
  </div>
</div>

<!-- Main App -->
<div class="screen" id="s-app" style="display:flex;flex:1;overflow:hidden;">
  <!-- Sidebar -->
  <div class="sidebar">
    <button class="nav-item active" data-tab="pipeline" onclick="showTab('pipeline')"><span class="nav-icon">&#128203;</span> Pipeline</button>
    <button class="nav-item" data-tab="skills" onclick="showTab('skills')"><span class="nav-icon">&#129504;</span> Skill prep</button>
    <button class="nav-item" data-tab="resume" onclick="showTab('resume')"><span class="nav-icon">&#128196;</span> Resume review</button>
    <button class="nav-item" data-tab="reminders" onclick="showTab('reminders')"><span class="nav-icon">&#128276;</span> Reminders</button>
    <div class="nav-spacer"></div>
    <div class="nav-divider"></div>
    <div style="padding:8px 10px;">
      <div class="key-pill" id="key-pill" style="width:100%;justify-content:center;">&#10003; Claude key active</div>
    </div>
    <button class="nav-item" data-tab="settings" onclick="showTab('settings')"><span class="nav-icon">&#9881;</span> Settings</button>
    <div class="nav-quit-area">
      <div class="nav-quit-note">Background runs only if you<br>enable automation in Settings.<br>AI tokens used on scan/extract.</div>
      <button class="nav-quit-btn" onclick="quitApp()">&#9211; Quit app</button>
    </div>
  </div>

  <!-- Main content -->
  <div class="main">
    <!-- PIPELINE TAB -->
    <div id="tab-pipeline">
      <div id="gmail-banner" class="gmail-banner" style="display:none;">
        <span class="gb-icon">&#9888;&#65039;</span>
        <div class="gb-text">
          <strong id="gb-title">Gmail isn't connected</strong>
          <div id="gb-sub">Connect your Gmail to auto-scan your job application emails.</div>
        </div>
        <button class="btn btn-p btn-sm" id="gb-btn" onclick="bannerConnectGmail()">Connect Gmail <div class="spinner" id="gb-sp"></div></button>
        <button class="gb-dismiss" onclick="dismissGmailBanner()" title="Hide until next launch">&times;</button>
      </div>
      <div class="stats-row">
        <div class="stat-card"><div class="stat-n" id="st-total">0</div><div class="stat-l">Total applied</div></div>
        <div class="stat-card stat-int"><div class="stat-n" id="st-int">0</div><div class="stat-l">Interviews</div></div>
        <div class="stat-card stat-offer"><div class="stat-n" id="st-offer">0</div><div class="stat-l">Offers</div></div>
        <div class="stat-card stat-rej"><div class="stat-n" id="st-rej">0</div><div class="stat-l">Rejections</div></div>
        <div class="stat-card stat-rate"><div class="stat-n" id="st-rate">0%</div><div class="stat-l">Response rate</div></div>
      </div>
      <div class="trend-card">
        <div class="trend-label">Weekly applications — last 8 weeks</div>
        <div class="trend-chart" id="trend-chart"></div>
      </div>
      <div class="quote-card" id="daily-quote-card">
        <div class="quote-text" id="daily-quote-text"></div>
        <div class="quote-meta"><span id="daily-quote-attr"></span><span class="quote-tag" id="daily-quote-tag"></span></div>
      </div>
      <div class="scan-bar">
        <div class="sdot dot-ok" id="sdot"></div>
        <div class="sbar-text" id="sbar-text">
          <span>Scan from</span>
          <input type="date" id="scan-from-date" class="scan-date-input" onchange="updateScanDate(this.value)" title="Change scan start date">
        </div>
        <div class="spinner" id="scan-sp"></div>
        <span class="scan-last" id="last-scan-note" title="">Never scanned</span>
        <button class="btn btn-p btn-sm" onclick="scanGmail()">&#8635; Scan Gmail</button>
      </div>
      <div class="section-head">
        <div class="section-title">Applications</div>
        <div style="display:flex;align-items:center;gap:6px;">
          <span style="font-size:11px;color:var(--text3);font-weight:600;">Sort</span>
          <select class="fi" style="font-size:11px;padding:4px 8px;height:auto;" onchange="setSortBy(this.value)" id="sort-select">
            <option value="date-desc">Date — newest first</option>
            <option value="date-asc">Date — oldest first</option>
            <option value="company-asc">Company — A → Z</option>
            <option value="company-desc">Company — Z → A</option>
          </select>
          <button class="btn btn-sm" onclick="toggleAdd()">+ Add</button>
        </div>
      </div>
      <div class="add-form" id="add-form">
        <div class="form-row"><div><div class="fl">Company</div><input class="fi" id="f-co" placeholder="Stripe"></div><div><div class="fl">Role</div><input class="fi" id="f-role" placeholder="ML Engineer"></div></div>
        <div class="form-row-3"><div><div class="fl">Applied date</div><input class="fi" id="f-date" type="date"></div><div><div class="fl">Status</div><select class="fi" id="f-status"><option value="applied">Applied</option><option value="screening">Screening</option><option value="interview">Interview</option><option value="offer">Offer</option><option value="rejected">Rejected</option></select></div><div><div class="fl">Interview / call date</div><input class="fi" id="f-intdate" type="date"></div></div>
        <div class="form-row-3"><div><div class="fl">Time <span style="font-weight:400;color:var(--text3);">(in your timezone)</span></div><input class="fi" id="f-inttime" type="time"></div><div></div><div></div></div>
        <div style="display:flex;gap:8px;margin-top:8px;"><button class="btn btn-p btn-sm" onclick="addManual()">Save</button><button class="btn btn-sm" onclick="toggleAdd()">Cancel</button></div>
      </div>
      <div id="company-list"></div>
      <div id="detail-panel" style="display:none;" class="detail-panel">
        <div class="section-head" style="margin-top:16px;">
          <div class="section-title" id="detail-heading">Timeline</div>
          <div style="display:flex;gap:6px;">
            <button class="btn btn-sm" onclick="openEdit()">&#9999;&#65039; Edit</button>
            <button class="btn btn-sm btn-danger" onclick="deleteApplication()">&#128465;&#65039; Delete</button>
          </div>
        </div>

        <!-- Inline edit form -->
        <div class="card" id="edit-form" style="display:none;margin-bottom:4px;">
          <div class="card-title" style="font-size:13px;">Edit application</div>
          <div class="form-row"><div><div class="fl">Company</div><input class="fi" id="e-co"></div><div><div class="fl">Role</div><input class="fi" id="e-role"></div></div>
          <div class="form-row-3">
            <div><div class="fl">Status</div><select class="fi" id="e-status"><option value="applied">Applied</option><option value="screening">Screening</option><option value="interview">Interview</option><option value="offer">Offer</option><option value="rejected">Rejected</option></select></div>
            <div><div class="fl">Applied date</div><input class="fi" id="e-applied" type="date"></div>
            <div><div class="fl">Screening date</div><input class="fi" id="e-screening" type="date"></div>
          </div>
          <div class="form-row-3">
            <div><div class="fl">Interview date</div><input class="fi" id="e-interview" type="date"></div>
            <div><div class="fl">Event time <span style="font-weight:400;color:var(--text3);">(your tz)</span></div><input class="fi" id="e-time" type="time"></div>
            <div><div class="fl">Final-round date</div><input class="fi" id="e-final" type="date"></div>
          </div>
          <div style="display:flex;gap:8px;margin-top:10px;"><button class="btn btn-p btn-sm" onclick="saveEdit()">Save changes</button><button class="btn btn-sm" onclick="cancelEdit()">Cancel</button></div>
        </div>

        <div class="card"><div class="timeline" id="timeline"></div></div>

        <!-- Job description paste area -->
        <div class="card" style="margin-top:4px;">
          <div class="card-title" style="font-size:13px;">&#10022; Extract skills from job description</div>
          <div class="card-sub" style="margin-bottom:10px;">Paste the job description for the most accurate results. Or leave blank to use AI's knowledge of this role.</div>
          <textarea id="jd-paste" class="fi" rows="5" style="-webkit-text-security:none;letter-spacing:normal;resize:vertical;font-size:12px;line-height:1.6;" placeholder="Paste the full job description here (requirements, responsibilities, qualifications)&#10;&#10;Leave blank to have the AI guess based on the company and role title — less accurate but still useful."></textarea>
          <div style="display:flex;align-items:center;gap:8px;margin-top:10px;">
            <button class="btn btn-p btn-sm" id="extract-btn" onclick="extractSkills()">Extract skills <div class="spinner" id="ex-sp"></div></button>
            <span id="jd-hint" style="font-size:11px;color:var(--text3);">Paste a JD above for accurate results</span>
          </div>
        </div>
      </div>
    </div>

    <!-- SKILLS TAB -->
    <div id="tab-skills" style="display:none;">
      <!-- Extract panel -->
      <div class="card" style="margin-bottom:16px;">
        <div class="card-title">Extract skills from a job description</div>
        <div class="card-sub">Pick an application, paste its job description, and let AI identify the key required skills.</div>
        <div class="fl" style="margin-top:10px;">Application</div>
        <select class="fi" id="skills-app-select" style="margin-bottom:10px;">
          <option value="">— choose an application —</option>
        </select>
        <div class="fl">Job description <span style="font-weight:400;color:var(--text3);">— optional. Leave blank and the app searches online automatically.</span></div>
        <textarea id="skills-jd" class="fi" rows="3" style="resize:vertical;font-size:12px;line-height:1.6;margin-bottom:10px;"
          placeholder="Optional: paste the job description to override the automatic online search."></textarea>
        <div style="display:flex;align-items:center;gap:10px;">
          <button class="btn btn-p btn-sm" id="skills-extract-btn" onclick="extractSkillsFromTab()">Extract skills <div class="spinner" id="skills-ex-sp"></div></button>
          <span id="skills-extract-status" style="font-size:12px;color:var(--text3);"></span>
        </div>
      </div>
      <div class="section-head">
        <div class="section-title">All skills to prepare</div>
        <div style="display:flex;align-items:center;gap:6px;">
          <span style="font-size:11px;color:var(--text3);font-weight:600;">Sort</span>
          <select class="fi" style="font-size:11px;padding:4px 8px;height:auto;" onchange="setSkillSort(this.value)" id="skill-sort-select">
            <option value="importance">Importance — most roles first</option>
            <option value="manual">My order — drag to arrange</option>
          </select>
        </div>
      </div>
      <div style="font-size:11px;color:var(--text3);margin:-4px 0 10px;">Number = how many of your roles need this skill &middot; tap <strong>Prep resources</strong> under any skill for tailored links.</div>
      <div class="skill-list" id="skill-list"></div>
    </div>

    <!-- RESUME REVIEW TAB -->
    <div id="tab-resume" style="display:none;">
      <div class="card" style="margin-bottom:16px;">
        <div class="card-title">Resume review</div>
        <div class="card-sub">Upload your resume (PDF or Word) or paste it below. The AI cross-checks it against the roles you've applied to and your ranked skills, then points out concrete improvements.</div>
        <div style="display:flex;gap:8px;align-items:center;margin:12px 0 8px;">
          <button class="btn btn-sm" onclick="loadResumeFile()">&#128196; Upload resume (PDF / Word / .txt)</button>
          <span style="font-size:11px;color:var(--text3);">PDF, Word .docx, or plain text — or just paste below.</span>
        </div>
        <textarea id="resume-text" class="fi" rows="10" style="resize:vertical;font-size:12px;line-height:1.6;"
          placeholder="Paste your full resume text here (summary, experience, skills, education)…" oninput="onResumeInput()"></textarea>
        <div style="display:flex;align-items:center;gap:10px;margin-top:10px;">
          <button class="btn btn-p btn-sm" id="resume-run-btn" onclick="runResumeReview()">&#10022; Analyze my resume <div class="spinner" id="resume-sp"></div></button>
          <button class="btn btn-sm" onclick="saveResumeText()">Save resume</button>
          <span id="resume-status" style="font-size:12px;color:var(--text3);"></span>
        </div>
      </div>
      <div id="resume-result"></div>
    </div>

    <!-- REMINDERS TAB -->
    <div id="tab-reminders" style="display:none;">
      <div class="note note-b" style="margin-bottom:14px;"><span>&#128276;</span><div>Turn on <strong>Interview reminders</strong> in Settings &rarr; Automation to get a desktop notification the evening before each interview (default 6:30 PM). The app must be running (it stays in your tray). Preview below shows the AI-written prep email you can send yourself.</div></div>
      <div class="section-head" style="margin-bottom:10px;">
        <div class="section-title">Upcoming interviews</div>
        <div style="display:flex;align-items:center;gap:6px;">
          <span style="font-size:11px;color:var(--text3);font-weight:600;">Show times in</span>
          <select class="fi" style="font-size:11px;padding:4px 8px;height:auto;" id="reminders-timezone" onchange="setTimezone(this.value)"></select>
        </div>
      </div>
      <div id="reminders-tz-note" style="font-size:11px;color:var(--text3);margin:-4px 0 10px;"></div>
      <div id="reminder-list"></div>
    </div>

    <!-- SETTINGS TAB -->
    <div id="tab-settings" style="display:none;">
      <div class="section-title" style="margin-bottom:16px;">Settings</div>

      <!-- AI Provider -->
      <div class="card" style="margin-bottom:12px;">
        <div class="card-title">AI Provider</div>
        <div class="fl">Current provider</div>
        <div id="settings-provider-display" style="font-size:13px;font-weight:500;color:var(--text);margin-bottom:10px;">Claude</div>
        <div class="fl">API Key</div>
        <div style="display:flex;gap:8px;margin-bottom:8px;">
          <input class="fi fi-pw" id="settings-api-key" placeholder="Enter new API key" style="flex:1;">
          <button class="btn btn-sm" onclick="toggleFieldVis('settings-api-key')">&#128065;</button>
          <button class="btn btn-p btn-sm" onclick="updateProviderKey()">Update</button>
        </div>
        <div style="font-size:11px;color:var(--text3);">
          Get a key: Claude &#8594; <strong>console.anthropic.com</strong> &nbsp;|&nbsp; GPT-4o &#8594; <strong>platform.openai.com/api-keys</strong> &nbsp;|&nbsp; Gemini &#8594; <strong>aistudio.google.com</strong>
        </div>
        <div id="settings-key-status" style="display:none;margin-top:8px;" class="note"></div>
      </div>

      <!-- Google Credentials -->
      <div class="card" style="margin-bottom:12px;">
        <div class="card-title">Google OAuth Credentials</div>
        <div class="fl">Client ID</div>
        <div style="display:flex;gap:8px;margin-bottom:8px;">
          <input class="fi fi-pw" id="settings-client-id" placeholder="Your Google Client ID" style="flex:1;">
          <button class="btn btn-sm" onclick="toggleFieldVis('settings-client-id')">&#128065;</button>
        </div>
        <div class="fl">Client Secret</div>
        <div style="display:flex;gap:8px;margin-bottom:10px;">
          <input class="fi fi-pw" id="settings-client-secret" placeholder="Your Google Client Secret" style="flex:1;">
          <button class="btn btn-sm" onclick="toggleFieldVis('settings-client-secret')">&#128065;</button>
        </div>
        <button class="btn btn-p btn-sm" onclick="updateGoogleCreds()">Save to keychain</button>
        <div id="settings-google-creds-status" style="display:none;margin-top:8px;" class="note"></div>
      </div>

      <!-- Gmail Connection -->
      <div class="card" style="margin-bottom:12px;">
        <div class="card-title">Gmail Connection</div>
        <div id="settings-gmail-status" style="margin-bottom:8px;"></div>
        <button class="btn btn-sm btn-danger" id="settings-disconnect-btn" onclick="disconnectGmailFromSettings()" style="display:none;">Disconnect Gmail</button>
      </div>

      <!-- Scan & Reminder Settings -->
      <div class="card" style="margin-bottom:12px;">
        <div class="card-title">Scan &amp; Reminder Settings</div>
        <div class="fl">Scan emails from this date forward</div>
        <input class="fi" type="date" id="settings-start-date" style="margin-bottom:10px;">
        <div class="fl">Digest email address</div>
        <input class="fi" type="email" id="settings-digest-email" placeholder="you@gmail.com" style="margin-bottom:12px;">
        <div class="fl">Show interview times in</div>
        <select class="fi" id="settings-timezone" style="margin-bottom:4px;" onchange="setTimezone(this.value)"></select>
        <div style="font-size:11px;color:var(--text3);margin-bottom:12px;">Defaults to your computer's local timezone. Reminders and notifications are shown in this zone.</div>
        <button class="btn btn-p btn-sm" onclick="saveSettings()">Save settings</button>
        <div id="settings-save-status" style="display:none;margin-top:8px;" class="note note-g">&#10003; Settings saved</div>
      </div>

      <!-- Automation -->
      <div class="card" style="margin-bottom:12px;">
        <div class="card-title">Automation</div>
        <div class="card-sub">Runs while the app is open. Closing the window keeps it alive in your menu bar / tray so these keep working — quit fully from the tray or the Quit button.</div>

        <label class="auto-row">
          <input type="checkbox" id="auto-scan-enabled" onchange="saveAutomation()">
          <span class="auto-label">Auto-scan Gmail daily</span>
          <input type="time" class="fi auto-time" id="auto-scan-time" value="08:00" onchange="saveAutomation()">
        </label>
        <div class="auto-hint">Each day at this time, the app scans your inbox for application updates (incremental — fast).</div>

        <label class="auto-row" style="margin-top:12px;">
          <input type="checkbox" id="reminders-enabled" onchange="saveAutomation()">
          <span class="auto-label">Interview reminders</span>
          <input type="time" class="fi auto-time" id="reminder-time" value="18:30" onchange="saveAutomation()">
        </label>
        <div class="auto-hint">Shows a desktop notification at this time the evening before any interview.</div>

        <div id="auto-last-scan" style="font-size:11px;color:var(--text2);margin-top:14px;padding-top:12px;border-top:1px dashed var(--border);"></div>

        <div id="automation-status" style="display:none;margin-top:10px;" class="note note-g">&#10003; Automation updated</div>
      </div>

      <!-- Data management -->
      <div class="card" style="margin-bottom:12px;">
        <div class="card-title">Clear tracked data</div>
        <div class="card-sub">Deletes all applications, skills, and reminders, but keeps your Gmail connection and API key. The next scan starts fresh (full scan). Great for demos or starting your pipeline over.</div>
        <button class="btn btn-sm" style="margin-top:10px;" onclick="clearData()">Clear data &amp; keep connections</button>
      </div>

      <!-- Reset / Danger zone -->
      <div class="card" style="margin-bottom:12px;border-color:#fecaca;">
        <div class="card-title" style="color:#b91c1c;">Reset app</div>
        <div class="card-sub">Permanently deletes all tracked applications, skills, and settings, and disconnects Gmail. You'll start over from setup (including the Google sign-in). This cannot be undone.</div>
        <button class="btn btn-sm btn-danger" style="margin-top:10px;" onclick="resetApp()">Disconnect &amp; erase all data</button>
      </div>
    </div>
  </div>
</div>

</div>`;

// Expose functions to onclick handlers
window.goTo = goTo;
window.showTab = showTab;
window.saveGoogleCredentials = saveGoogleCredentials;
window.toggleFieldVis = toggleFieldVis;
window.connectGmail = connectGmail;
window.step1Next = step1Next;
window.skipGmailSetup = skipGmailSetup;
window.toggleAdvancedCreds = toggleAdvancedCreds;
window.selProv = selProv;
window.toggleKeyVis = toggleKeyVis;
window.validateKey = validateKey;
window.launch = launch;
window.devSkip = devSkip;
window.updateScanDate = updateScanDate;
window.quitApp = quitApp;
window.resetApp = resetApp;
window.clearData = clearData;
window.bannerConnectGmail = bannerConnectGmail;
window.dismissGmailBanner = dismissGmailBanner;
window.renderSettings = renderSettings;
window.updateProviderKey = updateProviderKey;
window.updateGoogleCreds = updateGoogleCreds;
window.disconnectGmailFromSettings = disconnectGmailFromSettings;
window.saveSettings = saveSettings;
window.saveAutomation = saveAutomation;
window.setTimezone = setTimezone;
window.scanGmail = scanGmail;
window.toggleAdd = toggleAdd;
window.setSortBy = setSortBy;
window.addManual = addManual;
window.toggleCompany = toggleCompany;
window.selectRole = selectRole;
window.openEdit = openEdit;
window.cancelEdit = cancelEdit;
window.saveEdit = saveEdit;
window.deleteApplication = deleteApplication;
window.extractSkills = extractSkills;
window.extractSkillsFromTab = extractSkillsFromTab;
window.togglePrepared = togglePrepared;
window.previewReminder = previewReminder;
window.openLink = openLink;
window.setSkillSort = setSkillSort;
window.toggleSkillRes = toggleSkillRes;
window.renderResume = renderResume;
window.onResumeInput = onResumeInput;
window.saveResumeText = saveResumeText;
window.loadResumeFile = loadResumeFile;
window.runResumeReview = runResumeReview;

// Boot
init();
