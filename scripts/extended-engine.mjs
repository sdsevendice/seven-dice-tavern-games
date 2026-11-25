export const CROWN_SYMBOLS = Object.freeze([
  { value: 1, id: "crown", label: "Корона", icon: "♛" },
  { value: 2, id: "anchor", label: "Якорь", icon: "⚓" },
  { value: 3, id: "sword", label: "Меч", icon: "⚔" },
  { value: 4, id: "heart", label: "Сердце", icon: "♥" },
  { value: 5, id: "diamond", label: "Ромб", icon: "♦" },
  { value: 6, id: "club", label: "Клевер", icon: "♣" }
]);

export function crownMatches(dice, symbol) {
  if (!Array.isArray(dice) || dice.length !== 3) throw new TypeError("Нужны результаты 3d6.");
  return dice.filter(value => value === symbol).length;
}
export const MAX_CROWN_COINS = 999;

export function normalizeCrownBets(bets) {
  if (!Array.isArray(bets) || bets.length < 1 || bets.length > CROWN_SYMBOLS.length) throw new TypeError("Нужно выбрать от одного до шести символов.");
  const seen = new Set();
  return bets.map(bet => {
    const { symbol, coins } = typeof bet === "number" ? { symbol: bet, coins: 1 } : bet ?? {};
    if (!Number.isInteger(symbol) || symbol < 1 || symbol > CROWN_SYMBOLS.length || seen.has(symbol)) throw new TypeError("Некорректные символы ставки.");
    if (!Number.isInteger(coins) || coins < 1 || coins > MAX_CROWN_COINS) throw new TypeError(`На символ можно поставить от 1 до ${MAX_CROWN_COINS} монет.`);
    seen.add(symbol);
    return { symbol, coins };
  });
}

export function settleCrown(dice, bets, stake) {
  const entries = normalizeCrownBets(bets);
  if (!Number.isFinite(stake) || stake < 0) throw new TypeError("Ставка должна быть положительным числом.");
  const unit = Math.round(stake * 100);
  let wager = 0, payout = 0;
  const breakdown = entries.map(({ symbol, coins }) => {
    const matches = crownMatches(dice, symbol);
    const placed = unit * coins;
    const returned = placed * matches;
    wager += placed;
    payout += returned;
    return { symbol, coins, stake: placed / 100, matches, returned: returned / 100 };
  });
  return { wager: wager / 100, payout: payout / 100, net: (payout - wager) / 100, breakdown };
}

export function crownHouseNet(players) {
  return players.reduce((total, p) => total + Math.round(p.wager * 100) - Math.round(p.payout * 100), 0) / 100;
}

export function scoreDeadlyShot(dice) {
  if (!Array.isArray(dice) || dice.length !== 3) throw new TypeError("Нужны три d6.");
  const sorted = [...dice].sort((a,b)=>b-a);
  const counts = new Map(); for (const value of dice) counts.set(value,(counts.get(value)??0)+1);
  const groups=[...counts.entries()].sort((a,b)=>b[1]-a[1]||b[0]-a[0]);
  if(groups[0][1]===3) return {rank:3,name:"Смертельный выстрел",tiebreak:[groups[0][0]]};
  if(groups[0][1]===2) return {rank:2,name:"Верный глаз",tiebreak:[groups[0][0],groups[1][0]]};
  return {rank:1,name:"Критический промах",tiebreak:sorted};
}

export function compareDeadly(left,right){
  const a=left.rank?left:scoreDeadlyShot(left),b=right.rank?right:scoreDeadlyShot(right);
  if(a.rank!==b.rank)return Math.sign(a.rank-b.rank);
  for(let i=0;i<Math.max(a.tiebreak.length,b.tiebreak.length);i++){
    const delta=(a.tiebreak[i]??0)-(b.tiebreak[i]??0); if(delta)return Math.sign(delta);
  }
  return 0;
}

export function deadlyWinners(participants){
  const hits=participants.filter(p=>p.combo.rank>1);
  if(!hits.length)return [];
  let winners=[hits[0]];
  for(const p of hits.slice(1)){const result=compareDeadly(p.combo,winners[0].combo);if(result>0)winners=[p];else if(result===0)winners.push(p);}
  return winners;
}

export function longestSequence(marks,ownerId){
  let best=0,current=0;
  for(let number=1;number<=20;number++){if(marks[number]===ownerId){current+=1;best=Math.max(best,current);}else current=0;}
  return best;
}

export function hammerDelta(value,advanced=false){
  if(!Number.isInteger(value)||value<1||value>6)throw new TypeError("Нужен результат d6.");
  if(!advanced)return value<=3?1:-1;
  return [1,3,5].includes(value)?1:value===6?-2:-1;
}

export function highestWinners(participants,field){
  if(!participants.length)return [];
  const best=Math.max(...participants.map(p=>p[field]));return participants.filter(p=>p[field]===best);
}
