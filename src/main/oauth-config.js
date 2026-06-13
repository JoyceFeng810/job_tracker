// src/main/oauth-config.js
// ──────────────────────────────────────────────────────────────────────────────
// Default Google OAuth client SHIPPED WITH THE APP so end-users do NOT have to
// create a Google Cloud project or their own credentials. They just click
// "Sign in with Google."
//
// HOW TO SET THIS UP (one time, by the app developer):
//   1. console.cloud.google.com → create a project → enable the Gmail API.
//   2. OAuth consent screen → External → add the gmail.readonly scope.
//   3. Credentials → Create Client → Application type: "Desktop app".
//   4. Copy the Client ID and Client Secret into the fields below
//      (or set the env vars JT_GOOGLE_CLIENT_ID / JT_GOOGLE_CLIENT_SECRET).
//   5. Add this redirect URI to the client: http://localhost:3742/oauth/callback
//
// NOTE: gmail.readonly is a Google "restricted" scope. Until the app is verified
// by Google, users see an "unverified app" warning and you are capped at ~100
// test users. For desktop ("installed") apps the client secret is not treated as
// confidential, so bundling it here is acceptable per Google's OAuth model.
//
// Leaving these blank falls back to the old flow (user enters their own creds).
// ──────────────────────────────────────────────────────────────────────────────

module.exports = {
  DEFAULT_CLIENT_ID: process.env.JT_GOOGLE_CLIENT_ID || '',
  DEFAULT_CLIENT_SECRET: process.env.JT_GOOGLE_CLIENT_SECRET || '',
};
