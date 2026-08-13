export function scoreGoblinDart(sector, hit) {
  if (!Number.isInteger(sector) || sector < 1 || sector > 20) throw new TypeError("Сектор должен быть от 1 до 20.");
  if (!Number.isInteger(hit) || hit < 1 || hit > 6) throw new TypeError("Результат d6 должен быть от 1 до 6.");
  if (hit === 6) return { multiplier: 0, points: 50, label: "Яблочко" };
  const multiplier = hit <= 2 ? 1 : hit <= 4 ? 2 : 3;
  return { multiplier, points: sector * multiplier, label: multiplier === 1 ? "Внешний круг" : multiplier === 2 ? "Внутренний круг" : "Тройное кольцо" };
}

export function findBaldurWinners(participants) {
  const valid = participants.filter((participant) => !participant.bust && participant.total <= 21);
  if (!valid.length) return [];
  const best = Math.max(...valid.map((participant) => participant.total));
  return valid.filter((participant) => participant.total === best);
}
