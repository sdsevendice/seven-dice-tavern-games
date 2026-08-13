export const HAND_NAMES = Object.freeze({
  fiveKind: "Пять одинаковых",
  fourKind: "Каре",
  fullHouse: "Фулл-хаус",
  straight: "Стрит",
  threeKind: "Тройка",
  twoPair: "Две пары",
  pair: "Пара",
  highCard: "Старшая кость"
});

export function analyzeHand(dice) {
  if (!Array.isArray(dice) || dice.length !== 5 || dice.some((value) => !Number.isInteger(value) || value < 1 || value > 6)) {
    throw new TypeError("Для анализа нужны ровно пять значений d6.");
  }

  const counts = new Map();
  for (const value of dice) counts.set(value, (counts.get(value) ?? 0) + 1);
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const descending = [...dice].sort((a, b) => b - a);
  const unique = [...counts.keys()].sort((a, b) => a - b);
  const isStraight = unique.length === 5 && (
    unique.every((value, index) => value === index + 1) ||
    unique.every((value, index) => value === index + 2)
  );

  let id;
  let rank;
  let tiebreak;

  if (groups[0][1] === 5) {
    id = "fiveKind"; rank = 8; tiebreak = [groups[0][0]];
  }
  else if (groups[0][1] === 4) {
    id = "fourKind"; rank = 7; tiebreak = [groups[0][0], groups[1][0]];
  }
  else if (groups[0][1] === 3 && groups[1][1] === 2) {
    id = "fullHouse"; rank = 6; tiebreak = [groups[0][0], groups[1][0]];
  }
  else if (isStraight) {
    id = "straight"; rank = 5; tiebreak = [Math.max(...unique)];
  }
  else if (groups[0][1] === 3) {
    id = "threeKind"; rank = 4;
    tiebreak = [groups[0][0], ...groups.filter((group) => group[1] === 1).map((group) => group[0]).sort((a, b) => b - a)];
  }
  else if (groups[0][1] === 2 && groups[1][1] === 2) {
    id = "twoPair"; rank = 3;
    const pairs = groups.filter((group) => group[1] === 2).map((group) => group[0]).sort((a, b) => b - a);
    const kicker = groups.find((group) => group[1] === 1)[0];
    tiebreak = [...pairs, kicker];
  }
  else if (groups[0][1] === 2) {
    id = "pair"; rank = 2;
    tiebreak = [groups[0][0], ...groups.filter((group) => group[1] === 1).map((group) => group[0]).sort((a, b) => b - a)];
  }
  else {
    id = "highCard"; rank = 1; tiebreak = descending;
  }

  return { id, name: HAND_NAMES[id], rank, tiebreak };
}

export function compareHands(left, right) {
  const a = left.rank === undefined ? analyzeHand(left) : left;
  const b = right.rank === undefined ? analyzeHand(right) : right;
  if (a.rank !== b.rank) return Math.sign(a.rank - b.rank);
  const length = Math.max(a.tiebreak.length, b.tiebreak.length);
  for (let index = 0; index < length; index += 1) {
    const delta = (a.tiebreak[index] ?? 0) - (b.tiebreak[index] ?? 0);
    if (delta !== 0) return Math.sign(delta);
  }
  return 0;
}

export function determineWinners(entries) {
  if (!entries.length) return [];
  let winners = [entries[0]];
  for (const entry of entries.slice(1)) {
    const comparison = compareHands(entry.hand, winners[0].hand);
    if (comparison > 0) winners = [entry];
    else if (comparison === 0) winners.push(entry);
  }
  return winners;
}
