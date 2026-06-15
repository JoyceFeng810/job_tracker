# 💼 Job Tracker

A **local-first** desktop app (macOS) that turns your messy job-search inbox into one organized pipeline. It scans Gmail for application emails, tracks every role and its status, ranks the skills you'll be interviewed on, reminds you before interviews, and reviews your resume — all using **your own AI key**, running **entirely on your machine**.

> **Privacy first.** Nothing is sent to any server we control. Your emails are read with **read-only** Gmail access, your API keys and OAuth tokens are stored in the **macOS Keychain**, and your tracked data lives in a local SQLite database in your user folder. There are no analytics and no backend.

---

## ⬇️ Download (Apple Silicon Mac)

**[👉 Download the latest release](https://github.com/JoyceFeng810/job_tracker/releases/latest)** — grab the `.dmg`, then:

1. Open the `.dmg` and drag **Job Tracker** to Applications.
2. First launch: the app is unsigned, so **right-click it → Open → Open** (only needed once) to get past macOS Gatekeeper.
3. Follow the in-app setup (Steps 1–3 below): connect Gmail, add your AI key.

> 💡 Currently **Apple Silicon (M-series) only**. Intel Macs and Windows can build from source — see the "Install & run from source" section below.

**Verify your download is authentic (optional but recommended).** Every release is built by this repo's CI with a cryptographic [build-provenance attestation](https://github.com/JoyceFeng810/job_tracker/attestations). Confirm your dmg wasn't tampered with — replace the filename with the one you downloaded:

```bash
gh attestation verify "Job Tracker-<version>-arm64.dmg" --repo JoyceFeng810/job_tracker
```

Or compare its SHA-256 to the `.sha256` file attached to the release.

---

## ✨ Features

- **Auto-scan Gmail** → builds your pipeline (applied / screening / interview / offer / rejected)
- **Pipeline & stats** — totals, response rate, an 8-week trend, sort & search, edit/delete any entry
- **Reminders** — upcoming interviews & recruiter calls in your timezone, with night-before desktop notifications
- **Skill prep** — AI summarizes the skills you'll be interviewed on, ranked by importance, each with curated prep resources
- **Resume review** — upload a PDF/Word/text resume and get an objective, role-specific critique (fit score, gaps, bullet rewrites, missing keywords)
- **Automation** — optional daily auto-scan + interview reminders (runs while the app sits in your menu-bar tray)

---

## 🔑 What you need before you start

1. **macOS** and **[Node.js 20](https://nodejs.org/)** (the app pins Node 20 — see `.nvmrc`). Native modules (`better-sqlite3`, `keytar`) compile against your exact Node version, so other versions can break the build.
2. **An AI API key** (pick one): [Anthropic Claude](https://console.anthropic.com), [OpenAI](https://platform.openai.com/api-keys), or [Google Gemini](https://aistudio.google.com). You pay your provider directly for usage.
3. **A Google account** + your own **Google OAuth client** (free, ~5 min — steps below).

You provide these yourself. **They are never committed to this repo or sent anywhere** — keys live only in your Keychain.

---

## 🚀 Install & run (from source)

```bash
git clone https://github.com/<your-username>/job-tracker.git
cd job-tracker
nvm use 20            # or make sure `node -v` is v20.x
npm install          # also rebuilds native modules for Electron
npm start            # launches the app
```

If native modules complain about a Node/Electron version mismatch:

```bash
npx electron-rebuild
```

### Build a standalone Mac app

```bash
npm run build:mac    # produces a .dmg in dist/
```

The build is **unsigned**, so the first time you open it macOS Gatekeeper will warn "unidentified developer." Right-click the app → **Open** → **Open** to allow it (only needed once). Proper signing requires an Apple Developer account.

---

## 1. Connect Gmail — create your own Google OAuth client

This app reads **your own** inbox, so Google requires **your own OAuth Client** (an *OAuth Client ID*, **not** a "service account" — service accounts are for server-to-server access and cannot read a personal Gmail). It's free and takes about five minutes.

1. **Create a project.** Go to the **[Google Cloud Console](https://console.cloud.google.com)** → create a new project (any name) → make sure it's selected in the top dropdown.
2. **Enable the Gmail API.** Sidebar → **APIs & Services → Library** → search **"Gmail API"** → **Enable**.
3. **Configure the OAuth consent screen.** Sidebar → **OAuth consent screen** → choose **External** → fill in an **App name** and your **support email** → **Save & Continue**.
4. **Add yourself as a Test user (required).** On the consent screen, scroll to **Test users** → **Add Users** → enter **your own Gmail address**. The app stays in *"Testing"* mode, so **only** emails listed here can sign in. (This is why no Google verification is needed for personal use — up to 100 test users.)
5. **Create the credentials.** Sidebar → **Credentials** → **+ Create Credentials** → **OAuth client ID** → **Application type: Desktop app** → **Create**.
6. **Copy the Client ID and Client Secret** and paste them into the app's setup screen (Step 1).

> **Choose "Desktop app".** It automatically allows this app's loopback sign-in at `http://localhost:3742/oauth/callback`, so you do **not** need to add any redirect URI. Do **not** choose "Web application" (that would require manual redirect setup).

7. **Authorize.** Click **Sign in with Google** in the app. Google shows an **"unverified app"** warning — expected, because it's *your* personal app. Click **Advanced → Go to [your project] (unsafe)** to continue, then grant the **read-only** Gmail permission.

---

## 2. Add your AI key

In the app (onboarding Step 2, or **Settings → AI Provider**), choose your provider and paste your API key. It's validated and stored in your **Keychain**. The app calls the AI provider directly from your machine using your key.

---

## 🔐 Where your data & secrets live

| Item | Stored in | In this repo? |
|---|---|---|
| AI API key | macOS Keychain (`job-tracker`) | ❌ never |
| Google Client ID / Secret | macOS Keychain | ❌ never |
| Gmail OAuth tokens | macOS Keychain | ❌ never |
| Tracked applications, skills, resume | Local SQLite + prefs in `~/Library/Application Support/job-tracker/` | ❌ never |

Nothing sensitive is written to the project folder, and `.gitignore` excludes `.env`, build output, media, and any `*credentials*.json` just in case.

- **Start a fresh pipeline but stay connected:** Settings → **Clear tracked data**.
- **Wipe everything and re-onboard:** Settings → **Reset app** (also disconnects Gmail).

---

## 🛠 Troubleshooting

- **"Port 3742 is already in use"** — another copy is running. Quit it from the tray, or `pkill -f "job-tracker/node_modules/electron"`.
- **"redirect_uri_mismatch"** — you created a *Web application* client. Delete it and create a **Desktop app** client instead.
- **"access_denied" / stuck on the warning** — make sure your Gmail is under **Test users**, then click **Advanced → Go to … (unsafe)**.
- **Native module errors after `npm install`** — run `npx electron-rebuild`.

---

## ⚠️ Distributing to many people

`gmail.readonly` is a Google **restricted scope**. In "Testing" mode any OAuth client is capped at **100 test users**. To distribute publicly *without* each person making their own client, the app would need **Google's OAuth verification** (a paid security assessment). For personal use, a small team, or this open-source build where each user creates their own client, no verification is required.

---

## License

[MIT](./LICENSE).
