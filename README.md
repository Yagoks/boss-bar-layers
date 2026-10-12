# Boss Bar Layers

A Foundry VTT v13 add-on for [theripper93's Boss Bar](https://github.com/theripper93/Boss-Bar) that turns the bar into a layered, multi-bar boss health bar (Korean MMO style).

- HP split into bars of a fixed size (default 30 HP, per boss override), with an `×N` counter of remaining bars next to the bar
- Current layer drawn over the next layer's color, percentage in the middle
- Intro animation: bars fill up one by one when the boss appears (seconds per bar + total cap in settings)
- Damage and healing animate bar by bar, with a white trail showing the HP lost
- Active effects (red arrow on negative conditions)

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

