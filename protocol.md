# Rassive Online Protocol (v1)

All messages are small JSON text frames: `{"t":"<type>", ...}`. Max **1024 bytes** per message (bigger = socket closed with code 1009).
Numbers are meters and radians, rounded to 2 decimals. Server time `ts` is milliseconds (Date.now on the server).

**Who decides what**
| Client decides (and server sanity-checks) | Server decides (clients just show it) |
|---|---|
| Your own movement (speed + map checks, snap-back with `corr`) | Hits, damage, shield, HP |
| Where you aim | Eliminations, places, who wins |
| What you want to build | Whether a build is allowed, its id, HP, when it breaks |
| | Storm circle + storm damage, respawns, ammo, materials |

Kid-safe on purpose: **there is no text chat message.** Unknown types (like `chat`) get `{"t":"error","code":"unknown_type"}`. Names are made by the server.

---
## 1. Client → Server

### `ping` (every 2 s, also keeps Render awake)
```json
{"t":"ping","c":1760999999123,"rtt":84}
```
`c` = client clock, `rtt` = the client's measured round-trip (used for lag compensation).

### `create` (make a private room, you become host)
```json
{"t":"create","mode":"br","max":4,"skin":"recruit"}
```
`mode`: `br` | `oneshot` | `teams` | `duel` (duel max is 2). `max`: 2–8. `skin`: optional cosmetic id (`[a-z0-9_]`, max 16).

### `join`
```json
{"t":"join","code":"KX7P2M"}
```
Codes are 6 characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (no 0/O/1/I/L). Not case-sensitive. 10 wrong codes in a minute from one IP gives `slow_down`.

### `rejoin` (after a Wi-Fi blip, within 30 s)
```json
{"t":"rejoin","code":"KX7P2M","token":"9f2c...32 hex chars"}
```
`token` comes from `joined`. It is secret; never show it on screen.

### `leave`
```json
{"t":"leave"}
```

### `start` (host only, needs at least 2 players)
```json
{"t":"start"}
```

### `again` (host only, after `end`: back to the lobby with the same people)
```json
{"t":"again"}
```

### `p` (your movement, about 20 times a second)
```json
{"t":"p","x":12.3,"y":4.1,"z":-8.1,"r":1.57,"pi":-0.12,"w":"ak45","v":1,"tp":1}
```
`r` = yaw (`me.yaw`), `pi` = pitch, `w` = held weapon id or `"pick"`, `v:1` = in a vehicle (higher speed allowed), `tp:1` = "I just used a portal" (one long jump allowed every 4 s).

### `shot`
```json
{"t":"shot","w":"ak45","o":[10.2,5.7,-3.1],"d":[0.995,-0.04,0.087]}
{"t":"shot","w":"pump","o":[10.2,5.7,-3.1],"d":[0.995,-0.04,0.087],"ds":[[0.99,-0.03,0.1],[0.98,-0.05,0.08]]}
{"t":"shot","w":"pick","o":[10.2,5.7,-3.1],"d":[1,0,0]}
```
`o` = aim origin (`aimOrigin()`), must be within 2.5 m of your eyes (8 m in a vehicle). `d` = unit direction. `ds` (optional) = shotgun pellet directions; if missing, the server rolls the pellets itself. Splash weapons (rocket, grenade launcher, snowball) explode where the ray first hits.

### `reload`
```json
{"t":"reload"}
```

### `equip` (switch weapon; in v1 also "I picked this gun up")
```json
{"t":"equip","w":"scar"}
```

### `build`
```json
{"t":"build","type":"wall","x":40,"y":3.25,"z":10,"rot":3,"mat":"wood","s":7}
{"t":"build","type":"floor","x":42,"y":3.25,"z":14,"mat":"stone","s":8}
{"t":"build","type":"ramp","x":46,"y":3.25,"z":10,"rot":1,"mat":"wood","s":9}
```
`x,y,z` are exactly what `planPiece(me,type)` returns (src/game3.js). `rot` = `cardinal(me.yaw)` (0:-z, 1:+x, 2:+z, 3:-x); walls use it for direction, ramps for which way they rise. `s` = your sequence number, echoed back.
Server checks: on the 4 m grid, within 8 m of you, cell not taken, you have 10 of that material, at most ~10 builds/second.

### `harvest` (pickaxe hit a tree / rock / scrap pile)
```json
{"t":"harvest","k":"wood"}
```
`k`: `wood` (+12) | `stone` (+9) | `metal` (+7). At most one every 0.4 s.

### `emote` (the only way to "talk")
```json
{"t":"emote","e":"gg"}
```
Allowed: `wave gg lol thumbs wow sorry dance heart`. At most one per second.

---
## 2. Server → Client

### `pong`
```json
{"t":"pong","c":1760999999123,"s":1760999999170}
```

### `error`
```json
{"t":"error","code":"no_room","re":"join"}
```
`re` = which message type caused it. Codes: `bad_code no_room room_full in_progress slow_down already_in_room server_full rejoin_failed not_host already_started need_players not_over not_in_room not_playing bad_weapon no_weapon reloading too_fast empty bad_shot bad_origin bad_emote unknown_type bad_json bad_msg server_error`.

### `joined` (answer to create / join / rejoin)
```json
{"t":"joined","code":"KX7P2M","you":"p3fa91c","nick":"CosmicPanda42","token":"9f2c…","mode":"br","max":4,"state":"lobby","host":"p3fa91c",
 "emotes":["wave","gg","lol","thumbs","wow","sorry","dance","heart"],"tickHz":20,"interpMs":100,
 "players":[{"id":"p3fa91c","nick":"CosmicPanda42","team":0,"host":true,"on":true,"skin":"recruit"}]}
```

### `lobby` (whenever the lobby list changes)
```json
{"t":"lobby","code":"KX7P2M","mode":"br","max":4,"state":"lobby","host":"p3fa91c","players":[{"id":"p3fa91c","nick":"CosmicPanda42","team":0,"host":true,"on":true,"skin":"recruit"},{"id":"p77b0e2","nick":"TurboFox17","team":0,"host":false,"on":true,"skin":"recruit"}]}
```

### `host` (host left, someone else is host now)
```json
{"t":"host","id":"p77b0e2"}
```

### `start` (match begins; also sent on rejoin / late join, with the full build list)
```json
{"t":"start","mode":"br","countdownMs":3000,"you":"p3fa91c","team":1,"spawn":[41.2,3.3,10.9],"hp":100,"sh":0,
 "players":[{"id":"p3fa91c","nick":"CosmicPanda42","team":1,"host":true,"on":true,"skin":"recruit"}],
 "builds":[{"id":4,"type":"wall","mat":"wood","x":40,"y":3.25,"z":10,"rot":3,"hp":150,"by":"p77b0e2"}],
 "storm":[12.5,-8.1,230,230,45,0,1],"goal":0,"score":[0,0]}
```
Teleport your player to `spawn`. Free-for-all modes give everyone their own `team` number; `teams` uses 0 (blue) and 1 (red).

### `go` (countdown done, damage is on)
```json
{"t":"go"}
```

### `inv` (only to you: your ammo + materials, sent when they change)
```json
{"t":"inv","wood":20,"stone":0,"metal":0,"guns":{"ak45":[29,120]},"w":"ak45"}
```
`guns` = `{id:[mag, reserve]}`.

### `s` (snapshot, 20 times a second)
```json
{"t":"s","tk":512,"ts":1760999999170,
 "p":[["p3fa91c",41.2,3.3,10.9,1.57,-0.1,100,0,"ak45",3],["p77b0e2",49.2,3.4,12.9,0,0,70,0,"pump",3]],
 "st":[12.5,-8.1,228.4,130,12,1,1]}
```
Each player: `[id, x, y, z, yaw, pitch, hp, shield, weapon, flags]`. Flags: `1` alive, `2` online, `4` spawn-protected, `8` in vehicle.
`st` (every 5th snapshot, storm modes only): `[x, z, radius, targetRadius, secondsLeftInPhase, phase, damagePerSecond]`.

### `corr` (you moved too fast, go back here)
```json
{"t":"corr","x":41.2,"y":3.3,"z":10.9,"why":"speed"}
```

### `shot` (someone else fired: draw the tracer/muzzle flash)
```json
{"t":"shot","by":"p77b0e2","w":"ak45","o":[49.2,5,12.9],"d":[-0.99,0,-0.1]}
```

### `hit` (server-decided damage; the ONLY thing that lowers HP)
```json
{"t":"hit","tg":"p77b0e2","by":"p3fa91c","dmg":30,"hd":0,"hp":70,"sh":0}
{"t":"hit","tg":"p3fa91c","by":"storm","dmg":1,"hd":0,"hp":99,"sh":0}
```

### `boom` (splash weapon exploded)
```json
{"t":"boom","by":"p3fa91c","w":"rocket","x":48,"y":4.1,"z":12,"r":4.5}
```

### `elim`
```json
{"t":"elim","tg":"p77b0e2","by":"p3fa91c","w":"AK-45","left":2}
{"t":"elim","tg":"p77b0e2","by":"p3fa91c","w":"AK-45","left":4,"score":[3,1],"respawnMs":3000}
```
`by` can be `"storm"` or `null` (left the match). `left` = players still alive.

### `respawn` (respawn modes)
```json
{"t":"respawn","id":"p77b0e2","x":20.1,"y":3.9,"z":-4.4,"hp":100,"sh":0}
```

### `end`
```json
{"t":"end","winner":"p3fa91c","team":null,"ranks":[{"id":"p3fa91c","nick":"CosmicPanda42","kills":2,"place":1,"team":1},{"id":"p9c1d00","nick":"LuckyKoala55","kills":0,"place":2,"team":3}]}
{"t":"end","winner":null,"team":0,"ranks":[…],"score":[15,9]}
```

### Builds
```json
{"t":"built","s":7,"id":4,"type":"wall","mat":"wood","x":40,"y":3.25,"z":10,"rot":3,"hp":150,"by":"p77b0e2"}
{"t":"buildNo","s":8,"why":"need_mats"}
{"t":"buildHp","id":4,"hp":57}
{"t":"buildGone","id":4}
```
`buildNo.why`: `not_playing bad_type bad_mat bad_pos off_grid off_map too_far taken need_mats too_fast`. Piece HP: wood 150, stone 300, metal 500 (floors/ramps × 0.93), same as `MATS` in src/game3.js.

### People coming and going
```json
{"t":"away","id":"p77b0e2","graceMs":30000}
{"t":"back","id":"p77b0e2"}
{"t":"left","id":"p77b0e2","why":"timeout"}
{"t":"joinedMatch","p":{"id":"p11aa22","nick":"MegaShark30","team":1,"host":false,"on":true,"skin":"recruit"}}
{"t":"emote","id":"p77b0e2","e":"gg"}
{"t":"closed","why":"too_old"}
```

### Close codes
`1009` message too big · `4001` you opened the room on another tab/device · `4002` room closed (older than 1 hour) · `4008` too many messages (flooding).

---
## 3. Limits (see `DEFAULTS` in server.js)
20 Hz tick · 2–8 players per room · 200 rooms · 12 sockets per IP · 60 msgs/s (extra dropped), 120 msgs/s = kick · 30 s rejoin grace · rooms deleted when empty or after 1 hour · nothing is saved to disk.
