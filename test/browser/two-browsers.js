// Manual 2-browser check of client/game-online.example.js inside a SCRATCH build (never the real src/).
// Setup: copy build.py, src, three.min.js to /tmp/ultron-net, then
//   cat client/rassive-net.js client/game-online.example.js > /tmp/ultron-net/src/game30.js && (cd /tmp/ultron-net && python3 build.py)
// Run: node test/browser/srv.js &  node test/browser/two-browsers.js   (slow under swiftshader: about 3 minutes)
const { chromium } = require('/workspace/rocket-game/node_modules/playwright-core');
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const br = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  const errs = [];
  const mk = async (name, vp) => { const c = await br.newContext({ viewport: vp }); const p = await c.newPage(); p.on('pageerror', e => errs.push(name + ': ' + e.message)); p.on('console', m => { if (m.type() === 'error') errs.push(name + ' console: ' + m.text()); });
    await p.addInitScript(() => { window.RASSIVE_SERVER = 'ws://127.0.0.1:8099'; try { localStorage.setItem('__x', '1'); } catch (e) {} });
    await p.goto('file:///tmp/ultron-net/rassive.html', { waitUntil: 'commit', timeout: 60000 }); await p.waitForFunction(() => window.RassiveOnline && window.RASSIVE, null, { timeout: 90000 }); await sleep(3000); return p; };
  const A = await mk('A', { width: 1280, height: 720 }), B = await mk('B', { width: 844, height: 390 });
  console.log('online button present:', await A.evaluate(() => !!document.getElementById('bOnline')));
  await A.evaluate(() => RassiveOnline.open()); await A.evaluate(() => document.getElementById('onCreate').click()); await A.waitForFunction(() => (RassiveOnline.net && RassiveOnline.net.code) || /Oops|reach|busy/.test((document.getElementById('onMsg')||{}).textContent||''), null, { timeout: 60000 }).catch(()=>{}); console.log('msg', await A.evaluate(() => (document.getElementById('onMsg')||{}).textContent, ), 'errs', errs);
  const code = await A.evaluate(() => RassiveOnline.net && RassiveOnline.net.code); console.log('code', code);
  await A.screenshot({ path: '/tmp/ultron-net/room.png' });
  await B.evaluate(() => RassiveOnline.open()); await B.evaluate(c => { document.getElementById('onCode').value = c; }, code); await B.evaluate(() => document.getElementById('onJoin').click()); await B.waitForFunction(() => RassiveOnline.net && RassiveOnline.net.code, null, { timeout: 60000 });
  await A.evaluate(() => document.getElementById('onStart').click()); await A.waitForFunction(() => RassiveOnline.on && RASSIVE.me, null, { timeout: 60000 }); await B.waitForFunction(() => RassiveOnline.on && RASSIVE.me, null, { timeout: 60000 }); await sleep(3000);
  const st = p => p.evaluate(() => ({ on: RassiveOnline.on, state: RASSIVE.state, ents: RASSIVE.ents.length, remote: RASSIVE.ents.filter(e => e.remote).map(e => [e.name, +e.pos.x.toFixed(1), +e.pos.z.toFixed(1), e.mesh && e.mesh.visible]), me: [+RASSIVE.me.pos.x.toFixed(1), +RASSIVE.me.pos.z.toFixed(1), RASSIVE.me.hp] }));
  for (const p of [A, B]) await p.evaluate(() => { window.__log = []; RassiveOnline.net.on('*', m => { if (m.t !== 's' && m.t !== 'pong') window.__log.push(JSON.stringify(m).slice(0, 160)); }); });
  console.log('fps A', await A.evaluate(() => RASSIVE.fps));
  console.log('A', JSON.stringify(await st(A))); console.log('B', JSON.stringify(await st(B)));
  // A turns to face B and fires through the real playerFire hook
  for (let i = 0; i < 4; i++) {
    await A.evaluate(() => { const me = RASSIVE.me, t = RASSIVE.ents.find(e => e.remote); const dx = t.pos.x - me.pos.x, dz = t.pos.z - me.pos.z; me.yaw = Math.atan2(-dx, -dz); me.pitch = -0.04; });
    await sleep(2500); await A.evaluate(() => { RASSIVE.me.fireT = 0; RASSIVE.playerFire(); }); await sleep(500);
  }
  console.log('B hp after A fired 4x:', await B.evaluate(() => [RASSIVE.me.hp, RASSIVE.me.sh]));
  // B builds a wall through the tryBuild hook
  await B.evaluate(() => { RASSIVE.tryBuild(RASSIVE.me, 'wall'); }); await sleep(4000);
  console.log('pieces A/B:', await A.evaluate(() => pieces.length), await B.evaluate(() => pieces.length), 'B wood:', await B.evaluate(() => RASSIVE.me.wood));
  await A.screenshot({ path: '/tmp/ultron-net/A-game.png' }); await B.screenshot({ path: '/tmp/ultron-net/B-game.png' });
  console.log('A log', await A.evaluate(() => window.__log.slice(0, 25)));
  console.log('B log', await B.evaluate(() => window.__log.slice(0, 25)));
  console.log('ERRORS:', errs.length ? errs.slice(0, 10) : 'none');
  await br.close(); process.exit(0);
})().catch(e => { console.log('FAIL', e.message); process.exit(1); });
