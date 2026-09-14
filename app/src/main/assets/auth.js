// OAuth 2.0 Authorization Code + PKCE, entirely client-side. Tokens live in localStorage.
// Shared by index.html (login/refresh) and callback.html (code exchange).
(function () {
  const ACCOUNTS = 'https://accounts.spotify.com';
  const SCOPES = [
    'streaming', 'user-read-email', 'user-read-private',
    'user-read-playback-state', 'user-modify-playback-state',
    'user-library-read', 'playlist-read-private', 'playlist-read-collaborative',
  ].join(' ');
  const LS = { access: 'sp_access', refresh: 'sp_refresh', exp: 'sp_exp', verifier: 'sp_pkce_verifier' };

  const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const randomString = n => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
    return Array.from(crypto.getRandomValues(new Uint8Array(n)), b => chars[b % chars.length]).join('');
  };

  async function tokenRequest(params) {
    const r = await fetch(`${ACCOUNTS}/api/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: CONFIG.clientId, ...params }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(`${j.error}: ${j.error_description || ''}`);
    localStorage[LS.access] = j.access_token;
    if (j.refresh_token) localStorage[LS.refresh] = j.refresh_token;   // PKCE rotates refresh tokens
    localStorage[LS.exp] = String(Date.now() + j.expires_in * 1000);
    return j.access_token;
  }

  window.AUTH = {
    redirectUri: `${location.origin}/assets/callback.html`,
    configured: () => !!CONFIG.clientId && !CONFIG.clientId.startsWith('PASTE'),
    signedIn: () => !!localStorage[LS.refresh],

    async login() {
      const verifier = randomString(64);
      localStorage[LS.verifier] = verifier;
      const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
      location.href = `${ACCOUNTS}/authorize?` + new URLSearchParams({
        client_id: CONFIG.clientId, response_type: 'code', redirect_uri: this.redirectUri,
        scope: SCOPES, code_challenge_method: 'S256', code_challenge: challenge,
      });
    },

    async exchange(code) {
      const verifier = localStorage[LS.verifier];
      if (!verifier) throw new Error('missing PKCE verifier (login not started from this app?)');
      const t = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: this.redirectUri, code_verifier: verifier });
      delete localStorage[LS.verifier];
      return t;
    },

    _refreshing: null,
    refresh() {
      if (!this._refreshing) {
        this._refreshing = tokenRequest({ grant_type: 'refresh_token', refresh_token: localStorage[LS.refresh] })
          .finally(() => { this._refreshing = null; });
      }
      return this._refreshing;
    },

    // Always hand out a token with at least a minute left; refresh transparently otherwise.
    async token() {
      if (!this.signedIn()) throw new Error('not signed in');
      if (Number(localStorage[LS.exp] || 0) - Date.now() < 60_000) return this.refresh();
      return localStorage[LS.access];
    },

    logout() { Object.values(LS).forEach(k => delete localStorage[k]); },
  };
})();
