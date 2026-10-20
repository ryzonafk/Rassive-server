// Re-run with `npm run guns` whenever weapons change in ../src/game1.js.
// It only READS the game source and writes server/guns.json.
const fs = require('fs'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'game1.js'), 'utf8');
const start = src.indexOf('const GUNS={');
if (start < 0) throw new Error('GUNS table not found in src/game1.js');
let i = src.indexOf('{', start), depth = 0, end = -1;
for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } } }
const GUNS = new Function('return ' + src.slice(src.indexOf('{', start), end + 1))();
const keep = ['name', 'dmg', 'rate', 'mag', 'reload', 'spread', 'range', 'pellets', 'burst', 'splash', 'res'];
const out = {};
for (const [id, g] of Object.entries(GUNS)) { out[id] = {}; for (const k of keep) if (g[k] != null) out[id][k] = g[k]; }
fs.writeFileSync(path.join(__dirname, '..', 'guns.json'), JSON.stringify(out, null, 1) + '\n');
console.log('Wrote guns.json with ' + Object.keys(out).length + ' weapons');
