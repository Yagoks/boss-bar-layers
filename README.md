# Boss Bar Layers

A Foundry VTT v13 add-on for [theripper93's Boss Bar](https://github.com/theripper93/Boss-Bar) that turns the bar into a layered, multi-bar boss health bar (Korean MMO style).

- HP split into bars of a fixed size (default 30 HP, per boss override), with an `×N` counter of remaining bars next to the bar
- Current layer drawn over the next layer's color, percentage in the middle
- Intro animation: bars fill up one by one when the boss appears (seconds per bar + total cap in settings)
- Damage and healing animate bar by bar, with a white trail showing the HP lost
- Active effects (red arrow on negative conditions)

## Styles
Boss Bar Layers adds two styles to Boss Bar's own style list: **Layered (Boss Bar Layers)** (id `bbl-layers`) and
**Thorns (Boss Bar Layers)** (id `bbl-thorns`). Pick them per boss in the Boss Bar configuration, next to Boss Bar's
own styles (Classic, Evil, Segmented…). Bosses with any other style keep Boss Bar's own look.
- **Layered (MMO):** stacked bars with an `×N` counter, the percentage in the middle and effect icons.
- **Thorns (dark fantasy):** the boss name in a brush font, touching a thin orange bar.
  - **Thorns:** the bar sits on a dense band of crossed black scribbles, and bundles of long strokes flare out of both ends.
  - **Segments:** each HP layer is a segment, and the bar drains from right to left.
  - **Effects:** listed below, with their names in capitals.
  - **Settings:** the name font and the bar color. The fonts come from Google Fonts, under the SIL Open Font License:
    Covered By Your Grace (the default), Sedgwick Ave Display, Reenie Beanie, Rock Salt or Permanent Marker.

### In macros
A boss on the bar is an entry `{uuid, style, hideName}` in the scene flag `bossbar.actors`. Set `style` to the style id:
```js
const bars = foundry.utils.deepClone(scene.getFlag("bossbar", "actors") ?? []);
bars.push({uuid: token.actor.uuid, style: "bbl-thorns", hideName: false}); // or "bbl-layers", "segmented", "evil", "default"…
await scene.setFlag("bossbar", "actors", bars);
```

## Usage
1. Install and enable **Bossbar** and **Boss Bar Layers**.
2. Add a boss to the scene with Boss Bar as usual.
3. GM: **right-click the boss bar** to set how many HP each bar holds for that boss (default in module settings).

## Install
Manifest URL: `https://github.com/Yagoks/boss-bar-layers/releases/latest/download/module.json`

## Same bar position for everyone (GM)
```js
// centered, 15% from the top of the screen, 60% of the screen wide
game.modules.get("boss-bar-layers").api.setBarPositionForAll({top: 0.15, width: 0.6});
```
Each connected player gets the bar at that spot on their own screen (and it is saved as their position). They can still move it afterwards.

