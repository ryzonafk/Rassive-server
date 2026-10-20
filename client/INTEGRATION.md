# Hooking online play into Rassive (for Jarvis)

Nothing in `src/` was changed. `client/game-online.example.js` is ready-made glue that uses only wrappers and hooks from HOOKS.md.
**It was tested in a scratch build** (`/tmp/ultron-net`, the files joined as `src/game30.js`): two Chrome windows, desktop and phone size, created and joined a room and started a battle royale. Each saw the other player in the right spot. A's real `playerFire()` made the server send `hit` (B went to 70 HP), and B's `tryBuild(me,'wall')` showed up on both screens. There were 0 page errors. Screenshots: `shots/ultron-online-room.png`, `shots/ultron-online-match-phone.png` and `shots/ultron-online-match-desktop.png`.

## The 5 steps
1. **Add the file.** Make `src/game<N>.js` (any free number, since 17, 18 and 19 are taken) with this content: `client/rassive-net.js`, then `client/game-online.example.js`. Above it, set `window.RASSIVE_SERVER = 'wss://<your-app>.onrender.com'` in a single place. build.py picks it up automatically (it globs `src/game*.js`).
2. **Lobby button.** The glue adds a **PLAY ONLINE** tile after `.mode[data-m="creative"]` (head.html lobby). It opens Create Room / Join Code and then the room screen with the code, the player list and the host's START button. Polish may want to restyle it, and the phone layout now has 6 tiles.
3. **Start a match.** On the server's `start`, the glue calls the normal `startGame(mode)` (game2.js). It then removes the bots from `ents`, calls `preEnd()` to skip the sky-island countdown, teleports `me` to the server's `spawn`, and adds each friend with `newEnt()` + `makeGuy()` (game2.js) as `{remote:id, ai:null, isBot:false}`. Keeping `isBot:false` matters, because then bot chat never makes up words for a real kid.
4. **Wrapped functions** (each one passes straight through when not online):
   | Function (file) | Online behaviour |
   |---|---|
   | `botUpdate` (game4/12, called from `frame()` in game5.js) | remote players get their spot from `net.sample(id)`, 100 ms interpolation |
   | `RASSIVE.onUpdate` push | `net.sendInput({x,y,z,r:yaw,pi:pitch,w,v,tp})` every frame; the module throttles to 20 Hz. A jump over 10 m is flagged `tp` (portals) |
   | `playerFire` (game3.js) | runs locally for the flash and tracer, then `net.sendShot({w, o:aimOrigin(), d:camera dir})`; the pickaxe sends `w:'pick'`; wood/stone/metal gains send `harvest` |
   | `applyDmg`, `hitPiece` (game3.js) | do nothing locally. Only the server's `hit` / `buildHp` / `buildGone` change HP |
   | `tryBuild` (game3/9.js) | sends `planPiece()` x,y,z + `cardinal(me.yaw)`; the piece appears on `built` through `makePlan()` + `addPiece()` (game9.js) |
   | `startReload` (game3.js), `RASSIVE.onPickup` | `reload` / `equip` |
   | `stormUpdate` (game4.js) | draws the server's circle only, with no local storm damage |
   | `meteorUpdate`, `eventsUpdate`, `visitorUpdate`, `chatUpdate`, `chatOpenFn` | off online (v1); the text chat box is blocked online (emotes only) |
   | `goLobby` (game5.js) | leaves the room and closes the socket |
   | `RASSIVE.appPause` | doesn't pause online; the 30 s rejoin grace covers app switching and the module rejoins by itself |
   Server events feed the existing UI: `hit` → `dmgNum`/`flash('#hitm')`/`sfx`, `elim` → `feed()`, `end` → `endGame()`.
5. **Deploy and Android.** A grown-up deploys `server/` to Render (README). Use the `wss://` address, because Android blocks `ws://`. The manifest already has `INTERNET` (checked `/workspace/android/app/AndroidManifest.xml`), so rebuild the APK and test phone ↔ computer.

## Still to do (v2)
- Loot, trees, vehicles, meteors, rockets, events and portals are still local to each player. The server trusts `equip` (picked-up guns) and `harvest`, with limits.
- `playerFire` rolls its own spread for shotgun pellets, so the server rolls its own pellets. To match exactly, send the pellet directions in `ds`.
- Third-person `aimOrigin()` sits a little off the head, but it is well inside the server's 2.5 m origin limit.
- Emote buttons have no UI yet (call `net.sendEmote('gg')`).
