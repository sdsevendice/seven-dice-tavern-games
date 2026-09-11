// Browser-local recovery: never publish a saved private hand in world settings.
// This recovers reloads of this GM's tab, not loss of the browser or GM handoff.
const prefix = "seven-dice-tavern-recovery-v1";
function key(kind) { return `${prefix}:${game.world.id}:${game.user.id}:${kind}`; }
export function saveRecovery(kind, state) {
  if (!game.user.isGM || !globalThis.sessionStorage || !game.world?.id) return;
  try {
    if (state) sessionStorage.setItem(key(kind), JSON.stringify(state));
    else sessionStorage.removeItem(key(kind));
  } catch (error) { console.warn("Seven Dice | Не удалось сохранить восстановление вкладки", error); }
}
export function loadRecovery(kind) {
  if (!game.user.isGM || !globalThis.sessionStorage || !game.world?.id) return null;
  try {
    const state = JSON.parse(sessionStorage.getItem(key(kind)) ?? "null");
    return state?.id && Array.isArray(state.participants) && ["playing", "betting", "finished"].includes(state.phase) ? state : null;
  } catch { return null; }
}
