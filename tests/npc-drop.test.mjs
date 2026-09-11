import assert from 'node:assert/strict';
import { resolveNpcActors } from '../scripts/npc-drop.mjs';
import { session } from './poker-session.test.mjs';
import { quickSession } from './quick-session.test.mjs';
globalThis.fromUuid=async uuid=>uuid==='Actor.innkeeper'?{documentName:'Actor',name:'Трактирщик',img:'portrait.webp',prototypeToken:{texture:{src:'token.webp'}}}:uuid==='Actor.random'?{documentName:'Actor',name:'Гость',img:'portrait.webp',prototypeToken:{randomImg:true,texture:{src:'tokens/*.webp'}}}:null;
const [actor]=await resolveNpcActors(['Actor.innkeeper']);assert.equal(actor.portrait,'token.webp');
assert.equal((await resolveNpcActors(['Actor.random']))[0].portrait,'portrait.webp');
assert.equal((await resolveNpcActors(['Actor.innkeeper','Actor.innkeeper'])).length,1);
await assert.rejects(resolveNpcActors(['Actor.missing']));
const s=session();await s.send('create',null,{userIds:['a'],npcNames:[],npcActorUuids:['Actor.innkeeper'],bet:'1 зм',simultaneous:true});
const npc=s.api.table.participants.find(p=>p.kind==='npc');assert.equal(npc.name,'Трактирщик');assert.equal(npc.portrait,'token.webp');assert.equal(npc.controllerUserId,'a');
assert.equal(s.api.publicSnapshot().participants.find(p=>p.id===npc.id).portrait,'token.webp');
for(const gameId of ['goblin-darts','baldur-dice']){
  const q=quickSession();await q.create(gameId,{userIds:['a'],npcActorUuids:['Actor.innkeeper']});
  assert.equal(q.api.state.participants[1].name,'Трактирщик');assert.equal(q.api.state.participants[1].portrait,'token.webp');
  assert.equal(q.api.state.setup.npcActorUuids[0],'Actor.innkeeper');
}
delete globalThis.fromUuid;
console.log('NPC actors: token, fallback, invalid drops, deduplication and all three game setups passed.');
