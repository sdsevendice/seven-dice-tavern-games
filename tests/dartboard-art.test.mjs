import assert from 'node:assert/strict';
import fs from 'node:fs';
import {BOARD_GEOMETRY,renderDartboard} from '../scripts/dartboard-art.mjs';
assert.equal(BOARD_GEOMETRY.sectors,20);
assert.equal(360/BOARD_GEOMETRY.sectors,18);
assert.ok(BOARD_GEOMETRY.tripleInner<BOARD_GEOMETRY.impactTriple && BOARD_GEOMETRY.impactTriple<BOARD_GEOMETRY.tripleOuter);
for(const style of ['classic','rustic']) {
  const svg=fs.readFileSync(new URL(`../assets/dartboard-${style}-20.svg`,import.meta.url),'utf8');
  assert.equal(svg.trim(),renderDartboard(style).trim(),'asset matches shared geometry');
  assert.deepEqual([...svg.matchAll(/data-sector="(\d+)"/g)].map(m=>Number(m[1])),Array.from({length:20},(_,i)=>i+1));
}
console.log('Dartboards: exact 20 sectors, 18-degree pitch and reproducible geometry passed.');
