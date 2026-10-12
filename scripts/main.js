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
  game.settings.register(MODULE_ID, "defaultLayers", {
    name: "Default number of layers",
    hint: "HP layers for bosses without their own value. Right-click a boss bar (GM) to set it per boss.",
    scope: "world",
    config: true,
    type: Number,
    default: 3,
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
    getLayers,
    setLayers: (actor, layers) => actor.setFlag(MODULE_ID, "layers", Math.max(1, Math.round(layers))),
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

function getLayers(actor) {
  const own = Number(actor?.getFlag(MODULE_ID, "layers"));
  if (Number.isFinite(own) && own >= 1) return Math.round(own);
  return Math.max(1, Math.round(Number(game.settings.get(MODULE_ID, "defaultLayers")) || 1));
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
  const layers = getLayers(actor);
  const perLayer = max / layers;
  const clamped = Math.min(Math.max(hp, 0), max);
  // current layer counted from the bottom (1 = last bar)
  const current = clamped <= 0 ? 0 : Math.min(layers, Math.ceil(clamped / perLayer - 1e-9));
  const inLayer = current ? clamped - (current - 1) * perLayer : 0;
  const pct = current ? Math.max(0, Math.min(100, (inLayer / perLayer) * 100)) : 0;
  const colors = layerColors();
  const colorOf = layer => colors[(layers - layer) % colors.length];
  return {
    hp: clamped, max, layers, current, pct,
    front: current ? colorOf(current) : "transparent",
    back: current > 1 ? colorOf(current - 1) : "transparent"
  };
}

function legendaryGauges(actor) {
  const res = actor.system.resources ?? {};
  const out = [];
  const add = (data, icon, label) => {
    const max = Number(data?.max) || 0;
    if (max <= 0) return;
    const value = Math.max(0, Math.min(max, Number(data?.value) || 0));
    out.push({value, max, icon, label});
  };
  add(res.legact, "fa-solid fa-infinity", "Legendary Actions");
  add(res.legres, "fa-solid fa-shield-halved", "Legendary Resistances");
  return out;
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
    <div class="bbl-portrait"><img src="${actor.img}" alt=""></div>
    <div class="bbl-main">
      <div class="bbl-name"${hideName ? ' style="visibility:hidden"' : ""}>${foundry.utils.escapeHTML(actor.name)}</div>
      <div class="bbl-bar">
        <div class="bbl-back"></div>
        <div class="bbl-chip"></div>
        <div class="bbl-fill"></div>
        <div class="bbl-pct"></div>
      </div>
      <div class="bbl-effects"></div>
    </div>
    <div class="bbl-side">
      <div class="bbl-count"></div>
      <div class="bbl-gauges"></div>
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
  const prevLayer = Number(root.dataset.layer ?? s.current);
  const layerChanged = prevLayer !== s.current;

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
  root.dataset.layer = String(s.current);

  root.querySelector(".bbl-pct").textContent = `${Math.round(s.pct)}%`;
  const count = root.querySelector(".bbl-count");
  count.textContent = s.current > 1 ? `×${s.current}` : "";

  const gauges = root.querySelector(".bbl-gauges");
  gauges.innerHTML = legendaryGauges(actor).map(g => `
    <div class="bbl-gauge" data-tooltip="${g.label}" style="--bbl-gauge:${(g.value / g.max) * 100}%">
      <i class="${g.icon}"></i>
      <span>${g.value}/${g.max}</span>
    </div>`).join("");

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
  const current = getLayers(actor);
  const value = await foundry.applications.api.DialogV2.prompt({
    window: {title: `Boss Bar Layers — ${actor.name}`},
    content: `<div class="form-group"><label>Number of HP layers</label>
      <input type="number" name="layers" min="1" step="1" value="${current}" autofocus></div>
      <p class="hint">The maximum HP is split evenly between the layers.</p>`,
    ok: {label: "Save", callback: (event, button) => Number(button.form.elements.layers.value)},
    rejectClose: false
  });
  if (!Number.isFinite(value) || value < 1) return;
  await actor.setFlag(MODULE_ID, "layers", Math.round(value));
  refreshAll();
}
