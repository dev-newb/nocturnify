// Spotify TV — minimal D-pad front end over the Web Playback SDK + Web API.
(function () {
  const $ = s => document.querySelector(s);
  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const status = m => { $('#now-status').textContent = m; console.log('[status]', m); };
  let screen = 'login';   // 'login' | 'app' — decides how the remote OK key is routed
  let userId = null;      // signed-in user's id, for owned-vs-followed playlist logic
  let lastSearch = null;   // {q, tracks, albums} — so returning to Search keeps results
  let ctxName = '';       // what's playing (playlist / Liked Songs / search), shown in the visualiser
  let idleTimer = null;
  let logoutArmed = false;

  // ---------- Web API ----------
  async function api(path, opts = {}, retry = true) {
    const r = await fetch('https://api.spotify.com/v1' + path, {
      ...opts, headers: { Authorization: 'Bearer ' + await AUTH.token(), 'Content-Type': 'application/json', ...(opts.headers || {}) },
    });
    if (r.status === 401 && retry) { await AUTH.refresh(); return api(path, opts, false); }
    if (!r.ok) throw new Error(`${r.status} ${path}: ${(await r.text()).slice(0, 200)}`);
    // Some endpoints answer with no body, and some (e.g. PUT /me/player/shuffle) answer 200
    // with a non-JSON payload. Neither should throw — callers that need data check for it.
    const txt = await r.text();
    if (!txt) return null;
    try { return JSON.parse(txt); } catch { return null; }
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
    player.addListener('player_state_changed', s => { lastState = s; lastStateAt = Date.now(); renderNow(); markPlaying(); pushNative(); syncShuffle(!!s?.shuffle, !!s?.disallows?.toggling_shuffle); });
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
    const names = (t.artists || []).map(a => a.name).join(', ');
    const alb = t.album?.name || '';
    // don't echo the album when it just repeats the track title (common for singles)
    $('#now-artist').textContent = alb && alb.trim().toLowerCase() !== (t.name || '').trim().toLowerCase()
      ? `${names}  ·  ${alb}` : names;
    $('#now-art').src = t.album.images?.[0]?.url || '';
    $('#now-state').textContent = s.paused ? '❚❚' : '▶';
  }
  setInterval(() => {                                 // interpolate progress between SDK state events
    const s = lastState; if (!s || !s.duration) return;
    const pos = s.paused ? s.position : Math.min(s.duration, s.position + (Date.now() - lastStateAt));
    $('#now-fill').style.width = (100 * pos / s.duration).toFixed(2) + '%';
  }, 500);
  // Mirror current play state to the native MediaSession + foreground service (background audio).
  let lastPush = '';
  function pushNative() {
    try {
      const t = lastState?.track_window?.current_track;
      const payload = JSON.stringify({
        playing: lastState ? !lastState.paused : false,
        title: t?.name || '',
        artist: (t?.artists || []).map(a => a.name).join(', '),
      });
      // player_state_changed fires constantly (position ticks included). Crossing the bridge
      // each time rebuilt the notification and spammed the system media wrapper — which said
      // as much: "tried to update with no new data".
      if (payload === lastPush) return;
      lastPush = payload;
      window.AndroidBridge?.postMessage(payload);
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
  // Spotify disallows toggling shuffle in some contexts (playlists, in practice) and answers
  // PUT /me/player/shuffle with 200 while ignoring it. The player reports this up front in
  // actions.disallows, so say so rather than offering a switch that silently snaps back.
  function syncShuffle(on, locked) {
    const item = document.querySelector('[data-nav="shuffle"]');
    if (item) item.textContent = `Shuffle: ${on ? 'On' : 'Off'}${locked ? ' (locked)' : ''}`;
  }
  async function toggleShuffle() {
    if (lastState?.disallows?.toggling_shuffle) {
      status('Spotify locks shuffle for this playlist — play an album, or change it in the Spotify app');
      return;
    }
    const want = !(lastState && lastState.shuffle);
    syncShuffle(want);                                    // optimistic; corrected by the next state event
    try {
      await api(`/me/player/shuffle?state=${want}${deviceId ? '&device_id=' + deviceId : ''}`, { method: 'PUT' });
      status('Shuffle ' + (want ? 'on' : 'off'));
    } catch (e) {
      syncShuffle(!want, !!lastState?.disallows?.toggling_shuffle);
      status('shuffle: ' + e.message);
    }
  }

  function openViz() { screen = 'viz'; VIZ.start({ state: vizState }); }
  // The SDK can strand playback at exactly end-of-track: is_playing stays true, position
  // never moves, and it never rolls over. Nudge it along.
  setInterval(() => {
    const s = lastState;
    if (!s || s.paused || !s.duration) return;
    if (s.position >= s.duration - 400 && Date.now() - lastStateAt > 3000) {
      status('Advancing (stalled at end)');
      player?.nextTrack();
    }
  }, 1500);

  function resetIdle() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (screen === 'app' && lastState && !lastState.paused) openViz();   // screensaver-style
    }, 60000);
  }
  function closeViz() { VIZ.stop(); screen = 'app'; resetIdle(); }

  // Seeking from the visualiser. Presses accumulate against a local target and fire a single
  // seek once you stop, so holding the key scrubs smoothly instead of spamming the SDK.
  let seekTarget = null, seekTimer = null;
  function seekBy(deltaMs) {
    const st = vizState();
    if (!st.duration) return;
    const base = seekTarget != null ? seekTarget : st.position;
    seekTarget = Math.max(0, Math.min(Math.max(0, st.duration - 5000), base + deltaMs));
    VIZ.setSeekPreview(seekTarget);
    clearTimeout(seekTimer);
    seekTimer = setTimeout(() => {
      const t = seekTarget; seekTarget = null;
      Promise.resolve(player?.seek(t)).catch(() => {});
      setTimeout(() => VIZ.setSeekPreview(null), 700);
    }, 400);
  }
  // Remote FF/RW: a single press skips a track, holding scrubs within it. Key repeat is the
  // only signal that separates them — one lone event is a tap, a stream of them is a hold.
  let ffDir = 0, ffCount = 0, ffTimer = null, ffT0 = 0;
  const FF_TAP_MS = 500;
  window.tvScrub = dir => {
    const now = performance.now();
    if (ffDir !== dir) { clearTimeout(ffTimer); ffDir = dir; ffCount = 0; ffT0 = now; }
    ffCount++;
    console.log('[ff]', dir, 'n=' + ffCount, 'dt=' + Math.round(now - ffT0));   // TEMP: tune FF_TAP_MS
    if (ffCount === 1) {
      ffTimer = setTimeout(() => {
        if (ffCount === 1) { if (dir > 0) player?.nextTrack(); else player?.previousTrack(); }
        ffDir = 0; ffCount = 0;
      }, FF_TAP_MS);
    } else {
      clearTimeout(ffTimer);
      seekBy(dir * 5000);
      ffTimer = setTimeout(() => { ffDir = 0; ffCount = 0; }, 600);
    }
  };
  window.tvSeekTo = ms => { Promise.resolve(player?.seek(ms)).catch(() => {}); };

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
    // Spotify exposes no deep play history to this app: /me/player/recently-played is a hard
    // 50-item window (~2h here) that pages back to nothing, and /me/top/* is 403 in Dev mode.
    // The saved album library is the one deep, stable, intentional list available.
    async albums() {
      ctxName = 'Albums';
      const list = el('div', 'list');
      const r = await api('/me/albums?limit=50');
      const items = (r?.items || []).map(x => x.album).filter(a => a?.id);
      for (const al of items) {
        const row = el('div', 'item');
        const img = el('img'); img.src = al.images?.[2]?.url || al.images?.[0]?.url || '';
        const who = (al.artists || []).map(x => x.name).join(', ');
        const bits = [al.total_tracks ? `${al.total_tracks} track${al.total_tracks === 1 ? '' : 's'}` : null, who]
          .filter(Boolean).join(' · ');
        row.append(img, el('div', '', `<div class="t">${esc(al.name)}</div><div class="s">${esc(bits)}</div>`));
        row.onactivate = () => { ctxName = al.name; go({ name: 'album', id: al.id, title: al.name, uri: al.uri }); };
        list.append(row);
      }
      if (!items.length) list.append(el('div', 'empty', 'No saved albums'));
      setMain(r?.total > items.length ? `Albums (${items.length} of ${r.total})` : 'Albums', list);
      markPlaying();
    },
    async album({ id, title, uri }) {
      const list = el('div', 'list');
      const r = await api(`/albums/${id}/tracks?limit=50`);   // plain track objects, no .track wrapper
      (r.items || []).filter(t => t && t.uri).forEach((t, i) => list.append(trackRow(t, i, { context: uri })));
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
      ctxName = 'Search';
      const wrap = el('div');
      const input = el('input'); input.placeholder = 'Search songs and albums…'; input.className = 'item';
      const results = el('div', 'list');
      input.onactivate = () => input.focus();          // OK enters the field; IME opens
      const render = () => {
        results.innerHTML = '';
        const { albums = [], tracks = [] } = lastSearch || {};
        if (albums.length) {
          results.append(el('div', 'sect', 'Albums'));
          for (const al of albums) {
            const row = el('div', 'item');
            const img = el('img'); img.src = al.images?.[2]?.url || al.images?.[0]?.url || '';
            row.append(img, el('div', '', `<div class="t">${esc(al.name)}</div><div class="s">${al.total_tracks} tracks · ${esc((al.artists || []).map(x => x.name).join(', '))}</div>`));
            row.onactivate = () => { ctxName = al.name; go({ name: 'album', id: al.id, title: al.name, uri: al.uri }); };
            results.append(row);
          }
        }
        if (tracks.length) {
          results.append(el('div', 'sect', 'Songs'));
          tracks.forEach((t, i) => results.append(trackRow(t, i, { uris: tracks.map(x => x.uri).slice(i) })));
        }
        if (!albums.length && !tracks.length) results.append(el('div', 'empty', lastSearch ? 'No results' : 'Press OK to type a search'));
        markPlaying();
      };
      const run = async () => {
        const q = input.value.trim(); if (!q) return;
        results.innerHTML = '<div class="empty">Searching…</div>';
        try {
          const r = await api(`/search?type=track,album&limit=10&q=${encodeURIComponent(q)}`);   // dev mode caps limit at 10
          lastSearch = {
            q,
            tracks: (r.tracks?.items || []).filter(t => t && t.uri),
            albums: (r.albums?.items || []).filter(a2 => a2 && a2.uri),
          };
          render();
          focus.enter('main', 1);
        } catch (err) {
          results.innerHTML = '';
          results.append(el('div', 'empty', 'Search failed: ' + err.message));
          status(err.message);
        }
      };
      input.addEventListener('keydown', async e => {
        if (e.key === 'Enter') { e.preventDefault(); input.blur(); await run(); }
        else if (e.key === 'Escape') { e.preventDefault(); input.blur(); }
        // D-pad must be able to leave the field, otherwise results are unreachable
        else if (e.key === 'ArrowDown') { e.preventDefault(); input.blur(); focus.enter('main', 1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); input.blur(); focus.enter('main', 0); }
      });
      if (lastSearch) input.value = lastSearch.q;
      wrap.append(input, results);
      setMain('Search', wrap);
      render();                                        // restore previous results immediately
    },
    logout() {
      const item = document.querySelector('[data-nav="logout"]');
      if (logoutArmed) { AUTH.logout(); location.reload(); return; }
      logoutArmed = true;
      if (item) item.textContent = 'Press OK again to sign out';
      setTimeout(() => {
        logoutArmed = false;
        if (item) item.textContent = 'Sign out';
      }, 5000);
    },
  };

  async function go(v) {
    if (v.name === 'viz') { openViz(); return; }     // overlay: leave the current view intact underneath
    if (v.name === 'shuffle') { toggleShuffle(); return; }   // a toggle, not a destination
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
      if (cur) {
        // never pull DOM focus into the search field — that traps the D-pad. OK enters it.
        if (cur.tagName !== 'INPUT') { cur.tabIndex = -1; cur.focus({ preventScroll: true }); }
        else document.activeElement?.blur?.();
        cur.scrollIntoView({ block: 'nearest' });
      }
    },
    current() { return this.items(this.zone)[this.idx[this.zone]]; },
  };

  // Activate whatever actually holds DOM focus — works for sidebar, list rows, and the login button alike.
  function activateFocused() {
    const a = document.activeElement;
    const t = focus.current() || ((a && (a.dataset?.nav || a.onactivate)) ? a : null);
    if (!t) return;
    if (t.dataset?.nav) go({ name: t.dataset.nav }); else t.onactivate?.();
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
  window.onTvKey = (code, down = true) => {
    if (!down) return;
    if (code === 90) return seekBy(5000);
    if (code === 89) return seekBy(-5000);
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
    if (AUTH.scopesStale()) AUTH.logout();   // a newly-added scope needs a freshly issued token
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
