const MODULE_ID = "boss-bar-layers";
const NEGATIVE_EXCLUDED = new Set(["invisible", "transformed"]);

/* -------------------------------------------- */
/*  Settings                                    */
/* -------------------------------------------- */

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "enabled", {
    name: "Enable layered boss bars",
    hint: "Replace the Boss Bar look with stacked HP layers.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
    onChange: () => rerenderAll()
  });
  game.settings.register(MODULE_ID, "hpPerLayer", {
    name: "HP per bar",
    hint: "How many hit points make one full bar, for bosses without their own value. Right-click a boss bar (GM) to set it per boss.",
    scope: "world",
    config: true,
    type: Number,
    default: 30,
    onChange: () => refreshAll()
  });
  game.settings.register(MODULE_ID, "layerColors", {
    name: "Layer colors",
    hint: "Comma-separated colors, from the top layer down. They repeat if there are more layers.",
    scope: "world",
    config: true,
    type: String,
    default: "#f4b6c2, #4f86d9, #6cc58f, #e0b84f, #a874d9",
    onChange: () => refreshAll()
  });
  game.settings.register(MODULE_ID, "showEffects", {
    name: "Show active effects",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
    onChange: () => refreshAll()
  });
});

Hooks.once("ready", () => {
  const mod = game.modules.get(MODULE_ID);
  mod.api = {
    getHpPerLayer,
    setHpPerLayer: (actor, hp) => actor.setFlag(MODULE_ID, "hpPerLayer", Math.max(1, Math.round(hp))),
    refresh: refreshAll
  };
});

/* -------------------------------------------- */
/*  Hooks                                       */
/* -------------------------------------------- */

Hooks.on("renderBossBar", (app, element) => {
  if (!game.settings.get(MODULE_ID, "enabled")) return;
  const root = element instanceof HTMLElement ? element : element?.[0];
  if (!root) return;
  root.classList.add("bbl-enabled");
  for (const li of root.querySelectorAll(".bar-list-item[data-uuid]")) buildItem(li);
});

Hooks.on("updateActor", actor => refreshActor(actor));
for (const hook of ["createActiveEffect", "updateActiveEffect", "deleteActiveEffect"]) {
  Hooks.on(hook, effect => {
    const actor = effect.parent instanceof Actor ? effect.parent : effect.parent?.parent;
    if (actor instanceof Actor) refreshActor(actor);
  });
}

/* -------------------------------------------- */
/*  Data                                        */
/* -------------------------------------------- */

function bossbarSetting(key, fallback) {
  try { return game.settings.get("bossbar", key) ?? fallback; } catch { return fallback; }
}

function getHpPerLayer(actor) {
  const own = Number(actor?.flags?.[MODULE_ID]?.hpPerLayer);
  if (Number.isFinite(own) && own >= 1) return Math.round(own);
  return Math.max(1, Math.round(Number(game.settings.get(MODULE_ID, "hpPerLayer")) || 30));
}

function layerColors() {
  const list = String(game.settings.get(MODULE_ID, "layerColors") ?? "")
    .split(",").map(c => c.trim()).filter(Boolean);
  return list.length ? list : ["#f4b6c2", "#4f86d9"];
}

function computeState(actor) {
  const sys = actor.system;
  const hp = Number(foundry.utils.getProperty(sys, bossbarSetting("currentHpPath", "attributes.hp.value"))) || 0;
  const max = Math.max(1, Number(foundry.utils.getProperty(sys, bossbarSetting("maxHpPath", "attributes.hp.max"))) || 1);
  const perLayer = getHpPerLayer(actor);
  const clamped = Math.min(Math.max(hp, 0), max);
  // Full bars from the top; the last (bottom) bar holds whatever is left over.
  const layers = Math.max(1, Math.ceil(max / perLayer - 1e-9));
  const lastSize = max - (layers - 1) * perLayer;
  const lost = max - clamped;
  // index of the bar being drained, counted from the top (0 = top bar)
  const top = clamped <= 0 ? layers : Math.min(layers - 1, Math.floor(lost / perLayer + 1e-9));
  const remaining = layers - top; // bars still showing HP, including the current one
  let pct = 0;
  if (clamped > 0) {
    const size = top === layers - 1 ? lastSize : perLayer;
    const inLayer = top === layers - 1 ? clamped : perLayer - (lost - top * perLayer);
    pct = Math.max(0, Math.min(100, (inLayer / size) * 100));
  }
  const colors = layerColors();
  const colorOf = index => colors[index % colors.length];
  return {
    hp: clamped, max, layers, remaining, pct,
    front: remaining > 0 ? colorOf(top) : "transparent",
    back: remaining > 1 ? colorOf(top + 1) : "transparent"
  };
}

function activeEffects(actor) {
  if (!game.settings.get(MODULE_ID, "showEffects")) return [];
  const conditions = CONFIG.DND5E?.conditionTypes ?? {};
  const seen = new Set();
  const list = [];
  for (const e of actor.temporaryEffects ?? []) {
    if (!e.img || seen.has(e.img + e.name)) continue;
    seen.add(e.img + e.name);
    const negative = [...(e.statuses ?? [])].some(s => s in conditions && !NEGATIVE_EXCLUDED.has(s));
    list.push({img: e.img, name: e.name, negative});
  }
  return list;
}

/* -------------------------------------------- */
/*  Rendering                                   */
/* -------------------------------------------- */

function buildItem(li) {
  const actor = fromUuidSync(li.dataset.uuid);
  if (!actor) return;
  li.classList.add("bbl-item");
  li.querySelector(".bbl-root")?.remove();
  const hideName = !li.querySelector(".bar-name");

  const root = document.createElement("div");
  root.className = "bbl-root";
  root.innerHTML = `
    <div class="bbl-main">
      <div class="bbl-name"${hideName ? ' style="visibility:hidden"' : ""}>${foundry.utils.escapeHTML(actor.name)}</div>
      <div class="bbl-row">
        <div class="bbl-bar">
          <div class="bbl-back"></div>
          <div class="bbl-chip"></div>
          <div class="bbl-fill"></div>
          <div class="bbl-pct"></div>
        </div>
        <div class="bbl-count"></div>
      </div>
      <div class="bbl-effects"></div>
    </div>`;
  li.append(root);

  if (game.user.isGM) {
    root.addEventListener("contextmenu", ev => {
      ev.preventDefault();
      ev.stopPropagation();
      promptLayers(actor);
    });
  }
  updateItem(li, actor, {instant: true});
}

function updateItem(li, actor, {instant = false} = {}) {
  const root = li.querySelector(".bbl-root");
  if (!root) return;
  const s = computeState(actor);
  const prevLayer = Number(root.dataset.layer ?? s.remaining);
  const layerChanged = prevLayer !== s.remaining;

  const fill = root.querySelector(".bbl-fill");
  const chip = root.querySelector(".bbl-chip");
  const back = root.querySelector(".bbl-back");
  root.style.setProperty("--bbl-front", s.front);
  back.style.background = s.back;

  if (instant || layerChanged) {
    // jump straight to the new layer without animating across bars
    for (const el of [fill, chip]) el.classList.add("bbl-no-anim");
    fill.style.width = `${s.pct}%`;
    chip.style.width = `${s.pct}%`;
    void fill.offsetWidth;
    for (const el of [fill, chip]) el.classList.remove("bbl-no-anim");
  } else {
    fill.style.width = `${s.pct}%`;
    chip.style.width = `${s.pct}%`;
  }
  root.dataset.layer = String(s.remaining);

  root.querySelector(".bbl-pct").textContent = `${Math.round(s.pct)}%`;
  // number of bars still showing HP, including the one being drained
  root.querySelector(".bbl-count").textContent = s.layers > 1 ? `×${s.remaining}` : "";

  const effects = root.querySelector(".bbl-effects");
  effects.innerHTML = activeEffects(actor).map(e => `
    <div class="bbl-effect${e.negative ? " negative" : ""}" data-tooltip="${foundry.utils.escapeHTML(e.name)}">
      <img src="${e.img}" alt="">
    </div>`).join("");
}

function refreshActor(actor) {
  if (!game.settings.get(MODULE_ID, "enabled")) return;
  const uuids = new Set([actor.uuid, actor.token?.uuid, actor.token?.actor?.uuid].filter(Boolean));
  for (const li of document.querySelectorAll("#boss-bar .bar-list-item.bbl-item[data-uuid]")) {
    if (!uuids.has(li.dataset.uuid)) continue;
    const doc = fromUuidSync(li.dataset.uuid);
    if (doc) updateItem(li, doc);
  }
}

function refreshAll() {
  for (const li of document.querySelectorAll("#boss-bar .bar-list-item.bbl-item[data-uuid]")) {
    const doc = fromUuidSync(li.dataset.uuid);
    if (doc) updateItem(li, doc, {instant: true});
  }
}

function rerenderAll() {
  const bar = document.querySelector("#boss-bar");
  if (!bar) return;
  if (!game.settings.get(MODULE_ID, "enabled")) {
    bar.classList.remove("bbl-enabled");
    bar.querySelectorAll(".bbl-root").forEach(e => e.remove());
    bar.querySelectorAll(".bbl-item").forEach(e => e.classList.remove("bbl-item"));
    return;
  }
  bar.classList.add("bbl-enabled");
  bar.querySelectorAll(".bar-list-item[data-uuid]").forEach(buildItem);
}

async function promptLayers(actor) {
  const current = getHpPerLayer(actor);
  const value = await foundry.applications.api.DialogV2.prompt({
    window: {title: `Boss Bar Layers — ${actor.name}`},
    content: `<div class="form-group"><label>HP per bar</label>
      <input type="number" name="hpPerLayer" min="1" step="1" value="${current}" autofocus></div>
      <p class="hint">Each full bar holds this many hit points; the last bar holds the remainder.</p>`,
    ok: {label: "Save", callback: (event, button) => Number(button.form.elements.hpPerLayer.value)},
    rejectClose: false
  });
  if (!Number.isFinite(value) || value < 1) return;
  await actor.setFlag(MODULE_ID, "hpPerLayer", Math.round(value));
  refreshAll();
}
