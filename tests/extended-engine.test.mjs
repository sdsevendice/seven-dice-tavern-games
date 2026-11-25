import test from "node:test";
import assert from "node:assert/strict";
import { crownMatches, settleCrown, crownHouseNet, scoreDeadlyShot, compareDeadly, deadlyWinners, longestSequence, hammerDelta, highestWinners } from "../scripts/extended-engine.mjs";

test("Критические промахи не дают победителя", () => {
  const shots = [[4, 2, 3], [1, 5, 3]].map(dice => ({ combo: scoreDeadlyShot(dice) }));
  assert.deepEqual(deadlyWinners(shots), []);
  const hit = { combo: scoreDeadlyShot([1, 1, 2]) };
  assert.deepEqual(deadlyWinners([...shots, hit]), [hit]);
});

test("Корона и Якорь считает совпадения", () => {
  assert.equal(crownMatches([1, 1, 6], 1), 2);
  assert.equal(crownMatches([1, 1, 6], 2), 0);
});

test("Корона и Якорь считает чистый итог и разрешает выбрать все шесть символов", () => {
  assert.deepEqual(settleCrown([1, 1, 6], [1, 2], 2), {
    wager: 4,
    payout: 4,
    net: 0,
    breakdown: [{ symbol: 1, coins: 1, stake: 2, matches: 2, returned: 4 }, { symbol: 2, coins: 1, stake: 2, matches: 0, returned: 0 }]
  });
  const all = [1, 2, 3, 4, 5, 6];
  const covered = settleCrown([1, 1, 6], all, 2);
  assert.deepEqual([covered.wager, covered.payout, covered.net], [12, 6, -6]);
  assert.throws(() => settleCrown([1, 2, 3], [...all, 7], 1), /шести/);
});

test("Корона и Якорь применяет разные ставки и считает итог заведения отдельно", () => {
  const win = settleCrown([1, 3, 3], [{symbol:1, coins:1}, {symbol:3, coins:2}], 1);
  assert.deepEqual([win.wager, win.payout, win.net], [3, 5, 2]);
  assert.equal(crownHouseNet([win, { wager: 6, payout: 0 }]), 4);
  const even = settleCrown([1, 4, 5], [{symbol:1, coins:2}], 1);
  assert.deepEqual([even.wager, even.payout, even.net], [2, 2, 0]);
  assert.equal(crownHouseNet([even]), 0);
  assert.equal(settleCrown([1, 1, 1], [1], 2).payout, 6);
  assert.equal(crownHouseNet([settleCrown([5, 4, 1], [1, 2, 3, 4, 5, 6], 1)]), 3);
  assert.throws(() => settleCrown([1, 2, 3], [{symbol:1, coins:1.5}], 1), /монет/);
});

test("Смертельный выстрел ранжирует комбинации", () => {
  assert.equal(scoreDeadlyShot([4, 4, 4]).rank, 3);
  assert.equal(scoreDeadlyShot([6, 6, 1]).rank, 2);
  assert.equal(scoreDeadlyShot([6, 4, 1]).rank, 1);
  assert.equal(compareDeadly([3, 3, 3], [6, 6, 1]), 1);
  const participants = [{ id: "a", combo: scoreDeadlyShot([5, 5, 2]) }, { id: "b", combo: scoreDeadlyShot([4, 4, 6]) }];
  assert.deepEqual(deadlyWinners(participants).map(p => p.id), ["a"]);
});

test("Метка безумия находит непрерывную цепочку", () => {
  const marks = Array(21).fill(null);
  marks[4] = marks[5] = marks[6] = marks[7] = "hero";
  marks[12] = "hero";
  assert.equal(longestSequence(marks, "hero"), 4);
});

test("Звон молота использует обычные и сложные грани", () => {
  assert.equal(hammerDelta(3), 1);
  assert.equal(hammerDelta(6), -1);
  assert.equal(hammerDelta(5, true), 1);
  assert.equal(hammerDelta(6, true), -2);
});

test("победители сохраняют ничью", () => {
  const participants = [{ id: "a", score: 7 }, { id: "b", score: 7 }, { id: "c", score: 4 }];
  assert.deepEqual(highestWinners(participants, "score").map(p => p.id), ["a", "b"]);
});
