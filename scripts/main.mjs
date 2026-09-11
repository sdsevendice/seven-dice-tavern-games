import { analyzeHand, determineWinners, HAND_NAMES } from "./engine.mjs";
import { TAVERN_GAMES } from "./catalog.mjs";
import { QuickGamesApp } from "./quick-games.mjs";
import { saveRecovery, loadRecovery } from "./recovery.mjs";
import { bindNpcDrop, resolveNpcActors } from "./npc-drop.mjs";

const MODULE_ID = "seven-dice-tavern-games";
const MODULE_PATH = `modules/${MODULE_ID}`;
const SOCKET = `module.${MODULE_ID}`;
const MAX_PLAYERS = 6;

let hostTable = null;
let publicTable = null;
let privateHands = {};
let hostQueue = Promise.resolve();
let requestPending = false;

function activeHost() {
  return game.users
    .filter((user) => user.active && user.isGM)
    .sort((a, b) => a.id.localeCompare(b.id))[0] ?? null;
}

function isHost() {
  return activeHost()?.id === game.user.id;
}

function makeId() {
  return foundry.utils.randomID(12);
}

function notifyError(message) {
  ui.notifications.warn(`Покер на костях: ${message}`);
}

function refreshApp() {
  if (DiceParlorApp.instance?.rendered) DiceParlorApp.instance.render({ force: true });
}

function publicSnapshot() {
  if (!hostTable) return null;
  const revealed = hostTable.phase === "finished" && hostTable.finishReason !== "fold";
  return {
    id: hostTable.id,
    revision: hostTable.revision ?? 0,
    simultaneous: Boolean(hostTable.simultaneous),
    finishReason: hostTable.finishReason,
    phase: hostTable.phase,
    bet: hostTable.bet,
    pool: hostTable.pool,
    round: hostTable.round,
    bettingAfterRound: hostTable.bettingAfterRound,
    bettingActiveParticipantId: hostTable.bettingActiveParticipantId,
    targetStake: hostTable.targetStake,
    currency: hostTable.currency,
    bettingResponses: hostTable.bettingResponses,
    activeParticipantId: hostTable.activeParticipantId,
    winnerIds: hostTable.winnerIds,
    resultText: hostTable.resultText,
    history: hostTable.history ?? [],
    participants: hostTable.participants.map((participant) => ({
      id: participant.id,
      name: participant.name,
      kind: participant.kind,
      controllerUserId: participant.controllerUserId,
      portrait: participant.portrait,
      actorUuid: participant.actorUuid,
      rollCount: participant.rollCount,
      awaitingChoice: participant.awaitingChoice,
      actionRevision: participant.actionRevision ?? 0,
      readyRound: participant.readyRound ?? 0,
      heldCount: participant.held.filter(Boolean).length,
      completed: participant.completed,
      folded: participant.folded,
      orderRoll: participant.orderRoll,
      foldLoss: participant.foldLoss,
      committed: participant.committed,
      dice: revealed && !participant.folded ? participant.dice : null,
      hand: revealed && !participant.folded ? participant.hand : null
    }))
  };
}

function privateSnapshotFor(userId) {
  if (!hostTable) return {};
  return Object.fromEntries(hostTable.participants
    .filter((participant) => participant.controllerUserId === userId && !participant.folded)
    .map((participant) => [participant.id, {
      dice: participant.dice,
      held: participant.held,
      awaitingChoice: participant.awaitingChoice,
      hand: participant.hand
    }]));
}

function acceptState(state) {
  requestPending = false;
  publicTable = state;
  if (!state) privateHands = {};
  refreshApp();
}

function acceptPrivate(state) {
  privateHands = state ?? {};
  refreshApp();
}

function sendPacket(packet) {
  game.socket.emit(SOCKET, packet);
}

function sendStateTo(userId) {
  const publicPacket = { type: "state", targetUserId: userId, state: publicSnapshot() };
  const privatePacket = { type: "private", targetUserId: userId, state: privateSnapshotFor(userId) };
  if (userId === game.user.id) {
    acceptState(publicPacket.state);
    acceptPrivate(privatePacket.state);
  }
  else {
    sendPacket(publicPacket);
    sendPacket(privatePacket);
  }
}

function broadcastState() {
  if (!isHost()) return;
  if (hostTable) hostTable.revision = (hostTable.revision ?? 0) + 1;
  saveRecovery("poker", hostTable);
  for (const user of game.users.filter((entry) => entry.active)) sendStateTo(user.id);
}

function participantForAction(senderId, participantId) {
  const participant = hostTable?.participants.find((entry) => entry.id === participantId);
  if (!participant) throw new Error("Участник не найден.");
  if (hostTable.phase !== "playing") throw new Error(hostTable.phase === "betting" ? "Сначала завершите торговлю — бросок пока недоступен." : "Партия уже завершена.");
  if (hostTable.simultaneous) {
    if (participant.folded || (participant.readyRound ?? 0) >= hostTable.round) throw new Error("Вы уже готовы. Дождитесь остальных участников.");
  } else if (hostTable.activeParticipantId !== participant.id) throw new Error("Сейчас ход другого участника.");
  if (participant.controllerUserId !== senderId) throw new Error("Этим участником управляет другой пользователь.");
  return participant;
}

function participantForBetAction(senderId, participantId) {
  const participant = hostTable?.participants.find((entry) => entry.id === participantId);
  if (!participant) throw new Error("Участник не найден.");
  if (hostTable.phase !== "betting") throw new Error("Сейчас нет круга торговли.");
  if (hostTable.bettingActiveParticipantId !== participant.id) throw new Error("Сейчас решение принимает другой участник.");
  if (participant.controllerUserId !== senderId) throw new Error("Этим участником управляет другой пользователь.");
  if (participant.folded) throw new Error("Участник уже спасовал.");
  return participant;
}

async function rollD6(count) {
  if (count <= 0) return [];
  const roll = await new Roll(`${count}d6`).evaluate();
  const die = roll.dice[0];
  return die.results.map((result) => result.result);
}

async function determineTurnOrder(participants) {
  for (const participant of participants) participant.orderRolls = [];
  let unresolved = [...participants];
  while (unresolved.length) {
    for (const participant of unresolved) {
      const roll = await new Roll("1d20").evaluate();
      participant.orderRolls.push(roll.total);
    }
    const byResult = new Map();
    for (const participant of participants) {
      const key = participant.orderRolls.join("-");
      const tied = byResult.get(key) ?? [];
      tied.push(participant);
      byResult.set(key, tied);
    }
    unresolved = [];
    for (const tied of byResult.values()) {
      if (tied.length > 1) unresolved.push(...tied);
    }
  }
  participants.sort((a, b) => {
    const length = Math.max(a.orderRolls.length, b.orderRolls.length);
    for (let index = 0; index < length; index += 1) {
      const delta = (b.orderRolls[index] ?? 0) - (a.orderRolls[index] ?? 0);
      if (delta) return delta;
    }
    return 0;
  });
  for (const participant of participants) participant.orderRoll = participant.orderRolls.join(" → ");
}

function parseMoney(value) {
  const match = String(value ?? "").trim().match(/^(\d+(?:[.,]\d+)?)\s*(.*)$/);
  if (!match) return null;
  const amount = Number(match[1].replace(",", "."));
  if (!Number.isFinite(amount)) return null;
  return { amount, currency: match[2].trim() };
}

function formatMoney(amount, currency = "") {
  const formatted = Number.isInteger(amount) ? String(amount) : String(Math.round(amount * 100) / 100).replace(".", ",");
  return `${formatted}${currency ? ` ${currency}` : ""}`;
}

function updateMoneyLabels() {
  hostTable.bet = formatMoney(hostTable.stakeAmount, hostTable.currency);
  hostTable.pool = formatMoney(hostTable.poolAmount, hostTable.currency);
}

function recordAction(text) {
  if (hostTable) hostTable.history = [...(hostTable.history ?? []), text].slice(-12);
}

function keptCombination(dice) {
  if (!dice.length) return "";
  if (dice.length === 5) return analyzeHand(dice).name;
  const counts = [...new Set(dice)].map(value => dice.filter(die => die === value).length);
  if (counts.includes(4)) return "Каре";
  if (counts.includes(3)) return "Тройка";
  if (counts.filter(count => count === 2).length === 2) return "Две пары";
  if (counts.includes(2)) return "Пара";
  return "Пока без комбинации";
}

function diePips(value) {
  const positions = {1:[5],2:[1,9],3:[1,5,9],4:[1,3,7,9],5:[1,3,5,7,9],6:[1,3,4,6,7,9]};
  return (positions[value] ?? []).map(position => ({row:Math.ceil(position / 3),column:(position - 1) % 3 + 1}));
}

function finishTable(reason = "showdown") {
  hostTable.finishReason = reason;
  hostTable.phase = "finished";
  hostTable.activeParticipantId = null;
  const survivors = hostTable.participants.filter((participant) => !participant.folded);
  const contenders = reason === "fold" ? survivors.map((participant) => ({ id: participant.id, hand: null })) : survivors.map((participant) => ({
    id: participant.id,
    hand: participant.hand ?? analyzeHand(participant.dice)
  }));
  const winners = reason === "fold" ? contenders : determineWinners(contenders);
  hostTable.winnerIds = winners.map((winner) => winner.id);
  const winnerNames = hostTable.participants.filter((participant) => hostTable.winnerIds.includes(participant.id)).map((participant) => participant.name);
  hostTable.resultText = reason === "fold"
    ? `${winnerNames.join(", ")} побеждает: остальные участники спасовали.`
    : winners.length > 1
      ? `Ничья: ${winnerNames.join(", ")}.`
      : `Победитель: ${winnerNames[0]}.`;
  if (reason !== "fold" && winners.length === 1) {
    const best = winners[0].hand;
    const runner = determineWinners(contenders.filter(p => p.id !== winners[0].id))[0]?.hand;
    if (runner) {
      if (best.rank !== runner.rank) hostTable.resultText += ` ${best.name} сильнее комбинации «${runner.name}».`;
      else {
        const index = best.tiebreak.findIndex((value, i) => value !== runner.tiebreak[i]);
        if (index >= 0) hostTable.resultText += ` При одинаковой комбинации «${best.name}» решает номинал ${best.tiebreak[index]} против ${runner.tiebreak[index]}.`;
      }
    }
  }
  postResultToChat().catch(error => { console.error(`${MODULE_ID} | Итог сохранён, чат недоступен`, error); notifyError("Партия завершена, но итог не удалось опубликовать в чат."); });
}

async function postResultToChat() {
  const rows = hostTable.participants.map((participant) => {
    if (participant.folded) return `<li><strong>${foundry.utils.escapeHTML(participant.name)}</strong> — пас; внесённые ${foundry.utils.escapeHTML(participant.foldLoss)} остаются в банке</li>`;
    if (hostTable.finishReason === "fold" || !participant.hand) return `<li><strong>${foundry.utils.escapeHTML(participant.name)}</strong> — победа без раскрытия руки</li>`;
    return `<li><strong>${foundry.utils.escapeHTML(participant.name)}</strong>: ${participant.dice.join(" · ")} — ${participant.hand.name}</li>`;
  }).join("");
  await ChatMessage.create({
    speaker: { alias: "Игорный дом" },
    content: `<section class="dice-parlor-chat"><h3>Покер на костях</h3><p>Финальный банк: <strong>${foundry.utils.escapeHTML(hostTable.pool)}</strong></p><ul>${rows}</ul><p><strong>${foundry.utils.escapeHTML(hostTable.resultText)}</strong></p></section>`
  });
}

function enterBetting(round, starterId = null, resumeId = null) {
  const live = hostTable.participants.filter((participant) => !participant.folded);
  if (live.length <= 1) {
    if (live.length === 1 && hostTable.participants.filter((participant) => !participant.folded).length === 1) finishTable("fold");
    return false;
  }
  hostTable.phase = "betting";
  hostTable.activeParticipantId = null;
  hostTable.bettingAfterRound = round;
  hostTable.bettingResumeId = resumeId;
  hostTable.bettingResponses = [];
  hostTable.bettingRaised = false;
  hostTable.targetStake = hostTable.stakeAmount;
  hostTable.bettingActiveParticipantId = starterId ?? live[0].id;
  return true;
}

function startNextRound() {
  const live = hostTable.participants.filter((participant) => !participant.folded);
  if (live.length <= 1) {
    finishTable("fold");
    return;
  }
  const resumeId = hostTable.bettingResumeId;
  hostTable.phase = "playing";
  if (!resumeId) hostTable.round = hostTable.bettingAfterRound + 1;
  hostTable.bettingResumeId = null;
  hostTable.bettingAfterRound = null;
  hostTable.bettingActiveParticipantId = null;
  hostTable.bettingResponses = [];
  if (resumeId) {
    advanceTurn(resumeId, true);
    return;
  }
  if (hostTable.simultaneous) {
    if (hostTable.round > 3) { finishTable(); return; }
    hostTable.activeParticipantId = live[0]?.id ?? null;
    return;
  }
  hostTable.activeParticipantId = hostTable.participants.find((participant) => !participant.folded && !participant.completed)?.id ?? null;
  if (!hostTable.activeParticipantId) finishTable();
}

function advanceBetting(currentId) {
  const live = hostTable.participants.filter((participant) => !participant.folded);
  if (live.length <= 1) {
    finishTable("fold");
    return;
  }
  if (live.every((participant) => hostTable.bettingResponses.includes(participant.id))) {
    startNextRound();
    return;
  }
  const start = hostTable.participants.findIndex((participant) => participant.id === currentId);
  for (let offset = 1; offset <= hostTable.participants.length; offset += 1) {
    const candidate = hostTable.participants[(start + offset) % hostTable.participants.length];
    if (!candidate.folded && !hostTable.bettingResponses.includes(candidate.id)) {
      hostTable.bettingActiveParticipantId = candidate.id;
      return;
    }
  }
}

function advanceTurn(currentId, afterBetting = false) {
  const live = hostTable.participants.filter((participant) => !participant.folded);
  if (live.length <= 1) {
    const survivor = live[0];
    if (survivor && !survivor.hand && survivor.dice.every(Number.isInteger)) survivor.hand = analyzeHand(survivor.dice);
    finishTable("fold");
    return;
  }
  if (hostTable.simultaneous) {
    if (live.every(p => (p.readyRound ?? 0) >= hostTable.round)) enterBetting(hostTable.round);
    return;
  }
  // From the second round, settle bets after each hand, before the next roll.
  const current = hostTable.participants.find((participant) => participant.id === currentId);
  if (hostTable.round >= 2 && !afterBetting && !current.folded) {
    enterBetting(hostTable.round, currentId, currentId);
    return;
  }
  const completedRound = live.every((participant) => participant.completed || participant.rollCount >= hostTable.round);
  if (completedRound && hostTable.round === 1 && enterBetting(1)) return;
  if (live.every((participant) => participant.completed)) {
    finishTable();
    return;
  }

  if (completedRound) {
    hostTable.round += 1;
    hostTable.activeParticipantId = live.find((participant) => !participant.completed)?.id ?? null;
    return;
  }

  const start = hostTable.participants.findIndex((participant) => participant.id === currentId);
  for (let offset = 1; offset <= hostTable.participants.length; offset += 1) {
    const candidate = hostTable.participants[(start + offset) % hostTable.participants.length];
    if (!candidate.folded && !candidate.completed && candidate.rollCount < hostTable.round) {
      hostTable.activeParticipantId = candidate.id;
      return;
    }
  }
}

async function handleHostRequest(packet) {
  try {
    if (packet.action === "sync") {
      sendStateTo(packet.senderId);
      return;
    }
    const concurrent = hostTable?.simultaneous && hostTable.phase === "playing" && packet.phase === "playing" && packet.round === hostTable.round && ["roll", "toggle", "endTurn", "fold"].includes(packet.action);
    const actor = hostTable?.participants.find(p => p.id === packet.participantId);
    if (packet.revision !== undefined && (packet.tableId !== (hostTable?.id ?? null) || (concurrent ? packet.actionRevision !== (actor?.actionRevision ?? 0) : packet.revision !== (hostTable?.revision ?? 0)))) throw new Error("Стол уже изменился. Дождитесь обновления и повторите действие.");
    if (packet.action === "reclaim") {
      if (!game.users.get(packet.senderId)?.isGM) throw new Error("Управление может принять только мастер.");
      const absent = hostTable?.participants.find(p => p.id === packet.participantId);
      if (!absent || game.users.get(absent.controllerUserId)?.active) throw new Error("Участник ещё подключён.");
      absent.controllerUserId = packet.senderId;
      broadcastState();
      return;
    }
    if (packet.action === "replay") {
      if (hostTable?.phase !== "finished") throw new Error("Сначала завершите партию.");
      packet.data = hostTable.setup;
      packet.action = "create";
    }

    if (packet.action === "create") {
      if (!game.users.get(packet.senderId)?.isGM) throw new Error("Создать стол может только мастер.");
      if (hostTable && hostTable.phase !== "finished") throw new Error("Сначала завершите текущую партию.");
      const requestedUsers = [...new Set(packet.data.userIds ?? [])]
        .map((id) => game.users.get(id))
        .filter((user) => user?.active);
      const npcNames = (packet.data.npcNames ?? []).map((name) => String(name).trim()).filter(Boolean);
      const npcActors = await resolveNpcActors(packet.data.npcActorUuids ?? []);
      if (requestedUsers.length + npcNames.length + npcActors.length > MAX_PLAYERS) throw new Error("За столом может быть не больше 6 участников.");
      const participants = [
        ...requestedUsers.map((user) => ({ name: user.name, kind: "player", controllerUserId: user.id })),
        ...npcNames.map((name) => ({ name, kind: "npc", controllerUserId: packet.senderId })),
        ...npcActors.map(actor => ({...actor, kind: "npc", controllerUserId: packet.senderId}))
      ].slice(0, MAX_PLAYERS);
      if (participants.length < 2) throw new Error("Нужно выбрать минимум двух участников.");
      const betMoney = parseMoney(packet.data.bet || "0 зм");
      if (!betMoney) throw new Error("Укажите корректную ставку, например 1 зм.");
      const poolMoney = parseMoney(packet.data.pool);
      if (packet.data.pool?.trim() && !poolMoney) throw new Error("Укажите корректный банк или оставьте поле пустым.");
      if (poolMoney && poolMoney.amount < betMoney.amount * participants.length) throw new Error("Банк не может быть меньше взносов участников.");
      if (poolMoney?.currency && betMoney.currency && poolMoney.currency !== betMoney.currency) throw new Error("Ставка и банк должны быть в одной валюте.");
      const currency = betMoney.currency || poolMoney?.currency || "зм";
      hostTable = {
        id: makeId(),
        simultaneous: packet.data.simultaneous !== false,
        setup: JSON.parse(JSON.stringify(packet.data)),
        phase: "playing",
        bet: "",
        pool: "",
        stakeAmount: betMoney.amount,
        targetStake: betMoney.amount,
        poolAmount: poolMoney?.amount ?? betMoney.amount * participants.length,
        currency,
        round: 1,
        bettingAfterRound: null,
        bettingActiveParticipantId: null,
        bettingResponses: [],
        activeParticipantId: null,
        winnerIds: [],
        resultText: "",
        participants: participants.map((entry) => ({
          ...entry,
          id: makeId(),
          dice: [null, null, null, null, null],
          held: [false, false, false, false, false],
          rollCount: 0,
          readyRound: 0,
          awaitingChoice: false,
          completed: false,
          folded: false,
          committed: betMoney.amount,
          hand: null
        }))
      };
      updateMoneyLabels();
      await determineTurnOrder(hostTable.participants);
      hostTable.activeParticipantId = hostTable.participants[0].id;
      broadcastState();
      return;
    }

    if (packet.action === "reset") {
      if (!game.users.get(packet.senderId)?.isGM) throw new Error("Завершить стол может только мастер.");
      hostTable = null;
      broadcastState();
      return;
    }

    if (["callStake", "raiseStake", "betFold"].includes(packet.action)) {
      const participant = participantForBetAction(packet.senderId, packet.participantId);
      if (packet.action === "raiseStake") {
        const raise = parseMoney(packet.data.amount);
        if (!raise || raise.amount <= 0 || !Number.isFinite(hostTable.targetStake + raise.amount)) throw new Error("Укажите положительную конечную сумму повышения.");
        hostTable.targetStake += raise.amount;
        hostTable.bettingRaised = true;
        recordAction(`${participant.name} повышает на ${formatMoney(raise.amount, hostTable.currency)}`);
        hostTable.stakeAmount = hostTable.targetStake;
        const contribution = Math.max(0, hostTable.targetStake - participant.committed);
        participant.committed = hostTable.targetStake;
        hostTable.poolAmount += contribution;
        hostTable.bettingResponses = [participant.id];
        updateMoneyLabels();
      }
      else if (packet.action === "callStake") {
        const contribution = Math.max(0, hostTable.targetStake - participant.committed);
        recordAction(`${participant.name}: ${contribution > 0 ? `уравнивает +${formatMoney(contribution, hostTable.currency)}` : "чек"}`);
        participant.committed = hostTable.targetStake;
        hostTable.poolAmount += contribution;
        if (!hostTable.bettingResponses.includes(participant.id)) hostTable.bettingResponses.push(participant.id);
        updateMoneyLabels();
        // After an individual turn, a check needs no table-wide confirmation.
        // A raise still resets responses and every survivor must answer it.
        if (hostTable.bettingResumeId && hostTable.bettingResponses.length === 1 && contribution === 0 && !hostTable.bettingRaised) {
          startNextRound();
          broadcastState();
          return;
        }
      }
      else {
        participant.folded = true;
        recordAction(`${participant.name} пасует`);
        participant.foldLoss = formatMoney(participant.committed, hostTable.currency);
        participant.completed = true;
        participant.awaitingChoice = false;
        hostTable.bettingResponses = hostTable.bettingResponses.filter((id) => id !== participant.id);
      }
      advanceBetting(participant.id);
      broadcastState();
      return;
    }

    const participant = participantForAction(packet.senderId, packet.participantId);
    if (packet.action === "roll") {
      if (participant.awaitingChoice) throw new Error("Сначала завершите выбор костей.");
      const openIndexes = participant.held.map((held, index) => held ? null : index).filter((index) => index !== null);
      if (hostTable.simultaneous && !openIndexes.length) throw new Error("Все кости оставлены. Верните нужные на переброс или нажмите «Готов».");
      const values = await rollD6(openIndexes.length);
      openIndexes.forEach((index, valueIndex) => { participant.dice[index] = values[valueIndex]; });
      participant.rollCount = hostTable.simultaneous ? hostTable.round : participant.rollCount + 1;
      if (participant.rollCount >= 3 || participant.held.every(Boolean)) {
        participant.held.fill(true);
        participant.awaitingChoice = Boolean(hostTable.simultaneous);
        if (!hostTable.simultaneous) {
          participant.completed = true;
          participant.hand = analyzeHand(participant.dice);
          advanceTurn(participant.id);
        }
      }
      else {
        participant.awaitingChoice = true;
      }
    }
    else if (packet.action === "toggle") {
      const beforeRoll = hostTable.simultaneous && participant.rollCount < hostTable.round && participant.dice.every(Number.isInteger);
      if (!participant.awaitingChoice && !beforeRoll) throw new Error("Сначала бросьте кости.");
      if (participant.rollCount >= 3) throw new Error("Это финальный бросок. Нажмите «Готов».");
      const index = Number(packet.data.index);
      if (!Number.isInteger(index) || index < 0 || index > 4) throw new Error("Некорректная кость.");
      participant.held[index] = !participant.held[index];
      participant.completed = false;
      participant.hand = null;
    }
    else if (packet.action === "endTurn") {
      if (!participant.awaitingChoice && !(hostTable.simultaneous && participant.held.every(Boolean) && participant.dice.every(Number.isInteger))) throw new Error("Сначала бросьте кости.");
      if (hostTable.simultaneous) {
        participant.readyRound = hostTable.round;
        participant.rollCount = hostTable.round;
      }
      participant.awaitingChoice = false;
      if (participant.held.every(Boolean)) {
        participant.completed = true;
        participant.hand = analyzeHand(participant.dice);
      }
      advanceTurn(participant.id);
    }
    else if (packet.action === "fold") {
      if (participant.rollCount >= 3) throw new Error("После финального броска пасовать поздно.");
      participant.folded = true;
      participant.foldLoss = formatMoney(participant.committed, hostTable.currency);
      participant.completed = true;
      participant.awaitingChoice = false;
      advanceTurn(participant.id);
    }
    else {
      throw new Error("Неизвестное действие.");
    }
    const labels = {roll: "бросает кости", endTurn: "завершает выбор костей", fold: "пасует"};
    participant.actionRevision = (participant.actionRevision ?? 0) + 1;
    if (labels[packet.action]) recordAction(`${participant.name} — ${labels[packet.action]}`);
    broadcastState();
  }
  catch (error) {
    requestPending = false;
    console.warn(`${MODULE_ID} | Запрос отклонён`, error);
    const targetUserId = packet.senderId;
    if (targetUserId === game.user.id) notifyError(error.message);
    else sendPacket({ type: "error", targetUserId, message: error.message });
  }
}

function enqueueHostRequest(packet) {
  hostQueue = hostQueue.then(() => handleHostRequest(packet)).catch((error) => {
    console.error(`${MODULE_ID} | Ошибка очереди запросов`, error);
  });
  return hostQueue;
}

function request(action, data = {}, participantId = null) {
  if (action !== "sync" && requestPending) return;
  if (action !== "sync") requestPending = true;
  const packet = { type: "request", action, data, participantId, senderId: game.user.id, tableId: publicTable?.id ?? null, revision: publicTable?.revision ?? 0, phase: publicTable?.phase, round: publicTable?.round, actionRevision: publicTable?.participants.find(p => p.id === participantId)?.actionRevision ?? 0 };
  if (isHost()) enqueueHostRequest(packet);
  else if (activeHost()) sendPacket(packet);
  else { requestPending = false; notifyError("Нет активного мастера, который может вести стол."); }
}

function onSocket(packet) {
  if (!packet || typeof packet !== "object") return;
  if (packet.type === "request" && isHost()) {
    enqueueHostRequest(packet);
    return;
  }
  if (packet.targetUserId && packet.targetUserId !== game.user.id) return;
  if (packet.type === "state") acceptState(packet.state);
  else if (packet.type === "private") acceptPrivate(packet.state);
  else if (packet.type === "error") { requestPending = false; notifyError(packet.message); }
}

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

class DiceParlorApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static instance = null;

  static DEFAULT_OPTIONS = {
    id: "seven-dice-poker",
    classes: ["seven-dice-poker"],
    tag: "section",
    window: {
      frame: true,
      icon: "fa-solid fa-dice",
      title: "Игорный дом — Покер на костях",
      resizable: true
    },
    position: { width: 920, height: 700 },
    actions: {
      create: DiceParlorApp.onCreate,
      roll: DiceParlorApp.onRoll,
      toggleDie: DiceParlorApp.onToggleDie,
      endTurn: DiceParlorApp.onEndTurn,
      fold: DiceParlorApp.onFold,
      callStake: DiceParlorApp.onCallStake,
      raiseStake: DiceParlorApp.onRaiseStake,
      betFold: DiceParlorApp.onBetFold,
      reset: DiceParlorApp.onReset,
      replay: () => request("replay"),
      sync: () => request("sync"),
      reclaim: (event, target) => request("reclaim", {}, target.dataset.participantId),
      rules: DiceParlorApp.onRules
    }
  };

  static PARTS = {
    main: { template: `${MODULE_PATH}/templates/dice-parlor.hbs` }
  };

  rulesOpen = false;
  movedDie = null;

  _onRender(context, options) {
    super._onRender(context, options);
    bindNpcDrop(this);
    if (this.movedDie !== null) {
      this.element.querySelector(`.dp-dice-zone .dp-die[data-index="${this.movedDie}"]`)?.classList.add("dp-moved");
      this.movedDie = null;
    }
  }

  static open() {
    this.instance ??= new this();
    const width = Math.min(920, window.innerWidth - 32);
    const height = Math.min(700, window.innerHeight - 48);
    this.instance.render({
      force: true,
      position: {
        width,
        height,
        left: Math.max(16, Math.round((window.innerWidth - width) / 2)),
        top: 24
      }
    });
    request("sync");
  }

  async _prepareContext() {
    const table = publicTable;
    const pending = table?.participants.filter(p => !p.folded && (table.simultaneous ? (p.readyRound ?? 0) < table.round : !p.completed && (p.rollCount < table.round || p.awaitingChoice))) ?? [];
    const active = table?.simultaneous ? (table.phase === "playing" ? pending.find(p => p.controllerUserId === game.user.id) : null) : table?.participants.find((participant) => participant.id === table.activeParticipantId) ?? null;
    const myPrivate = active ? privateHands[active.id] : null;
    const controlsActive = Boolean(active && active.controllerUserId === game.user.id);
    const bettingActive = table?.participants.find((participant) => participant.id === table.bettingActiveParticipantId) ?? null;
    const controlsBetting = Boolean(bettingActive && bettingActive.controllerUserId === game.user.id);
    const amountToCall = bettingActive ? Math.max(0, table.targetStake - bettingActive.committed) : 0;
    const dice = (myPrivate?.dice ?? active?.dice ?? [null, null, null, null, null]).map((value, index) => ({
      index,
      value: value ?? "?",
      held: Boolean(myPrivate?.held?.[index]),
      selectable: Boolean(controlsActive && active.rollCount < 3 && (myPrivate?.awaitingChoice || (table.simultaneous && active.rollCount < table.round && myPrivate?.dice?.every(Number.isInteger))))
    }));
    const heldDice = dice.filter((die) => die.held);
    const freeDice = dice.filter((die) => !die.held);
    return {
      hasTable: Boolean(table),
      stageSteps: ["Бросок", "Выбор костей", "Ставки", "Победитель"].map((label,index)=>({label,number:index+1,current:index === (table?.phase === "finished" ? 3 : table?.phase === "betting" ? 2 : (myPrivate?.awaitingChoice || (active?.heldCount === 5)) ? 1 : 0)})),
      resultWinners: table?.phase === "finished" ? table.participants.filter(p=>table.winnerIds.includes(p.id)).map(p=>({name:p.name,portrait:p.kind !== "npc" ? (game.users.get(p.controllerUserId)?.character?.img || game.users.get(p.controllerUserId)?.avatar) : p.portrait,initial:p.name.slice(0,1),combination:p.hand?.name,dice:p.dice?.map(value=>({value,pips:diePips(value)}))??[]})) : [],
      readiness: table?.simultaneous && table.phase === "playing" ? `Готовы ${table.participants.filter(p => !p.folded).length - pending.length} из ${table.participants.filter(p => !p.folded).length}. Ждём: ${pending.map(p => p.name).join(", ")}` : "",
      readyLabel: table?.simultaneous ? "Готов" : "Завершить ход",
      waitingForGm: !table && !game.user.isGM,
      isGM: game.user.isGM,
      isHost: isHost(),
      rulesOpen: this.rulesOpen,
      bettingHands: table && table.phase !== "finished" ? table.participants.filter(p => !(controlsActive && p.id === active.id) && privateHands[p.id]?.dice?.every(Number.isInteger)).map(p => {
        const kept = privateHands[p.id].dice.filter((value, index) => privateHands[p.id].held?.[index]);
        return { name: p.name, count: kept.length, combination: keptCombination(kept), dice: kept.map(value => ({ value, pips: diePips(value) })), emptySlots: Array.from({length:5-kept.length},()=>({})) };
      }) : [],
      handReference: [
        ["Пять одинаковых",[5,5,5,5,5]], ["Каре",[4,4,4,4,1]],
        ["Фулл-хаус",[6,6,6,3,3]], ["Стрит",[1,2,3,4,5]],
        ["Тройка",[2,2,2,5,6]], ["Две пары",[5,5,3,3,1]],
        ["Пара",[6,6,4,2,1]], ["Старшая кость",[6,5,3,2,1]]
      ].map(([name, values], index) => ({name, order:index+1, example:values.map(value=>String.fromCodePoint(0x267f+value)).join(" "), numbers:values.join(", "), current: Object.values(privateHands).some(hand=>keptCombination(hand.dice.filter((value,i)=>hand.held?.[i]))===name)})),
      stepHint: table?.phase === "finished" ? "Партия завершена" : controlsBetting ? (amountToCall > 0 ? `Доплатите ${formatMoney(amountToCall, table.currency)}, повысьте ставку или спасуйте.` : "Нажмите «Чек», чтобы не повышать ставку. Либо повысьте её.") : controlsActive ? (myPrivate?.awaitingChoice ? (active.rollCount >= 3 ? "Финальная рука собрана. Нажмите «Готов»." : "Выберите оставляемые кости и подтвердите готовность.") : (freeDice.length ? `Можно вернуть оставленные кости на переброс. Сейчас будут брошены: ${freeDice.length}.` : "Можно вернуть любые кости на переброс или сохранить все пять: нажмите «Готов».")) : "Ожидаем остальных участников. Оставленные кости — перед вами.",
      contributionText: bettingActive ? `Уже внесено: ${formatMoney(bettingActive.committed, table.currency)} · Доплатить: ${formatMoney(amountToCall, table.currency)} · Итого: ${formatMoney(table.targetStake, table.currency)}` : "",
      resultCaption: table?.finishReason === "fold" ? "Остальные спасовали — рука победителя не раскрывается." : "",
      activeUsers: game.users.filter((user) => user.active).map((user) => ({ id: user.id, name: user.name, checked: true })),
      table: table ? {
        ...table,
        isFinished: table.phase === "finished",
        isBetting: table.phase === "betting",
        bettingRoundLabel: `после ${table.bettingAfterRound}-го круга`,
        roundLabel: table.round === 1 ? "Первый бросок" : table.round === 2 ? "Второй бросок" : "Финальный бросок",
        participants: table.participants.map((participant) => ({
          ...participant,
          isActive: table.simultaneous && table.phase === "playing" ? pending.some(p => p.id === participant.id) : participant.id === (table.phase === "betting" ? table.bettingActiveParticipantId : table.activeParticipantId),
          isWinner: table.winnerIds.includes(participant.id),
          portrait: participant.kind !== "npc" ? (game.users.get(participant.controllerUserId)?.character?.img || game.users.get(participant.controllerUserId)?.avatar) : participant.portrait,
          initial: participant.name.slice(0,1),
          offline: !game.users.get(participant.controllerUserId)?.active,
          status: participant.folded
            ? `Пас · в банке: ${participant.foldLoss}`
            : table.phase === "betting"
              ? participant.id === table.bettingActiveParticipantId
                ? "Принимает решение"
                : table.bettingResponses.includes(participant.id) ? "Ставка принята" : "Ожидает ответа"
              : table.simultaneous ? (pending.some(p => p.id === participant.id) ? "Бросает / выбирает" : "Готов") : participant.completed ? "Готов" : participant.id === table.activeParticipantId ? "Ходит" : "Ожидает",
          diceText: participant.dice?.join(" · ") ?? "",
          revealedDice: participant.dice?.map(value => ({ value, face: String.fromCodePoint(0x267f + value), emphasized: table.winnerIds.includes(participant.id) && (['straight','fullHouse','fiveKind'].includes(participant.hand?.id) || (participant.hand?.id === 'highCard' ? value === participant.hand.tiebreak[0] : participant.dice.filter(d => d === value).length > 1)) })) ?? [],
          handName: participant.hand?.name ?? "",
          privateDiceText: privateHands[participant.id]?.dice?.every(Number.isInteger) ? privateHands[participant.id].dice.join(" · ") : "",
          privateHandName: privateHands[participant.id]?.dice?.every(Number.isInteger) ? analyzeHand(privateHands[participant.id].dice).name : "",
          icon: participant.kind === "npc" ? "fa-user-secret" : "fa-user"
        }))
      } : null,
      active,
      bettingActive,
      dice,
      heldDice,
      freeDice,
      heldCount: heldDice.length,
      freeCount: freeDice.length,
      showDiceZones: Boolean(controlsActive && myPrivate?.dice?.every(Number.isInteger)),
      canRoll: Boolean(controlsActive && !myPrivate?.awaitingChoice && freeDice.length),
      canChoose: Boolean(controlsActive && (myPrivate?.awaitingChoice || (table.simultaneous && heldDice.length === 5))),
      finalChoice: Boolean(controlsActive && myPrivate?.awaitingChoice && active.rollCount >= 3),
      canFold: Boolean(controlsActive && (active?.rollCount ?? 0) < 3),
      canBet: controlsBetting,
      callLabel: amountToCall > 0 ? `Уравнять +${formatMoney(amountToCall, table?.currency)}` : "Чек — без повышения",
      privateCombination: myPrivate?.dice?.every(Number.isInteger) ? analyzeHand(myPrivate.dice).name : ""
    };
  }

  static onCreate() {
    const userIds = [...this.element.querySelectorAll('input[name="player"]:checked')].map((input) => input.value);
    const npcNames = this.element.querySelector('textarea[name="npcs"]')?.value.split(/\r?\n/) ?? [];
    const bet = this.element.querySelector('input[name="bet"]')?.value ?? "";
    const pool = this.element.querySelector('input[name="pool"]')?.value ?? "";
    request("create", { userIds, npcNames, bet, pool, npcActorUuids: (this.npcActors ?? []).map(actor => actor.actorUuid) });
  }

  static onRoll(event, target) {
    request("roll", {}, target.dataset.participantId);
  }

  static onToggleDie(event, target) {
    this.movedDie = Number(target.dataset.index);
    request("toggle", { index: target.dataset.index }, target.dataset.participantId);
  }

  static onEndTurn(event, target) {
    request("endTurn", {}, target.dataset.participantId);
  }

  static onFold(event, target) {
    request("fold", {}, target.dataset.participantId);
  }

  static onCallStake(event, target) {
    request("callStake", {}, target.dataset.participantId);
  }

  static onRaiseStake(event, target) {
    const amount = this.element.querySelector('input[name="raiseAmount"]')?.value ?? "";
    request("raiseStake", { amount }, target.dataset.participantId);
  }

  static onBetFold(event, target) {
    request("betFold", {}, target.dataset.participantId);
  }

  static async onReset() {
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: "Завершить текущую партию?" },
      content: "<p>Стол будет закрыт, а текущие результаты удалены.</p>"
    });
    if (confirmed) request("reset");
  }

  static onRules() {
    this.rulesOpen = !this.rulesOpen;
    this.render({ force: true });
  }
}

class TavernGamesHubApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static instance = null;

  static DEFAULT_OPTIONS = {
    id: "seven-dice-tavern-games",
    classes: ["seven-dice-tavern-hub"],
    tag: "section",
    window: {
      frame: true,
      icon: "fa-solid fa-beer-mug-empty",
      title: "Игры в таверне от Seven Dice",
      resizable: true
    },
    position: { width: 1000, height: 720 },
    actions: {
      selectGame: TavernGamesHubApp.onSelectGame,
      back: TavernGamesHubApp.onBack,
      playGame: TavernGamesHubApp.onPlayGame
    }
  };

  static PARTS = {
    main: { template: `${MODULE_PATH}/templates/tavern-hub.hbs` }
  };

  selectedGameId = null;

  static open() {
    this.instance ??= new this();
    const width = Math.min(1000, window.innerWidth - 32);
    const height = Math.min(720, window.innerHeight - 48);
    this.instance.render({
      force: true,
      position: {
        width,
        height,
        left: Math.max(16, Math.round((window.innerWidth - width) / 2)),
        top: 24
      }
    });
  }

  async _prepareContext() {
    const readyCount = TAVERN_GAMES.filter(entry => entry.available).length;
    return {
      readyCount,
      totalCount: TAVERN_GAMES.length,
      plannedCount: TAVERN_GAMES.length - readyCount,
      progress: TAVERN_GAMES.length ? readyCount / TAVERN_GAMES.length * 100 : 0,
      progressSlots: TAVERN_GAMES.map((entry,index)=>({ready:index<readyCount})),
      games: [...TAVERN_GAMES].sort((a, b) => Number(b.available) - Number(a.available)).map((gameEntry, index) => ({
        ...gameEntry,
        brief: {"poker-dice":"Соберите комбинацию из 5 костей за 3 круга. Оставляйте нужные, остальные перебрасывайте. Между кругами — ставки; сильнейшая рука забирает банк.","goblin-darts":"Бросайте d20 и d6: сектор и множитель определяют очки. Яблочко — 50. Кто первым наберёт цель, забирает банк.","baldur-dice":"Начните с 2d6. Добавляйте по кости или остановитесь: нужна сумма ближе к 21. Перебор проигрывает; при ничьей банк делится."}[gameEntry.id] ?? "",
        number: String(index + 1).padStart(2,"0")
      }))
    };
  }

  static onSelectGame(event, target) {
    const entry = TAVERN_GAMES.find(item => item.id === target.dataset.gameId);
    if (!entry?.available) return;
    if (entry.id === "poker-dice") DiceParlorApp.open();
    else QuickGamesApp.open(entry.id);
  }

  static onBack() {
    this.selectedGameId = null;
    this.render({ force: true });
  }

  static onPlayGame(event, target) {
    const gameId = target.dataset.gameId;
    if (gameId === "poker-dice") DiceParlorApp.open();
    else QuickGamesApp.open(gameId);
  }
}

Hooks.once("ready", () => {
  if (isHost()) hostTable = loadRecovery("poker");
  game.socket.on(SOCKET, onSocket);
  const module = game.modules.get(MODULE_ID);
  module.api = {
    open: () => TavernGamesHubApp.open(),
    openPoker: () => DiceParlorApp.open(),
    openGame: (gameId) => gameId === "poker-dice" ? DiceParlorApp.open() : QuickGamesApp.open(gameId),
    analyzeHand,
    handNames: HAND_NAMES,
    games: TAVERN_GAMES
  };
  request("sync");
});

Hooks.on("getSceneControlButtons", (controls) => {
  const group = controls.tokens ?? controls.token;
  if (!group?.tools) return;
  group.tools.sevenDiceTavern = {
    name: "sevenDiceTavern",
    order: 0.6,
    title: "Открыть игры в таверне от Seven Dice",
    icon: "fa-solid fa-beer-mug-empty",
    button: true,
    onChange: () => TavernGamesHubApp.open()
  };
});

Hooks.on("userConnected", () => {
  if (isHost() && hostTable) broadcastState();
});
