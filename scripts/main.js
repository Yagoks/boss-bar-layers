const MODULE_ID = "boss-bar-layers";
const NEGATIVE_EXCLUDED = new Set(["invisible", "transformed"]);

// damage/heal animation across bars
const DRAIN_MS_PER_BAR = 450;
const DRAIN_MAX_MS = 1600;
const CHIP_DELAY_MS = 150;
const CHIP_MS = 450;

// bosses whose intro fill already played on this page
const introPlayed = new Set();

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
  game.settings.register(MODULE_ID, "introSecondsPerBar", {
    name: "Intro: seconds per bar",
    hint: "When a boss bar appears it fills up bar by bar. Set to 0 to disable the intro.",
    scope: "world",
    config: true,
    type: Number,
    default: 2
  });
  game.settings.register(MODULE_ID, "introMaxSeconds", {
    name: "Intro: maximum total seconds",
    hint: "Bosses with many bars fill each bar faster so the whole intro never takes longer than this.",
    scope: "world",
    config: true,
    type: Number,
    default: 6
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
    refresh: refreshAll,
    replayIntro: () => { introPlayed.clear(); rerenderAll(); }
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
  return {hp: clamped, max, layers, remaining, pct};
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

  const intro = Number(game.settings.get(MODULE_ID, "introSecondsPerBar")) > 0 && !introPlayed.has(li.dataset.uuid);
  introPlayed.add(li.dataset.uuid);
  updateItem(li, actor, {instant: !intro, intro});
}

function updateItem(li, actor, {instant = false, intro = false} = {}) {
  const root = li.querySelector(".bbl-root");
  if (!root) return;
  const target = computeState(actor);
  root._bblLayers = target.layers;

  const effects = root.querySelector(".bbl-effects");
  effects.innerHTML = activeEffects(actor).map(e => `
    <div class="bbl-effect${e.negative ? " negative" : ""}" data-tooltip="${foundry.utils.escapeHTML(e.name)}">
      <img src="${e.img}" alt="">
    </div>`).join("");

  const shown = root._bblShown;
  if (instant || (!intro && !shown)) {
    cancelAnimation(root);
    paintBar(root, target.remaining);
    setFill(root, target.pct);
    setChip(root, target.pct);
    return;
  }
  if (intro) {
    paintBar(root, 1);
    setFill(root, 0);
    setChip(root, 0);
    animateTo(root, {remaining: 1, pct: 0}, target, "intro");
    return;
  }
  if (shown.remaining === target.remaining && Math.abs(shown.pct - target.pct) < 0.01) return;
  animateTo(root, shown, target, "change");
}

/* -------------------------------------------- */
/*  Bar painting                                */
/* -------------------------------------------- */

// colors for the bar that is currently showing as "remaining" r (1 = bottom bar)
function paintBar(root, remaining) {
  const layers = root._bblLayers ?? 1;
  const colors = layerColors();
  const top = layers - remaining;
  root.style.setProperty("--bbl-front", remaining > 0 ? colors[((top % colors.length) + colors.length) % colors.length] : "transparent");
  root.querySelector(".bbl-back").style.background = remaining > 1 ? colors[(top + 1) % colors.length] : "transparent";
  root.querySelector(".bbl-count").textContent = layers > 1 ? `×${Math.max(0, remaining)}` : "";
  root._bblShown = {...(root._bblShown ?? {pct: 0}), remaining};
}

function setFill(root, pct) {
  root.querySelector(".bbl-fill").style.width = `${pct}%`;
  root.querySelector(".bbl-pct").textContent = `${Math.round(pct)}%`;
  root._bblShown = {...(root._bblShown ?? {remaining: 0}), pct};
}

function setChip(root, pct, {ms = 0, delay = 0} = {}) {
  const chip = root.querySelector(".bbl-chip");
  chip.style.transition = ms ? `width ${ms}ms ease-in ${delay}ms` : "none";
  if (!ms) void chip.offsetWidth;
  chip.style.width = `${pct}%`;
}

/* -------------------------------------------- */
/*  Animation                                   */
/* -------------------------------------------- */

function cancelAnimation(root) {
  root._bblToken = null;
}

// Split a change into per-bar segments: [{remaining, from, to}]
function buildSegments(from, to) {
  const segs = [];
  if (to.remaining < from.remaining || (to.remaining === from.remaining && to.pct < from.pct)) {
    // losing HP: drain the current bar, then each bar below, down to the target
    if (from.remaining === to.remaining) return [{remaining: from.remaining, from: from.pct, to: to.pct}];
    segs.push({remaining: from.remaining, from: from.pct, to: 0});
    for (let r = from.remaining - 1; r > Math.max(to.remaining, 0); r--) segs.push({remaining: r, from: 100, to: 0});
    if (to.remaining > 0) segs.push({remaining: to.remaining, from: 100, to: to.pct});
  } else {
    // gaining HP (heal or intro): fill the current bar, then each bar above, up to the target
    const start = Math.max(from.remaining, 1);
    if (start === to.remaining) return [{remaining: start, from: from.remaining ? from.pct : 0, to: to.pct}];
    segs.push({remaining: start, from: from.remaining ? from.pct : 0, to: 100});
    for (let r = start + 1; r < to.remaining; r++) segs.push({remaining: r, from: 0, to: 100});
    segs.push({remaining: to.remaining, from: 0, to: to.pct});
  }
  return segs;
}

function tween(root, token, from, to, ms) {
  return new Promise(resolve => {
    const start = performance.now();
    const ease = t => 1 - Math.pow(1 - t, 2);
    const step = now => {
      if (root._bblToken !== token || !root.isConnected) return resolve(false);
      const t = ms > 0 ? Math.min(1, (now - start) / ms) : 1;
      setFill(root, from + (to - from) * ease(t));
      if (t < 1) requestAnimationFrame(step);
      else resolve(true);
    };
    requestAnimationFrame(step);
  });
}

async function animateTo(root, from, to, mode) {
  const token = Symbol("bbl");
  root._bblToken = token;
  const segs = buildSegments(from, to);
  if (!segs.length) return;

  let perSeg;
  if (mode === "intro") {
    const perBar = Math.max(0, Number(game.settings.get(MODULE_ID, "introSecondsPerBar")) || 0) * 1000;
    const maxTotal = Math.max(0, Number(game.settings.get(MODULE_ID, "introMaxSeconds")) || 0) * 1000;
    perSeg = maxTotal > 0 ? Math.min(perBar, maxTotal / segs.length) : perBar;
  } else {
    perSeg = Math.min(DRAIN_MS_PER_BAR, DRAIN_MAX_MS / segs.length);
  }

  for (const seg of segs) {
    if (root._bblToken !== token) return;
    paintBar(root, seg.remaining);
    const losing = seg.to < seg.from;
    // the white chip marks the HP being lost and trails behind the bar
    setChip(root, seg.from);
    // partial bars in an intro/heal scale their time to the distance travelled
    const ms = perSeg * Math.max(0.15, Math.abs(seg.to - seg.from) / 100);
    const ok = await tween(root, token, seg.from, seg.to, ms);
    if (!ok) return;
    setChip(root, seg.to, losing ? {ms: CHIP_MS, delay: CHIP_DELAY_MS} : {});
    if (losing && seg !== segs.at(-1)) await new Promise(r => setTimeout(r, 60));
  }
  if (to.remaining <= 0) paintBar(root, 0);
}

/* -------------------------------------------- */
/*  Refresh                                     */
/* -------------------------------------------- */

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
