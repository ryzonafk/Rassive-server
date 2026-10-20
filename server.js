'use strict';
/*
 * Rassive online rooms server (prototype).
 *  - Private 6-character room codes, 2-8 players per room, the host presses Start.
 *  - Clients send their OWN movement ~20x/second. The server checks speed and decides
 *    everything important: hits, damage, builds, storm, eliminations and who wins.
 *  - Kid-safe: no free-text chat (emotes only), server-made nicknames, nothing saved to disk.
 * Run: `npm start` (PORT env, default 8080). Health check: GET /health -> "ok".
 */
const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const D = require('./gamedata');

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L
const CODE_LEN = 6;
const CODE_RE = new RegExp('^[' + CODE_ALPHABET + ']{' + CODE_LEN + '}$');

const DEFAULTS = {
  tickHz: 20,
  maxPlayers: 8,
  minPlayersToStart: 2,
  maxPayload: 1024,          // bytes; bigger messages close the socket (ws code 1009)
  msgSoftPerSec: 60,         // over this, extra messages are dropped
  msgKickPerSec: 120,        // over this, the socket is kicked (code 4008)
  heartbeatMs: 10000,        // ws ping; two missed pongs = disconnect
  rejoinGraceMs: 30000,      // time to come back after Wi-Fi blips
  roomMaxAgeMs: 60 * 60 * 1000,
  maxRooms: 200,
  maxConnsPerIp: 12,
  joinFailsPerMin: 10,       // stops code guessing
  countdownMs: 3000,
  protMs: 3000,              // spawn protection after GO
  respawnMs: 3000,
  interpMs: 100,             // clients draw others 100 ms in the past
  maxRewindMs: 300,          // lag compensation cap
  runSpeed: 14,              // m/s allowance on foot (7.5 walk + jump pads, jetpack, slack)
  vehSpeed: 45,              // m/s allowance in vehicles
  allowedOrigins: process.env.ALLOWED_ORIGINS || '*', // comma list; "null" (file:// pages) is always allowed
  trustProxy: process.env.TRUST_PROXY === '1',
  trustLoot: true,           // v1: loot is still picked up client-side, so "equip" of any real gun is allowed
  testSpawns: null,          // [[x,z],...] for automated tests
  stormCenter: null,         // [x,z] for tests
  log: process.env.QUIET !== '1',
};

function createServer(opts = {}) {
  const C = Object.assign({}, DEFAULTS, opts);
  const rooms = new Map();
  const ipConns = new Map();   // ip -> open sockets
  const ipFails = new Map();   // ip -> [timestamps of bad codes]
  const log = (...a) => { if (C.log) console.log(new Date().toISOString().slice(11, 19), ...a); };
  const now = () => Date.now();
  const r2 = v => Math.round(v * 100) / 100;
  const fin = v => typeof v === 'number' && Number.isFinite(v);

  /* ---------------- HTTP: health check + friendly page ---------------- */
  const httpServer = http.createServer((req, res) => {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
    if (req.url === '/health') { res.writeHead(200, Object.assign({ 'Content-Type': 'text/plain' }, cors)); res.end('ok'); return; }
    if (req.url === '/') { res.writeHead(200, Object.assign({ 'Content-Type': 'text/plain' }, cors)); res.end('Rassive server is running. Rooms: ' + rooms.size + '\n'); return; }
    res.writeHead(404, cors); res.end();
  });

  function clientIp(req) {
    if (C.trustProxy) {
      const f = req.headers['fly-client-ip'] || (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      if (f) return f;
    }
    return req.socket.remoteAddress || '?';
  }
  function originOk(origin) {
    if (!origin || origin === 'null' || origin.startsWith('file://')) return true; // offline HTML + Android WebView
    if (C.allowedOrigins === '*') return true;
    return C.allowedOrigins.split(',').map(s => s.trim()).filter(Boolean).includes(origin);
  }

  const wss = new WebSocketServer({
    server: httpServer,
    maxPayload: C.maxPayload,
    perMessageDeflate: false,
    verifyClient: (info, cb) => {
      if (!originOk(info.origin)) { log('reject origin', info.origin); return cb(false, 403, 'Origin not allowed'); }
      const ip = clientIp(info.req);
      if ((ipConns.get(ip) || 0) >= C.maxConnsPerIp) return cb(false, 429, 'Too many connections');
      cb(true);
    },
  });

  /* ---------------- helpers ---------------- */
  function send(ws, m) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); }
  function err(ws, code, extra) { send(ws, Object.assign({ t: 'error', code, re: ws._c && ws._c.cur }, extra || {})); }
  function bcast(room, m, exceptId) { const s = JSON.stringify(m); for (const p of room.players.values()) if (p.ws && p.id !== exceptId && p.ws.readyState === 1) p.ws.send(s); }
  function newCode() { for (let k = 0; k < 50; k++) { let c = ''; const b = crypto.randomBytes(CODE_LEN); for (let i = 0; i < CODE_LEN; i++) c += CODE_ALPHABET[b[i] % CODE_ALPHABET.length]; if (!rooms.has(c)) return c; } return null; }
  function newNick(room) {
    for (let k = 0; k < 40; k++) {
      const n = D.NICK_A[crypto.randomInt(D.NICK_A.length)] + D.NICK_B[crypto.randomInt(D.NICK_B.length)] + crypto.randomInt(10, 100);
      if (![...room.players.values()].some(p => p.nick === n)) return n;
    }
    return 'Player' + crypto.randomInt(100, 1000);
  }
  function publicPlayer(p) { return { id: p.id, nick: p.nick, team: p.team, host: p.room.hostId === p.id, on: !!p.ws, skin: p.skin }; }
  function lobbyMsg(room) { return { t: 'lobby', code: room.code, mode: room.mode, max: room.max, state: room.state, host: room.hostId, players: [...room.players.values()].map(publicPlayer) }; }
  function invMsg(p) { const g = {}; for (const [k, v] of Object.entries(p.guns)) g[k] = [v.mag, v.res]; return { t: 'inv', wood: p.inv.wood, stone: p.inv.stone, metal: p.inv.metal, guns: g, w: p.w }; }
  function stormArr(room) { const s = room.storm; return s ? [r2(s.x), r2(s.z), r2(s.r), r2(s.tr), Math.max(0, Math.round(s.left)), s.phase, s.dmg] : null; }
  function buildArr(b) { return { id: b.id, type: b.type, mat: b.mat, x: b.x, y: b.y, z: b.z, rot: b.rot, hp: Math.round(b.hp), by: b.by }; }
  function aliveList(room) { return [...room.players.values()].filter(p => p.alive && p.inMatch); }

  function giveLoadout(p) {
    const M = p.room.M;
    p.guns = {};
    for (const id of M.load) p.guns[id] = { mag: D.GUNS[id].mag, res: D.GUNS[id].res };
    p.w = M.load[0] || 'pick';
    p.inv = { wood: M.wood || 0, stone: M.stone || 0, metal: M.metal || 0 };
  }
  function spawnPoint(room, i) {
    if (C.testSpawns && C.testSpawns[i]) { const [x, z] = C.testSpawns[i]; return [x, D.H(x, z), z]; }
    const s = room.storm, cx = s ? s.x : 0, cz = s ? s.z : 0, R = s ? Math.min(140, s.r * 0.6) : 120;
    for (let k = 0; k < 300; k++) {
      const a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * R, x = cx + Math.cos(a) * d, z = cz + Math.sin(a) * d;
      if (D.H(x, z) > 1.8 && [...room.players.values()].every(q => !q.inMatch || Math.hypot(q.x - x, q.z - z) > 12)) return [r2(x), r2(D.H(x, z)), r2(z)];
    }
    return [40, D.H(40, 0), 0];
  }
  function placeAt(p, pos) { p.x = pos[0]; p.y = pos[1]; p.z = pos[2]; p.lastPosT = now(); p.hist = [{ t: now(), x: p.x, y: p.y, z: p.z }]; }

  /* ---------------- rooms ---------------- */
  function makePlayer(ws, room) {
    const p = {
      id: 'p' + crypto.randomBytes(3).toString('hex'), token: crypto.randomBytes(16).toString('hex'), ws, room,
      nick: newNick(room), team: 0, skin: 'recruit', x: 0, y: 0, z: 0, r: 0, pi: 0, w: 'pick', v: 0,
      hp: 100, sh: 0, alive: true, inMatch: false, kills: 0, place: 0, guns: {}, inv: { wood: 0, stone: 0, metal: 0 },
      fireLog: [], lastFire: 0, reloadUntil: 0, reloadW: null, lastPosT: 0, hist: [], protUntil: 0, tpT: 0, harvestT: 0, buildT: 0, emoteT: 0,
      rtt: 100, viol: 0, offAt: 0, respawnAt: 0,
    };
    room.players.set(p.id, p);
    return p;
  }
  function attach(ws, p) { ws._c.room = p.room; ws._c.pid = p.id; p.ws = ws; p.offAt = 0; }
  function joinedMsg(p) {
    const room = p.room;
    return { t: 'joined', code: room.code, you: p.id, nick: p.nick, token: p.token, mode: room.mode, max: room.max, state: room.state, host: room.hostId, emotes: D.EMOTES, tickHz: C.tickHz, interpMs: C.interpMs, players: [...room.players.values()].map(publicPlayer) };
  }
  function startMsg(room, p) {
    return { t: 'start', mode: room.mode, countdownMs: Math.max(0, room.goAt - now()), you: p.id, team: p.team, spawn: [p.x, p.y, p.z], hp: p.hp, sh: p.sh,
      players: [...room.players.values()].filter(q => q.inMatch).map(publicPlayer), builds: [...room.builds.values()].map(buildArr), storm: stormArr(room), goal: room.M.goal || 0, score: room.teamScore };
  }
  function pickHost(room) {
    const cur = room.players.get(room.hostId);
    if (cur && cur.ws) return;
    const next = [...room.players.values()].find(q => q.ws);
    if (next && next.id !== room.hostId) { room.hostId = next.id; bcast(room, { t: 'host', id: next.id }); }
  }
  function removePlayer(room, p, why) {
    room.players.delete(p.id);
    if (room.state === 'play' && p.inMatch && p.alive) {
      p.alive = false;
      if (!room.M.respawn) bcast(room, { t: 'elim', tg: p.id, by: null, w: why || 'left', left: aliveList(room).length });
    }
    bcast(room, { t: 'left', id: p.id, why: why || 'left' });
    if (room.players.size === 0) { rooms.delete(room.code); log('room', room.code, 'closed (empty)'); return; }
    pickHost(room);
    if (room.state === 'lobby') bcast(room, lobbyMsg(room));
    if (room.state === 'play') checkWin(room);
  }

  /* ---------------- message handlers ---------------- */
  function onCreate(ws, m) {
    if (ws._c.room) return err(ws, 'already_in_room');
    if (rooms.size >= C.maxRooms) return err(ws, 'server_full');
    const mode = D.MODES[m.mode] ? m.mode : 'br';
    const M = D.MODES[mode];
    const max = Math.max(2, Math.min(C.maxPlayers, M.maxPlayers, fin(m.max) ? Math.floor(m.max) : M.maxPlayers));
    const code = newCode(); if (!code) return err(ws, 'server_full');
    const room = { code, mode, M, max, hostId: null, state: 'lobby', players: new Map(), builds: new Map(), buildKeys: new Map(), nextBuild: 1,
      tick: 0, created: now(), goAt: 0, storm: null, teamScore: [0, 0] };
    rooms.set(code, room);
    const p = makePlayer(ws, room); room.hostId = p.id; setSkin(p, m.skin); attach(ws, p);
    log('room', code, 'created', mode, 'max', max);
    send(ws, joinedMsg(p));
  }
  function joinFailed(ws, code) {
    const ip = ws._c.ip, a = (ipFails.get(ip) || []).filter(t => now() - t < 60000); a.push(now()); ipFails.set(ip, a);
    err(ws, code);
  }
  function onJoin(ws, m) {
    if (ws._c.room) return err(ws, 'already_in_room');
    const fails = (ipFails.get(ws._c.ip) || []).filter(t => now() - t < 60000);
    if (fails.length >= C.joinFailsPerMin) return err(ws, 'slow_down');
    const code = typeof m.code === 'string' ? m.code.trim().toUpperCase() : '';
    if (!CODE_RE.test(code)) return joinFailed(ws, 'bad_code');
    const room = rooms.get(code);
    if (!room) return joinFailed(ws, 'no_room');
    if (room.players.size >= room.max) return err(ws, 'room_full');
    if (room.state !== 'lobby' && !room.M.respawn) return err(ws, 'in_progress');
    const p = makePlayer(ws, room); setSkin(p, m.skin); attach(ws, p);
    send(ws, joinedMsg(p));
    if (room.state === 'lobby') bcast(room, lobbyMsg(room));
    else { // late join in respawn modes
      bcast(room, { t: 'joinedMatch', p: publicPlayer(p) }, p.id);
      enterMatch(room, p, room.players.size - 1);
      send(ws, startMsg(room, p)); send(ws, invMsg(p));
    }
  }
  function onRejoin(ws, m) {
    if (ws._c.room) return err(ws, 'already_in_room');
    const room = rooms.get(typeof m.code === 'string' ? m.code.toUpperCase() : '');
    const p = room && typeof m.token === 'string' && [...room.players.values()].find(q => q.token === m.token);
    if (!p) return err(ws, 'rejoin_failed');
    if (p.ws && p.ws !== ws) { try { p.ws._c.room = null; p.ws.close(4001, 'replaced'); } catch (e) { /* ignore */ } }
    attach(ws, p);
    log('room', room.code, p.nick, 'rejoined');
    send(ws, joinedMsg(p));
    bcast(room, { t: 'back', id: p.id }, p.id);
    if (room.state !== 'lobby' && p.inMatch) { send(ws, startMsg(room, p)); send(ws, invMsg(p)); if (!p.alive) send(ws, { t: 'youDied' }); }
    pickHost(room);
  }
  function setSkin(p, s) { if (typeof s === 'string' && /^[a-z0-9_]{1,16}$/.test(s)) p.skin = s; }
  function enterMatch(room, p, i) {
    p.inMatch = true; p.alive = true; p.hp = 100; p.sh = room.M.shieldOnSpawn || 0; p.kills = 0; p.place = 0; p.viol = 0;
    p.fireLog = []; p.reloadUntil = 0; p.respawnAt = 0;
    if (room.M.teams) { const t0 = [...room.players.values()].filter(q => q.inMatch && q.team === 0 && q !== p).length, t1 = [...room.players.values()].filter(q => q.inMatch && q.team === 1 && q !== p).length; p.team = t0 <= t1 ? 0 : 1; }
    else p.team = i + 1; // free-for-all: everyone on their own team
    giveLoadout(p);
    placeAt(p, spawnPoint(room, i));
    p.protUntil = Math.max(room.goAt, now()) + C.protMs;
  }
  function onStart(ws, m, p, room) {
    if (room.hostId !== p.id) return err(ws, 'not_host');
    if (room.state !== 'lobby') return err(ws, 'already_started');
    const n = [...room.players.values()].filter(q => q.ws).length;
    if (n < C.minPlayersToStart) return err(ws, 'need_players', { need: C.minPlayersToStart });
    room.state = 'countdown'; room.goAt = now() + C.countdownMs; room.builds.clear(); room.buildKeys.clear(); room.teamScore = [0, 0];
    if (room.M.storm) {
      let c = C.stormCenter;
      if (!c) { for (let k = 0; k < 200; k++) { const x = (Math.random() * 2 - 1) * 60, z = (Math.random() * 2 - 1) * 60; if (D.H(x, z) > 1.8) { c = [x, z]; break; } } }
      c = c || [40, 0];
      room.storm = { x: c[0], z: c[1], r: 230, tr: 230, t: 0, phase: 0, left: 45, dmg: 1, tickAcc: 0 };
    } else room.storm = null;
    let i = 0; for (const q of room.players.values()) { if (q.ws) enterMatch(room, q, i++); else q.inMatch = false; }
    for (const q of room.players.values()) if (q.inMatch) { send(q.ws, startMsg(room, q)); send(q.ws, invMsg(q)); }
    log('room', room.code, 'start', room.mode, 'players', i);
  }
  function onAgain(ws, m, p, room) {
    if (room.hostId !== p.id) return err(ws, 'not_host');
    if (room.state !== 'over') return err(ws, 'not_over');
    room.state = 'lobby'; room.builds.clear(); room.buildKeys.clear(); room.storm = null;
    for (const q of room.players.values()) { q.inMatch = false; q.alive = true; }
    bcast(room, lobbyMsg(room));
  }

  // Movement: client-side prediction, server sanity check (speed + map bounds), snap back on cheating.
  function onPos(ws, m, p, room) {
    if (room.state !== 'play' && room.state !== 'countdown') return;
    if (!p.inMatch || !p.alive) return;
    if (!fin(m.x) || !fin(m.y) || !fin(m.z)) return;
    if (fin(m.r)) p.r = r2(m.r % (Math.PI * 2)); if (fin(m.pi)) p.pi = r2(D.clamp(m.pi, -1.6, 1.6));
    if (typeof m.w === 'string' && (m.w === 'pick' || p.guns[m.w])) p.w = m.w;
    p.v = m.v ? 1 : 0;
    const t = now(), dt = D.clamp((t - p.lastPosT) / 1000, 0.05, 1.5);
    const x = D.clamp(m.x, -D.MAP_HALF - 5, D.MAP_HALF + 5), z = D.clamp(m.z, -D.MAP_HALF - 5, D.MAP_HALF + 5), y = D.clamp(m.y, -20, 250);
    const horiz = Math.hypot(x - p.x, z - p.z), up = y - p.y;
    const maxH = (p.v ? C.vehSpeed : C.runSpeed) * dt * 1.25 + 1.5, maxUp = (p.v ? 40 : 32) * dt + 1.5, maxDown = 80 * dt + 2;
    const teleportOk = m.tp && t - p.tpT > 4000; // portals: at most one long jump per 4 s (TODO: check real portal spots)
    if (room.state === 'countdown' && horiz > 8) return send(ws, { t: 'corr', x: p.x, y: p.y, z: p.z });
    if ((horiz > maxH || up > maxUp || -up > maxDown) && !teleportOk) {
      p.viol++; send(ws, { t: 'corr', x: p.x, y: p.y, z: p.z, why: 'speed' }); p.lastPosT = t; return;
    }
    if (m.tp && (horiz > maxH || up > maxUp)) p.tpT = t;
    p.x = r2(x); p.y = r2(y); p.z = r2(z); p.lastPosT = t;
    p.hist.push({ t, x: p.x, y: p.y, z: p.z }); while (p.hist.length && t - p.hist[0].t > 1000) p.hist.shift();
  }
  function posAt(p, t) { // lag compensation: where was p at time t?
    const h = p.hist; if (!h.length) return { x: p.x, y: p.y, z: p.z };
    if (t >= h[h.length - 1].t) return h[h.length - 1];
    for (let i = h.length - 1; i > 0; i--) { const a = h[i - 1], b = h[i]; if (a.t <= t) { const k = (t - a.t) / Math.max(1, b.t - a.t); return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, z: a.z + (b.z - a.z) * k }; } }
    return h[0];
  }

  function rayBox(o, d, b, maxT) {
    let t0 = 0, t1 = maxT;
    for (const [oa, da, mn, mx] of [[o[0], d[0], b.x0, b.x1], [o[1], d[1], b.y0, b.y1], [o[2], d[2], b.z0, b.z1]]) {
      if (Math.abs(da) < 1e-9) { if (oa < mn || oa > mx) return -1; continue; }
      let a = (mn - oa) / da, c = (mx - oa) / da; if (a > c) { const s = a; a = c; c = s; }
      t0 = Math.max(t0, a); t1 = Math.min(t1, c); if (t0 > t1) return -1;
    }
    return t0;
  }
  function rampSurf(b, x, z) { const L = D.CELL, t = b.rot === 1 ? (x - b.box.x0) / L : b.rot === 2 ? (z - b.box.z0) / L : b.rot === 3 ? (b.box.x1 - x) / L : (b.box.z1 - z) / L; return b.y + 4 * D.clamp(t, 0, 1); }
  function rayPiece(o, d, b, maxT) {
    const t = rayBox(o, d, b.box, maxT); if (t < 0) return -1;
    if (b.type !== 'ramp') return t;
    const tExit = (() => { let e = maxT; for (let s = t; s <= maxT; s += 0.2) { const x = o[0] + d[0] * s, y = o[1] + d[1] * s, z = o[2] + d[2] * s; if (x < b.box.x0 - 0.01 || x > b.box.x1 + 0.01 || z < b.box.z0 - 0.01 || z > b.box.z1 + 0.01 || y < b.box.y0 - 0.01 || y > b.box.y1 + 0.01) { e = s; break; } } return e; })();
    const side = s => { const x = o[0] + d[0] * s, z = o[2] + d[2] * s; return o[1] + d[1] * s - rampSurf(b, x, z); };
    let prev = side(t); if (Math.abs(prev) < 0.2) return t;
    for (let s = t + 0.1; s <= tExit; s += 0.1) { const v = side(s); if (Math.sign(v) !== Math.sign(prev) || Math.abs(v) < 0.2) return s; prev = v; }
    return -1;
  }
  function terrainHit(o, d, maxT) { // "LOS-light": march the ray over the real terrain height
    for (let s = 1; s < maxT; s += 1) { const x = o[0] + d[0] * s, z = o[2] + d[2] * s; if (Math.max(D.H(x, z), -1.05) > o[1] + d[1] * s) return s; }
    return -1;
  }
  // Cast one bullet. Returns the closest thing it hits: player, build, terrain or nothing.
  function castRay(room, shooter, o, d, range, rewindT) {
    let best = { kind: null, t: range };
    const tt = terrainHit(o, d, range); if (tt >= 0) best = { kind: 'terrain', t: tt };
    for (const b of room.builds.values()) { const t = rayPiece(o, d, b, best.t); if (t >= 0 && t < best.t) best = { kind: 'build', t, b }; }
    for (const q of room.players.values()) {
      if (q === shooter || !q.inMatch || !q.alive) continue;
      const P = posAt(q, rewindT), HB = D.HITBOX;
      const t = rayBox(o, d, { x0: P.x - HB.r, x1: P.x + HB.r, y0: P.y, y1: P.y + HB.h, z0: P.z - HB.r, z1: P.z + HB.r }, best.t);
      if (t >= 0 && t < best.t) best = { kind: 'player', t, q, head: o[1] + d[1] * t > P.y + HB.headY };
    }
    best.at = [o[0] + d[0] * best.t, o[1] + d[1] * best.t, o[2] + d[2] * best.t];
    return best;
  }
  function norm(v) { if (!Array.isArray(v) || v.length !== 3 || !v.every(fin)) return null; const L = Math.hypot(v[0], v[1], v[2]); if (L < 0.9 || L > 1.1) return null; return [v[0] / L, v[1] / L, v[2] / L]; }

  function onReload(ws, m, p, room) {
    if (room.state !== 'play' || !p.alive) return;
    const g = p.guns[p.w]; if (!g) return; const G = D.GUNS[p.w];
    if (g.mag >= G.mag || g.res <= 0 || p.reloadUntil > now()) return;
    p.reloadUntil = now() + G.reload * 1000 * 0.85; p.reloadW = p.w;
  }
  function finishReload(p) {
    if (!p.reloadUntil || now() < p.reloadUntil) return;
    const g = p.guns[p.reloadW], G = D.GUNS[p.reloadW];
    if (g && G) { const take = Math.min(G.mag - g.mag, g.res); g.mag += take; g.res -= take; send(p.ws, invMsg(p)); }
    p.reloadUntil = 0; p.reloadW = null;
  }
  function onEquip(ws, m, p, room) {
    if (typeof m.w !== 'string') return;
    if (m.w === 'pick' || p.guns[m.w]) { p.w = m.w; return; }
    if (C.trustLoot && D.GUNS[m.w] && Object.keys(p.guns).length < 5 && room.state === 'play') { // v1: client picked it up from loot
      p.guns[m.w] = { mag: D.GUNS[m.w].mag, res: D.GUNS[m.w].res }; p.w = m.w; send(ws, invMsg(p));
    } else err(ws, 'no_weapon');
  }

  function onShot(ws, m, p, room) {
    if (room.state !== 'play') return err(ws, 'not_playing');
    if (!p.alive) return;
    const w = typeof m.w === 'string' ? m.w : p.w;
    const G = w === 'pick' ? D.PICK : D.GUNS[w];
    if (!G) return err(ws, 'bad_weapon');
    const g = w === 'pick' ? null : p.guns[w];
    if (w !== 'pick' && !g) return err(ws, 'no_weapon');
    const t = now();
    finishReload(p);
    if (p.reloadUntil && p.reloadW === w) return err(ws, 'reloading');
    // fire-rate check (burst guns may fire their burst quickly, but not more per second)
    const per = (G.burst || 1);
    const minGap = G.burst ? 55 : (1000 / G.rate) * 0.85;
    p.fireLog = p.fireLog.filter(f => t - f < 1000);
    if (t - p.lastFire < minGap || p.fireLog.length >= Math.ceil(G.rate * per * 1.15) + 1) return err(ws, 'too_fast');
    if (g && g.mag <= 0) return err(ws, 'empty');
    const o = m.o, d = norm(m.d);
    if (!Array.isArray(o) || o.length !== 3 || !o.every(fin) || !d) return err(ws, 'bad_shot');
    const eye = [p.x, p.y + D.HITBOX.eye, p.z];
    if (Math.hypot(o[0] - eye[0], o[1] - eye[1], o[2] - eye[2]) > (p.v ? 8 : 2.5)) return err(ws, 'bad_origin');
    p.lastFire = t; p.fireLog.push(t); p.w = w;
    if (g) g.mag--;
    // pellets: every pellet must point roughly where the player aimed
    let dirs = [d];
    if (G.pellets && Array.isArray(m.ds) && m.ds.length) {
      dirs = m.ds.slice(0, G.pellets).map(norm).filter(v => v && Math.acos(D.clamp(v[0] * d[0] + v[1] * d[1] + v[2] * d[2], -1, 1)) <= G.spread * 5 + 0.05);
      if (!dirs.length) dirs = [d];
    } else if (G.pellets) { // no pellet list sent: the server rolls the spread itself (same as src/game3.js playerFire)
      dirs = [];
      for (let k = 0; k < G.pellets; k++) { const sp = G.spread, v = [d[0] + (Math.random() * 2 - 1) * sp, d[1] + (Math.random() * 2 - 1) * sp, d[2] + (Math.random() * 2 - 1) * sp], L = Math.hypot(...v); dirs.push(v.map(c => c / L)); }
    }
    const rewindT = t - Math.min(C.maxRewindMs, p.rtt / 2 + C.interpMs);
    const dmgTo = new Map(); const builds = new Map(); let boom = null;
    for (const dir of dirs) {
      const hit = castRay(room, p, o, dir, G.range, rewindT);
      if (G.splash) { if (hit.kind) { boom = hit.at; } break; }
      if (hit.kind === 'player') {
        const fall = w === 'pick' ? 1 : D.clamp(1 - (hit.t / G.range) * 0.4, 0.6, 1);
        const cur = dmgTo.get(hit.q) || { dmg: 0, head: false };
        cur.dmg += G.dmg * fall * (hit.head ? 1.5 : 1); cur.head = cur.head || hit.head; dmgTo.set(hit.q, cur);
      } else if (hit.kind === 'build') builds.set(hit.b, (builds.get(hit.b) || 0) + (w === 'pick' ? D.PICK.pieceDmg : G.dmg));
    }
    if (boom) {
      bcast(room, { t: 'boom', by: p.id, w, x: r2(boom[0]), y: r2(boom[1]), z: r2(boom[2]), r: G.splash });
      for (const q of room.players.values()) {
        if (q === p || !q.inMatch || !q.alive) continue;
        const dd = Math.hypot(q.x - boom[0], q.y + 1 - boom[1], q.z - boom[2]);
        if (dd < G.splash) dmgTo.set(q, { dmg: G.dmg * (1 - (dd / G.splash) * 0.6), head: false });
      }
      for (const b of room.builds.values()) if (Math.hypot(b.cx - boom[0], b.cy - boom[1], b.cz - boom[2]) < G.splash + 1.5) builds.set(b, G.dmg * 1.5);
    }
    // tell others to draw the tracer (the shooter already drew it)
    bcast(room, { t: 'shot', by: p.id, w, o: o.map(r2), d: d.map(v => Math.round(v * 1000) / 1000) }, p.id);
    for (const [b, dmg] of builds) hitBuild(room, b, dmg);
    for (const [q, h] of dmgTo) applyDmg(room, q, p, h.dmg, h.head, w === 'pick' ? 'Pickaxe' : G.name);
    if (g && (g.mag === 0)) send(ws, invMsg(p));
  }
  function applyDmg(room, q, src, dmg, head, wname) {
    if (!q.alive || room.state !== 'play') return;
    if (q.protUntil > now()) return;
    if (src && src !== q && room.M.teams && src.team === q.team) return; // no friendly fire
    if (room.M.oneShot && src) dmg = 999;
    dmg = Math.round(dmg);
    const sd = Math.min(q.sh, dmg); q.sh -= sd; q.hp -= dmg - sd;
    bcast(room, { t: 'hit', tg: q.id, by: src ? src.id : 'storm', dmg, hd: head ? 1 : 0, hp: Math.max(0, q.hp), sh: q.sh });
    if (q.hp <= 0) eliminate(room, q, src, wname);
  }
  function eliminate(room, q, src, wname) {
    q.alive = false; q.hp = 0; q.sh = 0;
    if (src && src !== q) src.kills++;
    if (src && src !== q && room.M.teams) room.teamScore[src.team]++;
    const left = aliveList(room).length;
    if (!room.M.respawn) q.place = left + 1;
    else q.respawnAt = now() + C.respawnMs;
    bcast(room, { t: 'elim', tg: q.id, by: src ? src.id : 'storm', w: wname || 'Storm', left, score: room.M.teams ? room.teamScore : undefined, respawnMs: room.M.respawn ? C.respawnMs : undefined });
    checkWin(room);
  }
  function checkWin(room) {
    if (room.state !== 'play') return;
    const inM = [...room.players.values()].filter(q => q.inMatch);
    let winner = null, team = null;
    if (!room.M.respawn) {
      const alive = aliveList(room);
      if (alive.length > 1) return;
      winner = alive[0] || null; if (winner) winner.place = 1;
    } else if (room.M.teams) {
      const ti = room.teamScore.findIndex(s => s >= room.M.goal);
      const teamsLeft = new Set(inM.map(q => q.team));
      if (ti < 0 && teamsLeft.size > 1) return;
      team = ti >= 0 ? ti : [...teamsLeft][0];
    } else {
      winner = inM.find(q => q.kills >= room.M.goal);
      if (!winner && inM.length > 1) return;
      winner = winner || inM[0] || null;
    }
    room.state = 'over';
    const ranks = inM.map(q => ({ id: q.id, nick: q.nick, kills: q.kills, place: q.place || (q === winner ? 1 : 0), team: q.team })).sort((a, b) => (a.place || 99) - (b.place || 99) || b.kills - a.kills);
    bcast(room, { t: 'end', winner: winner ? winner.id : null, team, ranks, score: room.M.teams ? room.teamScore : undefined });
    log('room', room.code, 'over, winner', winner ? winner.nick : team != null ? 'team ' + team : 'nobody');
  }

  // Builds: grid snapped like src/game3.js planPiece; server checks mats, empty cell, distance.
  function onBuild(ws, m, p, room) {
    const no = why => send(ws, { t: 'buildNo', why, s: m.s });
    if (room.state !== 'play' || !p.alive) return no('not_playing');
    const type = m.type, mat = m.mat || 'wood';
    if (!['wall', 'floor', 'ramp'].includes(type)) return no('bad_type');
    if (!D.MATS[mat]) return no('bad_mat');
    if (!fin(m.x) || !fin(m.y) || !fin(m.z)) return no('bad_pos');
    const rot = fin(m.rot) ? ((Math.floor(m.rot) % 4) + 4) % 4 : 0;
    const x = Math.round(m.x * 100) / 100, z = Math.round(m.z * 100) / 100, y = Math.round(m.y * 100) / 100;
    const on = (v, off) => Math.abs((((v - off) % 4) + 4) % 4) < 0.01 || Math.abs((((v - off) % 4) + 4) % 4 - 4) < 0.01;
    const ax = rot === 1 || rot === 3;
    let ok, key, box;
    if (type === 'wall') {
      ok = ax ? on(x, 0) && on(z, 2) : on(z, 0) && on(x, 2);
      key = 'w' + Math.round(x) + ',' + Math.round(z) + ',' + Math.round(y);
      box = ax ? { x0: x - 0.15, x1: x + 0.15, z0: z - 2, z1: z + 2, y0: y, y1: y + 4 } : { x0: x - 2, x1: x + 2, z0: z - 0.15, z1: z + 0.15, y0: y, y1: y + 4 };
    } else {
      ok = on(x, 2) && on(z, 2);
      const tx = Math.floor(x / 4), tz = Math.floor(z / 4);
      key = (type === 'floor' ? 'f' : 'r') + tx + ',' + tz + ',' + Math.round(y);
      box = type === 'floor' ? { x0: x - 2, x1: x + 2, z0: z - 2, z1: z + 2, y0: y - 0.3, y1: y } : { x0: x - 2, x1: x + 2, z0: z - 2, z1: z + 2, y0: y, y1: y + 4 };
    }
    if (!ok) return no('off_grid');
    if (y < -8 || y > 200) return no('bad_pos');
    if (Math.abs(x) > D.MAP_HALF || Math.abs(z) > D.MAP_HALF) return no('off_map');
    if (Math.hypot(x - p.x, z - p.z) > 8 || Math.abs(y - p.y) > 6.5) return no('too_far');
    if (room.buildKeys.has(key)) return no('taken');
    if (p.inv[mat] < D.BCOST) return no('need_mats');
    if (now() - p.buildT < 90) return no('too_fast');
    p.buildT = now(); p.inv[mat] -= D.BCOST;
    const b = { id: room.nextBuild++, type, mat, x, y, z, rot, key, box, by: p.id, hp: D.MATS[mat] * (type === 'wall' ? 1 : 0.93),
      cx: x, cy: type === 'floor' ? y - 0.15 : y + 2, cz: z };
    room.builds.set(b.id, b); room.buildKeys.set(key, b.id);
    if (room.builds.size > 3000) { const first = room.builds.values().next().value; removeBuild(room, first); }
    bcast(room, Object.assign({ t: 'built', s: m.s }, buildArr(b)));
    send(ws, invMsg(p));
  }
  function hitBuild(room, b, dmg) {
    b.hp -= dmg;
    if (b.hp <= 0) removeBuild(room, b); else bcast(room, { t: 'buildHp', id: b.id, hp: Math.round(b.hp) });
  }
  function removeBuild(room, b) { room.builds.delete(b.id); room.buildKeys.delete(b.key); bcast(room, { t: 'buildGone', id: b.id }); }

  function onHarvest(ws, m, p, room) { // pickaxe on trees/rocks/scrap (world objects are still client-side in v1)
    if (room.state !== 'play' || !p.alive) return;
    const k = D.HARVEST[m.k] ? m.k : null; if (!k) return;
    if (now() - p.harvestT < 400) return err(ws, 'too_fast');
    p.harvestT = now(); p.inv[k] = Math.min(999, p.inv[k] + D.HARVEST[k]); send(ws, invMsg(p));
  }
  function onEmote(ws, m, p, room) {
    if (!D.EMOTES.includes(m.e)) return err(ws, 'bad_emote');
    if (now() - p.emoteT < 1000) return;
    p.emoteT = now(); bcast(room, { t: 'emote', id: p.id, e: m.e });
  }

  const ROOM_HANDLERS = { start: onStart, again: onAgain, p: onPos, shot: onShot, reload: onReload, equip: onEquip, build: onBuild, harvest: onHarvest, emote: onEmote };

  /* ---------------- connections ---------------- */
  wss.on('connection', (ws, req) => {
    const ip = clientIp(req);
    ipConns.set(ip, (ipConns.get(ip) || 0) + 1);
    ws._c = { ip, room: null, pid: null, win: now(), count: 0, alive: true };
    ws.on('pong', () => { ws._c.alive = true; });
    ws.on('message', (data, isBinary) => {
      const c = ws._c;
      const t = now(); if (t - c.win >= 1000) { c.win = t; c.count = 0; }
      c.count++;
      if (c.count > C.msgKickPerSec) { log('kick (flood)'); ws.close(4008, 'too_many_messages'); return; }
      if (c.count > C.msgSoftPerSec) return; // drop
      if (isBinary) return;
      let m; try { m = JSON.parse(data.toString()); } catch (e) { return err(ws, 'bad_json'); }
      if (!m || typeof m !== 'object' || typeof m.t !== 'string') return err(ws, 'bad_msg');
      c.cur = m.t.slice(0, 16);
      try {
        if (m.t === 'ping') { const p = c.room && c.room.players.get(c.pid); if (p && fin(m.rtt)) p.rtt = D.clamp(m.rtt, 0, 1000); return send(ws, { t: 'pong', c: m.c, s: now() }); }
        if (m.t === 'create') return onCreate(ws, m);
        if (m.t === 'join') return onJoin(ws, m);
        if (m.t === 'rejoin') return onRejoin(ws, m);
        const room = c.room, p = room && room.players.get(c.pid);
        if (m.t === 'leave') { if (p) { c.room = null; removePlayer(room, p, 'left'); } return; }
        const h = ROOM_HANDLERS[m.t];
        if (!h) return err(ws, 'unknown_type', { type: m.t.slice(0, 16) }); // there is no free-text chat on purpose
        if (!p) return err(ws, 'not_in_room');
        h(ws, m, p, room);
      } catch (e) { log('handler error', e && e.stack); err(ws, 'server_error'); }
    });
    ws.on('close', () => {
      ipConns.set(ip, Math.max(0, (ipConns.get(ip) || 1) - 1)); if (!ipConns.get(ip)) ipConns.delete(ip);
      const room = ws._c.room, p = room && room.players.get(ws._c.pid);
      if (!p || p.ws !== ws) return;
      p.ws = null; p.offAt = now();
      if (room.state === 'lobby') { removePlayer(room, p, 'left'); return; }
      bcast(room, { t: 'away', id: p.id, graceMs: C.rejoinGraceMs });
      pickHost(room);
    });
    ws.on('error', () => {});
  });

  /* ---------------- game loop ---------------- */
  function stormStep(room, dt) {
    const s = room.storm; if (!s) return;
    s.t += dt; let t = s.t, i = 0, prev = 230;
    while (t > D.STORM_PH[i][0]) { t -= D.STORM_PH[i][0]; prev = D.STORM_PH[i][2]; i++; }
    const ph = D.STORM_PH[i];
    s.r = ph[1] ? D.lerp(prev, ph[2], t / ph[0]) : ph[2]; s.tr = ph[2]; s.dmg = 1 + Math.floor(i / 2); s.phase = i; s.left = ph[0] - t;
    s.tickAcc += dt;
    if (s.tickAcc >= 1) {
      s.tickAcc -= 1;
      for (const q of room.players.values()) if (q.inMatch && q.alive && Math.hypot(q.x - s.x, q.z - s.z) > s.r) applyDmg(room, q, null, s.dmg, false, 'Storm');
    }
  }
  let lastTick = now();
  function tick() {
    const t = now(), dt = Math.min(0.25, (t - lastTick) / 1000); lastTick = t;
    for (const room of [...rooms.values()]) {
      if (t - room.created > C.roomMaxAgeMs) { bcast(room, { t: 'closed', why: 'too_old' }); for (const p of room.players.values()) if (p.ws) { p.ws._c.room = null; p.ws.close(4002, 'room_closed'); } rooms.delete(room.code); continue; }
      for (const p of [...room.players.values()]) if (!p.ws && p.offAt && t - p.offAt > C.rejoinGraceMs) removePlayer(room, p, 'timeout');
      if (!rooms.has(room.code)) continue;
      if (room.state === 'countdown' && t >= room.goAt) { room.state = 'play'; bcast(room, { t: 'go' }); }
      if (room.state === 'play') {
        stormStep(room, dt);
        for (const p of room.players.values()) {
          finishReload(p);
          if (room.M.respawn && !p.alive && p.inMatch && p.respawnAt && t >= p.respawnAt && room.state === 'play') {
            p.alive = true; p.hp = 100; p.sh = room.M.shieldOnSpawn || 0; p.respawnAt = 0; p.protUntil = t + C.protMs;
            for (const [id, g] of Object.entries(p.guns)) { g.mag = D.GUNS[id].mag; g.res = Math.max(g.res, D.GUNS[id].res); }
            placeAt(p, spawnPoint(room, crypto.randomInt(100)));
            bcast(room, { t: 'respawn', id: p.id, x: p.x, y: p.y, z: p.z, hp: p.hp, sh: p.sh });
            send(p.ws, invMsg(p));
          }
        }
      }
      if (room.state === 'play' || room.state === 'countdown') {
        room.tick++;
        const ps = [];
        for (const p of room.players.values()) if (p.inMatch) ps.push([p.id, p.x, p.y, p.z, p.r, p.pi, Math.max(0, Math.round(p.hp)), Math.round(p.sh), p.w, (p.alive ? 1 : 0) | (p.ws ? 2 : 0) | (p.protUntil > t ? 4 : 0) | (p.v ? 8 : 0)]);
        const snap = { t: 's', tk: room.tick, ts: t, p: ps };
        if (room.storm && room.tick % 5 === 0) snap.st = stormArr(room);
        bcast(room, snap);
      }
    }
  }
  const tickTimer = setInterval(tick, 1000 / C.tickHz);
  const hbTimer = setInterval(() => {
    for (const ws of wss.clients) { if (!ws._c.alive) { ws.terminate(); continue; } ws._c.alive = false; try { ws.ping(); } catch (e) { /* ignore */ } }
    for (const [ip, a] of ipFails) { const f = a.filter(x => now() - x < 60000); if (f.length) ipFails.set(ip, f); else ipFails.delete(ip); }
  }, C.heartbeatMs);

  return {
    rooms, wss, httpServer, config: C,
    listen(port) { return new Promise(res => httpServer.listen(port, () => { const a = httpServer.address().port; log('Rassive server listening on port', a); res(a); })); },
    close() { clearInterval(tickTimer); clearInterval(hbTimer); for (const ws of wss.clients) ws.terminate(); return new Promise(res => wss.close(() => httpServer.close(() => res()))); },
  };
}

module.exports = { createServer, CODE_ALPHABET, CODE_LEN };

if (require.main === module) {
  const srv = createServer();
  srv.listen(Number(process.env.PORT) || 8080);
  const stop = () => { srv.close().then(() => process.exit(0)); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
