/* ==== Rassive ONLINE glue (EXAMPLE, not wired in yet) ====
 * For Jarvis: to turn online on, make a new src/gameNN.js = the contents of client/rassive-net.js
 * followed by this file (build.py concatenates src/game*.js in number order, so it runs after
 * game1-16 and gfx-main.js). Nothing here runs until the player taps PLAY ONLINE, so offline play
 * stays exactly the same. Every hook is a wrapper (const _old=fn; fn=function(){...}), per HOOKS.md.
 */
(function () {
  'use strict';
  const RASSIVE_SERVER = window.RASSIVE_SERVER || 'wss://rassive-server.onrender.com'; // change once, works everywhere
  const R = window.RASSIVE;
  let net = null, ON = null; // ON = { mode, remotes: Map(id -> ent), pieces: Map(id -> piece), st, lastPos }
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const ERR = c => (window.RassiveNet && RassiveNet.ERRORS[c]) || ('Oops: ' + c);

  /* ---------- lobby button + room screens ---------- */
  function addButton() {
    if (document.getElementById('bOnline')) return;
    const anchor = document.querySelector('.mode[data-m="creative"]'); if (!anchor) return;
    const b = document.createElement('div'); b.className = 'mode m2'; b.id = 'bOnline';
    b.innerHTML = '<b>PLAY ONLINE</b><span>Play with a friend using a secret room code.</span>';
    b.onclick = openOnline; anchor.after(b);
  }
  function ensureNet() {
    if (net) return net;
    net = new RassiveNet({ url: RASSIVE_SERVER });
    net.on('status', s => { const el = document.getElementById('onMsg'); if (!el) return;
      if (s.status === 'waking') el.textContent = 'Waking up the server... this can take up to 1 minute.';
      if (s.status === 'reconnecting') toast('Connection lost, reconnecting...'); });
    net.on('lobby', showRoom); net.on('host', () => showRoom(null));
    net.on('start', onStart); net.on('go', () => { if (ON) bigMsg('GO!', 'Last one standing wins!', 2); });
    net.on('s', onSnap); net.on('corr', m => { if (ON && me) { me.pos.set(m.x, m.y, m.z); me.vel.set(0, 0, 0); } });
    net.on('inv', onInv); net.on('hit', onHit); net.on('elim', onElim); net.on('respawn', onRespawn); net.on('end', onEnd);
    net.on('shot', onRemoteShot); net.on('boom', m => { try { spr(new V3(m.x, m.y, m.z), 0xffb030, m.r * 1.3, .3, { add: true, grow: m.r * 4 }); sfxAt('boom', new V3(m.x, m.y, m.z)); } catch (e) {} });
    net.on('built', onBuilt); net.on('buildHp', m => { const p = ON && ON.pieces.get(m.id); if (p) p.hp = m.hp; });
    net.on('buildGone', m => { const p = ON && ON.pieces.get(m.id); if (p) { ON.pieces.delete(m.id); if (pieces.includes(p)) destroyPiece(p); } });
    net.on('buildNo', m => { if (m.why === 'need_mats') toastPick('Need 10 ' + me.mat + '!', '#ffb3a8'); });
    net.on('left', m => dropRemote(m.id)); net.on('emote', m => { const e = ON && ON.remotes.get(m.id); feed((e ? esc(e.name) : 'Someone') + ' : ' + esc(m.e.toUpperCase())); });
    net.on('lost', () => { if (ON) { toast("Can't reach the server."); } });
    return net;
  }
  function toast(t) { try { toastPick(t, '#ffe066'); } catch (e) {} }
  function openOnline() {
    modal('<h2>PLAY ONLINE</h2><p style="text-align:center">Play with a friend using a secret room code. No chat, no real names.</p>' +
      '<div class="rw"><span>Mode</span><select id="onMode"><option value="br">Battle Royale</option><option value="teams">Teams</option><option value="duel">1v1</option><option value="oneshot">One Shot</option></select></div>' +
      '<div class="btns"><button class="btn green" id="onCreate">CREATE ROOM</button></div>' +
      '<div class="rw"><input id="onCode" maxlength="6" placeholder="ROOM CODE" autocomplete="off" style="text-transform:uppercase;font-size:20px;width:60%"><button class="btn" id="onJoin">JOIN</button></div>' +
      '<p id="onMsg" style="text-align:center;color:#ffe066"></p><div class="btns"><button class="btn gray" id="onX">BACK</button></div>');
    const msg = t => { const el = document.getElementById('onMsg'); if (el) el.textContent = t; };
    const go = async fn => { try { msg('Connecting...'); ensureNet(); if (!net.ws || net.ws.readyState !== 1) await net.connect(); await fn(); } catch (e) { msg(ERR(e.code || e.message)); } };
    document.getElementById('onCreate').onclick = () => go(async () => { const j = await net.createRoom({ mode: document.getElementById('onMode').value, max: 4, skin: S.skin }); showRoom(j); });
    document.getElementById('onJoin').onclick = () => go(async () => { const j = await net.joinRoom(document.getElementById('onCode').value, { skin: S.skin }); showRoom(j); });
    document.getElementById('onX').onclick = () => { if (net) net.close(); net = null; closeModal(); };
  }
  let lastLobby = null;
  function showRoom(m) {
    if (m) lastLobby = m; const L = lastLobby; if (ON || !net || !net.code) return;
    const list = L ? L.players.map(p => '<div class="rw"><span>' + esc(p.nick) + (p.id === net.you ? ' (you)' : '') + '</span><span>' + (p.host ? 'HOST' : '') + '</span></div>').join('') : '';
    const host = L ? L.host === net.you : true;
    modal('<h2>ROOM ' + esc(net.code) + '</h2><p style="text-align:center">Tell your friend this code: <b style="font-size:24px;letter-spacing:3px">' + esc(net.code) + '</b></p>' + list +
      '<p id="onMsg" style="text-align:center;color:#ffe066"></p><div class="btns">' + (host ? '<button class="btn green" id="onStart">START</button>' : '<span>Waiting for the host...</span>') + '<button class="btn gray" id="onLeave">LEAVE</button></div>');
    const s = document.getElementById('onStart'); if (s) s.onclick = () => net.startMatch().catch(e => { document.getElementById('onMsg').textContent = ERR(e.code); });
    document.getElementById('onLeave').onclick = () => { net.close(); net = null; lastLobby = null; closeModal(); };
  }

  /* ---------- match start: normal startGame, then remove bots and use server spawn ---------- */
  function onStart(m) {
    const rejoin = ON && state === 'game';
    if (!rejoin) {
      closeModal(); startGame(m.mode);
      for (const b of ents.filter(e => !e.isMe)) { if (b.mesh) scene.remove(b.mesh); ents.splice(ents.indexOf(b), 1); }
      if (MODE.pre > 0) preEnd();
      ON = { mode: m.mode, remotes: new Map(), pieces: new Map(), st: m.storm, lastPos: null };
    }
    me.team = m.team; me.pos.set(m.spawn[0], m.spawn[1] + .1, m.spawn[2]); me.vel.set(0, 0, 0); me.hp = m.hp; me.sh = m.sh;
    for (const p of m.players) if (p.id !== net.you && !ON.remotes.has(p.id)) addRemote(p);
    for (const b of m.builds) if (!ON.pieces.has(b.id)) onBuilt(b);
    bigMsg('ROOM ' + net.code, 'Get ready!', 2);
  }
  function addRemote(p) {
    // isBot stays false so bot chat never puts words in a real kid's mouth; ai:null so bot AI skips them
    const e = newEnt({ name: p.nick, team: p.team, remote: p.id, ai: null, col: MODE.teams ? (p.team === 0 ? 0x3a7bff : 0xff4d4d) : 0xffb23a, labelCol: '#ffffff' });
    makeGuy(e); ents.push(e); ON.remotes.set(p.id, e); return e;
  }
  function dropRemote(id) { const e = ON && ON.remotes.get(id); if (!e) return; if (e.mesh) scene.remove(e.mesh); const i = ents.indexOf(e); if (i >= 0) ents.splice(i, 1); ON.remotes.delete(id); }

  // Remote players: drawn 100 ms in the past, blended between snapshots (game5.js frame() calls botUpdate for every non-me ent)
  const _bu = botUpdate; botUpdate = function (b, dt) {
    if (!b.remote) return _bu(b, dt);
    const s = net && net.sample(b.remote); if (!s) return;
    b.pos.set(s.x, s.y, s.z); b.yaw = s.r; b.hp = s.hp; b.sh = s.sh; const alive = !!(s.f & 1);
    if (b.mesh) { b.mesh.position.copy(b.pos); b.mesh.rotation.y = b.yaw; b.mesh.visible = alive; }
    b.alive = alive;
  };
  function onSnap(m) {
    if (!ON || !me) return;
    if (m.st) ON.st = m.st;
    if (net.me) { me.hp = net.me[6]; me.sh = net.me[7]; }
    for (const p of m.p) { const e = ON.remotes.get(p[0]); if (e && !(p[9] & 1)) e.alive = false; else if (e && !e.alive && (p[9] & 1)) { e.alive = true; } }
  }
  // Storm: the server owns it. Show its circle, never do local storm damage.
  const _su = stormUpdate; stormUpdate = function (dt) {
    if (!ON) return _su(dt);
    if (storm && ON.st && storm.mesh) { const [x, z, r, tr, left, ph, dmg] = ON.st; Object.assign(storm, { x, z, r, tr, left, phase: ph, dmg }); storm.mesh.position.set(x, 40, z); storm.mesh.scale.set(r, 1, r); }
  };
  // No bot events, meteors, visitors or bot chat online (v1)
  for (const n of ['meteorUpdate', 'eventsUpdate', 'visitorUpdate', 'chatUpdate']) { try { const f = window[n]; if (typeof f === 'function') window[n] = function (dt) { if (!ON) return f(dt); }; } catch (e) {} }
  const _co = chatOpenFn; chatOpenFn = function () { if (ON) { toast('Online uses emotes only'); return; } return _co(); };

  /* ---------- sending: movement, shots, reloads, pickups, harvest ---------- */
  R.onUpdate.push(() => {
    if (!ON || !net || !me) return;
    const g = curGun(me), tp = ON.lastPos && me.pos.distanceTo(ON.lastPos) > 10; ON.lastPos = (ON.lastPos || me.pos.clone()).copy(me.pos);
    net.sendInput({ x: me.pos.x, y: me.pos.y, z: me.pos.z, r: me.yaw, pi: me.pitch, w: me.cur === 0 || !g ? 'pick' : g.id, v: me.veh ? 1 : 0, tp }, tp);
  });
  const _pf = playerFire; playerFire = function () {
    if (!ON) return _pf.apply(this, arguments);
    const g = curGun(me), mag0 = g && g.mag, f0 = me.fireT, w0 = me.wood, s0 = me.stone, m0 = me.metal;
    const r = _pf.apply(this, arguments);
    const o = aimOrigin().toArray(), d = camera.getWorldDirection(new V3()).toArray();
    if (g && me.cur !== 0 && g.mag < mag0) net.sendShot({ w: g.id, o, d });
    else if (me.cur === 0 && f0 <= 0 && me.fireT > 0) net.sendShot({ w: 'pick', o, d });
    if (me.wood > w0) net.sendHarvest('wood'); if (me.stone > s0) net.sendHarvest('stone'); if (me.metal > m0) net.sendHarvest('metal');
    return r;
  };
  const _sr = startReload; startReload = function (e) { _sr(e); if (ON && e === me && e.reloadT > 0) net.sendReload(); };
  R.onPickup.push((ent, item) => { if (ON && ent === me && item && item.type === 'gun') net.sendEquip(item.id); });

  /* ---------- the server decides damage ---------- */
  const _ad = applyDmg; applyDmg = function (t, d, src, head, gname, at) { if (!ON) return _ad(t, d, src, head, gname, at); /* local hits are only for show online */ };
  const _hp = hitPiece; hitPiece = function (p, d) { if (!ON) return _hp(p, d); };
  function entById(id) { return id === net.you ? me : ON && ON.remotes.get(id); }
  function onHit(m) {
    if (!ON) return; const t = entById(m.tg); if (!t) return;
    t.hp = m.hp; t.sh = m.sh;
    if (t === me) { flash('#dmgflash', .7); vib(35); sfx('hurt', .6); if (m.by === 'storm') flash('#storm', .6); }
    if (m.by === net.you && t !== me) { dmgNum(t.pos.clone().add(new V3(0, 2, 0)), m.dmg, m.hd ? '#ffe066' : t.sh > 0 ? '#7fd4ff' : '#ffffff'); sfx(m.hd ? 'head' : 'hit'); flash('#hitm', .6); }
  }
  function onElim(m) {
    if (!ON) return; const t = entById(m.tg), k = m.by && m.by !== 'storm' ? entById(m.by) : null; if (!t) return;
    t.alive = false; t.hp = 0; if (t.mesh) t.mesh.visible = t === me ? t.mesh.visible : false;
    feed((k ? nameHtml(k) : '<span style="color:#c070ff">Storm</span>') + ' eliminated ' + nameHtml(t) + ' <span style="opacity:.7">[' + esc(m.w || '') + ']</span>');
    if (k === me) { me.kills++; S.kills++; S.coins += 10; sfx('coin'); }
    if (t === me && !MODE.respawn && !over) endGame(false, 'You placed #' + (m.left + 1), m.left + 1);
    if (t === me && MODE.respawn) me.respawnT = (m.respawnMs || 3000) / 1000 + .3; // the server's respawn message normally arrives first
  }
  function onRespawn(m) {
    if (!ON) return;
    if (m.id === net.you) { me.respawnT = null; respawn(me); me.pos.set(m.x, m.y + .1, m.z); me.hp = m.hp; me.sh = m.sh; }
    else { const e = ON.remotes.get(m.id); if (e) { e.alive = true; if (e.mesh) e.mesh.visible = true; } }
  }
  function onEnd(m) {
    if (!ON) return; if (over) return;
    const win = m.winner === net.you || (m.team != null && m.team === me.team);
    const place = (m.ranks.find(r => r.id === net.you) || {}).place || 2;
    endGame(win, win ? '#1 VICTORY!' : (m.team != null ? (m.team === 0 ? 'BLUE' : 'RED') + ' TEAM WINS!' : 'You placed #' + place), place);
  }
  function onInv(m) { if (!ON || !me) return; me.wood = m.wood; me.stone = m.stone; me.metal = m.metal; for (const s of me.slots) if (s && !s.pick && m.guns[s.id]) s.res = m.guns[s.id][1]; try { refreshHB(); } catch (e) {} }
  function onRemoteShot(m) { try { const o = new V3(...m.o), d = new V3(...m.d), G = GUNS[m.w]; tracer(o, o.clone().addScaledVector(d, Math.min(60, G ? G.range : 3)), G && G.beam); sfxAt('shot', o); } catch (e) {} }

  /* ---------- builds go through the server ---------- */
  const _tb = tryBuild; tryBuild = function (e, type) {
    if (!ON || e !== me) return _tb(e, type);
    if (!e.alive) return false; const p = planPiece(e, type); if (PIECE_KEYS[p.key]) return false;
    if (e[e.mat] < BCOST) { toastPick('Need 10 ' + e.mat + '!', '#ffb3a8'); return false; }
    net.sendBuild({ type, x: p.x, y: p.y, z: p.z, rot: cardinal(e.yaw), mat: e.mat }); return true;
  };
  function onBuilt(m) {
    if (!ON) return; const pl = makePlan(m.type, m.x, m.z, m.y, m.rot % 2 === 1, m.rot);
    if (PIECE_KEYS[pl.key]) destroyPiece(PIECE_KEYS[pl.key], true);
    const p = addPiece(pl, m.mat, true); p.hp = m.hp; p.netId = m.id; ON.pieces.set(m.id, p); try { sfx('build', .5); } catch (e) {}
  }

  /* ---------- leaving ---------- */
  const _gl = goLobby; goLobby = function () { if (ON) { ON = null; if (net) { net.close(); net = null; } lastLobby = null; } return _gl(); };
  const _ap = R.appPause; R.appPause = function () { if (ON) return; return _ap && _ap(); }; // online can't pause; 30 s rejoin grace covers app switching

  window.RassiveOnline = { open: openOnline, get on() { return !!ON; }, get net() { return net; } };
  addButton();
})();
