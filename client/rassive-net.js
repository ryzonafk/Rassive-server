/*
 * rassive-net.js - small browser client for the Rassive online rooms server.
 * Works as a plain <script> (window.RassiveNet) and in Node (module.exports) for tests.
 *
 *   const net = new RassiveNet({ url: RASSIVE_SERVER });
 *   await net.connect();                       // only when the player taps ONLINE
 *   const room = await net.createRoom({ mode: 'br', max: 4 });   // room.code = "KX7P2M"
 *   // or: await net.joinRoom('KX7P2M');
 *   net.on('start', m => ...); net.on('hit', m => ...); net.on('built', m => ...);
 *   every frame: net.sendInput({x,y,z,r,pi,w}); for (const o of net.remotes()) drawRemote(o);
 *
 * Kid-safe: there is no text chat here on purpose. Only net.sendEmote('gg') etc.
 */
(function (root) {
  'use strict';
  const r2 = v => Math.round(v * 100) / 100;
  const lerp = (a, b, t) => a + (b - a) * t;
  const lerpAngle = (a, b, t) => { let d = (b - a) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return a + d * t; };

  function RassiveNet(opts) {
    opts = opts || {};
    this.url = opts.url || root.RASSIVE_SERVER || 'ws://localhost:8080';
    this.WS = opts.WebSocket || root.WebSocket;
    this.inputHz = opts.inputHz || 20;
    this.interpMs = opts.interpMs || 100;
    this.connectTimeoutMs = opts.connectTimeoutMs || 75000; // Render free tier can take ~1 min to wake up
    this.ws = null; this.handlers = {}; this.pending = []; this.seq = 0;
    this.you = null; this.code = null; this.token = null; this.state = 'offline';
    this.buf = new Map();          // id -> [{ts,x,y,z,r,pi,hp,sh,w,f}]
    this.offset = null;            // serverTime - localTime
    this.rtt = 100; this.lastInput = 0; this.lastSent = null;
    this.userClosed = false; this.retries = 0; this.paused = false;
    this._pingTimer = null;
  }
  const P = RassiveNet.prototype;

  /* ---- events ---- */
  P.on = function (t, fn) { (this.handlers[t] = this.handlers[t] || []).push(fn); return this; };
  P.off = function (t, fn) { const a = this.handlers[t]; if (a) this.handlers[t] = a.filter(f => f !== fn); return this; };
  P.emit = function (t, m) { for (const f of (this.handlers[t] || []).slice()) { try { f(m); } catch (e) { console.error('[RassiveNet]', t, e); } } };
  P.onState = function (fn) { return this.on('s', fn); };
  P._status = function (s, extra) { this.state = s; this.emit('status', Object.assign({ status: s }, extra || {})); };

  /* ---- connection ---- */
  P.connect = function (url) {
    if (url) this.url = url;
    this.userClosed = false;
    return new Promise((resolve, reject) => {
      let done = false;
      const ws = new this.WS(this.url); this.ws = ws;
      this._status('connecting');
      const wake = setTimeout(() => { if (!done) this._status('waking'); }, 3000); // show "Waking up the server..."
      const fail = setTimeout(() => { if (!done) { done = true; try { ws.close(); } catch (e) {} this._status('offline'); reject(new Error('cant_reach_server')); } }, this.connectTimeoutMs);
      ws.onopen = () => { if (done) return; done = true; clearTimeout(wake); clearTimeout(fail); this._status('online'); this._startPing(); resolve(this); };
      ws.onerror = () => { if (!done) { done = true; clearTimeout(wake); clearTimeout(fail); this._status('offline'); reject(new Error('cant_reach_server')); } };
      ws.onmessage = ev => this._onMessage(ev.data);
      ws.onclose = ev => { clearTimeout(wake); clearTimeout(fail); this._stopPing(); if (this.ws === ws) this._onClose(ev); };
    });
  };
  P.close = function () { this.userClosed = true; this._stopPing(); if (this.ws) try { this.ws.close(1000, 'bye'); } catch (e) {} this.ws = null; this.code = null; this.token = null; this._status('offline'); };
  P._send = function (m) { if (this.ws && this.ws.readyState === 1 && !this.paused) { this.ws.send(JSON.stringify(m)); return true; } return false; };
  P._startPing = function () { this._stopPing(); const ping = () => this._send({ t: 'ping', c: Date.now(), rtt: Math.round(this.rtt) }); ping(); this._pingTimer = setInterval(ping, 2000); };
  P._stopPing = function () { if (this._pingTimer) clearInterval(this._pingTimer); this._pingTimer = null; };
  P._onClose = function (ev) {
    this.emit('close', { code: ev && ev.code, reason: ev && ev.reason && String(ev.reason) });
    if (this.userClosed || !this.token || this.retries >= 5 || (ev && (ev.code === 4002 || ev.code === 4001 || ev.code === 4008))) { this._status('offline'); this.emit('lost', {}); return; }
    // Wi-Fi blip: try to come back into the same room with our secret rejoin token.
    const wait = Math.min(8000, 1000 * Math.pow(2, this.retries++));
    this._status('reconnecting', { inMs: wait });
    setTimeout(() => {
      const code = this.code, token = this.token;
      this.connect().then(() => this._request({ t: 'rejoin', code, token }, 'joined')).then(() => { this.retries = 0; this.emit('reconnected', {}); })
        .catch(() => this._onClose({ code: 0 }));
    }, wait);
  };
  // Send a message and wait for a reply of type `want` (or an error).
  P._request = function (m, want, timeoutMs) {
    return new Promise((resolve, reject) => {
      const entry = { want, req: m.t, resolve, reject, timer: setTimeout(() => { this.pending = this.pending.filter(x => x !== entry); reject(new Error('timeout')); }, timeoutMs || 8000) };
      this.pending.push(entry);
      if (!this._send(m)) { clearTimeout(entry.timer); this.pending = this.pending.filter(x => x !== entry); reject(new Error('not_connected')); }
    });
  };

  P._onMessage = function (data) {
    let m; try { m = JSON.parse(typeof data === 'string' ? data : data.toString()); } catch (e) { return; }
    const t = Date.now();
    if (m.t === 'pong') { const rtt = t - m.c; this.rtt = lerp(this.rtt, rtt, 0.3); const off = m.s - (m.c + rtt / 2); this.offset = this.offset == null ? off : lerp(this.offset, off, 0.2); }
    if (m.t === 'joined') { this.you = m.you; this.code = m.code; this.token = m.token; if (m.interpMs) this.interpMs = m.interpMs; try { root.sessionStorage && root.sessionStorage.setItem('rassiveRejoin', JSON.stringify({ code: m.code, token: m.token })); } catch (e) {} }
    if (m.t === 'start') { this.buf.clear(); }
    if (m.t === 's') {
      if (this.offset == null) this.offset = m.ts - t;
      for (const p of m.p) {
        const id = p[0]; if (id === this.you) { this.me = p; continue; }
        let b = this.buf.get(id); if (!b) { b = []; this.buf.set(id, b); }
        b.push({ ts: m.ts, x: p[1], y: p[2], z: p[3], r: p[4], pi: p[5], hp: p[6], sh: p[7], w: p[8], f: p[9] });
        while (b.length > 30) b.shift();
      }
      for (const id of this.buf.keys()) if (!m.p.some(p => p[0] === id)) this.buf.delete(id);
    }
    if (m.t === 'error') {
      const i = this.pending.findIndex(x => x.req === m.re);
      if (i >= 0) { const e = this.pending.splice(i, 1)[0]; clearTimeout(e.timer); const er = new Error(m.code); er.code = m.code; e.reject(er); }
    } else if (m.t !== 'buildNo') {
      const i = this.pending.findIndex(x => x.want === m.t);
      if (i >= 0) { const e = this.pending.splice(i, 1)[0]; clearTimeout(e.timer); e.resolve(m); }
    }
    this.emit(m.t, m); this.emit('*', m);
  };

  /* ---- rooms ---- */
  P.createRoom = function (o) { o = o || {}; return this._request({ t: 'create', mode: o.mode || 'br', max: o.max || 4, skin: o.skin }, 'joined'); };
  P.joinRoom = function (code, o) { o = o || {}; return this._request({ t: 'join', code: String(code || '').trim().toUpperCase(), skin: o.skin }, 'joined'); };
  P.startMatch = function () { return this._request({ t: 'start' }, 'start'); };
  P.playAgain = function () { return this._send({ t: 'again' }); };
  P.leave = function () { this._send({ t: 'leave' }); this.code = null; this.token = null; this.buf.clear(); };

  /* ---- gameplay ---- */
  // Call every frame; it only really sends ~20 times a second, and skips if nothing changed.
  P.sendInput = function (s, force) {
    const t = Date.now(); if (!force && t - this.lastInput < 1000 / this.inputHz - 2) return false;
    const m = { t: 'p', x: r2(s.x), y: r2(s.y), z: r2(s.z), r: r2(s.r || 0), pi: r2(s.pi || 0) };
    if (s.w) m.w = s.w; if (s.v) m.v = 1; if (s.tp) m.tp = 1;
    const k = m.x + ',' + m.y + ',' + m.z + ',' + m.r + ',' + m.pi + ',' + m.w + ',' + (m.v || 0);
    if (!force && k === this.lastSent && t - this.lastInput < 500) return false; // idle: send 2x/s only
    this.lastInput = t; this.lastSent = k; return this._send(m);
  };
  // o and d are [x,y,z]; ds is an optional list of pellet directions for shotguns.
  P.sendShot = function (s) { const m = { t: 'shot', w: s.w, o: s.o.map(r2), d: s.d.map(v => Math.round(v * 1000) / 1000) }; if (s.ds) m.ds = s.ds.map(d => d.map(v => Math.round(v * 1000) / 1000)); return this._send(m); };
  P.sendReload = function () { return this._send({ t: 'reload' }); };
  P.sendEquip = function (w) { return this._send({ t: 'equip', w }); };
  // b = {type:'wall'|'floor'|'ramp', x,y,z (from planPiece), rot 0-3, mat}. Returns a seq number echoed in built/buildNo.
  P.sendBuild = function (b) { const s = ++this.seq; this._send({ t: 'build', type: b.type, x: b.x, y: r2(b.y), z: b.z, rot: b.rot | 0, mat: b.mat || 'wood', s }); return s; };
  P.sendHarvest = function (k) { return this._send({ t: 'harvest', k }); };
  P.sendEmote = function (e) { return this._send({ t: 'emote', e }); };

  /* ---- interpolation (draw other players 100 ms in the past) ---- */
  P.serverNow = function () { return Date.now() + (this.offset || 0); };
  P.sample = function (id, renderTs) {
    const b = this.buf.get(id); if (!b || !b.length) return null;
    const rt = renderTs != null ? renderTs : this.serverNow() - this.interpMs;
    if (rt <= b[0].ts) return Object.assign({ id }, b[0]);
    for (let i = b.length - 1; i > 0; i--) {
      const a = b[i - 1], c = b[i];
      if (a.ts <= rt) {
        if (rt > c.ts) { // ran out of snapshots: hold the last one (max 250 ms of guessing)
          const ex = Math.min(rt - c.ts, 250) / Math.max(1, c.ts - a.ts);
          return { id, x: lerp(a.x, c.x, 1 + ex), y: lerp(a.y, c.y, 1 + ex), z: lerp(a.z, c.z, 1 + ex), r: c.r, pi: c.pi, hp: c.hp, sh: c.sh, w: c.w, f: c.f, ts: rt };
        }
        const k = (rt - a.ts) / Math.max(1, c.ts - a.ts);
        return { id, x: lerp(a.x, c.x, k), y: lerp(a.y, c.y, k), z: lerp(a.z, c.z, k), r: lerpAngle(a.r, c.r, k), pi: lerp(a.pi, c.pi, k), hp: c.hp, sh: c.sh, w: c.w, f: c.f, ts: rt };
      }
    }
    return Object.assign({ id }, b[0]);
  };
  // All other players, smoothed. alive = !!(f & 1), online = !!(f & 2), protected = !!(f & 4).
  P.remotes = function (renderTs) { const out = []; for (const id of this.buf.keys()) { const s = this.sample(id, renderTs); if (s) { s.alive = !!(s.f & 1); s.online = !!(s.f & 2); out.push(s); } } return out; };

  /* ---- app pause (RASSIVE.appPause on Android) ---- */
  P.pause = function () { this.paused = true; };
  P.resume = function () { this.paused = false; if (!this.ws || this.ws.readyState > 1) this._onClose({ code: 0 }); };

  RassiveNet.EMOTES = ['wave', 'gg', 'lol', 'thumbs', 'wow', 'sorry', 'dance', 'heart'];
  RassiveNet.ERRORS = { // kid-friendly text for error codes
    no_room: 'No room with that code. Check the letters!', bad_code: 'Room codes have 6 letters and numbers.', room_full: 'That room is full.',
    in_progress: 'That match already started.', slow_down: 'Too many tries. Wait a minute.', need_players: 'You need a friend to start!',
    not_host: 'Only the host can start.', cant_reach_server: "Can't reach the server. Play offline?", server_full: 'The server is busy. Try again soon.',
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = RassiveNet; else root.RassiveNet = RassiveNet;
})(typeof window !== 'undefined' ? window : globalThis);
