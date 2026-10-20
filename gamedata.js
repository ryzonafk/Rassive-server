'use strict';
// Game rules the server needs, copied from the game source so both sides agree.
// Source of truth: ../src (read only). If the game changes, update this file.
const GUNS = require('./guns.json'); // made by `npm run guns` from src/game1.js GUNS

// Pickaxe (src/game3.js playerFire, cur===0): 20 dmg to players, 50 to builds, every 0.45 s, 3.6 m reach.
const PICK = { name: 'Pickaxe', dmg: 20, pieceDmg: 50, rate: 1 / 0.45, range: 3.6, mag: Infinity, spread: 0 };

// Terrain height, copied from src/game1.js H(x,z) (deterministic, no randomness).
const ISL = 175;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const riverX = z => 14 * Math.sin(z * 0.018) + 6 * Math.sin(z * 0.05 + 1);
function H(x, z) {
  const r = Math.hypot(x, z) / ISL;
  let h = 4.2 + 2.2 * Math.sin(x * 0.045) * Math.cos(z * 0.038) + 1.5 * Math.sin(x * 0.11 + z * 0.07) + 1.1 * Math.cos(z * 0.09 - 1);
  h += 7 * Math.exp(-((x - 80) ** 2 + (z + 70) ** 2) / 700) + 5 * Math.exp(-((x + 90) ** 2 + (z - 80) ** 2) / 900);
  h = lerp(h, -6, smooth(0.78, 1.02, r));
  const d = Math.abs(x - riverX(z));
  h = lerp(-2.4, h, smooth(5, 12, d));
  return h;
}
const MAP_HALF = 210; // world is 420 x 420 (src/game1.js SIZE)

// Modes, matching src/game2.js MODES (online subset; creative stays offline).
const MODES = {
  br:      { name: 'BATTLE ROYALE', storm: true,  respawn: false, load: ['ak45'],         wood: 30,  stone: 0,   metal: 0,  maxPlayers: 8 },
  oneshot: { name: 'ONE SHOT',      storm: true,  respawn: false, load: ['sniper'],       wood: 60,  stone: 0,   metal: 0,  maxPlayers: 8, oneShot: true },
  teams:   { name: 'TEAMS',         storm: false, respawn: true,  load: ['ak45', 'pump'], wood: 100, stone: 0,   metal: 0,  maxPlayers: 8, teams: true, goal: 15 },
  duel:    { name: '1v1 ARENA',     storm: false, respawn: true,  load: ['ak45', 'pump'], wood: 200, stone: 100, metal: 60, maxPlayers: 2, goal: 5, shieldOnSpawn: 50 },
};

// Build pieces (src/game3.js MATS, BCOST, planPiece). Grid cells are 4 m.
const MATS = { wood: 150, stone: 300, metal: 500 };
const BCOST = 10;
const CELL = 4;
const HARVEST = { wood: 12, stone: 9, metal: 7 }; // per pickaxe hit (trees give 12 wood)

// Storm phases from src/game4.js STORM_PH: [seconds, shrinking?, radius]
const STORM_PH = [[45, 0, 230], [40, 1, 130], [30, 0, 130], [35, 1, 70], [25, 0, 70], [30, 1, 30], [20, 0, 30], [40, 1, 4], [1e9, 0, 4]];

// Player hit box (src/game2.js makeGuy): feet at pos.y, body to ~1.65, head 1.65..2.15.
const HITBOX = { r: 0.45, h: 2.15, headY: 1.65, eye: 1.62 };

// Kid-safe: no free text. Only these emotes, and server-made nicknames.
const EMOTES = ['wave', 'gg', 'lol', 'thumbs', 'wow', 'sorry', 'dance', 'heart'];
const NICK_A = ['Blue', 'Red', 'Gold', 'Green', 'Turbo', 'Cosmic', 'Mega', 'Pixel', 'Rocket', 'Sunny', 'Frost', 'Lava', 'Jolly', 'Zippy', 'Mighty', 'Lucky'];
const NICK_B = ['Rocket', 'Comet', 'Panda', 'Falcon', 'Tiger', 'Dragon', 'Ninja', 'Robot', 'Meteor', 'Builder', 'Llama', 'Shark', 'Fox', 'Wizard', 'Penguin', 'Koala'];

module.exports = { GUNS, PICK, H, MAP_HALF, MODES, MATS, BCOST, CELL, HARVEST, STORM_PH, HITBOX, EMOTES, NICK_A, NICK_B, clamp, lerp };
