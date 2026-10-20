'use strict';
// Automated match test: starts the real server and plays 3 fake clients (plus 1 troublemaker)
// through create -> join -> start -> move -> shoot -> hit -> build -> rejoin -> elimination -> win.
// Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const WS = require('ws');
const { createServer, CODE_ALPHABET } = require('../server');
const RassiveNet = require('../client/rassive-net');
const D = require('../gamedata');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const OriginNullWS = class extends WS { constructor(url) { super(url, { origin: 'null' }); } }; // like the offline rassive.html

// Find 3 spots 8 m apart on flat land with clear line of sight, so shots are predictable.
function findSpawns() {
  for (let z0 = -100; z0 < 100; z0 += 3) for (let x0 = -120; x0 < 100; x0 += 3) {
    const pts = [0, 1, 2].map(k => [x0 + 8 * k + 1, z0 + 2]); // +1/+2 keeps players inside a build cell
    const hs = pts.map(([x, z]) => D.H(x, z));
    if (hs.some(h => h < 2) || Math.max(...hs) - Math.min(...hs) > 0.6) continue;
    let clear = true;
    for (let x = x0; x <= x0 + 18; x += 0.5) if (D.H(x, z0 + 2) > Math.min(...hs) + 0.7) clear = false;
    if (clear && Math.floor(pts[0][0] / 4) !== Math.floor(pts[1][0] / 4)) return pts;
  }
  throw new Error('no flat spot');
}

function bot(url, name) {
  const n = new RassiveNet({ url, WebSocket: OriginNullWS, connectTimeoutMs: 3000 });
  n.name = name; n.log = [];
  n.on('*', m => n.log.push(m));
  n.on('reconnected', () => n.log.push({ t: 'reconnected' }));
  n.mark = () => n.log.length;
  n.waitFor = (type, pred, since = 0, ms = 3000) => new Promise((res, rej) => {
    const t0 = Date.now();
    (function poll() {
      const m = n.log.slice(since).find(x => x.t === type && (!pred || pred(x)));
      if (m) return res(m);
      if (Date.now() - t0 > ms) return rej(new Error(name + ' timed out waiting for ' + type));
      setTimeout(poll, 10);
    })();
  });
  return n;
}
const aim = (from, to) => { const o = [from.x, from.y + D.HITBOX.eye, from.z], t = [to.x, to.y + 1.2, to.z]; const d = t.map((v, i) => v - o[i]); const L = Math.hypot(...d); return { o, d: d.map(v => v / L) }; };

test('Rassive online rooms: full match', async t => {
  const spawns = findSpawns();
  const srv = createServer({ log: false, countdownMs: 300, protMs: 0, testSpawns: spawns, stormCenter: spawns[0], heartbeatMs: 60000, allowedOrigins: 'https://rassive.example' });
  const port = await srv.listen(0);
  const url = 'ws://127.0.0.1:' + port;
  const A = bot(url, 'A'), B = bot(url, 'B'), C = bot(url, 'C'), Dd = bot(url, 'D');
  let code, startA, startB, startC, wallId;
  const P = {}; // last known positions of each bot

  await t.test('health check says ok', async () => {
    const body = await new Promise((res, rej) => http.get('http://127.0.0.1:' + port + '/health', r => { let s = ''; r.on('data', c => s += c); r.on('end', () => res(s)); }).on('error', rej));
    assert.equal(body, 'ok');
  });

  await t.test('Origin: null (offline HTML) is accepted, unknown website is rejected', async () => {
    await Promise.all([A.connect(), B.connect(), C.connect(), Dd.connect()]);
    const status = await new Promise(res => { const w = new WS(url, { origin: 'https://evil.example' }); w.on('unexpected-response', (q, r) => res(r.statusCode)); w.on('open', () => res('open')); });
    assert.equal(status, 403);
  });

  await t.test('host creates a room with a 6-character code', async () => {
    const j = await A.createRoom({ mode: 'br', max: 4 });
    code = j.code;
    assert.match(code, new RegExp('^[' + CODE_ALPHABET + ']{6}$'));
    assert.equal(j.host, j.you);
    assert.match(j.nick, /^[A-Za-z]+\d+$/, 'server-made nickname, no real names');
  });

  await t.test('wrong codes are refused', async () => {
    await assert.rejects(Dd.joinRoom('abc'), { code: 'bad_code' });
    let wrong = 'ZZZZZZ'; if (wrong === code) wrong = 'YYYYYY';
    await assert.rejects(Dd.joinRoom(wrong), { code: 'no_room' });
  });

  await t.test('two friends join, everybody sees the lobby list', async () => {
    const s = A.mark();
    await B.joinRoom(code.toLowerCase()); // codes are not case sensitive
    await C.joinRoom(code);
    const lob = await A.waitFor('lobby', m => m.players.length === 3, s);
    assert.equal(lob.players.filter(p => p.host).length, 1);
  });

  await t.test('no free-text chat, only emotes', async () => {
    const s = B.mark();
    B._send({ t: 'chat', text: 'hi whats your address' });
    const e = await B.waitFor('error', m => m.code === 'unknown_type', s);
    assert.equal(e.type, 'chat');
    const s2 = A.mark();
    B.sendEmote('gg');
    const em = await A.waitFor('emote', null, s2);
    assert.deepEqual([em.id, em.e], [B.you, 'gg']);
  });

  await t.test('only the host can start; start + countdown + GO', async () => {
    await assert.rejects(B.startMatch(), { code: 'not_host' });
    const sb = B.mark(), sc = C.mark();
    startA = await A.startMatch();
    startB = await B.waitFor('start', null, sb); startC = await C.waitFor('start', null, sc);
    for (const [n, st] of [[A, startA], [B, startB], [C, startC]]) P[n.name] = { x: st.spawn[0], y: st.spawn[1], z: st.spawn[2] };
    assert.equal(startA.players.length, 3);
    assert.ok(startA.storm, 'battle royale has a storm');
    await Promise.all([A.waitFor('go'), B.waitFor('go'), C.waitFor('go')]);
  });

  await t.test('movement: normal steps accepted, teleport cheat snapped back, others interpolate', async () => {
    for (const n of [A, B, C]) n.sendInput(Object.assign({ r: 0, w: 'ak45' }, P[n.name]), true);
    await sleep(120);
    P.B.z += 0.8; B.sendInput(Object.assign({ r: 1.57, w: 'ak45' }, P.B), true);
    const sc = C.mark();
    C.sendInput({ x: P.C.x + 100, y: P.C.y, z: P.C.z, r: 0 }, true);
    const corr = await C.waitFor('corr', null, sc);
    assert.equal(corr.why, 'speed'); assert.equal(corr.x, P.C.x);
    await sleep(400);
    const seenB = A.sample(B.you);
    assert.ok(seenB, 'A has a snapshot buffer for B');
    assert.ok(Math.abs(seenB.z - P.B.z) < 0.05, 'A sees B at the new spot (z=' + seenB.z + ')');
    // interpolation half-way between two snapshots
    const buf = A.buf.get(B.you); const a = buf[buf.length - 2], b = buf[buf.length - 1];
    buf.push({ ts: b.ts + 50, x: b.x + 1, y: b.y, z: b.z, r: b.r, pi: 0, f: b.f }); const mid = A.sample(B.you, b.ts + 25);
    assert.ok(Math.abs(mid.x - (b.x + 0.5)) < 0.01, 'lerp works'); buf.pop(); void a;
  });

  await t.test('shooting: server decides the hit and damage; fire-rate and origin cheats are blocked', async () => {
    const s = B.mark(), sa = A.mark();
    const sh = aim(P.A, P.B);
    A.sendShot({ w: 'ak45', o: sh.o, d: sh.d });
    A.sendShot({ w: 'ak45', o: sh.o, d: sh.d }); // too fast, same millisecond
    const hit = await B.waitFor('hit', m => m.tg === B.you, s);
    assert.equal(hit.by, A.you); assert.ok(hit.dmg >= 29 && hit.dmg <= 31, 'AK-45 does ~31 with falloff, got ' + hit.dmg); assert.equal(hit.hp, 100 - hit.dmg);
    await A.waitFor('error', m => m.code === 'too_fast', sa);
    await sleep(150);
    A.sendShot({ w: 'ak45', o: [sh.o[0] + 10, sh.o[1], sh.o[2]], d: sh.d });
    await A.waitFor('error', m => m.code === 'bad_origin', sa);
    A.sendShot({ w: 'heavysn', o: sh.o, d: sh.d });
    await A.waitFor('error', m => m.code === 'no_weapon', sa);
    P.B.hp = hit.hp;
  });

  await t.test('building: server checks grid, distance, empty cell and materials', async () => {
    const cx = Math.floor(P.B.x / 4), cz = Math.floor(P.B.z / 4), y = P.B.y - 0.05;
    const sb = B.mark(), sa = A.mark();
    const wall = { type: 'wall', x: cx * 4, y, z: cz * 4 + 2, rot: 3, mat: 'wood' }; // wall on B's -x side, between A and B
    const s1 = B.sendBuild(wall);
    const built = await A.waitFor('built', m => m.s === s1, sa);
    wallId = built.id; assert.equal(built.by, B.you); assert.equal(built.hp, 150);
    B.sendBuild(wall); await B.waitFor('buildNo', m => m.why === 'taken', sb);
    B.sendBuild(Object.assign({}, wall, { z: wall.z + 1 })); await B.waitFor('buildNo', m => m.why === 'off_grid', sb);
    B.sendBuild(Object.assign({}, wall, { x: wall.x + 40 })); await B.waitFor('buildNo', m => m.why === 'too_far', sb);
    await sleep(100); // builds are limited to about 10 per second
    const f1 = B.sendBuild({ type: 'floor', x: cx * 4 + 2, y, z: (cz + 1) * 4 + 2, mat: 'wood' }); await B.waitFor('built', m => m.s === f1, sb); await sleep(100);
    const f2 = B.sendBuild({ type: 'floor', x: (cx + 1) * 4 + 2, y, z: cz * 4 + 2, mat: 'wood' }); await B.waitFor('built', m => m.s === f2, sb); await sleep(100);
    B.sendBuild({ type: 'floor', x: cx * 4 + 2, y, z: (cz - 1) * 4 + 2, mat: 'wood' }); await B.waitFor('buildNo', m => m.why === 'need_mats', sb); // 30 wood = 3 pieces
    const inv = B.log.filter(m => m.t === 'inv').pop(); assert.equal(inv.wood, 0);
  });

  await t.test('the wall blocks bullets and breaks after enough damage', async () => {
    const sa = A.mark(), sb = B.mark();
    const sh = aim(P.A, P.B);
    for (let i = 0; i < 8 && !A.log.slice(sa).some(m => m.t === 'buildGone'); i++) { A.sendShot({ w: 'ak45', o: sh.o, d: sh.d }); await sleep(140); }
    const hp = await A.waitFor('buildHp', m => m.id === wallId, sa);
    assert.ok(hp.hp < 150);
    await A.waitFor('buildGone', m => m.id === wallId, sa);
    assert.equal(B.log.slice(sb).filter(m => m.t === 'hit' && m.tg === B.you).length, 0, 'B took no damage behind the wall');
  });

  await t.test('disconnect + rejoin keeps the same player and gets the full build list', async () => {
    const sa = A.mark(), sc = C.mark(), oldId = C.you;
    C.ws.terminate(); // Wi-Fi blip
    await A.waitFor('away', m => m.id === oldId, sa);
    await C.waitFor('reconnected', null, sc, 5000); // the client module rejoins by itself with its secret token
    const st = await C.waitFor('start', null, sc, 5000);
    assert.equal(C.you, oldId);
    assert.equal(st.builds.length, 2, 'late joiner gets both floors');
    await A.waitFor('back', m => m.id === oldId, sa);
    C.sendInput(Object.assign({ r: 0 }, P.C), true);
  });

  await t.test('elimination and win are decided by the server', async () => {
    const sa = A.mark();
    for (const [V, n] of [[B, 'B'], [C, 'C']]) {
      const sh = aim(P.A, P[n]);
      for (let i = 0; i < 10 && !A.log.slice(sa).some(m => m.t === 'elim' && m.tg === V.you); i++) {
        A.sendShot({ w: 'ak45', o: sh.o, d: sh.d }); await sleep(140);
        if (A.log.slice(sa).some(m => m.t === 'inv' && m.guns.ak45 && m.guns.ak45[0] === 0)) { A.sendReload(); await sleep(2100); }
      }
      const el = await A.waitFor('elim', m => m.tg === V.you, sa);
      assert.equal(el.by, A.you); assert.equal(el.w, 'AK-45');
    }
    const end = await B.waitFor('end');
    assert.equal(end.winner, A.you);
    assert.deepEqual(end.ranks.map(r => r.id), [A.you, C.you, B.you]);
    assert.equal(end.ranks[0].kills, 2);
  });

  await t.test('join-code guessing gets slowed down', async () => {
    let got = null;
    for (let i = 0; i < 12 && !got; i++) { try { await Dd.joinRoom('QQQQQ' + CODE_ALPHABET[i]); } catch (e) { if (e.code === 'slow_down') got = e.code; } }
    assert.equal(got, 'slow_down');
  });

  await t.test('flooding gets kicked, giant messages get dropped', async () => {
    const closed = new Promise(res => Dd.on('close', res));
    Dd.userClosed = true;
    for (let i = 0; i < 200; i++) Dd.ws.send('{"t":"ping","c":1}');
    assert.equal((await closed).code, 4008);
    const big = await new Promise(res => { const w = new OriginNullWS(url); w.on('open', () => w.send(JSON.stringify({ t: 'p', pad: 'x'.repeat(2000) }))); w.on('close', c => res(c)); });
    assert.equal(big, 1009);
  });

  for (const n of [A, B, C]) n.close();
  await srv.close();
});

test('storm hurts players outside the circle', async () => {
  const spawns = findSpawns();
  const srv = createServer({ log: false, countdownMs: 50, protMs: 0, testSpawns: spawns, stormCenter: [spawns[0][0] - 300, spawns[0][1]], heartbeatMs: 60000 });
  const url = 'ws://127.0.0.1:' + (await srv.listen(0));
  const A = bot(url, 'A'), B = bot(url, 'B');
  await A.connect(); await B.connect();
  const { code } = await A.createRoom({ mode: 'br' }); await B.joinRoom(code); await A.startMatch();
  const h = await A.waitFor('hit', m => m.by === 'storm' && m.tg === A.you, 0, 3000);
  assert.equal(h.dmg, 1);
  A.close(); B.close(); await srv.close();
});

test('teams mode: respawn after elimination, no friendly fire', async () => {
  const spawns = findSpawns();
  const srv = createServer({ log: false, countdownMs: 50, protMs: 0, respawnMs: 300, testSpawns: spawns, heartbeatMs: 60000 });
  const url = 'ws://127.0.0.1:' + (await srv.listen(0));
  const A = bot(url, 'A'), B = bot(url, 'B'), C = bot(url, 'C');
  await Promise.all([A.connect(), B.connect(), C.connect()]);
  const { code } = await A.createRoom({ mode: 'teams', max: 4 }); await B.joinRoom(code); await C.joinRoom(code);
  const st = await A.startMatch(); await A.waitFor('go');
  const pos = {}; for (const p of st.players) pos[p.id] = p;
  const sp = i => ({ x: spawns[i][0], y: D.H(spawns[i][0], spawns[i][1]), z: spawns[i][1] });
  const team = Object.fromEntries(st.players.map(p => [p.id, p.team]));
  assert.notEqual(team[A.you], team[B.you]); assert.equal(team[A.you], team[C.you]);
  // C steps 2 m sideways so B is not in the way, then A shoots teammate C: no damage
  const c2 = Object.assign(sp(2), {}); c2.z += 2; await sleep(100); C.sendInput(Object.assign({ r: 0 }, c2), true); await sleep(200);
  const sa = A.mark();
  A.sendShot(Object.assign({ w: 'ak45' }, aim(sp(0), c2))); await sleep(300);
  assert.equal(A.log.slice(sa).filter(m => m.t === 'error').length, 0, 'shot was accepted');
  assert.equal(A.log.slice(sa).filter(m => m.t === 'hit').length, 0, 'no friendly fire');
  // A kills B with the shotgun up close? B is 8 m away; use the AK
  for (let i = 0; i < 10 && !A.log.some(m => m.t === 'elim'); i++) { A.sendShot(Object.assign({ w: 'ak45' }, aim(sp(0), sp(1)))); await sleep(140); }
  const el = await A.waitFor('elim', m => m.tg === B.you);
  assert.deepEqual(el.score, team[A.you] === 0 ? [1, 0] : [0, 1]);
  const rs = await B.waitFor('respawn', m => m.id === B.you, 0, 2000);
  assert.equal(rs.hp, 100);
  A.close(); B.close(); C.close(); await srv.close();
});

test('shotgun: server rolls the pellets when the client sends only the aim', async () => {
  const spawns = findSpawns();
  const srv = createServer({ log: false, countdownMs: 50, protMs: 0, testSpawns: spawns, heartbeatMs: 60000 });
  const url = 'ws://127.0.0.1:' + (await srv.listen(0));
  const A = bot(url, 'A'), B = bot(url, 'B');
  await A.connect(); await B.connect();
  const { code } = await A.createRoom({ mode: 'duel' }); await B.joinRoom(code); await A.startMatch(); await A.waitFor('go');
  const sp = i => ({ x: spawns[i][0], y: D.H(spawns[i][0], spawns[i][1]), z: spawns[i][1] });
  A.sendShot(Object.assign({ w: 'pump' }, aim(sp(0), sp(1))));
  const h = await B.waitFor('hit', m => m.tg === B.you);
  assert.ok(h.dmg > 11, 'more than one pellet hit at 8 m (got ' + h.dmg + ')');
  assert.equal(h.sh + h.hp, 150 - h.dmg, 'duel spawns with 50 shield, shield goes first');
  A.close(); B.close(); await srv.close();
});
