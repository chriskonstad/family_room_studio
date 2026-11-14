/*
 * Tests for fr-screen.js. Plain node, no browser, no simulator:
 *
 *     node sdk/fr-screen.test.mjs
 *
 * The load-bearing one is "an op outside the vocabulary throws". Everything else
 * about this design follows from the recorder being STRICTER than a real canvas:
 * if the Studio quietly accepted an op tvOS cannot draw, we would have rebuilt the
 * exact failure this project keeps hitting — a permissive test environment agreeing
 * with itself while the device disagrees.
 */
import assert from 'node:assert/strict';
import FRScreen from './fr-screen.js';

/* bounds() items carry metadata the geometry tests don't care about (the op's
 * index in the frame, and the alpha it was drawn at — both there so a layout
 * checker can reason about painter's order). Compare the geometry alone, so
 * adding another field never breaks a test about rectangles. */
const geom = (it) => it && { op: it.op, x: it.x, y: it.y, w: it.w, h: it.h,
                             ...(it.text != null ? { text: it.text } : {}) };

let passed = 0, failed = 0;
const out = [];
function test(name, fn) {
  try { fn(); passed++; out.push(`  ✓ ${name}`); }
  catch (e) { failed++; out.push(`  ✗ ${name}\n      ${e.message.split('\n')[0]}`); }
}
function section(n) { out.push(`\n${n}`); }

/* ------------------------------------------------------------ recorder --- */
section('recorder — the vocabulary IS the contract');

test('method calls record in order with their arguments', () => {
  const c = FRScreen.context();
  c.beginPath(); c.moveTo(1, 2); c.lineTo(3, 4); c.stroke();
  assert.deepEqual(c.ops(), [['beginPath'], ['moveTo', 1, 2], ['lineTo', 3, 4], ['stroke']]);
});

test('property sets record as ops, in sequence with drawing', () => {
  const c = FRScreen.context();
  c.fillStyle = '#abc';
  c.fillRect(0, 0, 5, 5);
  c.fillStyle = '#def';
  assert.deepEqual(c.ops(), [['=', 'fillStyle', '#abc'], ['fillRect', 0, 0, 5, 5], ['=', 'fillStyle', '#def']]);
  assert.equal(c.fillStyle, '#def', 'readable back, like a real context');
});

test('AN OP OUTSIDE THE VOCABULARY THROWS — the whole design rests on this', () => {
  const c = FRScreen.context();
  // Real canvas has these. tvOS cannot. The Studio must refuse them on a laptop
  // rather than letting them reach a TV as a blank rectangle.
  for (const missing of ['drawImage', 'createLinearGradient', 'ellipse', 'filter', 'putImageData']) {
    assert.equal(typeof c[missing], 'undefined', `${missing} must not exist`);
    assert.throws(() => c[missing](0, 0), TypeError, `${missing} should throw`);
  }
});

test('every advertised op actually exists', () => {
  const c = FRScreen.context();
  for (const m of FRScreen.METHODS) assert.equal(typeof c[m], 'function', `${m} missing`);
  for (const p of FRScreen.PROPS) {
    c[p] = 'x';
    assert.equal(c[p], 'x', `${p} not settable`);
  }
});

test('reset clears the frame', () => {
  const c = FRScreen.context();
  c.fillRect(0, 0, 1, 1);
  assert.equal(c.ops().length, 1);
  c.reset();
  assert.deepEqual(c.ops(), []);
});

test('texts() surfaces every drawn string — this is the leak check', () => {
  const c = FRScreen.context();
  c.fillText('Round 2', 0, 0);
  c.fillRect(0, 0, 1, 1);
  c.fillText('Ava: 7', 0, 0);
  assert.deepEqual(c.texts(), ['Round 2', 'Ava: 7']);
});

test('measureText is consistent rather than accurate, by design', () => {
  const a = FRScreen.context(), b = FRScreen.context();
  a.font = '48px sans-serif'; b.font = '48px sans-serif';
  assert.equal(a.measureText('hello').width, b.measureText('hello').width);
  assert.ok(a.measureText('hello').width > a.measureText('hi').width);
  a.font = '96px sans-serif';
  assert.ok(a.measureText('hi').width > b.measureText('hi').width, 'scales with font size');
});

/* -------------------------------------------------------------- replay --- */
section('replay — a frame is a value, applied in order');

function mockCanvas() {
  const log = [];
  const c = { log };
  for (const m of FRScreen.METHODS) c[m] = (...a) => log.push([m, ...a]);
  for (const p of FRScreen.PROPS) {
    Object.defineProperty(c, p, { set(v) { log.push(['=', p, v]); }, get() { return null; } });
  }
  return c;
}

test('replay reproduces the recorded frame exactly', () => {
  const c = FRScreen.context();
  c.fillStyle = '#123'; c.fillRect(1, 2, 3, 4); c.fillText('x', 5, 6);
  const target = mockCanvas();
  const n = FRScreen.replay(c.ops(), target);
  assert.equal(n, 3);
  assert.deepEqual(target.log, [['=', 'fillStyle', '#123'], ['fillRect', 1, 2, 3, 4], ['fillText', 'x', 5, 6]]);
});

test('a renderer missing roundRect falls back to rect instead of losing the shape', () => {
  const c = FRScreen.context();
  c.roundRect(1, 2, 30, 40, 8);
  const target = mockCanvas();
  delete target.roundRect;             // older canvas implementations
  FRScreen.replay(c.ops(), target);
  assert.deepEqual(target.log, [['rect', 1, 2, 30, 40]]);
});

test('an unknown op is skipped, not thrown, during replay', () => {
  const target = mockCanvas();
  FRScreen.replay([['notARealOp', 1], ['fillRect', 0, 0, 1, 1]], target);
  assert.deepEqual(target.log, [['fillRect', 0, 0, 1, 1]], 'later ops still draw');
});

/* -------------------------------------------------------------- bounds --- */
section('bounds — where a frame actually put things');

test('a plain rect reports itself', () => {
  const c = FRScreen.context();
  c.fillRect(10, 20, 30, 40);
  assert.deepEqual(FRScreen.bounds(c.ops()).items.map(geom), [{ op: 'fillRect', x: 10, y: 20, w: 30, h: 40 }]);
});

test('translate moves the box, and restore puts it back', () => {
  const c = FRScreen.context();
  c.save(); c.translate(100, 50); c.fillRect(0, 0, 10, 10); c.restore();
  c.fillRect(0, 0, 10, 10);
  const b = FRScreen.bounds(c.ops()).items.map(geom);
  assert.deepEqual(b[0], { op: 'fillRect', x: 100, y: 50, w: 10, h: 10 });
  assert.deepEqual(b[1], { op: 'fillRect', x: 0, y: 0, w: 10, h: 10 }, 'restore must undo the translate');
});

test('scale and rotate are accounted for', () => {
  const c = FRScreen.context();
  c.save(); c.scale(2, 3); c.fillRect(10, 10, 5, 5); c.restore();
  const s = geom(FRScreen.bounds(c.ops()).items[0]);
  assert.deepEqual(s, { op: 'fillRect', x: 20, y: 30, w: 10, h: 15 });

  const r = FRScreen.context();
  r.save(); r.rotate(Math.PI / 2); r.fillRect(0, 0, 10, 0); r.restore();
  const rb = geom(FRScreen.bounds(r.ops()).items[0]);
  assert.ok(Math.abs(rb.h - 10) < 1e-6, 'a horizontal bar rotated 90° becomes vertical');
});

test('text boxes respect align and baseline', () => {
  const mk = (align, baseline) => {
    const c = FRScreen.context();
    c.font = '40px sans-serif'; c.textAlign = align; c.textBaseline = baseline;
    c.fillText('abcde', 500, 300);          // width estimate = 5 * 40 * 0.55 = 110
    return geom(FRScreen.bounds(c.ops()).items[0]);
  };
  assert.equal(mk('left', 'top').x, 500);
  assert.equal(mk('center', 'top').x, 445);
  assert.equal(mk('right', 'top').x, 390);
  assert.equal(mk('left', 'top').y, 300);
  assert.equal(mk('left', 'middle').y, 280);
  assert.equal(mk('left', 'bottom').y, 260);
  assert.equal(mk('left', 'top').w, 110);
  assert.equal(mk('left', 'top').h, 40);
});

test('an arc reports its full circle, not its centre', () => {
  const c = FRScreen.context();
  c.beginPath(); c.arc(200, 200, 50, 0, Math.PI * 2); c.fill();
  assert.deepEqual(geom(FRScreen.bounds(c.ops()).items[0]), { op: 'fill', x: 150, y: 150, w: 100, h: 100 });
});

test('a stroke is fattened by its line width — a ring can overflow by half of it', () => {
  const c = FRScreen.context();
  c.lineWidth = 20;
  c.beginPath(); c.arc(100, 100, 50, 0, Math.PI * 2); c.stroke();
  const b = geom(FRScreen.bounds(c.ops()).items[0]);
  assert.equal(b.x, 40); assert.equal(b.w, 120);
});

test('a path accumulates across moveTo/lineTo until it is drawn', () => {
  const c = FRScreen.context();
  c.beginPath(); c.moveTo(10, 10); c.lineTo(90, 10); c.lineTo(90, 60); c.fill();
  assert.deepEqual(geom(FRScreen.bounds(c.ops()).items[0]), { op: 'fill', x: 10, y: 10, w: 80, h: 50 });
});

test('beginPath discards the previous path', () => {
  const c = FRScreen.context();
  c.beginPath(); c.moveTo(0, 0); c.lineTo(1000, 1000);
  c.beginPath(); c.moveTo(10, 10); c.lineTo(20, 20); c.fill();
  assert.deepEqual(geom(FRScreen.bounds(c.ops()).items[0]), { op: 'fill', x: 10, y: 10, w: 10, h: 10 });
});

test('union covers everything drawn', () => {
  const c = FRScreen.context();
  c.fillRect(100, 100, 10, 10);
  c.fillRect(0, 50, 10, 10);
  const u = FRScreen.bounds(c.ops()).union;
  assert.deepEqual(u, { x: 0, y: 50, w: 110, h: 60 });
});

test('an empty frame has no union rather than a bogus one', () => {
  assert.equal(FRScreen.bounds([]).union, null);
});

/* -------------------------------------------------------------- layout --- */
section('box — screens are not one shape');

test('safe area is subtracted (TV overscan would cut the edges off)', () => {
  const b = FRScreen.box({ width: 1920, height: 1080, safe: { top: 54, right: 96, bottom: 54, left: 96 } });
  assert.equal(b.x, 96); assert.equal(b.y, 54);
  assert.equal(b.w, 1728); assert.equal(b.h, 972);
  assert.equal(b.cx, 960); assert.equal(b.cy, 540);
  assert.equal(b.right, 1824); assert.equal(b.bottom, 1026);
});

test('no safe area is handled (an iPad or the Studio)', () => {
  const b = FRScreen.box({ width: 1024, height: 768 });
  assert.equal(b.x, 0); assert.equal(b.w, 1024); assert.equal(b.h, 768);
});

test('unit is the SHORTER edge, so 16:9 and 4:3 feel alike', () => {
  const tv = FRScreen.box({ width: 1920, height: 1080 });
  const pad = FRScreen.box({ width: 1024, height: 768 });
  assert.equal(tv.unit, 1080);
  assert.equal(pad.unit, 768);
  assert.equal(tv.u(0.1), 108);
  assert.ok(!tv.portrait);
});

test('portrait is detected (an iPad stood up)', () => {
  assert.ok(FRScreen.box({ width: 768, height: 1024 }).portrait);
});

test('rows and cols give evenly spaced centres', () => {
  const b = FRScreen.box({ width: 1000, height: 900 });
  assert.deepEqual(b.rows(3), [150, 450, 750]);
  assert.deepEqual(b.cols(2), [250, 750]);
  const padded = b.rows(2, 100);
  assert.equal(padded[0], 275);
});

test('fitFont shrinks long text to fit, and agrees with the bounds check', () => {
  const width = 600;
  for (const text of ['Hi', 'Filling the bowl…', 'A rather long headline indeed, really quite long']) {
    const size = FRScreen.fitFont(text, width, 120);
    const c = FRScreen.context();
    c.font = size + 'px sans-serif';
    c.textAlign = 'left'; c.textBaseline = 'top';
    c.fillText(text, 0, 0);
    const b = geom(FRScreen.bounds(c.ops()).items[0]);
    assert.ok(b.w <= width + 0.5, `"${text}" at ${size}px measured ${b.w}, over ${width}`);
  }
  assert.equal(FRScreen.fitFont('Hi', 600, 120), 120, 'short text keeps the ideal size');
  assert.ok(FRScreen.fitFont('x'.repeat(200), 600, 120) >= 10, 'never shrinks below the floor');
});

/* -------------------------------------------------------------- motion --- */
section('motion — a screen redraws from scratch, so movement needs a memory');

test('follow eases toward a target and settles exactly on it', () => {
  const m = FRScreen.motion();
  assert.equal(m.follow('s', 100, 0.2, 16), 100, 'first sight snaps — no slide in from zero');
  m.set('s', 0);
  let v = 0;
  for (let i = 0; i < 200; i++) v = m.follow('s', 100, 0.2, 16);
  assert.equal(v, 100, 'settles exactly, not asymptotically near');
});

test('follow is frame-rate independent', () => {
  const slow = FRScreen.motion(), fast = FRScreen.motion();
  slow.set('v', 0); fast.set('v', 0);
  let a = 0, b = 0;
  for (let t = 0; t < 320; t += 32) a = slow.follow('v', 100, 0.2, 32);   // 30fps
  for (let t = 0; t < 320; t += 16) b = fast.follow('v', 100, 0.2, 16);   // 60fps
  assert.ok(Math.abs(a - b) < 1.5, `30fps ${a.toFixed(2)} vs 60fps ${b.toFixed(2)} should agree`);
});

test('pulse fires on change and decays to zero', () => {
  const m = FRScreen.motion();
  assert.equal(m.pulse('p', 0, 0), 0, 'no pulse on first sight');
  const hit = m.pulse('p', 1, 1000);
  assert.ok(hit > 0.99, 'full strength at the moment of change');
  assert.ok(m.pulse('p', 1, 1225) < 0.6, 'decaying');
  assert.equal(m.pulse('p', 1, 2000), 0, 'and gone');
});

test('particles live, move and die', () => {
  const m = FRScreen.motion();
  const c = FRScreen.context();
  let seq = 1;
  m.burst(100, 100, { count: 10, life: 500, rng: () => (seq = (seq * 48271) % 2147483647) / 2147483647 });
  assert.equal(m.alive(), 10);
  m.particles(c, 16);
  assert.ok(c.ops().length > 10, 'drew them');
  for (let i = 0; i < 40; i++) m.particles(c, 16);
  assert.equal(m.alive(), 0, 'all expired');
});

test('particles restore alpha so they cannot bleed into the next draw', () => {
  const m = FRScreen.motion(), c = FRScreen.context();
  m.burst(0, 0, { count: 2 });
  m.particles(c, 16);
  assert.equal(c.globalAlpha, 1);
});

test('easings start at 0 and end at 1', () => {
  for (const [name, fn] of Object.entries(FRScreen.ease)) {
    assert.ok(Math.abs(fn(0)) < 1e-6, `${name}(0) should be 0, got ${fn(0)}`);
    assert.ok(Math.abs(fn(1) - 1) < 1e-6, `${name}(1) should be 1, got ${fn(1)}`);
  }
});

/* -------------------------------------------------------------------- */
console.log(out.join('\n'));
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
