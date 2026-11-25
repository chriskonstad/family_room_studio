/*
 * The phone, with no TV in the room, at the tables a played game rarely reaches —
 * drawn and held to the same layout rules as every played screen (harness/phone.mjs).
 *
 * These are the TV's own hand-written frames (screen-states.mjs: eight seats, the
 * longest names and hand names, a three-way all-in, the end), with the screen switched
 * off — because without a TV, every one of those tables is on every phone instead.
 * Each is seen by Christopher (p1), holding a pair of kings.
 */
import TV from './screen-states.mjs';

const HOLE = { t: 'hole', cards: [{ r: 13, s: 0 }, { r: 13, s: 1 }] };

export default TV
  .filter(entry => entry.payload && entry.payload.s && entry.payload.s.order.includes('p1'))
  .map(entry => {
    const s = Object.assign({}, entry.payload.s, { screen: 0 });
    return {
      name: entry.name + ', no TV',
      as: 'p1',
      players: s.order.length,
      messages: [{ t: 'state', s }, Object.assign({ hand: s.hand }, HOLE)]
    };
  });
