import assert from "node:assert/strict";
import { findBaldurWinners, scoreGoblinDart } from "../scripts/quick-engine.mjs";

assert.deepEqual(scoreGoblinDart(20, 1), { multiplier: 1, points: 20, label: "Внешний круг" });
assert.deepEqual(scoreGoblinDart(20, 3), { multiplier: 2, points: 40, label: "Внутренний круг" });
assert.deepEqual(scoreGoblinDart(20, 5), { multiplier: 3, points: 60, label: "Тройное кольцо" });
assert.deepEqual(scoreGoblinDart(1, 6), { multiplier: 0, points: 50, label: "Яблочко" });
assert.throws(() => scoreGoblinDart(21, 1));

const players = [
  { id: "a", total: 19, bust: false },
  { id: "b", total: 21, bust: false },
  { id: "c", total: 22, bust: true },
  { id: "d", total: 21, bust: false }
];
assert.deepEqual(findBaldurWinners(players).map((player) => player.id), ["b", "d"]);
assert.deepEqual(findBaldurWinners([{ id: "x", total: 24, bust: true }]), []);
console.log("Seven Dice quick games engine: all tests passed.");
