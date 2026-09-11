export async function resolveNpcActors(uuids = []) {
  if (!Array.isArray(uuids) || uuids.length > 6) throw new Error("За столом может быть не больше 6 участников.");
  return Promise.all([...new Set(uuids)].map(async uuid => {
    if (typeof uuid !== "string") throw new Error("Некорректный актёр.");
    const actor = await fromUuid(uuid);
    if (actor?.documentName !== "Actor") throw new Error("Актёр не найден. Добавьте его заново.");
    const token = actor.prototypeToken?.texture?.src;
    return { actorUuid: uuid, name: actor.name, portrait: token && !actor.prototypeToken?.randomImg && !token.includes("*") ? token : actor.img };
  }));
}

// Update only the drop area, preserving checkboxes, stake and typed NPC names.
export function bindNpcDrop(app) {
  const zone = app.element.querySelector(".sd-npc-drop");
  if (!zone || !game.user.isGM) return;
  app.npcActors ??= [];
  const list = zone.querySelector(".sd-npc-list");
  const paint = () => {
    list.replaceChildren();
    for (const actor of app.npcActors) {
      const row = document.createElement("div"); row.className = "sd-npc-entry";
      if (actor.portrait) { const img = document.createElement("img"); img.src = actor.portrait; img.alt = ""; row.append(img); }
      const name = document.createElement("span"); name.textContent = actor.name; row.append(name);
      const remove = document.createElement("button"); remove.type = "button"; remove.textContent = "×";
      remove.setAttribute("aria-label", `Убрать ${actor.name}`);
      remove.addEventListener("click", event => { event.stopPropagation(); app.npcActors = app.npcActors.filter(p => p.actorUuid !== actor.actorUuid); paint(); });
      row.append(remove); list.append(row);
    }
  };
  paint();
  zone.addEventListener("dragover", event => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; zone.classList.add("drag-over"); });
  zone.addEventListener("dragleave", () => zone.classList.remove("drag-over"));
  zone.addEventListener("drop", async event => {
    event.preventDefault(); event.stopPropagation(); zone.classList.remove("drag-over");
    try {
      const data = JSON.parse(event.dataTransfer.getData("text/plain"));
      if (data.type !== "Actor" || !data.uuid) throw new Error("Перетащите актёра из списка актёров.");
      const [actor] = await resolveNpcActors([data.uuid]);
      if (app.npcActors.some(p => p.actorUuid === actor.actorUuid)) return;
      if (app.npcActors.length >= 6) throw new Error("За столом может быть не больше 6 участников.");
      app.npcActors.push(actor); paint();
    } catch (error) { ui.notifications.warn(error instanceof SyntaxError ? "Перетащите актёра из списка актёров." : error.message); }
  });
}
