import { analyzeHand, determineWinners, HAND_NAMES } from "./engine.mjs";
import { TAVERN_GAMES } from "./catalog.mjs";
import { QuickGamesApp } from "./quick-games.mjs";

const MODULE_ID = "seven-dice-tavern-games";
const MODULE_PATH = `modules/${MODULE_ID}`;
const SOCKET = `module.${MODULE_ID}`;
const MAX_PLAYERS = 6;

let hostTable = null;
let publicTable = null;
let privateHands = {};
let hostQueue = Promise.resolve();

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
  const revealed = hostTable.phase === "finished";
  return {
    id: hostTable.id,
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
    participants: hostTable.participants.map((participant) => ({
      id: participant.id,
      name: participant.name,
      kind: participant.kind,
      controllerUserId: participant.controllerUserId,
      rollCount: participant.rollCount,
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
  for (const user of game.users.filter((entry) => entry.active)) sendStateTo(user.id);
}

function participantForAction(senderId, participantId) {
  const participant = hostTable?.participants.find((entry) => entry.id === participantId);
  if (!participant) throw new Error("Участник не найден.");
  if (hostTable.phase !== "playing") throw new Error(hostTable.phase === "betting" ? "Сначала завершите торговлю — бросок пока недоступен." : "Партия уже завершена.");
  if (hostTable.activeParticipantId !== participant.id) throw new Error("Сейчас ход другого участника.");
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

function finishTable(reason = "showdown") {
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
  postResultToChat();
}

async function postResultToChat() {
  const rows = hostTable.participants.map((participant) => {
    if (participant.folded) return `<li><strong>${foundry.utils.escapeHTML(participant.name)}</strong> — пас; внесённые ${foundry.utils.escapeHTML(participant.foldLoss)} остаются в банке</li>`;
    if (!participant.hand) return `<li><strong>${foundry.utils.escapeHTML(participant.name)}</strong> — победа без раскрытия руки</li>`;
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

    if (packet.action === "create") {
      if (!game.users.get(packet.senderId)?.isGM) throw new Error("Создать стол может только мастер.");
      const requestedUsers = [...new Set(packet.data.userIds ?? [])]
        .map((id) => game.users.get(id))
        .filter((user) => user?.active);
      const npcNames = (packet.data.npcNames ?? []).map((name) => String(name).trim()).filter(Boolean);
      const participants = [
        ...requestedUsers.map((user) => ({ name: user.name, kind: "player", controllerUserId: user.id })),
        ...npcNames.map((name) => ({ name, kind: "npc", controllerUserId: packet.senderId }))
      ].slice(0, MAX_PLAYERS);
      if (participants.length < 2) throw new Error("Нужно выбрать минимум двух участников.");
      const betMoney = parseMoney(packet.data.bet) ?? { amount: 0, currency: "" };
      const poolMoney = parseMoney(packet.data.pool);
      const currency = betMoney.currency || poolMoney?.currency || "зм";
      hostTable = {
        id: makeId(),
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
        hostTable.stakeAmount = hostTable.targetStake;
        const contribution = Math.max(0, hostTable.targetStake - participant.committed);
        participant.committed = hostTable.targetStake;
        hostTable.poolAmount += contribution;
        hostTable.bettingResponses = [participant.id];
        updateMoneyLabels();
      }
      else if (packet.action === "callStake") {
        const contribution = Math.max(0, hostTable.targetStake - participant.committed);
        participant.committed = hostTable.targetStake;
        hostTable.poolAmount += contribution;
        if (!hostTable.bettingResponses.includes(participant.id)) hostTable.bettingResponses.push(participant.id);
        updateMoneyLabels();
      }
      else {
        participant.folded = true;
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
      const values = await rollD6(openIndexes.length);
      openIndexes.forEach((index, valueIndex) => { participant.dice[index] = values[valueIndex]; });
      participant.rollCount += 1;
      if (participant.rollCount >= 3 || participant.held.every(Boolean)) {
        participant.held.fill(true);
        participant.awaitingChoice = false;
        participant.completed = true;
        participant.hand = analyzeHand(participant.dice);
        advanceTurn(participant.id);
      }
      else {
        participant.awaitingChoice = true;
      }
    }
    else if (packet.action === "toggle") {
      if (!participant.awaitingChoice) throw new Error("Сначала бросьте кости.");
      const index = Number(packet.data.index);
      if (!Number.isInteger(index) || index < 0 || index > 4) throw new Error("Некорректная кость.");
      participant.held[index] = !participant.held[index];
    }
    else if (packet.action === "endTurn") {
      if (!participant.awaitingChoice) throw new Error("Сначала бросьте кости.");
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
    broadcastState();
  }
  catch (error) {
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
  const packet = { type: "request", action, data, participantId, senderId: game.user.id };
  if (isHost()) enqueueHostRequest(packet);
  else if (activeHost()) sendPacket(packet);
  else notifyError("Нет активного мастера, который может вести стол.");
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
  else if (packet.type === "error") notifyError(packet.message);
}

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

class DiceParlorApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static instance = null;

  static DEFAULT_OPTIONS = {
    id: "seven-dice-poker",
    classes: ["dice-parlor"],
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
      rules: DiceParlorApp.onRules
    }
  };

  static PARTS = {
    main: { template: `${MODULE_PATH}/templates/dice-parlor.hbs` }
  };

  rulesOpen = false;

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
    const active = table?.participants.find((participant) => participant.id === table.activeParticipantId) ?? null;
    const myPrivate = active ? privateHands[active.id] : null;
    const controlsActive = Boolean(active && active.controllerUserId === game.user.id);
    const bettingActive = table?.participants.find((participant) => participant.id === table.bettingActiveParticipantId) ?? null;
    const controlsBetting = Boolean(bettingActive && bettingActive.controllerUserId === game.user.id);
    const amountToCall = bettingActive ? Math.max(0, table.targetStake - bettingActive.committed) : 0;
    const dice = (myPrivate?.dice ?? active?.dice ?? [null, null, null, null, null]).map((value, index) => ({
      index,
      value: value ?? "?",
      held: Boolean(myPrivate?.held?.[index]),
      selectable: Boolean(controlsActive && myPrivate?.awaitingChoice)
    }));
    const heldDice = dice.filter((die) => die.held);
    const freeDice = dice.filter((die) => !die.held);
    return {
      hasTable: Boolean(table),
      waitingForGm: !table && !game.user.isGM,
      isGM: game.user.isGM,
      isHost: isHost(),
      rulesOpen: this.rulesOpen,
      activeUsers: game.users.filter((user) => user.active).map((user) => ({ id: user.id, name: user.name, checked: true })),
      table: table ? {
        ...table,
        isFinished: table.phase === "finished",
        isBetting: table.phase === "betting",
        bettingRoundLabel: table.bettingAfterRound === 1 ? "после первого круга" : "перед следующим броском или раскрытием",
        roundLabel: table.round === 1 ? "Первый бросок" : table.round === 2 ? "Второй бросок" : "Финальный бросок",
        participants: table.participants.map((participant) => ({
          ...participant,
          isActive: participant.id === (table.phase === "betting" ? table.bettingActiveParticipantId : table.activeParticipantId),
          isWinner: table.winnerIds.includes(participant.id),
          status: participant.folded
            ? `Пас · в банке: ${participant.foldLoss}`
            : table.phase === "betting"
              ? participant.id === table.bettingActiveParticipantId
                ? "Принимает решение"
                : table.bettingResponses.includes(participant.id) ? "Ставка принята" : "Ожидает ответа"
              : participant.completed ? "Готов" : participant.id === table.activeParticipantId ? "Ходит" : "Ожидает",
          diceText: participant.dice?.join(" · ") ?? "",
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
      canRoll: Boolean(controlsActive && !myPrivate?.awaitingChoice),
      canChoose: Boolean(controlsActive && myPrivate?.awaitingChoice),
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
    request("create", { userIds, npcNames, bet, pool });
  }

  static onRoll(event, target) {
    request("roll", {}, target.dataset.participantId);
  }

  static onToggleDie(event, target) {
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
    const selected = TAVERN_GAMES.find((gameEntry) => gameEntry.id === this.selectedGameId) ?? null;
    return {
      selected,
      games: TAVERN_GAMES.map((gameEntry, index) => ({
        ...gameEntry,
        number: index + 1,
        stateLabel: gameEntry.available ? "Можно играть" : "Правила добавлены"
      }))
    };
  }

  static onSelectGame(event, target) {
    this.selectedGameId = target.dataset.gameId;
    this.render({ force: true });
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
