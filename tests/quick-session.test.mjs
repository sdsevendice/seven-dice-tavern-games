import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as engine from '../scripts/quick-engine.mjs';
import { bindNpcDrop, resolveNpcActors } from '../scripts/npc-drop.mjs';
import { BOARD_GEOMETRY } from '../scripts/dartboard-art.mjs';
const source = fs.readFileSync(new URL('../scripts/quick-games.mjs', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '').replace('export class QuickGamesApp', 'class QuickGamesApp');
export function quickSession() {
  let id = 0;
  const warnings = [], messages = [];
  const users = [{ id:'a', name:'Мастер', active:true, isGM:true }, { id:'b', name:'Путник', active:true, isGM:false }];
  users.get = id => users.find(u => u.id === id);
  const game = { user:users[0], users, settings:{ get:()=>'classic' }, socket:{emit(){}}, dice3d:{showForRoll:async()=>{throw Error('DSN failure');}} };
  const context = vm.createContext({ ...engine, BOARD_GEOMETRY, bindNpcDrop, resolveNpcActors, game, saveRecovery(){}, loadRecovery(){return null;}, console:{...console,warn(){}}, setTimeout,
    ui:{notifications:{warn:m=>warnings.push(m)}}, Hooks:{once(){},on(){}},
    ChatMessage:{create:async m=>messages.push(m)},
    foundry:{utils:{deepClone:x=>JSON.parse(JSON.stringify(x)),escapeHTML:String,randomID:()=>String(++id)}, applications:{api:{ApplicationV2:class{},HandlebarsApplicationMixin:x=>x}}},
    Roll:class { constructor(formula){this.formula=formula;} async evaluate(){return { dice:this.formula==='1d20 + 1d6' ? [{results:[{result:20}]},{results:[{result:5}]}] : [{results:Array.from({length:this.formula==='2d6'?2:1},()=>({result:4}))}] };} }
  });
  vm.runInContext(source+'\nglobalThis.api={handleRequest,QuickGamesApp,makeDartVisual,get state(){return hostState;}};',context);
  const api=context.api;
  const send=(action,data={},participantId=api.state?.activeParticipantId,extra={})=>api.handleRequest({action,data,participantId,senderId:api.state?.participants.find(p=>p.id===participantId)?.controllerUserId??'a',...extra});
  const create=(gameId='baldur-dice',extra={})=>send('create',{gameId,userIds:['a','b'],stake:'1 зм',target:301,...extra},null);
  return {api,game,send,create,warnings,messages};
}
{
  const s=quickSession();await s.create();
  await s.send('baldurRoll');assert.equal(s.api.state.participants[0].total,8,'DSN errors do not lose rolls');
  const token={tableId:s.api.state.id,revision:s.api.state.revision};
  await s.send('baldurHit',{},undefined,token);await s.send('baldurHit',{},undefined,token);
  assert.equal(s.api.state.participants[0].total,12,'stale duplicate rejected');
  const original=s.api.state.id;await s.create('goblin-darts');assert.equal(s.api.state.id,original,'active table preserved');
  await s.send('baldurStand');await s.send('baldurRoll');await s.send('baldurStand');
  assert.equal(s.api.state.phase,'finished');assert.equal(s.messages.length,1);
  await s.send('replay',{},null);assert.equal(s.api.state.phase,'playing');assert.equal(s.api.state.participants[0].total,0);
}
{
  const s=quickSession();await s.create('goblin-darts',{stake:'wrong'});assert.equal(s.api.state,null);
  await s.create('goblin-darts',{target:Infinity});assert.equal(s.api.state,null);
  await s.create('goblin-darts',{target:20});await s.send('dartsRoll');
  assert.equal(s.api.state.phase,'finished');assert.equal(s.api.state.lastDart.points,60);
  const app=new s.api.QuickGamesApp();const view=await app._prepareContext();
  assert.ok(view.dartsVisual.highlight);assert.equal(view.dartsVisual.equation,'20 × 3 = 60');
  assert.equal(view.targetSectors.length,20);assert.equal(s.messages.length,1);
}
console.log('Quick sessions: DSN failure, duplicate requests, validation, active-table guard, replay and winning dart passed.');
{
  const s=quickSession();
  for(const skin of ['classic','rustic'])for(let sector=1;sector<=20;sector++)for(let hit=1;hit<=6;hit++){
    const v=s.api.makeDartVisual({sector,hit,multiplier:3,points:sector*3},skin);
    assert.ok(!v.markerStyle.includes('NaN'));
    assert.equal(v.highlight===null,hit===6);
    if(v.highlight)assert.ok(!v.highlight.includes('NaN'));
    const radius=hit===6?0:hit<=2?37:hit<=4?22:31.3;
    const angle=(sector-1)*18-90;
    assert.equal(v.markerStyle,`--dart-x:${50+radius*Math.cos(angle*Math.PI/180)}%;--dart-y:${50+radius*Math.sin(angle*Math.PI/180)}%;--dart-angle:${angle}deg`,'impact unchanged');
  }
}
