/* Bugs STREAK's tests must catch (node harness/mutants.mjs streak). */
export default [
  {
    "name": "eight players on a small phone get the roomy layout (rows below the fold)",
    "file": "game.js",
    "find": "const density = v.players.length >= 7 ? ' dense xdense' : v.players.length >= 5 ? ' dense' : '';",
    "replace": "const density = '';",
    "checks": [
      "phone"
    ]
  },
  {
    "name": "a duplicate number never busts",
    "file": "game.js",
    "find": "if (line.nums.includes(card.v)) {",
    "replace": "if (false) {"
  },
  {
    "name": "the x2 modifier is ignored when a line is scored",
    "file": "game.js",
    "find": "if (l.mods.some(m=>m.mod==='x2')) s *= 2;",
    "replace": ""
  },
  {
    "name": "Flip Three deals two cards",
    "file": "game.js",
    "find": "G.work.unshift({t:'flip',pid:target},{t:'flip',pid:target},{t:'flip',pid:target});",
    "replace": "G.work.unshift({t:'flip',pid:target},{t:'flip',pid:target});"
  },
  {
    "name": "input is not frozen while forced flips land (the Flip 3 bug)",
    "file": "game.js",
    "find": "if (table) table.freeze(!G.pending && (G.work.length > 0 || !!G.ending));",
    "replace": "if (table) table.freeze(false);"
  }
];
