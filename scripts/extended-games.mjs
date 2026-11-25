import { CROWN_SYMBOLS, MAX_CROWN_COINS, normalizeCrownBets, settleCrown, crownHouseNet, scoreDeadlyShot, deadlyWinners, longestSequence, hammerDelta, highestWinners } from "./extended-engine.mjs";
import { bindNpcDrop, resolveNpcActors } from "./npc-drop.mjs";
import { saveRecovery, loadRecovery } from "./recovery.mjs";

const MODULE_ID="seven-dice-tavern-games", MODULE_PATH=`modules/${MODULE_ID}`, SOCKET=`module.${MODULE_ID}`, MAX_PLAYERS=6;
const TITLES={"crown-anchor":"Корона и Якорь","deadly-shot":"Смертельный выстрел","help-neighbor":"Помощь соседу","madness-mark":"Метка безумия","hammer-ring":"Звон молота"};
const MIN_PLAYERS={"crown-anchor":1,"deadly-shot":2,"help-neighbor":3,"madness-mark":2,"hammer-ring":2};
let hostState=null,publicState=null,privateState={},queue=Promise.resolve(),pending=false;

function playHammerSound(){try{if(game.settings.get(MODULE_ID,"quietEffects"))return;const Context=globalThis.AudioContext??globalThis.webkitAudioContext;if(!Context)return;const context=playHammerSound.context??=new Context(),now=context.currentTime,master=context.createGain();master.gain.setValueAtTime(.48,now);master.gain.exponentialRampToValueAtTime(.001,now+.72);master.connect(context.destination);const impact=context.createOscillator(),impactGain=context.createGain();impact.type="sine";impact.frequency.setValueAtTime(118,now);impact.frequency.exponentialRampToValueAtTime(68,now+.16);impactGain.gain.setValueAtTime(.9,now);impactGain.gain.exponentialRampToValueAtTime(.001,now+.2);impact.connect(impactGain).connect(master);impact.start(now);impact.stop(now+.22);for(const [frequency,volume,duration] of [[286,.28,.5],[431,.18,.62],[713,.1,.42]]){const tone=context.createOscillator(),gain=context.createGain();tone.type="sine";tone.frequency.setValueAtTime(frequency,now);gain.gain.setValueAtTime(volume,now+.015);gain.gain.exponentialRampToValueAtTime(.001,now+duration);tone.connect(gain).connect(master);tone.start(now+.01);tone.stop(now+duration);}const length=Math.floor(context.sampleRate*.09),buffer=context.createBuffer(1,length,context.sampleRate),data=buffer.getChannelData(0);for(let i=0;i<length;i++)data[i]=(Math.random()*2-1)*(1-i/length);const noise=context.createBufferSource(),filter=context.createBiquadFilter(),noiseGain=context.createGain();noise.buffer=buffer;filter.type="bandpass";filter.frequency.value=1250;filter.Q.value=.7;noiseGain.gain.setValueAtTime(.24,now);noiseGain.gain.exponentialRampToValueAtTime(.001,now+.09);noise.connect(filter).connect(noiseGain).connect(master);noise.start(now);noise.stop(now+.1);}catch(error){console.warn(MODULE_ID,"hammer sound unavailable",error);}}

function playTableCue(kind) {
  try {
    if (game.settings.get(MODULE_ID, "quietEffects")) return;
    const Context = globalThis.AudioContext ?? globalThis.webkitAudioContext;
    if (!Context) return;
    const ctx = playHammerSound.context ??= new Context();
    const t = ctx.currentTime;
    const notes = kind === "shot" ? [360, 235] : kind === "loss" ? [760, 545] : [1170, 1520, 980];
    notes.forEach((hz, index) => {
      const tone = ctx.createOscillator(), gain = ctx.createGain(), start = t + index * .043;
      tone.type = index === 0 && kind === "shot" ? "triangle" : "sine";
      tone.frequency.setValueAtTime(hz, start);
      gain.gain.setValueAtTime(.001, start);
      gain.gain.exponentialRampToValueAtTime(.13, start + .007);
      gain.gain.exponentialRampToValueAtTime(.001, start + .15);
      tone.connect(gain).connect(ctx.destination); tone.start(start); tone.stop(start + .16);
    });
  } catch (error) { console.warn(MODULE_ID, "table sound unavailable", error); }
}
function activeHost(){return game.users.filter(u=>u.active&&u.isGM).sort((a,b)=>a.id.localeCompare(b.id))[0]??null;}
function isHost(){return activeHost()?.id===game.user.id;}
function money(value){const m=String(value??"").trim().match(/^(\d+(?:[.,]\d+)?)\s*(.*)$/);if(!m)throw new Error("Укажите ставку, например 1 зм.");return {amount:Number(m[1].replace(",",".")),currency:m[2].trim()||"зм"};}
function format(amount,currency){return `${Number.isInteger(amount)?amount:Math.round(amount*100)/100} ${currency}`;}
function dieFace(value){return ["","⚀","⚁","⚂","⚃","⚄","⚅"][value]??String(value);}
async function roll(formula,userId=game.user.id,{privateRoll=false}={}){const result=await new Roll(formula).evaluate();try{const roller=game.users.get(userId)??game.user,hideOnHost=privateRoll&&game.user.id!==roller.id;await game.dice3d?.showForRoll?.(result,roller,true,privateRoll?[roller]:null,hideOnHost);}catch(error){console.warn(MODULE_ID,"3D dice unavailable",error);}return result.dice.flatMap(d=>d.results.map(r=>r.result));}
function clone(value){return foundry.utils.deepClone(value);}
function participant(id){return hostState.participants.find(p=>p.id===id);}
function controlled(packet,{active=true}={}){const p=participant(packet.participantId);if(!p)throw new Error("Участник не найден.");if(p.controllerUserId!==packet.senderId)throw new Error("Этим участником управляет другой пользователь.");if(active&&hostState.activeParticipantId!==p.id)throw new Error("Сейчас ход другого участника.");return p;}
function portrait(entry){return entry.kind==="npc"?entry.portrait:(game.users.get(entry.controllerUserId)?.character?.img||game.users.get(entry.controllerUserId)?.avatar||null);}
function snapshot(){if(!hostState)return null;const state=clone(hostState);if(state.gameId==="deadly-shot"&&state.phase!=="finished")for(const p of state.participants){p.dice=null;p.combo=null;}return state;}
function privateFor(userId){if(!hostState||hostState.gameId!=="deadly-shot")return {};return Object.fromEntries(hostState.participants.filter(p=>p.controllerUserId===userId).map(p=>[p.id,{dice:p.dice,rerolled:p.rerolled,ready:p.ready}]));}
function accept(state){publicState=state;pending=false;if(ExtendedGamesApp.instance?.rendered)ExtendedGamesApp.instance.render({force:true});}
function acceptPrivate(state){privateState=state??{};pending=false;if(publicState?.gameId==="deadly-shot"&&publicState.phase!=="finished"&&ExtendedGamesApp.instance?.rendered)ExtendedGamesApp.instance.render({force:true});}
function sendTo(userId){const state={type:"ext-state",targetUserId:userId,state:snapshot()},secret={type:"ext-private",targetUserId:userId,state:privateFor(userId)};if(userId===game.user.id){accept(state.state);acceptPrivate(secret.state);}else{game.socket.emit(SOCKET,state);game.socket.emit(SOCKET,secret);}}
function broadcast(){if(!isHost())return;if(hostState){hostState.revision=(hostState.revision??0)+1;saveRecovery("extended",hostState);}for(const user of game.users.filter(u=>u.active))sendTo(user.id);}
function next(currentId){const list=hostState.participants,start=list.findIndex(p=>p.id===currentId);for(let i=1;i<=list.length;i++){const p=list[(start+i)%list.length];if(hostState.gameId==="madness-mark"?p.turns<hostState.maxTurns:true){hostState.activeParticipantId=p.id;return;}}}
function html(value){return foundry.utils.escapeHTML(String(value));}
async function chatResult(){const rows=hostState.participants.map(p=>`<li><strong>${html(p.name)}</strong>: ${html(p.resultLabel??p.score??p.tokens??"")}</li>`).join("");await ChatMessage.create({speaker:{alias:"Игры Seven Dice"},content:`<section><h3>${html(hostState.title)}</h3><p>Банк: <strong>${html(hostState.pool)}</strong></p><ul>${rows}</ul><p><strong>${html(hostState.resultText)}</strong></p></section>`});}
async function finish(winners,text){hostState.phase="finished";hostState.activeParticipantId=null;hostState.winnerIds=winners.map(p=>p.id);hostState.resultText=text;await chatResult().catch(error=>console.warn(MODULE_ID,"chat result failed",error));}
function setupEntries(packet){return Promise.resolve().then(async()=>{const users=[...new Set(packet.data.userIds??[])].map(id=>game.users.get(id)).filter(u=>u?.active);const names=(packet.data.npcNames??[]).map(n=>String(n).trim()).filter(Boolean);const actors=await resolveNpcActors(packet.data.npcActorUuids??[]);if(users.length+names.length+actors.length>MAX_PLAYERS)throw new Error("За столом может быть не больше 6 участников.");return [...users.map(u=>({name:u.name,kind:"player",controllerUserId:u.id})),...names.map(name=>({name,kind:"npc",controllerUserId:packet.senderId})),...actors.map(a=>({...a,kind:"npc",controllerUserId:packet.senderId}))];});}

async function create(packet){if(!game.users.get(packet.senderId)?.isGM)throw new Error("Стол создаёт мастер.");if(!TITLES[packet.data.gameId])throw new Error("Неизвестная игра.");if(hostState&&hostState.phase!=="finished")throw new Error("Сначала закройте текущий стол.");const entries=await setupEntries(packet),minimum=MIN_PLAYERS[packet.data.gameId];if(entries.length<minimum)throw new Error(`Нужно минимум ${minimum} участника.`);const stake=money(packet.data.stake||"1 зм"),gameId=packet.data.gameId;
 if(gameId==="crown-anchor"&&(!Number.isFinite(stake.amount)||stake.amount<0.01||stake.amount>1000000))throw new Error("Укажите номинал монеты от 0,01 до 1 000 000.");
 const hammerTarget=Number(packet.data.hammerTarget??10);
 if(gameId==="hammer-ring"&&(!Number.isInteger(hammerTarget)||hammerTarget<3||hammerTarget>50))throw new Error("Цель — целое число от 3 до 50 жетонов.");
 hostState={id:foundry.utils.randomID(12),revision:0,gameId,title:TITLES[gameId],phase:"playing",setup:clone(packet.data),stakeAmount:stake.amount,currency:stake.currency,stake:format(stake.amount,stake.currency),pool:format(stake.amount*entries.length,stake.currency),activeParticipantId:null,winnerIds:[],resultText:"",round:1,participants:entries.map(e=>({...e,id:foundry.utils.randomID(12),score:0,tokens:0,turns:0,ready:false,dice:[],rerolled:false,bets:[],wager:0,payout:0,net:0,lastDelta:0,resultLabel:""}))};
 if(gameId==="crown-anchor"){hostState.phase="betting";hostState.pool=format(0,stake.currency);}
 if(gameId==="madness-mark"){hostState.marks=Array(21).fill(null);hostState.maxTurns=10;}
 if(gameId==="hammer-ring"){hostState.targetTokens=hammerTarget;hostState.advanced=Boolean(packet.data.advanced);}
 if(gameId==="help-neighbor"){hostState.target=Math.max(5,Number(packet.data.target)||15);hostState.protection=packet.data.protection!==false;}
 hostState.activeParticipantId=hostState.participants[0].id;broadcast();}

async function finishDeadly(){for(const p of hostState.participants){p.combo=scoreDeadlyShot(p.dice);p.resultLabel=`${p.dice.map(dieFace).join(" ")} · ${p.combo.name}`;}const winners=deadlyWinners(hostState.participants);await finish(winners,!winners.length?"Все промахнулись. Победителя нет.":winners.length>1?`Ничья: ${winners.map(p=>p.name).join(", ")}.`:`${winners[0].name} попадает точнее всех: ${winners[0].combo.name}.`);}
async function finishMadness(){for(const p of hostState.participants){p.sequence=longestSequence(hostState.marks,p.id);p.resultLabel=`лучшая цепочка: ${p.sequence}`;}const best=Math.max(...hostState.participants.map(p=>p.sequence));if(best<3)return finish([],"Никто не собрал последовательность из трёх чисел.");const winners=hostState.participants.filter(p=>p.sequence===best);await finish(winners,`Лучшая последовательность: ${best}. Победители: ${winners.map(p=>p.name).join(", ")}.`);}
async function handle(packet){try{
 if(packet.action==="sync"){sendTo(packet.senderId);return;}
 if(packet.action==="create"){await create(packet);return;}
 if(!hostState)throw new Error("Стол ещё не создан.");
 if(packet.tableId!==hostState.id||(packet.action!=="crownBet"&&packet.revision!==hostState.revision))throw new Error("Стол уже изменился. Повторите действие.");
 if(packet.action==="reset"){if(!game.users.get(packet.senderId)?.isGM)throw new Error("Стол закрывает мастер.");hostState=null;saveRecovery("extended",null);broadcast();return;}
 if(packet.action==="replay"){if(!game.users.get(packet.senderId)?.isGM||hostState.phase!=="finished")throw new Error("Повтор запускает мастер после завершения.");packet.data=hostState.setup;packet.action="create";hostState=null;await create(packet);return;}
 if(hostState.phase==="finished")throw new Error("Партия завершена.");
 if(packet.action==="crownBet"){
   const p=controlled(packet,{active:false});
   if(hostState.gameId!=="crown-anchor"||hostState.phase!=="betting"||p.ready)throw new Error("Ставка уже принята или ставки закрыты.");
   p.bets=normalizeCrownBets(packet.data.bets??packet.data.symbols);
   p.wager=p.bets.reduce((sum,entry)=>sum+entry.coins,0)*Math.round(hostState.stakeAmount*100)/100;
   p.ready=true;
   hostState.pool=format(hostState.participants.reduce((sum,x)=>sum+x.wager,0),hostState.currency);
   if(hostState.participants.every(x=>x.ready))hostState.phase="dealer";
   broadcast();return;
 }
 if(packet.action==="crownRoll"){if(hostState.gameId!=="crown-anchor"||hostState.phase!=="dealer"||!game.users.get(packet.senderId)?.isGM)throw new Error("Бросок делает мастер после всех ставок.");hostState.dice=await roll("3d6",packet.senderId);for(const p of hostState.participants){const settled=settleCrown(hostState.dice,p.bets,hostState.stakeAmount);p.wager=settled.wager;p.payout=settled.payout;p.net=settled.net;p.crownBreakdown=settled.breakdown.map(item=>{const entry=CROWN_SYMBOLS[item.symbol-1];return {...entry,...item,placedLabel:format(item.stake,hostState.currency),returnedLabel:format(item.returned,hostState.currency),outcome:item.matches?`совпадений: ${item.matches}`:"не выпал"};});p.resultLabel=`внесено ${format(p.wager,hostState.currency)} · возвращено ${format(p.payout,hostState.currency)} · итог ${p.net>=0?"+":""}${format(p.net,hostState.currency)}`;}const best=Math.max(...hostState.participants.map(p=>p.net)),winners=best>0?hostState.participants.filter(p=>p.net===best):[];const house=crownHouseNet(hostState.participants),currency=hostState.currency;
 const houseText=house>0?`Заведение в плюсе на ${format(house,currency)}.`:house<0?`Заведение в минусе на ${format(-house,currency)}.`:hostState.participants.every(p=>p.net===0)?"Раунд в ноль.":"Заведение вышло в ноль.";
 await finish(winners,best>0?`${houseText} Лучший чистый выигрыш: +${format(best,currency)}.`:houseText);broadcast();return;}
 if(packet.action==="deadlyRoll"){const p=controlled(packet,{active:false});if(hostState.gameId!=="deadly-shot"||p.dice.length)throw new Error("Начальный бросок уже сделан.");p.dice=await roll("3d6",p.controllerUserId,{privateRoll:true});broadcast();return;}
 if(packet.action==="deadlyReroll"){const p=controlled(packet,{active:false}),indexes=[...new Set((packet.data.indexes??[]).map(Number))].filter(i=>i>=0&&i<3);if(hostState.gameId!=="deadly-shot"||p.dice.length!==3||p.rerolled||indexes.length<1||indexes.length>2)throw new Error("Можно один раз перебросить одну или две кости.");const values=await roll(`${indexes.length}d6`,p.controllerUserId,{privateRoll:true});indexes.forEach((index,i)=>p.dice[index]=values[i]);p.rerolled=true;p.ready=true;if(hostState.participants.every(x=>x.ready))await finishDeadly();broadcast();return;}
 if(packet.action==="deadlyStand"){const p=controlled(packet,{active:false});if(hostState.gameId!=="deadly-shot"||p.dice.length!==3)throw new Error("Сначала бросьте 3d6.");p.ready=true;if(hostState.participants.every(x=>x.ready))await finishDeadly();broadcast();return;}
 if(packet.action==="helpRoll"){const p=controlled(packet);if(hostState.gameId!=="help-neighbor")throw new Error("Действие недоступно.");const [value]=await roll("1d6",p.controllerUserId);p.lastRoll=value;if(value===1){if(hostState.protection&&p.score>=10)p.resultLabel="Защита: счёт сохранён";else{const index=hostState.participants.indexOf(p),neighbor=hostState.participants[(index+1)%hostState.participants.length];neighbor.score+=p.score;p.score=0;p.resultLabel=`передаёт очки: ${neighbor.name}`;}}else{p.score+=value;p.resultLabel=`+${value}, всего ${p.score}`;}if(p.score>=hostState.target)await finish([p],`${p.name} первым набирает ${p.score} очков.`);else next(p.id);broadcast();return;}
 if(packet.action==="madnessRoll"){const p=controlled(packet);if(hostState.gameId!=="madness-mark"||hostState.pendingNumber)throw new Error("Сначала решите судьбу занятого числа.");const [value]=await roll("1d20",p.controllerUserId);p.lastRoll=value;const owner=hostState.marks[value];if(!owner){hostState.marks[value]=p.id;p.resultLabel=`занимает ${value}`;p.turns+=1;if(hostState.participants.every(x=>x.turns>=hostState.maxTurns))await finishMadness();else next(p.id);}else if(owner===p.id){p.resultLabel=`${value} уже ваше — перебросьте`;}else{hostState.pendingNumber=value;hostState.pendingOwnerId=owner;p.resultLabel=`${value} занято соперником`;}broadcast();return;}
 if(packet.action==="madnessRemove"||packet.action==="madnessReroll"){const p=controlled(packet);if(hostState.gameId!=="madness-mark"||!hostState.pendingNumber)throw new Error("Нет спорного числа.");if(packet.action==="madnessRemove"){hostState.marks[hostState.pendingNumber]=null;p.resultLabel=`удаляет чужую отметку ${hostState.pendingNumber}`;p.turns+=1;hostState.pendingNumber=null;hostState.pendingOwnerId=null;if(hostState.participants.every(x=>x.turns>=hostState.maxTurns))await finishMadness();else next(p.id);}else{p.resultLabel="выбирает переброс";hostState.pendingNumber=null;hostState.pendingOwnerId=null;}broadcast();return;}
 if(packet.action==="hammerRoll"){const p=controlled(packet);if(hostState.gameId!=="hammer-ring")throw new Error("Действие недоступно.");const [value]=await roll("1d6",p.controllerUserId),delta=hammerDelta(value,hostState.advanced),before=p.tokens;p.lastRoll=value;p.lastDelta=delta;p.tokens=Math.max(0,p.tokens+delta);p.actualDelta=p.tokens-before;p.turns+=1;p.resultLabel=p.actualDelta>0?`Молот звенит: +${p.actualDelta} жетон`:(p.actualDelta<0?`Потеряно жетонов: ${Math.abs(p.actualDelta)}`:"Терять нечего");hostState.hammerEvent={id:foundry.utils.randomID(8),participantId:p.id,name:p.name,value,delta:p.actualDelta,label:p.actualDelta>0?"+1 жетон":p.actualDelta<0?`−${-p.actualDelta} жет.`:"Терять нечего"};if(p.tokens>=hostState.targetTokens)await finish([p],`${p.name} первым собирает ${p.tokens} жетонов.`);else next(p.id);broadcast();return;}
 throw new Error("Неизвестное действие.");
 }catch(error){pending=false;console.warn(MODULE_ID,"extended request rejected",error);if(packet.senderId===game.user.id)ui.notifications.warn(error.message);else game.socket.emit(SOCKET,{type:"ext-error",targetUserId:packet.senderId,message:error.message});}}
function enqueue(packet){queue=queue.then(()=>handle(packet)).catch(error=>console.error(MODULE_ID,error));}
function request(action,data={},participantId=null){if(action!=="sync"&&pending)return;if(action!=="sync")pending=true;const packet={type:"ext-request",action,data,participantId,senderId:game.user.id,tableId:publicState?.id??null,revision:publicState?.revision??0};if(isHost())enqueue(packet);else if(activeHost())game.socket.emit(SOCKET,packet);else{pending=false;ui.notifications.warn("Нет активного мастера.");}}
function onSocket(packet){if(packet?.type==="ext-request"&&isHost())return enqueue(packet);if(packet?.targetUserId&&packet.targetUserId!==game.user.id)return;if(packet?.type==="ext-state")accept(packet.state);else if(packet?.type==="ext-private")acceptPrivate(packet.state);else if(packet?.type==="ext-error"){pending=false;ui.notifications.warn(packet.message);}}

const {ApplicationV2,HandlebarsApplicationMixin}=foundry.applications.api;
export class ExtendedGamesApp extends HandlebarsApplicationMixin(ApplicationV2){
 static instance=null; selectedGameId="crown-anchor"; npcActors=[];
 static DEFAULT_OPTIONS={id:"seven-dice-extended-game",classes:["seven-dice-extended-game"],tag:"section",window:{frame:true,icon:"fa-solid fa-dice",title:"Игры Seven Dice",resizable:true},position:{width:900,height:720},actions:{create:ExtendedGamesApp.onCreate,reset:ExtendedGamesApp.onReset,replay:()=>request("replay"),crownBet:ExtendedGamesApp.onCrownBet,crownRoll:()=>request("crownRoll"),deadlyRoll:(e,t)=>request("deadlyRoll",{},t.dataset.participantId),deadlyReroll:ExtendedGamesApp.onDeadlyReroll,deadlyStand:(e,t)=>request("deadlyStand",{},t.dataset.participantId),helpRoll:(e,t)=>request("helpRoll",{},t.dataset.participantId),madnessRoll:(e,t)=>request("madnessRoll",{},t.dataset.participantId),madnessRemove:(e,t)=>request("madnessRemove",{},t.dataset.participantId),madnessReroll:(e,t)=>request("madnessReroll",{},t.dataset.participantId),hammerRoll:(e,t)=>request("hammerRoll",{},t.dataset.participantId)}};
 static PARTS={main:{template:`${MODULE_PATH}/templates/extended-game.hbs`,scrollable:[".sde-game",".sde-setup",".sde-rules-menu>div"]}};
 static open(gameId){this.instance??=new this();this.instance.selectedGameId=gameId;this.instance.npcActors=[];this.instance.render({force:true,position:{width:Math.min(900,window.innerWidth-32),height:Math.min(720,window.innerHeight-48),top:24}});request("sync");}
 _onRender(context,options){super._onRender(context,options);bindNpcDrop(this);const unlock=()=>{try{if(game.settings.get(MODULE_ID,"quietEffects"))return;const Context=globalThis.AudioContext??globalThis.webkitAudioContext;if(Context)(playHammerSound.context??=new Context()).resume().catch(()=>{});}catch{}}; const shell=this.element.querySelector(".sde-shell");shell?.addEventListener("pointerdown",unlock,{once:true});shell?.addEventListener("keydown",unlock,{once:true});const state=context.state, previous=this.lastPresentedState;
 this.lastPresentedState=state;
 const transitioned=state&&previous?.id===state.id&&previous.phase!=="finished"&&state.finished;
 const hit=state?.hammerEvent;
 if(hit?.id&&previous?.id===state.id&&previous.hammerEvent?.id!==hit.id){
   const scene=this.element.querySelector(".sde-forge");
   scene?.classList.add("sde-fresh-hit");
   const tray=[...this.element.querySelectorAll(".sde-hammer-roster article")].find(node=>node.dataset.seat===hit.participantId);
   if(tray){tray.classList.add("sde-hit-seat");if(hit.delta<0){const pile=tray.querySelector(".sde-player-token-pile");for(let i=0;i<Math.abs(hit.delta);i++){const token=document.createElement("i");token.textContent="✦";token.className="sde-lost-token";pile?.append(token);}}else if(hit.delta>0)tray.classList.add("sde-gained-token");}
   playHammerSound();
   if(hit.delta)setTimeout(()=>playTableCue(hit.delta<0?"loss":"coin"),260);
 }
 if(transitioned){this.element.querySelector(".sde-result")?.classList.add("sde-fresh-result");if(context.isDeadly||context.isCrown)playTableCue(context.isDeadly?"shot":"coin");}
 for(const preset of this.element.querySelectorAll("[data-hammer-preset]"))preset.addEventListener("click",()=>{const input=this.element.querySelector('[name="hammerTarget"]');input.value=preset.dataset.hammerPreset;input.dispatchEvent(new Event("input"));});
 const targetInput=this.element.querySelector('[name="hammerTarget"]');
 const paintPresets=()=>{for(const preset of this.element.querySelectorAll("[data-hammer-preset]"))preset.setAttribute("aria-pressed",String(targetInput?.value===preset.dataset.hammerPreset));};
 targetInput?.addEventListener("input",paintPresets);paintPresets();
 if(this.crownDraftTable!==state?.id){this.crownDraftTable=state?.id;this.crownDrafts=new Map();}
 for(const card of this.element.querySelectorAll(".sde-crown-bet")){
   const submit=card.querySelector('[data-action="crownBet"]'),seat=submit.dataset.participantId;
   const picks=this.crownDrafts.get(seat)??{};
   this.crownDrafts.set(seat,picks);
   const tiles=[...card.querySelectorAll(".sde-crown-tile")],total=card.querySelector(".sde-selection-total");
   const paint=()=>{
     for(const tile of tiles){
       const coins=picks[tile.dataset.symbol]??0;
       tile.classList.toggle("is-staked",coins>0);
       tile.querySelector("output").textContent=coins;
       tile.querySelector('[data-coin-step="-1"]').disabled=coins===0;
       tile.querySelector('[data-coin-step="1"]').disabled=coins>=MAX_CROWN_COINS;
     }
     const entries=Object.values(picks).filter(n=>n>0);
     submit.disabled=!entries.length;
     total.textContent=`Выбрано: ${entries.length}/${CROWN_SYMBOLS.length} · К оплате: ${format(entries.reduce((sum,n)=>sum+n,0)*Math.round(state.stakeAmount*100)/100,state.currency)}`;
   };
   for(const button of card.querySelectorAll("[data-coin-step]"))button.addEventListener("click",()=>{
     const key=button.closest(".sde-crown-tile").dataset.symbol;
     picks[key]=Math.max(0,Math.min(MAX_CROWN_COINS,(picks[key]??0)+Number(button.dataset.coinStep)));
     paint();
   });
   paint();
 }
 }
 async _prepareContext(){const state=publicState?.gameId===this.selectedGameId?publicState:null,gameId=this.selectedGameId,active=state?.participants.find(p=>p.id===state.activeParticipantId),controls=active?.controllerUserId===game.user.id;const decorate=p=>({...p,netLabel:p.net===0?"В ноль":`${p.net>0?"+":""}${format(p.net,state.currency)}`,wagerLabel:format(p.wager??0,state.currency),payoutLabel:format(p.payout??0,state.currency),active:p.id===state?.activeParticipantId,winner:state?.winnerIds.includes(p.id),controlled:p.controllerUserId===game.user.id,crownSymbols:CROWN_SYMBOLS,portrait:portrait(p),initial:p.name.slice(0,1),betLabels:(p.bets?.length?normalizeCrownBets(p.bets):[]).map(({symbol,coins})=>`${CROWN_SYMBOLS[symbol-1].label}: ${format(coins*Math.round(state.stakeAmount*100)/100,state.currency)}`).join(" · "),diceFaces:(p.dice??[]).map((value,index)=>({value,index,face:dieFace(value)})),tokenPieces:Array.from({length:p.tokens??0},(_,index)=>({index,style:`--token-x:${((index*37)%9)-4}px;--token-r:${((index*23)%17)-8}deg;--token-z:${index}`})),netPositive:p.net>0,netZero:p.net===0});const mine=state?.participants.filter(p=>p.controllerUserId===game.user.id)??[];const hands=mine.map(p=>({participant:decorate(p),secret:privateState[p.id]})).filter(x=>x.secret).map(x=>({...x,dice:(x.secret.dice??[]).map((value,index)=>({value,index,face:dieFace(value)})),canRoll:!(x.secret.dice?.length),canChoose:Boolean(x.secret.dice?.length&&!x.secret.ready&&!x.secret.rerolled),canStand:Boolean(x.secret.dice?.length&&!x.secret.ready),ready:Boolean(x.secret.ready)}));return {hasTable:Boolean(state),isGM:game.user.isGM,title:TITLES[gameId],gameId,isCrown:gameId==="crown-anchor",isDeadly:gameId==="deadly-shot",isHelp:gameId==="help-neighbor",isMadness:gameId==="madness-mark",isHammer:gameId==="hammer-ring",activeUsers:game.users.filter(u=>u.active).map(u=>({id:u.id,name:u.name})),symbols:CROWN_SYMBOLS,deadlyRanks:[{name:"Смертельный выстрел",example:"⚄ ⚄ ⚄",rank:"I"},{name:"Верный глаз",example:"⚃ ⚃ ⚀",rank:"II"},{name:"Критический промах",example:"⚅ ⚂ ⚀",rank:"III"}],state:state?{...state,finished:state.phase==="finished",betting:state.phase==="betting",dealer:state.phase==="dealer",participants:state.participants.map(decorate),crownResults:CROWN_SYMBOLS.map(symbol=>({...symbol,matched:state.dice?.includes(symbol.value)})),crownDice:(state.dice??[]).map(value=>({...CROWN_SYMBOLS[value-1],face:dieFace(value)})),marks:state.marks?.slice(1).map((owner,index)=>{const p=state.participants.find(x=>x.id===owner);return {number:index+1,owned:Boolean(p),ownerName:p?.name??"",ownerInitial:p?.name?.slice(0,1)??""};})}:null,active:active?decorate(active):null,controls,leaderControls:state?.phase==="dealer"&&game.user.isGM,privateHands:hands,pendingDecision:state?.gameId==="madness-mark"&&state.pendingNumber&&controls};}
 static onCreate(){const userIds=[...this.element.querySelectorAll('input[name="player"]:checked')].map(i=>i.value),npcNames=this.element.querySelector('textarea[name="npcs"]')?.value.split(/\r?\n/)??[],stake=this.element.querySelector('input[name="stake"]')?.value??"1 зм",target=this.element.querySelector('input[name="target"]')?.value??"15",hammerTarget=this.element.querySelector('input[name="hammerTarget"]')?.value??"10",advanced=Boolean(this.element.querySelector('input[name="advanced"]')?.checked),protection=Boolean(this.element.querySelector('input[name="protection"]')?.checked);request("create",{gameId:this.selectedGameId,userIds,npcNames,npcActorUuids:(this.npcActors??[]).map(a=>a.actorUuid),stake,target,hammerTarget,advanced,protection});}
 static onCrownBet(event,target){
   const seat=target.dataset.participantId,picks=this.crownDrafts?.get(seat)??{};
   const bets=Object.entries(picks).filter(([,coins])=>coins>0).map(([symbol,coins])=>({symbol:Number(symbol),coins}));
   if(bets.length)request("crownBet",{bets},seat);
 }
 static onDeadlyReroll(event,target){const card=target.closest(".sde-action-card");const indexes=[...card.querySelectorAll('input[name="rerollDie"]:checked')].map(i=>Number(i.value));request("deadlyReroll",{indexes},target.dataset.participantId);}
 static async onReset(){const ok=await foundry.applications.api.DialogV2.confirm({window:{title:"Закрыть стол?"},content:"<p>Текущая партия будет завершена.</p>"});if(ok)request("reset");}
}
Hooks.once("ready",()=>{if(isHost()){hostState=loadRecovery("extended");if(hostState?.gameId==="hammer-ring"&&!hostState.targetTokens)hostState.targetTokens=10;}game.socket.on(SOCKET,onSocket);request("sync");});
Hooks.on("userConnected",()=>{if(isHost())broadcast();});
