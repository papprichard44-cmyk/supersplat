// @ts-nocheck
/* eslint-disable */
// Vendored from SeedRock (github.com/reed-soul/SeedRock), MIT licence, see ../THIRD_PARTY.md.
// Only the geometry generator is used; erosion and rendering are left out.

// Deterministic seeded RNG — same pattern as SeedThree (xmur3 + splitmix32).

function xmur3(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function () {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

export class Rng {
  /** @param {string|number} seed */
  constructor(seed) {
    const seedStr = typeof seed === 'number' ? `n:${seed}` : String(seed);
    this._state = xmur3(seedStr)() >>> 0;
  }

  /**
   * Fork an RNG that continues from this instance's current internal state.
   * Used so LOD levels can share one StructureGraph build, then each run
   * erosion from the same post-graph draw position without advancing the
   * parent stream.
   * @returns {Rng}
   */
  clone() {
    const fork = Object.create(Rng.prototype);
    fork._state = this._state;
    return fork;
  }

  next() {
    let z = (this._state = (this._state + 0x9e3779b9) | 0);
    z ^= z >>> 16; z = Math.imul(z, 0x21f0aaad);
    z ^= z >>> 15; z = Math.imul(z, 0x735a2d97);
    z ^= z >>> 15;
    return (z >>> 0) / 4294967296;
  }

  range(min, max) {
    return min + (max - min) * this.next();
  }

  vary(base, spread) {
    return base + (this.next() * 2 - 1) * spread;
  }

  int(min, max) {
    return Math.floor(this.range(min, max + 1));
  }

  chance(p) {
    return this.next() < p;
  }

  pick(arr) {
    return arr[Math.floor(this.next() * arr.length)];
  }
}
