import { findBaldurWinners, scoreGoblinDart } from "./quick-engine.mjs";

const MODULE_ID = "seven-dice-tavern-games";
const MODULE_PATH = `modules/${MODULE_ID}`;
const SOCKET = `module.${MODULE_ID}`;
const MAX_PLAYERS = 6;
const DARTBOARD_SETTING = "dartboardStyle";

let hostState = null;
let publicState = null;
let hostQueue = Promise.resolve();

function activeHost() {
  return game.users.filter((user) => user.active && user.isGM).sort((a, b) => a.id.localeCompare(b.id))[0] ?? null;
}

function isHost() {
  return activeHost()?.id === game.user.id;
}

function parseMoney(value) {
  const match = String(value ?? "").trim().match(/^(\d+(?:[.,]\d+)?)\s*(.*)$/);
  if (!match) return { amount: 0, currency: "зм" };
  return { amount: Number(match[1].replace(",", ".")), currency: match[2].trim() || "зм" };
}

function formatMoney(amount, currency) {
  const number = Number.isInteger(amount) ? String(amount) : String(Math.round(amount * 100) / 100).replace(".", ",");
  return `${number} ${currency}`;
}

async function openRoll(formula, userId = game.user.id) {
  const evaluated = await new Roll(formula).evaluate();
  if (game.dice3d?.showForRoll) await game.dice3d.showForRoll(evaluated, game.users.get(userId) ?? game.user, true);
  return evaluated;
}

function allResults(evaluated) {
  return evaluated.dice.flatMap((die) => die.results.map((result) => result.result));
}

function playSynthWhoosh() {
  try {
    const AudioContextClass = globalThis.AudioContext ?? globalThis.webkitAudioContext;
    if (!AudioContextClass) return;
    const context = new AudioContextClass();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "sawtooth";
    oscillator.frequency.setValueAtTime(950, context.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(120, context.currentTime + 0.38);
    gain.gain.setValueAtTime(0.0001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.055, context.currentTime + 0.035);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.4);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.42);
    oscillator.addEventListener("ended", () => context.close());
  }
  catch (error) {
    console.debug(`${MODULE_ID} | Синтезированный звук недоступен`, error);
  }
}

function playFx(kind) {
  if (kind === "dart-whoosh") playSynthWhoosh();
  if (kind === "dart-impact") foundry.audio.AudioHelper.play({ src: `${MODULE_PATH}/assets/dart-impact.mp3`, volume: 0.75 }, false);
}

function broadcastFx(kind) {
  playFx(kind);
  game.socket.emit(SOCKET, { type: "qg-fx", kind, senderId: game.user.id });
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function makeDartVisual(lastDart, boardStyle = "classic") {
  if (!lastDart) return null;
  const angle = (lastDart.sector - 1) * 18 - 90;
  // Both images have decorative rims of different widths, so each visual skin
  // gets its own calibrated scoring radii.
  const radii = boardStyle === "rustic"
    ? { outer: 35, inner: 20, triple: 28 }
    : { outer: 37, inner: 22, triple: 31.3 };
  const radius = lastDart.hit === 6 ? 0 : lastDart.hit <= 2 ? radii.outer : lastDart.hit <= 4 ? radii.inner : radii.triple;
  const radians = angle * Math.PI / 180;
  return {
    ...lastDart,
    markerStyle: `--dart-x:${50 + radius * Math.cos(radians)}%;--dart-y:${50 + radius * Math.sin(radians)}%;--dart-angle:${angle}deg`
  };
}

function refresh() {
  if (QuickGamesApp.instance?.rendered) QuickGamesApp.instance.render({ force: true });
}

function acceptState(state) {
  publicState = state;
  refresh();
}

function snapshot() {
  return hostState ? foundry.utils.deepClone(hostState) : null;
}

function sendStateTo(userId) {
  const packet = { type: "qg-state", targetUserId: userId, state: snapshot() };
  if (userId === game.user.id) acceptState(packet.state);
  else game.socket.emit(SOCKET, packet);
}

function broadcast() {
  if (!isHost()) return;
  for (const user of game.users.filter((entry) => entry.active)) sendStateTo(user.id);
}

function notify(message) {
  ui.notifications.warn(`Игры Seven Dice: ${message}`);
}

function advanceTurn(currentId) {
  const participants = hostState.participants;
  const start = participants.findIndex((participant) => participant.id === currentId);
  for (let offset = 1; offset <= participants.length; offset += 1) {
    const candidate = participants[(start + offset) % participants.length];
    if (!candidate.done) {
      hostState.activeParticipantId = candidate.id;
      return;
    }
  }
  finishBaldur();
}

function controllerParticipant(packet) {
  const participant = hostState?.participants.find((entry) => entry.id === packet.participantId);
  if (!participant) throw new Error("Участник не найден.");
  if (hostState.phase !== "playing") throw new Error("Партия завершена.");
  if (hostState.activeParticipantId !== participant.id) throw new Error("Сейчас ход другого участника.");
  if (participant.controllerUserId !== packet.senderId) throw new Error("Этим участником управляет другой пользователь.");
  return participant;
}

async function finishDarts(winner) {
  hostState.phase = "finished";
  hostState.activeParticipantId = null;
  hostState.winnerIds = [winner.id];
  hostState.resultText = `${winner.name} первым набирает ${winner.score} очков и получает банк ${hostState.pool}.`;
  await postResult();
}

async function finishBaldur() {
  hostState.phase = "finished";
  hostState.activeParticipantId = null;
  const winners = findBaldurWinners(hostState.participants);
  const best = winners[0]?.total ?? null;
  hostState.winnerIds = winners.map((participant) => participant.id);
  hostState.resultText = winners.length === 0
    ? "Все участники превысили 21 — банк остаётся в таверне."
    : winners.length > 1
      ? `Ничья на ${best}: ${winners.map((participant) => participant.name).join(", ")}. Банк делится.`
      : `${winners[0].name} побеждает с суммой ${best} и получает банк ${hostState.pool}.`;
  await postResult();
}

async function postResult() {
  const rows = hostState.participants.map((participant) => hostState.gameId === "goblin-darts"
    ? `<li><strong>${foundry.utils.escapeHTML(participant.name)}</strong>: ${participant.score} очков</li>`
    : `<li><strong>${foundry.utils.escapeHTML(participant.name)}</strong>: ${participant.dice.join(" + ")} = ${participant.total}${participant.bust ? " — перебор" : ""}</li>`).join("");
  await ChatMessage.create({
    speaker: { alias: "Игры Seven Dice" },
    content: `<section><h3>${foundry.utils.escapeHTML(hostState.title)}</h3><p>Банк: <strong>${foundry.utils.escapeHTML(hostState.pool)}</strong></p><ul>${rows}</ul><p><strong>${foundry.utils.escapeHTML(hostState.resultText)}</strong></p></section>`
  });
}

async function handleRequest(packet) {
  try {
    if (packet.action === "sync") {
      sendStateTo(packet.senderId);
      return;
    }
    if (packet.action === "reset") {
      if (!game.users.get(packet.senderId)?.isGM) throw new Error("Закрыть стол может только мастер.");
      hostState = null;
      broadcast();
      return;
    }
    if (packet.action === "create") {
      if (!game.users.get(packet.senderId)?.isGM) throw new Error("Создать стол может только мастер.");
      const users = [...new Set(packet.data.userIds ?? [])].map((id) => game.users.get(id)).filter((user) => user?.active);
      const npcNames = (packet.data.npcNames ?? []).map((name) => String(name).trim()).filter(Boolean);
      const entries = [
        ...users.map((user) => ({ name: user.name, kind: "player", controllerUserId: user.id })),
        ...npcNames.map((name) => ({ name, kind: "npc", controllerUserId: packet.senderId }))
      ].slice(0, MAX_PLAYERS);
      const minimum = packet.data.gameId === "goblin-darts" || packet.data.gameId === "baldur-dice" ? 2 : 2;
      if (entries.length < minimum) throw new Error(`Нужно минимум ${minimum} участника.`);
      const money = parseMoney(packet.data.stake);
      hostState = {
        id: foundry.utils.randomID(12),
        gameId: packet.data.gameId,
        title: packet.data.gameId === "goblin-darts" ? "Гоблинский дротик" : "Кости Балдура",
        phase: "playing",
        stake: formatMoney(money.amount, money.currency),
        pool: formatMoney(money.amount * entries.length, money.currency),
        target: Math.max(20, Number(packet.data.target) || 301),
        activeParticipantId: null,
        winnerIds: [],
        resultText: "",
        lastDart: null,
        participants: entries.map((entry) => ({
          ...entry,
          id: foundry.utils.randomID(12),
          score: 0,
          total: 0,
          dice: [],
          lastRoll: null,
          done: false,
          bust: false,
          started: false
        }))
      };
      hostState.activeParticipantId = hostState.participants[0].id;
      broadcast();
      return;
    }

    const participant = controllerParticipant(packet);
    if (hostState.gameId === "goblin-darts" && packet.action === "dartsRoll") {
      const evaluated = await openRoll("1d20 + 1d6", participant.controllerUserId);
      const sector = evaluated.dice[0].results[0].result;
      const hit = evaluated.dice[1].results[0].result;
      const { multiplier, points, label } = scoreGoblinDart(sector, hit);
      broadcastFx("dart-whoosh");
      await wait(420);
      participant.score += points;
      participant.lastRoll = { sector, hit, multiplier, points, label };
      hostState.lastDart = { participantId: participant.id, participantName: participant.name, sector, hit, multiplier, points, label };
      broadcastFx("dart-impact");
      if (participant.score >= hostState.target) await finishDarts(participant);
      else advanceTurn(participant.id);
    }
    else if (hostState.gameId === "baldur-dice" && packet.action === "baldurRoll") {
      if (participant.started) throw new Error("Начальный бросок уже сделан.");
      participant.dice = allResults(await openRoll("2d6", participant.controllerUserId));
      participant.total = participant.dice.reduce((sum, value) => sum + value, 0);
      participant.started = true;
    }
    else if (hostState.gameId === "baldur-dice" && packet.action === "baldurHit") {
      if (!participant.started) throw new Error("Сначала бросьте начальные 2d6.");
      const [value] = allResults(await openRoll("1d6", participant.controllerUserId));
      participant.dice.push(value);
      participant.total += value;
      if (participant.total > 21) {
        participant.bust = true;
        participant.done = true;
        advanceTurn(participant.id);
      }
      else if (participant.total === 21) {
        participant.done = true;
        advanceTurn(participant.id);
      }
    }
    else if (hostState.gameId === "baldur-dice" && packet.action === "baldurStand") {
      if (!participant.started) throw new Error("Сначала бросьте начальные 2d6.");
      participant.done = true;
      advanceTurn(participant.id);
    }
    else throw new Error("Действие недоступно для этой игры.");
    broadcast();
  }
  catch (error) {
    console.warn(`${MODULE_ID} | Quick game request rejected`, error);
    if (packet.senderId === game.user.id) notify(error.message);
    else game.socket.emit(SOCKET, { type: "qg-error", targetUserId: packet.senderId, message: error.message });
  }
}

function enqueue(packet) {
  hostQueue = hostQueue.then(() => handleRequest(packet)).catch((error) => console.error(`${MODULE_ID} | Quick game queue`, error));
}

function request(action, data = {}, participantId = null) {
  const packet = { type: "qg-request", action, data, participantId, senderId: game.user.id };
  if (isHost()) enqueue(packet);
  else if (activeHost()) game.socket.emit(SOCKET, packet);
  else notify("Нет активного мастера.");
}

function onSocket(packet) {
  if (packet?.type === "qg-request" && isHost()) return enqueue(packet);
  if (packet?.type === "qg-fx") {
    if (packet.senderId !== game.user.id) playFx(packet.kind);
    return;
  }
  if (packet?.targetUserId && packet.targetUserId !== game.user.id) return;
  if (packet?.type === "qg-state") acceptState(packet.state);
  else if (packet?.type === "qg-error") notify(packet.message);
}

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class QuickGamesApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static instance = null;
  selectedGameId = "goblin-darts";

  static DEFAULT_OPTIONS = {
    id: "seven-dice-quick-game",
    classes: ["seven-dice-quick-game"],
    tag: "section",
    window: { frame: true, icon: "fa-solid fa-dice", title: "Игры Seven Dice", resizable: true },
    position: { width: 860, height: 670 },
    actions: {
      create: QuickGamesApp.onCreate,
      reset: QuickGamesApp.onReset,
      boardStyle: QuickGamesApp.onBoardStyle,
      dartsRoll: QuickGamesApp.onDartsRoll,
      baldurRoll: QuickGamesApp.onBaldurRoll,
      baldurHit: QuickGamesApp.onBaldurHit,
      baldurStand: QuickGamesApp.onBaldurStand
    }
  };

  static PARTS = { main: { template: `${MODULE_PATH}/templates/quick-game.hbs` } };

  static open(gameId) {
    this.instance ??= new this();
    this.instance.selectedGameId = gameId;
    this.instance.render({ force: true, position: { width: Math.min(860, window.innerWidth - 32), height: Math.min(670, window.innerHeight - 48), top: 24 } });
    request("sync");
  }

  async _prepareContext() {
    const state = publicState?.gameId === this.selectedGameId ? publicState : null;
    const active = state?.participants.find((participant) => participant.id === state.activeParticipantId) ?? null;
    const activeView = active ? { ...active, diceText: active.dice.length ? active.dice.join(" + ") : "—" } : null;
    const controls = active?.controllerUserId === game.user.id;
    const isDarts = this.selectedGameId === "goblin-darts";
    const dartboardStyle = game.settings.get(MODULE_ID, DARTBOARD_SETTING);
    return {
      hasTable: Boolean(state),
      isGM: game.user.isGM,
      isDarts,
      isBaldur: !isDarts,
      title: isDarts ? "Гоблинский дротик" : "Кости Балдура",
      subtitle: isDarts ? "Первым наберите установленную цель" : "Приблизьтесь к 21, не превышая его",
      activeUsers: game.users.filter((user) => user.active).map((user) => ({ id: user.id, name: user.name })),
      targetSectors: Array.from({ length: 20 }, (_, index) => ({ number: index + 1, style: `--sector:${index}` })),
      dartboardStyle,
      dartboardStyles: [
        { id: "classic", label: "Классическая", active: dartboardStyle === "classic" },
        { id: "rustic", label: "Гоблинская мишень", active: dartboardStyle === "rustic" }
      ],
      dartsVisual: makeDartVisual(state?.lastDart, dartboardStyle),
      state: state ? {
        ...state,
        finished: state.phase === "finished",
        participants: state.participants.map((participant) => ({
          ...participant,
          active: participant.id === state.activeParticipantId,
          winner: state.winnerIds.includes(participant.id),
          diceText: participant.dice.length ? participant.dice.join(" + ") : "—",
          status: participant.bust ? "Перебор" : participant.done ? "Остановился" : participant.id === state.activeParticipantId ? "Ходит" : "Ожидает",
          lastText: participant.lastRoll ? `d20: ${participant.lastRoll.sector}, d6: ${participant.lastRoll.hit}, +${participant.lastRoll.points}` : "Бросков ещё нет"
        }))
      } : null,
      active: activeView,
      controls,
      canInitialRoll: Boolean(controls && !active?.started),
      canBaldurChoose: Boolean(controls && active?.started && !active?.done)
    };
  }

  static onCreate() {
    const userIds = [...this.element.querySelectorAll('input[name="player"]:checked')].map((input) => input.value);
    const npcNames = this.element.querySelector('textarea[name="npcs"]')?.value.split(/\r?\n/) ?? [];
    const stake = this.element.querySelector('input[name="stake"]')?.value ?? "";
    const target = this.element.querySelector('input[name="target"]')?.value ?? "301";
    request("create", { gameId: this.selectedGameId, userIds, npcNames, stake, target });
  }

  static onDartsRoll(event, target) { request("dartsRoll", {}, target.dataset.participantId); }
  static async onBoardStyle(event, target) { await game.settings.set(MODULE_ID, DARTBOARD_SETTING, target.dataset.boardStyle); }
  static onBaldurRoll(event, target) { request("baldurRoll", {}, target.dataset.participantId); }
  static onBaldurHit(event, target) { request("baldurHit", {}, target.dataset.participantId); }
  static onBaldurStand(event, target) { request("baldurStand", {}, target.dataset.participantId); }

  static async onReset() {
    const confirmed = await foundry.applications.api.DialogV2.confirm({ window: { title: "Закрыть игровой стол?" }, content: "<p>Текущая партия будет завершена.</p>" });
    if (confirmed) request("reset");
  }
}

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, DARTBOARD_SETTING, {
    name: "Вид мишени для «Гоблинского дротика»",
    scope: "client",
    config: false,
    type: String,
    choices: { classic: "Классическая", rustic: "Гоблинская мишень" },
    default: "classic",
    onChange: refresh
  });
});

Hooks.once("ready", () => {
  game.socket.on(SOCKET, onSocket);
  request("sync");
});
