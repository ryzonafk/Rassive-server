# 🌐 Rassive Online Server

This is the "referee" computer for online Rassive. You make a room, get a code like **`KX7P2M`**, and your friend types it in.
The server decides the important stuff (hits, damage, builds, storm, who wins), so nobody can cheat by saying "I have 9999 HP".

```
server/
  server.js            the server (rooms, codes, game loop, hit checks, builds, storm, win)
  gamedata.js          game rules copied from ../src (terrain, modes, build HP, storm)
  guns.json            all 45 weapons, made from src/game1.js by `npm run guns`
  protocol.md          every message with examples
  client/rassive-net.js   small file the game uses to talk to the server
  client/INTEGRATION.md   where it plugs into the game code
  test/match.test.js   robot players that play a whole match
  Dockerfile, fly.toml, render.yaml   for putting it on the internet
```

## 🏃 Run it on your computer

You need **Node.js 18 or newer** (`node -v` to check).

```bash
cd /workspace/rocket-game/server
npm install        # gets the one helper library, "ws"
npm test           # robot players play a full match (takes about 7 seconds)
npm start          # starts the server at ws://localhost:8080
```

You should see `Rassive server listening on port 8080`. Open http://localhost:8080/health and it says `ok`.
Press **Ctrl + C** to stop it.

Locally, the game connects with `ws://localhost:8080`. That's the ONE time `ws://` (no "s") is OK.
On the internet, always use `wss://` (Android blocks plain `ws://`).

## 🛡️ Kid-safe rules built in

- **No text chat.** Only emotes: wave, gg, lol, thumbs, wow, sorry, dance, heart. A "chat" message is refused.
- **No names, emails or accounts.** The server picks a fun nickname like `CosmicPanda42`.
- **Private room codes only.** There is no "join random strangers" button. Guessing codes gets blocked after 10 wrong tries a minute.
- **Nothing is saved.** Rooms live only in memory, and they vanish when empty or after 1 hour.
- Before Google Play: a grown-up updates the privacy policy and the Data safety form (see `../ref/play-store-plan.md`).

## ☁️ Put it on the internet (with a grown-up)

> 👨‍👩‍👦 **A parent or guardian must create the hosting account** (Render, Fly.io and GitHub), using their own email and card.
> These sites have legal terms that kids can't agree to, and some can charge money. The grown-up holds the keys; you write the code.
> Prices change often, so re-check them first. See `../ref/online-multiplayer-plan.md`.

### Option 1: Render (free, good for testing)
1. Grown-up: make a GitHub account and a **new repo** with just the files in this `server/` folder (not `node_modules`).
2. Grown-up: make a Render account at render.com (free plan).
3. In Render: **New → Blueprint**, pick the repo. It reads `render.yaml` (free plan, `npm ci`, `npm start`, health check `/health`).
4. You get an address like `https://rassive-server.onrender.com`. In the game, use `wss://rassive-server.onrender.com`.
5. ⏰ Free servers **fall asleep after 15 minutes** with no players and take **about 1 minute** to wake up. The client shows a "waking" status, so the game should say *"Waking up the server…"*.

### Option 2: Fly.io (about $2–4 a month, stays awake while people play)
1. Grown-up: make a Fly.io account (needs a card) and **set a billing alert**. Free allowances don't cap the bill.
2. Install the `fly` tool (fly.io/docs/flyctl/install), then in this folder:
   ```bash
   fly auth login          # the grown-up signs in
   fly launch --no-deploy  # keeps fly.toml + Dockerfile; may ask to rename the app
   fly deploy
   ```
3. Your address is `wss://<app-name>.fly.dev`. `fly.toml` lets it stop when nobody is playing and start again when someone connects.

### Settings (environment variables)
| Name | What it does | Default |
|---|---|---|
| `PORT` | port to listen on | 8080 |
| `TRUST_PROXY` | set to `1` on Render/Fly so rate limits use the real player IP | off (on in Dockerfile/render.yaml) |
| `ALLOWED_ORIGINS` | comma list of websites allowed to connect. `null` (the offline rassive.html and the Android app) is **always** allowed | `*` (everyone) |
| `QUIET` | `1` = no logs | off |

## 🔧 How it works (short)
- 20 times a second each game sends "here's where I am". The server checks you didn't move faster than possible (else it sends you back with `corr`) and sends everyone a snapshot.
- Other players are drawn **100 ms in the past** and smoothly blended between snapshots (`client/rassive-net.js` → `remotes()`).
- When you shoot, your game shows the flash right away, and the server does the real raycast (range, fire rate, ammo, walls and hills in the way, lag compensation up to 300 ms) and sends `hit`.
- Builds use the same 4 m grid as `planPiece()` in the game. The server checks materials, distance and empty cells and gives each piece an ID.
- Heartbeat pings every 10 s drop dead connections. Wi-Fi blips get **30 seconds** to rejoin with a secret token (the client does it automatically).

## ⚠️ Not done yet (v1 limits)
- Loot, trees, rocks, vehicles, meteors, rockets, events and portals are still local to each player. The server trusts "I picked up this gun" (`equip`) and "I chopped wood" (`harvest`, rate-limited). Next step: the server spawns loot.
- Speed checks are on, but physics isn't (v2 "referee" movement from the plan).
- The Dockerfile and Fly/Render configs were written but **not deployed or Docker-built** (no account or Docker here).
