const MODULE_ID = "boss-bar-layers";
const NEGATIVE_EXCLUDED = new Set(["invisible", "transformed"]);

// damage/heal animation across bars
const DRAIN_MS_PER_BAR = 450;
const DRAIN_MAX_MS = 1600;
const CHIP_DELAY_MS = 150;
const CHIP_MS = 450;

// Brush/sketch fonts for the Thorns style (Google Fonts, SIL Open Font License), loaded on demand.
const THORN_FONTS = {
  "Rock Salt": "Rock+Salt",
  "Permanent Marker": "Permanent+Marker",
  "Cabin Sketch": "Cabin+Sketch:wght@700",
  "Fredericka the Great": "Fredericka+the+Great"
};
const thorns = () => game.settings.get(MODULE_ID, "style") === "thorns";

function loadFont(name) {
  const family = THORN_FONTS[name];
  if (!family || document.getElementById(`bbl-font-${family}`)) return;
  const link = document.createElement("link");
  link.id = `bbl-font-${family}`;
  link.rel = "stylesheet";
  link.href = `https://fonts.googleapis.com/css2?family=${family}&display=swap`;
  document.head.append(link);
}

// Per-boss bar state that survives Boss Bar re-renders (it re-renders on every scene update):
// uuid -> {shown: {remaining, pct}, animating: "intro" | "change" | null}
const live = new Map();

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
  game.settings.register(MODULE_ID, "style", {
    name: "Bar style",
    hint: "Layered: stacked bars with an ×N counter (MMO). Thorns: one thin bar split into segments, wrapped in black thorns, with the name in a brush font (dark fantasy).",
    scope: "world",
    config: true,
    type: String,
    choices: {layers: "Layered (MMO)", thorns: "Thorns (dark fantasy)"},
    default: "layers",
    onChange: () => { live.clear(); rerenderAll(); }
  });
  game.settings.register(MODULE_ID, "thornFont", {
    name: "Thorns style: name font",
    hint: "Font of the boss name in the Thorns style (Google Fonts).",
    scope: "world",
    config: true,
    type: String,
    choices: Object.fromEntries(Object.keys(THORN_FONTS).map(f => [f, f])),
    default: "Rock Salt",
    onChange: () => rerenderAll()
  });
  game.settings.register(MODULE_ID, "thornColor", {
    name: "Thorns style: bar color",
    scope: "world",
    config: true,
    type: String,
    default: "#ff5a1f",
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
  // last "reposition for everyone" request this client already applied
  game.settings.register(MODULE_ID, "appliedPositionNonce", {
    scope: "client",
    config: false,
    type: String,
    default: ""
  });
});

Hooks.once("ready", () => {
  const mod = game.modules.get(MODULE_ID);
  mod.api = {
    getHpPerLayer,
    setHpPerLayer: (actor, hp) => actor.setFlag(MODULE_ID, "hpPerLayer", Math.max(1, Math.round(hp))),
    refresh: refreshAll,
    replayIntro: () => { live.clear(); rerenderAll(); },
    setBarPositionForAll
  };
  applyPendingPosition(game.scenes.viewed);
});

Hooks.on("canvasReady", () => applyPendingPosition(game.scenes.viewed));

/* -------------------------------------------- */
/*  Hooks                                       */
/* -------------------------------------------- */

Hooks.on("renderBossBar", (app, element) => {
  if (!game.settings.get(MODULE_ID, "enabled")) return;
  const root = element instanceof HTMLElement ? element : element?.[0];
  if (!root) return;
  root.classList.add("bbl-enabled");
  const items = [...root.querySelectorAll(".bar-list-item[data-uuid]")];
  forgetMissing(items.map(li => li.dataset.uuid));
  for (const li of items) buildItem(li);
});

// A boss that leaves the Boss Bar plays its intro again the next time it is added
Hooks.on("updateScene", (scene, changes) => {
  if (scene !== game.scenes.viewed) return;
  if (foundry.utils.hasProperty(changes, `flags.${MODULE_ID}.barPosition`)) applyPendingPosition(scene);
  if (!foundry.utils.hasProperty(changes, "flags.bossbar")) return;
  forgetMissing((scene.getFlag("bossbar", "actors") ?? []).map(a => a.uuid));
});

function forgetMissing(present) {
  const keep = new Set(present);
  for (const uuid of live.keys()) if (!keep.has(uuid)) live.delete(uuid);
}

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
  if (thorns()) buildThorns(root, actor, hideName);
  else root.innerHTML = `
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

  const uuid = li.dataset.uuid;
  root._bblUuid = uuid;
  const prev = live.get(uuid);
  if (!prev) {
    // first time this boss shows up: play the intro
    const intro = Number(game.settings.get(MODULE_ID, "introSecondsPerBar")) > 0;
    live.set(uuid, {shown: null, animating: null});
    updateItem(li, actor, {instant: !intro, intro});
  } else {
    // Boss Bar re-rendered the window: pick up exactly where the bar was (even mid-animation)
    updateItem(li, actor, {resume: prev});
  }
}

function updateItem(li, actor, {instant = false, intro = false, resume = null} = {}) {
  const root = li.querySelector(".bbl-root");
  if (!root) return;
  const target = computeState(actor);
  root._bblLayers = target.layers;

  const effects = root.querySelector(".bbl-effects");
  const isThorns = root.classList.contains("bbl-thorns");
  if (isThorns && root._bblSegLayers !== target.layers) buildSegments_(root, actor, target.layers);
  effects.innerHTML = activeEffects(actor).map(e => isThorns ? `
    <div class="bbl-effect-tag${e.negative ? " negative" : ""}">
      <img src="${e.img}" alt=""><span>${foundry.utils.escapeHTML(e.name)}</span>
    </div>` : `
    <div class="bbl-effect${e.negative ? " negative" : ""}" data-tooltip="${foundry.utils.escapeHTML(e.name)}">
      <img src="${e.img}" alt="">
    </div>`).join("");

  const entry = live.get(root._bblUuid);
  const shown = resume?.shown ?? entry?.shown ?? null;
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
  if (resume) {
    // fresh DOM after a re-render: draw the last shown state first
    paintBar(root, shown.remaining);
    setFill(root, shown.pct);
    setChip(root, shown.pct);
  }
  const same = shown.remaining === target.remaining && Math.abs(shown.pct - target.pct) < 0.01;
  if (same) return;
  // an intro interrupted by a re-render keeps its intro pace; anything else animates as damage/heal
  const mode = (resume?.animating ?? entry?.animating) === "intro" ? "intro" : "change";
  animateTo(root, shown, target, mode);
}

/* -------------------------------------------- */
/*  Bar painting                                */
/* -------------------------------------------- */

// colors for the bar that is currently showing as "remaining" r (1 = bottom bar)
function paintBar(root, remaining) {
  if (root.classList.contains("bbl-thorns")) return paintSegments(root, remaining);
  const layers = root._bblLayers ?? 1;
  const colors = layerColors();
  const top = layers - remaining;
  root.style.setProperty("--bbl-front", remaining > 0 ? colors[((top % colors.length) + colors.length) % colors.length] : "transparent");
  root.querySelector(".bbl-back").style.background = remaining > 1 ? colors[(top + 1) % colors.length] : "transparent";
  root.querySelector(".bbl-count").textContent = layers > 1 ? `×${Math.max(0, remaining)}` : "";
  remember(root, {remaining});
}

function setFill(root, pct) {
  const fill = activePart(root, ".bbl-fill");
  if (fill) fill.style.width = `${pct}%`;
  const label = root.querySelector(".bbl-pct");
  if (label) label.textContent = `${Math.round(pct)}%`;
  remember(root, {pct});
}

/** In the Thorns style each layer is a segment; the parts being animated are the ones of the current segment. */
function activePart(root, selector) {
  if (!root.classList.contains("bbl-thorns")) return root.querySelector(selector);
  return root.querySelector(`.bbl-seg[data-i="${root._bblActive ?? 0}"] ${selector}`);
}

function remember(root, patch) {
  const entry = live.get(root._bblUuid);
  if (!entry) return;
  entry.shown = {...(entry.shown ?? {remaining: 0, pct: 0}), ...patch};
}

function setChip(root, pct, {ms = 0, delay = 0} = {}) {
  const chip = activePart(root, ".bbl-chip");
  if (!chip) return;
  chip.style.transition = ms ? `width ${ms}ms ease-in ${delay}ms` : "none";
  if (!ms) void chip.offsetWidth;
  chip.style.width = `${pct}%`;
}

/* -------------------------------------------- */
/*  Animation                                   */
/* -------------------------------------------- */

function cancelAnimation(root) {
  root._bblToken = null;
  const entry = live.get(root._bblUuid);
  if (entry) entry.animating = null;
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
  const entry = live.get(root._bblUuid);
  if (entry) entry.animating = mode;
  const segs = buildSegments(from, to);
  if (!segs.length) return finish();
  function finish() {
    if (root._bblToken === token && entry) entry.animating = null;
  }

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
  if (root._bblToken !== token) return;
  if (to.remaining <= 0) paintBar(root, 0);
  finish();
}

/* -------------------------------------------- */
/*  Thorns style                                */
/* -------------------------------------------- */

function buildThorns(root, actor, hideName) {
  const font = game.settings.get(MODULE_ID, "thornFont");
  loadFont(font);
  root.classList.add("bbl-thorns");
  root.style.setProperty("--bbl-thorn-font", `"${font}"`);
  // Brush-style title: each word's first letter a little bigger ("HIDDEN KING").
  const title = foundry.utils.escapeHTML(actor.name).split(/\s+/).map(w => `<span class="bbl-word"><span class="bbl-initial">${w.charAt(0)}</span>${w.slice(1)}</span>`).join(" ");
  root.innerHTML = `
    <div class="bbl-main">
      <div class="bbl-name"${hideName ? ' style="visibility:hidden"' : ""}>${title}</div>
      <div class="bbl-thornbar">
        <svg class="bbl-briars" aria-hidden="true"></svg>
        <div class="bbl-segs"></div>
      </div>
      <div class="bbl-effects"></div>
    </div>`;
  const bar = root.querySelector(".bbl-thornbar");
  const seed = [...actor.uuid].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
  const draw = () => drawBriars(root.querySelector(".bbl-briars"), bar.clientWidth, bar.clientHeight, seed);
  requestAnimationFrame(draw);
  new ResizeObserver(draw).observe(bar);
}

/** One segment per layer, left to right from the bottom layer; widths follow each layer's HP. */
function buildSegments_(root, actor, layers) {
  const per = getHpPerLayer(actor);
  const max = computeState(actor).max;
  const sizes = Array.from({length: layers}, (_, i) => (i === 0 ? max - (layers - 1) * per : per));
  root.querySelector(".bbl-segs").innerHTML = sizes.map((s, i) => `
    <div class="bbl-seg" data-i="${i}" style="flex-grow:${s}">
      <div class="bbl-chip"></div><div class="bbl-fill"></div>
    </div>`).join("");
  root._bblSegLayers = layers;
}

/** `remaining` layers left: the ones left of the current segment are full, the ones right of it empty. */
function paintSegments(root, remaining) {
  root.style.setProperty("--bbl-thorn-color", game.settings.get(MODULE_ID, "thornColor") || "#ff5a1f");
  const active = Math.max(0, remaining - 1);
  root._bblActive = active;
  for (const seg of root.querySelectorAll(".bbl-seg")) {
    const i = Number(seg.dataset.i);
    if (i === active && remaining > 0) continue;
    const w = (i < active) ? "100%" : "0%";
    seg.querySelector(".bbl-fill").style.width = w;
    const chip = seg.querySelector(".bbl-chip");
    chip.style.transition = "none";
    chip.style.width = w;
  }
  remember(root, {remaining});
}

/** Black scribbled briars along the bar, with thorns, and bigger spikes flaring out of both ends. */
function drawBriars(svg, w, h, seed) {
  if (!svg || w < 20) return;
  let s = seed || 1;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const pad = 40; // room for the end spikes
  const W = w + pad * 2, H = h + 36, top = 18, bottom = 18 + h;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("width", W);
  svg.setAttribute("height", H);
  svg.style.left = `-${pad}px`;
  svg.style.top = "-18px";
  const paths = [];
  // A wobbly line along y with thorns pointing away from the bar (dir -1 up, +1 down).
  const vine = (y, dir, jitter) => {
    let d = `M ${pad - 6} ${y + (rnd() - 0.5) * jitter}`;
    const thornsD = [];
    for (let x = pad - 6; x < pad + w + 6;) {
      x += 5 + rnd() * 9;
      const yy = y + (rnd() - 0.5) * jitter;
      d += ` L ${x.toFixed(1)} ${yy.toFixed(1)}`;
      if (rnd() < 0.32) {
        const len = 3 + rnd() * 9, lean = (rnd() - 0.5) * 10;
        thornsD.push(`M ${(x - 2).toFixed(1)} ${yy.toFixed(1)} L ${(x + lean).toFixed(1)} ${(yy + dir * len).toFixed(1)} L ${(x + 2).toFixed(1)} ${yy.toFixed(1)}`);
      }
    }
    paths.push(`<path d="${d}" class="bbl-vine"/>`);
    if (thornsD.length) paths.push(`<path d="${thornsD.join(" ")}" class="bbl-thorn"/>`);
  };
  vine(top - 1, -1, 3); vine(top + 1, -1, 4);
  vine(bottom + 1, 1, 3); vine(bottom - 1, 1, 4);
  // End caps: a burst of long spikes on each side.
  const burst = (cx, side) => {
    const cy = (top + bottom) / 2;
    const parts = [];
    for (let k = 0; k < 11; k++) {
      const ang = (side < 0 ? Math.PI : 0) + (rnd() - 0.5) * 2.4;
      const len = 12 + rnd() * 30;
      const ex = cx + Math.cos(ang) * len, ey = cy + Math.sin(ang) * len * 0.75;
      const nx = -Math.sin(ang) * 1.6, ny = Math.cos(ang) * 1.6;
      parts.push(`M ${(cx + nx).toFixed(1)} ${(cy + ny).toFixed(1)} L ${ex.toFixed(1)} ${ey.toFixed(1)} L ${(cx - nx).toFixed(1)} ${(cy - ny).toFixed(1)} Z`);
    }
    paths.push(`<path d="${parts.join(" ")}" class="bbl-spike"/>`);
  };
  burst(pad - 2, -1);
  burst(pad + w + 2, 1);
  svg.innerHTML = paths.join("");
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

/* -------------------------------------------- */
/*  Bar position for everyone                   */
/* -------------------------------------------- */

/**
 * GM: put the Boss Bar at the same relative spot on every player's screen.
 * Players can still drag it afterwards; this only re-applies when called again.
 * @param {object} [options]
 * @param {number} [options.top=0.15]   distance from the top, as a fraction of the screen height
 * @param {number} [options.width=0.6]  bar width, as a fraction of the screen width (always centered)
 * @param {Scene}  [options.scene]      defaults to the viewed scene
 */
async function setBarPositionForAll({top = 0.15, width = 0.6, scene = game.scenes.viewed} = {}) {
  if (!game.user.isGM) return ui.notifications.warn("Boss Bar Layers: only the GM can reposition the bar for everyone.");
  const data = {top: Number(top), width: Number(width), nonce: foundry.utils.randomID()};
  await scene.setFlag(MODULE_ID, "barPosition", data);
  applyPendingPosition(scene);
}

function applyPendingPosition(scene) {
  const data = scene?.getFlag?.(MODULE_ID, "barPosition");
  if (!data?.nonce || game.settings.get(MODULE_ID, "appliedPositionNonce") === data.nonce) return;
  const width = Math.round(window.innerWidth * Math.min(1, Math.max(0.1, Number(data.width) || 0.6)));
  const left = Math.round((window.innerWidth - width) / 2);
  const top = Math.round(window.innerHeight * Math.min(0.95, Math.max(0, Number(data.top) || 0)));
  const position = {width, left, top};
  try { game.settings.set("bossbar", "barPosition", position); } catch (err) { console.warn(MODULE_ID, err); }
  game.settings.set(MODULE_ID, "appliedPositionNonce", data.nonce);
  // move a bar that is already open
  const app = ui.bossBar ?? foundry.applications.instances.get("boss-bar");
  if (app?.rendered) app.setPosition(position);
  else {
    const el = document.getElementById("boss-bar");
    if (el) Object.assign(el.style, {left: `${left}px`, top: `${top}px`, width: `${width}px`});
  }
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
