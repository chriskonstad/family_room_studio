/*
 * intents.mjs — work out what a game will accept, without being told.
 *
 * A bot that can only press `<button data-act="…">` drives STREAK and nothing else: the
 * bundles use whatever convention their author liked — `data-c` on colour swatches,
 * `data-i` on plunger indices, a bare `#go`, `{type:'tap'}` instead of `{t:'tap'}`. Ten
 * games "stalled" on the first full run for exactly that reason, and none of them were
 * broken.
 *
 * So instead of insisting on a convention, read the game. Every intent a game can send
 * appears in its source as a `Table.send({...})` literal, and the dynamic parts of those
 * literals are filled from `dataset` values that are sitting in the rendered DOM. Between
 * the two you can reconstruct the real move set.
 *
 * This is static analysis of a string, not evaluation — nothing here runs game code.
 */

/**
 * Pull every `Table.send({...})` shape out of a bundle's source.
 *
 * @param {string} src the game's JavaScript
 * @returns {Array<{fixed:Object, dynamic:Array<string>}>}
 *   fixed   keys whose value is a literal ({ t: 'flip' })
 *   dynamic keys whose value is an expression we'll have to guess ({ id: b.dataset.id })
 */
export function discoverIntents(src) {
  const found = [];
  const re = /Table\.send\(\s*\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(src))) {
    const body = m[1];
    const fixed = {};
    const dynamic = [];
    // Split on commas that aren't inside quotes or parens — good enough for the
    // one-line object literals games actually write.
    let depth = 0, quote = null, part = '';
    const parts = [];
    for (const ch of body) {
      if (quote) { part += ch; if (ch === quote) quote = null; continue; }
      if (ch === '"' || ch === "'" || ch === '`') { quote = ch; part += ch; continue; }
      if (ch === '(' || ch === '[') depth++;
      if (ch === ')' || ch === ']') depth--;
      if (ch === ',' && depth === 0) { parts.push(part); part = ''; continue; }
      part += ch;
    }
    if (part.trim()) parts.push(part);

    for (const raw of parts) {
      const idx = raw.indexOf(':');
      if (idx === -1) continue;
      const key = raw.slice(0, idx).trim().replace(/['"]/g, '');
      const val = raw.slice(idx + 1).trim();
      if (!key) continue;
      const lit = val.match(/^['"]([^'"]*)['"]$/);
      if (lit) fixed[key] = lit[1];
      else if (/^-?\d+$/.test(val)) fixed[key] = Number(val);
      else if (val === 'true' || val === 'false') fixed[key] = val === 'true';
      else dynamic.push(key);
    }
    if (Object.keys(fixed).length || dynamic.length) found.push({ fixed, dynamic });
  }

  // De-duplicate by the literal part — the same intent is usually sent from two places.
  const seen = new Map();
  for (const f of found) {
    const key = JSON.stringify(f.fixed) + '|' + f.dynamic.sort().join(',');
    if (!seen.has(key)) seen.set(key, f);
  }
  return [...seen.values()];
}

/**
 * Values a dynamic key might plausibly take, harvested from what's on screen plus the
 * roster. A game's `{t:'target', id: …}` wants a player id; `{t:'press', i: …}` wants one
 * of the indices it just rendered as `data-i`.
 *
 * @param {Array<Object>} handles rendered elements, as {tag, attrs}
 * @param {Array<string>} playerIds
 */
export function candidateValues(handles, playerIds) {
  const out = new Set();
  for (const h of handles) {
    for (const [k, v] of Object.entries(h.attrs || {})) {
      if (!k.startsWith('data-')) continue;
      out.add(/^-?\d+$/.test(v) ? Number(v) : v);
    }
  }
  playerIds.forEach(id => out.add(id));
  [0, 1, 2, 3].forEach(n => out.add(n));
  return [...out];
}

/**
 * Build a concrete message for one discovered intent.
 * Dynamic keys are filled from `values`; a key we can't guess is simply omitted, which is
 * itself worth testing — a game must not crash on a malformed intent.
 */
export function buildMessage(intent, values, pick) {
  const msg = Object.assign({}, intent.fixed);
  for (const key of intent.dynamic) {
    if (!values.length) continue;
    msg[key] = pick(values);
  }
  return msg;
}
