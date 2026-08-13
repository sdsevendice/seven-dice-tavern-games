import assert from "node:assert/strict";
import { analyzeHand, compareHands, determineWinners } from "../scripts/engine.mjs";

const cases = [
  [[6, 6, 6, 6, 6], "fiveKind"],
  [[4, 4, 4, 4, 1], "fourKind"],
  [[3, 3, 3, 2, 2], "fullHouse"],
  [[1, 2, 3, 4, 5], "straight"],
  [[2, 3, 4, 5, 6], "straight"],
  [[5, 5, 5, 2, 1], "threeKind"],
  [[6, 6, 3, 3, 2], "twoPair"],
  [[4, 4, 6, 2, 1], "pair"],
  [[6, 5, 3, 2, 1], "highCard"]
];

for (const [dice, expected] of cases) assert.equal(analyzeHand(dice).id, expected, dice.join(","));
assert.equal(compareHands([4, 4, 4, 6, 1], [3, 3, 3, 6, 5]), 1);
assert.equal(compareHands([5, 5, 5, 3, 2], [5, 5, 5, 6, 4]), -1);
assert.equal(compareHands([6, 6, 3, 3, 2], [5, 5, 4, 4, 6]), 1);
assert.equal(compareHands([5, 5, 3, 3, 1], [6, 6, 4, 2, 1]), 1, "Две пары обязаны побеждать одну пару");
assert.equal(compareHands([1, 2, 3, 4, 5], [2, 3, 4, 5, 6]), -1);
assert.equal(compareHands([2, 2, 6, 5, 4], [2, 2, 6, 5, 4]), 0);

const winners = determineWinners([
  { id: "a", hand: analyzeHand([2, 2, 2, 6, 1]) },
  { id: "b", hand: analyzeHand([3, 3, 3, 2, 1]) },
  { id: "c", hand: analyzeHand([3, 3, 3, 2, 1]) }
]);
assert.deepEqual(winners.map((entry) => entry.id), ["b", "c"]);
assert.throws(() => analyzeHand([1, 2, 3]));

const distribution = {};
for (let a = 1; a <= 6; a += 1) for (let b = 1; b <= 6; b += 1) for (let c = 1; c <= 6; c += 1) {
  for (let d = 1; d <= 6; d += 1) for (let e = 1; e <= 6; e += 1) {
    const id = analyzeHand([a, b, c, d, e]).id;
    distribution[id] = (distribution[id] ?? 0) + 1;
  }
}
assert.deepEqual(distribution, {
  fiveKind: 6,
  fourKind: 150,
  fullHouse: 300,
  threeKind: 1200,
  twoPair: 1800,
  pair: 3600,
  straight: 240,
  highCard: 480
});
console.log("Dice Parlor engine: all tests passed.");
