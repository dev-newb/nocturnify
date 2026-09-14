// Spotify TV — minimal D-pad front end over the Web Playback SDK + Web API.
(function () {
  const $ = s => document.querySelector(s);
  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const status = m => { $('#now-status').textContent = m; console.log('[status]', m); };
  let screen = 'login';   // 'login' | 'app' — decides how the remote OK key is routed
  let userId = null;      // signed-in user's id, for owned-vs-followed playlist logic
  let ctxName = '';       // what's playing (playlist / Liked Songs / search), shown in the visualiser
  let idleTimer = null;

  // ---------- Web API ----------
  async function api(path, opts = {}, retry = true) {
    const r = await fetch('https://api.spotify.com/v1' + path, {
      ...opts, headers: { Authorization: 'Bearer ' + await AUTH.token(), 'Content-Type': 'application/json', ...(opts.headers || {}) },
    });
    if (r.status === 401 && retry) { await AUTH.refresh(); return api(path, opts, false); }
    if (r.status === 204) return null;
    if (!r.ok) throw new Error(`${r.status} ${path}: ${(await r.text()).slice(0, 200)}`);
    return r.json();
  }

  // ---------- Player (Web Playback SDK) ----------
  let player = null, deviceId = null, lastState = null, lastStateAt = 0;

  window.onSpotifyWebPlaybackSDKReady = () => {
    if (!AUTH.signedIn()) return;                     // login page will reload us afterwards
    player = new Spotify.Player({
      name: CONFIG.deviceName, volume: 0.8,
      getOAuthToken: cb => AUTH.token().then(cb).catch(e => status('token: ' + e.message)),
    });
    player.addListener('ready', async ({ device_id }) => {
      deviceId = device_id; status('Ready · ' + CONFIG.deviceName);
      try { await api('/me/player', { method: 'PUT', body: JSON.stringify({ device_ids: [deviceId], play: false }) }); }
      catch (e) { status('transfer: ' + e.message); }
    });
    player.addListener('not_ready', () => { deviceId = null; status('Device offline'); });
    player.addListener('player_state_changed', s => { lastState = s; lastStateAt = Date.now(); renderNow(); markPlaying(); pushNative(); });
    for (const ev of ['initialization_error', 'authentication_error', 'account_error', 'playback_error'])
      player.addListener(ev, ({ message }) => status(`${ev}: ${message}`));
    player.connect().then(ok => { if (!ok) status('SDK failed to connect'); });
  };

  // The SDK's resume() can silently no-op; toggling against fresh state always works.
  async function setPlaying(want) {
    if (!player) return;
    let st = null;
    try { st = await player.getCurrentState(); } catch (e) {}
    const paused = st ? st.paused : (lastState ? lastState.paused : true);
    if (want === paused) player.togglePlay();
  }
  window.tvSetPlaying = setPlaying;   // also called by the MediaSession (notification / remote)

  async function play(body) {
    if (!deviceId) { status('Player not ready yet'); return; }
    try { await api(`/me/player/play?device_id=${deviceId}`, { method: 'PUT', body: JSON.stringify(body) }); }
    catch (e) { status('play: ' + e.message); }
  }

  // ---------- Now playing ----------
  function renderNow() {
    const s = lastState; if (!s || !s.track_window?.current_track) return;
    const t = s.track_window.current_track;
    $('#now-title').textContent = t.name;
    $('#now-artist').textContent = t.artists.map(a => a.name).join(', ') + '  ·  ' + t.album.name;
    $('#now-art').src = t.album.images?.[0]?.url || '';
    $('#now-state').textContent = s.paused ? '❚❚' : '▶';
  }
  setInterval(() => {                                 // interpolate progress between SDK state events
    const s = lastState; if (!s || !s.duration) return;
    const pos = s.paused ? s.position : Math.min(s.duration, s.position + (Date.now() - lastStateAt));
    $('#now-fill').style.width = (100 * pos / s.duration).toFixed(2) + '%';
  }, 500);
  // Mirror current play state to the native MediaSession + foreground service (background audio).
  function pushNative() {
    try {
      const t = lastState?.track_window?.current_track;
      window.AndroidBridge?.postMessage(JSON.stringify({
        playing: lastState ? !lastState.paused : false,
        title: t?.name || '',
        artist: (t?.artists || []).map(a => a.name).join(', '),
      }));
    } catch (e) { /* bridge absent (e.g. older WebView) — background audio just won't engage */ }
  }

  // Everything the visualiser is allowed to know: real position, real art, real identity.
  const vizState = () => {
    const s = lastState; if (!s) return {};
    const t = s.track_window?.current_track;
    return {
      uri: t?.uri || '', title: t?.name || '',
      artist: (t?.artists || []).map(a => a.name).join(', '),
      album: t?.album?.name || '',
      context: s.context?.metadata?.context_description || ctxName || '',
      artUrl: t?.album?.images?.[0]?.url || '',
      position: s.paused ? s.position : Math.min(s.duration, s.position + (Date.now() - lastStateAt)),
      duration: s.duration || 0, paused: !!s.paused,
    };
  };
  function openViz() { screen = 'viz'; VIZ.start({ state: vizState }); }
  function resetIdle() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (screen === 'app' && lastState && !lastState.paused) openViz();   // screensaver-style
    }, 60000);
  }
  function closeViz() { VIZ.stop(); screen = 'app'; resetIdle(); }

  function markPlaying() {
    const uri = lastState?.track_window?.current_track?.uri;
    document.querySelectorAll('#main .item').forEach(i => i.classList.toggle('playing', !!uri && i.dataset.uri === uri));
  }

  // ---------- Views ----------
  const main = $('#main');
  let view = { name: 'home' };
  const setMain = (title, node) => { main.innerHTML = ''; main.append(el('div', 'title', esc(title)), node); focus.enter('main', 0); };

  function trackRow(t, i, extra = {}) {
    const row = el('div', 'item');
    row.dataset.uri = t.uri;
    row.append(el('span', 'n', String(i + 1)),
      el('div', '', `<div class="t">${esc(t.name)}</div><div class="s">${esc((t.artists || []).map(a => a.name).join(', '))}</div>`));
    row.onactivate = () => play(extra.context ? { context_uri: extra.context, offset: { position: i } } : { uris: extra.uris || [t.uri] });
    return row;
  }

  const views = {
    async home() {
      const list = el('div', 'list');
      if (userId === null) { try { userId = (await api('/me')).id; } catch (e) {} }
      const r = await api('/me/playlists?limit=50');
      const items = (r.items || []).filter(Boolean);
      for (const p of items) {
        const row = el('div', 'item');
        const img = el('img'); img.src = p.images?.[0]?.url || ''; row.append(img);
        const count = p.items?.total ?? p.tracks?.total;
        const meta = [count != null ? `${count} track${count === 1 ? '' : 's'}` : null, p.owner?.display_name].filter(Boolean).join(' · ');
        row.append(el('div', '', `<div class="t">${esc(p.name)}</div><div class="s">${esc(meta)}</div>`));
        row.onactivate = () => {
          if (p.owner?.id && p.owner.id === userId) { ctxName = p.name; go({ name: 'playlist', id: p.id, title: p.name, uri: p.uri }); }
          else { ctxName = p.name; play({ context_uri: p.uri }); status('Playing ' + p.name); }   // followed: track list is 403, play whole
        };
        list.append(row);
      }
      if (!items.length) list.append(el('div', 'empty', 'No playlists'));
      setMain('Playlists', list);
    },
    async playlist({ id, title, uri }) {
      const list = el('div', 'list');
      const r = await api(`/playlists/${id}/items?limit=100`);   // 200 for owned playlists; items[].item holds the track
      (r.items || []).map(x => x.item).filter(t => t && t.uri)
        .forEach((t, i) => list.append(trackRow(t, i, { context: uri })));
      if (!list.children.length) list.append(el('div', 'empty', 'No tracks'));
      setMain(title, list); markPlaying();
    },
    async liked() {
      ctxName = 'Liked Songs';
      const list = el('div', 'list');
      const r = await api('/me/tracks?limit=50');
      const tracks = (r.items || []).map(x => x.track).filter(t => t && t.uri);
      const uris = tracks.map(t => t.uri);
      tracks.forEach((t, i) => list.append(trackRow(t, i, { uris: uris.slice(i).concat(uris.slice(0, i)) })));
      setMain('Liked Songs', list); markPlaying();
    },
    async search() {
      const wrap = el('div');
      const input = el('input'); input.placeholder = 'Search songs, albums, artists…'; input.className = 'item';
      const results = el('div', 'list');
      input.onactivate = () => input.focus();                       // Enter on the field opens the TV keyboard
      input.addEventListener('keydown', async e => {
        if (e.key === 'Enter' && input.value.trim()) {
          e.preventDefault(); input.blur();
          ctxName = 'Search: ' + input.value.trim();
          results.innerHTML = '<div class="empty">Searching…</div>';
          try {
            // Dev-mode caps search at limit=10 (20+ -> 400 Invalid limit).
            const r = await api(`/search?type=track&limit=10&q=${encodeURIComponent(input.value.trim())}`);
            const tracks = (r.tracks?.items || []).filter(t => t && t.uri);
            results.innerHTML = '';
            tracks.forEach((t, i) => results.append(trackRow(t, i, { uris: tracks.map(x => x.uri).slice(i) })));
            if (!tracks.length) results.append(el('div', 'empty', 'No results'));
            focus.enter('main', 1);
          } catch (err) {
            results.innerHTML = '';
            results.append(el('div', 'empty', 'Search failed: ' + err.message));
            status(err.message);
          }
        }
        if (e.key === 'Escape') input.blur();
      });
      wrap.append(input, results);
      setMain('Search', wrap);
    },
    logout() { AUTH.logout(); location.reload(); },
  };

  async function go(v) {
    if (v.name === 'viz') { openViz(); return; }     // overlay: leave the current view intact underneath
    view = v; if (!views[v.name]) return;
    main.innerHTML = '<div class="title">Loading…</div>';
    try { await views[v.name](v); } catch (e) { main.innerHTML = `<div class="title">Error</div><div class="empty">${esc(e.message)}</div>`; status(e.message); }
  }

  // ---------- Focus / D-pad ----------
  const focus = {
    zone: 'main', idx: { side: 0, main: 0 },
    items(z) { return [...document.querySelectorAll(z === 'side' ? '#side .item' : '#main .item')]; },
    enter(z, i) { this.zone = z; if (i != null) this.idx[z] = i; this.apply(); },
    move(d) { const n = this.items(this.zone).length; if (!n) return; this.idx[this.zone] = Math.max(0, Math.min(n - 1, this.idx[this.zone] + d)); this.apply(); },
    apply() {
      for (const z of ['side', 'main']) this.items(z).forEach((it, i) => it.classList.toggle('focused', z === this.zone && i === this.idx[z]));
      const cur = this.current();
      if (cur) { cur.tabIndex = -1; cur.focus({ preventScroll: true }); cur.scrollIntoView({ block: 'nearest' }); }
    },
    current() { return this.items(this.zone)[this.idx[this.zone]]; },
  };

  // Activate whatever actually holds DOM focus — works for sidebar, list rows, and the login button alike.
  function activateFocused() {
    const a = document.activeElement;
    const t = (a && (a.dataset.nav || a.onactivate)) ? a : focus.current();
    if (!t) return;
    if (t.dataset.nav) go({ name: t.dataset.nav }); else t.onactivate?.();
  }

  document.addEventListener('keydown', e => {
    resetIdle();
    const k = e.key;
    if (screen === 'viz') {
      if (k === 'Enter' || k === 'MediaPlayPause' || e.keyCode === 13 || e.keyCode === 23) player?.togglePlay();
      else if (k === 'ArrowRight' || k === 'MediaTrackNext') player?.nextTrack();
      else if (k === 'ArrowLeft' || k === 'MediaTrackPrevious') player?.previousTrack();
      else if (k === 'ArrowUp') VIZ.cycle(1);        // D-pad up/down: the one control every
      else if (k === 'ArrowDown') VIZ.cycle(-1);     // Android TV remote has and we don't use
      else return;
      e.preventDefault(); return;
    }
    if (screen === 'login') {
      if (k === 'Enter' || k === 'Spacebar' || e.keyCode === 13 || e.keyCode === 23) { AUTH.login(); e.preventDefault(); }
      return;
    }
    if (document.activeElement?.tagName === 'INPUT') return;     // the TV keyboard owns the keys
    if (k === 'ArrowUp') focus.move(-1); else if (k === 'ArrowDown') focus.move(1);
    else if (k === 'ArrowLeft') focus.enter('side'); else if (k === 'ArrowRight') focus.enter('main');
    else if (k === 'Enter' || k === 'Spacebar' || e.keyCode === 13 || e.keyCode === 23) activateFocused();
    else if (k === 'MediaPlayPause') player?.togglePlay();
    else if (k === 'MediaTrackNext') player?.nextTrack(); else if (k === 'MediaTrackPrevious') player?.previousTrack();
    else return;
    e.preventDefault();
  });

  // Called from MainActivity for remote transport keys (Android keycodes) and Back.
  window.onTvKey = code => {
    ({ 85: () => player?.togglePlay(), 126: () => setPlaying(true), 127: () => setPlaying(false),
       87: () => player?.nextTrack(), 88: () => player?.previousTrack(), 86: () => setPlaying(false) })[code]?.();
  };
  window.onTvBack = () => {
    if (screen === 'viz') { closeViz(); return true; }
    if (document.activeElement?.tagName === 'INPUT') { document.activeElement.blur(); return true; }
    if (view.name !== 'home') { go({ name: 'home' }); return true; }
    if (focus.zone === 'main') { focus.enter('side'); return true; }
    return false;                                               // at the root: let Android close the app
  };

  // ---------- Boot ----------
  (function boot() {
    if (!AUTH.configured()) { $('#setup-uri').textContent = AUTH.redirectUri; $('#setup').hidden = false; return; }
    if (!AUTH.signedIn()) {
      $('#login').hidden = false;
      screen = 'login';
      $('#login-btn').onclick = () => AUTH.login();   // mouse/native activation
      return;
    }
    screen = 'app';
    $('#app').hidden = false;
    status('Connecting player…');
    resetIdle();
    go({ name: 'home' });
  })();
})();
