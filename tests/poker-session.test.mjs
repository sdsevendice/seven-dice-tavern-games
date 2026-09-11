import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as engine from '../scripts/engine.mjs';
import { TAVERN_GAMES } from '../scripts/catalog.mjs';
import { bindNpcDrop, resolveNpcActors } from '../scripts/npc-drop.mjs';

// Exercise the actual request handlers, not a second implementation of turns.
const source = fs.readFileSync(new URL('../scripts/main.mjs', import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/gm, '');
export function session() {
  let nextId = 0, order = 20;
  const warnings = [], messages = [], rolls = [];
  const users = ['a', 'b', 'c'].map(id => ({ id, name: id, active: true, isGM: id === 'a' }));
  users.get = id => users.find(user => user.id === id);
  const context = vm.createContext({
    ...engine, bindNpcDrop, resolveNpcActors, saveRecovery() {}, loadRecovery() { return null; }, TAVERN_GAMES, QuickGamesApp: {}, console: { ...console, warn() {} },
    game: { user: users[0], users, socket: { emit(channel, packet) { if (packet.type === 'error') warnings.push(packet.message); } } },
    foundry: {
      utils: { randomID: () => String(++nextId), escapeHTML: s => String(s) },
      applications: { api: { ApplicationV2: class {}, HandlebarsApplicationMixin: x => x } }
    },
    ui: { notifications: { warn: message => warnings.push(message) } },
    Hooks: { once() {}, on() {} },
    ChatMessage: { create: async message => messages.push(message) },
    Roll: class {
      constructor(formula) { this.formula = formula; }
      async evaluate() {
        if (this.formula === '1d20') return { total: order-- };
        rolls.push(this.formula);
        return { dice: [{ results: Array.from({ length: Number(this.formula.split('d')[0]) }, (_, i) => ({ result: i + 1 })) }] };
      }
    }
  });
  vm.runInContext(source + '\nglobalThis.harness = { handleHostRequest, publicSnapshot, privateSnapshotFor, DiceParlorApp, TavernGamesHubApp, get table() { return hostTable; } };', context);
  const api = context.harness;
  const send = (action, id, data = {}) => api.handleHostRequest({ action, participantId: id, senderId: api.table?.participants.find(p => p.id === id)?.controllerUserId ?? 'a', data });
  const create = async (count = 2, simultaneous = false) => send('create', null, { simultaneous, userIds: users.slice(0, count).map(u => u.id), npcNames: Array.from({ length: Math.max(0, count - users.length) }, (_, i) => `NPC ${i + 1}`), bet: '1 зм' });
  const choice = async id => { await send('roll', id); if (api.table.participants.find(p => p.id === id).awaitingChoice) await send('endTurn', id); };
  const settle = async () => {
    for (let n = 0; api.table.phase === 'betting' && n < 20; n++) await send('callStake', api.table.bettingActiveParticipantId);
    assert.notEqual(api.table.phase, 'betting', 'betting must finish');
  };
  return { api, send, create, choice, settle, warnings, messages, rolls };
}

{
  const s = session(); await s.create();
  const [a, b] = s.api.table.participants;
  await s.choice(a.id); assert.equal(s.api.table.phase, 'playing');
  await s.choice(b.id); assert.equal(s.api.table.phase, 'betting');
  await s.settle(); assert.equal(s.api.table.round, 2);
  await s.choice(a.id);
  assert.equal(s.api.table.phase, 'betting');
  assert.equal(s.api.table.bettingActiveParticipantId, a.id);
  const rollsBefore = s.rolls.length;
  await s.send('roll', b.id);
  assert.equal(s.rolls.length, rollsBefore, 'next player cannot roll during betting');
  await s.send('raiseStake', a.id, { amount: '12' });
  await s.send('raiseStake', b.id, { amount: '1' });
  await s.send('callStake', a.id);
  assert.equal(s.api.table.poolAmount, 28);
  assert.equal(s.api.table.activeParticipantId, b.id);
  await s.choice(b.id); await s.settle();
  assert.equal(s.api.table.round, 3);
  await s.choice(a.id);
  assert.equal(b.rollCount, 2, 'final roll waits for response');
  await s.settle(); await s.choice(b.id);
  assert.equal(s.api.table.phase, 'betting', 'last roll still has betting');
  await s.settle(); assert.equal(s.api.table.phase, 'finished');
  assert.equal(s.messages.length, 1);
  assert.equal(s.warnings.length, 1, 'only intentional out-of-turn action rejected');
}
{
  const s = session(); await s.create(3);
  const [a, b, c] = s.api.table.participants;
  await s.send('roll', a.id);
  for (let i = 0; i < 5; i++) await s.send('toggle', a.id, { index: i });
  await s.send('endTurn', a.id); assert.equal(a.completed, true);
  await s.choice(b.id); await s.choice(c.id); await s.settle();
  assert.equal(s.api.table.activeParticipantId, b.id);
  await s.choice(b.id); await s.send('raiseStake', b.id, { amount: '5' });
  await s.send('betFold', c.id);
  assert.equal(s.api.table.bettingActiveParticipantId, a.id, 'completed hand must answer raises');
  await s.settle();
  assert.equal(s.api.table.round, 3);
  assert.equal(s.api.table.activeParticipantId, b.id);
  await s.choice(b.id); await s.settle();
  assert.equal(s.api.table.phase, 'finished');
  assert.equal(s.warnings.length, 0);
}
{
  const s = session(); await s.create(); const [a, b] = s.api.table.participants;
  await s.choice(a.id); await s.choice(b.id); await s.settle();
  await s.choice(a.id); await s.send('raiseStake', a.id, { amount: '12' });
  await s.send('raiseStake', b.id, { amount: '1' }); await s.send('betFold', a.id);
  assert.equal(a.foldLoss, '13 зм', 'fold loses actual contribution, not half or unpaid raise');
  assert.equal(s.api.table.poolAmount, 27);
  assert.equal(s.api.table.phase, 'finished');
  assert.equal(s.messages.length, 1);
}
{
  const s = session(); await s.create(); const [a, b] = s.api.table.participants;
  await s.send('roll', a.id); await s.send('toggle', a.id, { index: 0 });
  const view = await new s.api.DiceParlorApp()._prepareContext();
  assert.equal(view.heldDice.length, 1); assert.equal(view.freeDice.length, 4);
  assert.equal(view.heldDice[0].index, 0);
  assert.equal(s.api.publicSnapshot().participants[0].dice, null);
  assert.equal(s.api.privateSnapshotFor('b')[a.id], undefined);
  await s.send('toggle', a.id, { index: 0 });
  assert.equal(a.held[0], false, 'second click returns die');
  await s.send('endTurn', a.id); await s.choice(b.id); await s.settle();
  await s.send('fold', a.id);
  assert.equal(s.api.table.phase, 'finished');
}
for (const count of [2, 3, 4, 5, 6]) {
  const s = session(); await s.create(count);
  for (let step = 0; step < 100 && s.api.table.phase !== 'finished'; step++) {
    if (s.api.table.phase === 'betting') await s.settle();
    else await s.choice(s.api.table.activeParticipantId);
  }
  assert.equal(s.api.table.phase, 'finished');
  assert.ok(s.api.table.participants.every(p => p.rollCount === 3));
  assert.equal(s.api.table.poolAmount, count);
  assert.equal(s.warnings.length, 0);
  assert.equal(s.messages.length, 1);
}
{
  const s = session(); await s.create();
  for (const p of s.api.table.participants) {
    await s.send('roll', p.id);
    for (let i = 0; i < 5; i++) await s.send('toggle', p.id, { index: i });
    await s.send('endTurn', p.id);
  }
  await s.settle();
  assert.equal(s.api.table.phase, 'finished', 'all early hands finish after betting');
  assert.equal(s.rolls.length, 2);
}
console.log('Poker session: selection, turn betting, raises, folds, privacy, 2–6 participants and showdown passed.');
{
  const s=session();await s.create(2,true);const [a,b]=s.api.table.participants;
  await s.send('roll',a.id);for(let index=0;index<5;index++)await s.send('toggle',a.id,{index});
  await s.send('endTurn',a.id);await s.choice(b.id);await s.settle();
  let view=await new s.api.DiceParlorApp()._prepareContext();
  assert.equal(view.heldDice.length,5);assert.equal(view.canChoose,true);assert.equal(view.canRoll,false);
  assert.ok(view.heldDice.every(d=>d.selectable),'old kept dice can be returned before rolling');
  await s.send('toggle',a.id,{index:0});assert.equal(a.held[0],false);assert.equal(a.completed,false);
  await s.send('roll',a.id);assert.equal(s.rolls.at(-1),'1d6');
  await s.send('endTurn',a.id);await s.send('toggle',a.id,{index:1});assert.equal(a.held[1],true,'ready locks hand');
  await s.choice(b.id);await s.settle();
  await s.send('toggle',a.id,{index:1});assert.equal(a.held[1],false,'old kept die can be released before final roll');
  await s.send('roll',a.id);assert.equal(s.rolls.at(-1),'2d6');
  await s.send('toggle',a.id,{index:2});assert.equal(a.held[2],true,'final results locked');
  await s.send('endTurn',a.id);await s.choice(b.id);await s.settle();assert.equal(s.api.table.phase,'finished');
  const hub=await new s.api.TavernGamesHubApp()._prepareContext();assert.equal(hub.readyCount,3);assert.equal(hub.totalCount,8);
}
for (const count of [2,3,6]) {
  const s=session();await s.create(count,true);
  for(let round=1;round<=3;round++) {
    const participants=[...s.api.table.participants].reverse();
    const revision=s.api.table.revision;
    // Independent clients may submit rolls against the same public revision.
    const packets=participants.map(p=>({action:'roll',data:{},senderId:p.controllerUserId,participantId:p.id,tableId:s.api.table.id,revision,phase:'playing',round,actionRevision:p.actionRevision??0}));
    for(const packet of packets)await s.api.handleHostRequest(packet);
    assert.equal(s.api.table.phase,'playing','rolling alone does not mark anyone ready');
    const before=s.rolls.length;
    await s.api.handleHostRequest(packets[0]);assert.equal(s.rolls.length,before,'duplicate roll rejected');
    for(let index=0;index<participants.length;index++) {
      await s.send('endTurn',participants[index].id);
      if(index<participants.length-1)assert.equal(s.api.table.phase,'playing','wait for last confirmation');
    }
    assert.equal(s.api.table.phase,'betting');
    assert.ok(s.api.publicSnapshot().participants.every(p=>p.dice===null),'no reveal before final betting');
    await s.settle();
  }
  assert.equal(s.api.table.phase,'finished');assert.equal(s.messages.length,1);
}
{
  const s=session();await s.create(3,true);const [a,b,c]=s.api.table.participants;
  await s.send('roll',a.id);for(let i=0;i<5;i++)await s.send('toggle',a.id,{index:i});await s.send('endTurn',a.id);
  await s.choice(c.id);await s.choice(b.id);
  await s.send('raiseStake',a.id,{amount:'12'});await s.send('raiseStake',b.id,{amount:'1'});await s.send('betFold',c.id);await s.settle();
  assert.equal(s.api.table.poolAmount,29);
  await s.choice(b.id);assert.equal(s.api.table.phase,'playing','kept hand must also confirm');await s.send('endTurn',a.id);await s.settle();
  await s.choice(b.id);await s.send('endTurn',a.id);await s.settle();assert.equal(s.api.table.phase,'finished');
}
{
  const s=session();await s.create();const [a,b]=s.api.table.participants;
  await s.choice(a.id);
  const view=await new s.api.DiceParlorApp()._prepareContext();
  assert.equal(view.bettingHands.length,1,'own hand remains while opponent plays');
  assert.equal(view.bettingHands[0].name,a.name);
  assert.equal(view.bettingHands[0].count,0,'unkept results are not shown');
  assert.equal(view.bettingHands[0].combination,'','no complete combination for an empty hand');
  assert.ok(view.table.history.every(row=>!row.includes('1 · 2')),'history excludes dice values');
  assert.equal(s.api.privateSnapshotFor('b')[a.id],undefined);
}
{
  const s=session();await s.create();const [a,b]=s.api.table.participants;
  await s.send('roll',a.id);
  await s.send('toggle',a.id,{index:0});await s.send('toggle',a.id,{index:3});
  await s.send('endTurn',a.id);
  let view=await new s.api.DiceParlorApp()._prepareContext();
  assert.deepEqual(Array.from(view.bettingHands[0].dice,d=>d.value),[1,4]);
  assert.equal(view.bettingHands[0].combination,'Пока без комбинации');
  await s.choice(b.id);
  view=await new s.api.DiceParlorApp()._prepareContext();
  assert.equal(view.bettingHands[0].count,2,'kept-only display also during betting');
}
{
  const s=session();await s.create();const [a,b]=s.api.table.participants;
  await s.choice(a.id);await s.choice(b.id);await s.settle();
  await s.choice(a.id);await s.send('callStake',a.id);
  assert.equal(s.api.table.activeParticipantId,b.id,'check advances without redundant replies');
  await s.send('fold',b.id);
  assert.ok(s.api.publicSnapshot().participants.every(p=>p.dice===null),'fold victory never reveals a hand');
  assert.ok(!s.messages[0].content.includes('1 · 2 · 3 · 4 · 5'));
  await s.send('replay');assert.equal(s.api.table.phase,'playing');
}
