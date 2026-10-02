// @ts-nocheck
/* eslint-disable */
// Vendored from SeedRock (github.com/reed-soul/SeedRock), MIT licence, see ../THIRD_PARTY.md.
// Only the geometry generator is used; erosion and rendering are left out.

// Worley / cellular feature points — Worley, S. (1996), SIGGRAPH '96.
//
// Classic Worley noise evaluates F1/F2 distances to the nearest feature points
// of a jittered lattice. SeedRock needs the *feature points themselves* as
// crystal nucleation sites, so this module exposes the lattice points rather
// than a distance field. Same seeded-hash idea as `makeNoise3D`: one
// deterministic jitter per integer cell, no floating RNG stream.
//
// See docs/generation-design.md §4 (crystal) and docs/structure-skeleton.md.

/**
 * Integer hash → uint32. Splitmix-ish mix of (ix, iy, seed).
 * @param {number} ix
 * @param {number} iy
 * @param {number} seed
 */
function hash2(ix, iy, seed) {
  let h = Math.imul(ix | 0, 374761393) ^ Math.imul(iy | 0, 668265263) ^ (seed >>> 0);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * Feature-point jitter in [0, 1) for lattice cell (ix, iy).
 * Two independent channels so X/Y are uncorrelated.
 * @param {number} ix
 * @param {number} iy
 * @param {number} seed
 * @returns {[number, number]}
 */
export function cellJitter(ix, iy, seed) {
  const hx = hash2(ix, iy, seed);
  const hy = hash2(ix, iy, seed ^ 0x9e3779b9);
  return [hx / 4294967296, hy / 4294967296];
}

/**
 * Collect Worley feature points whose cells overlap an axis-aligned box.
 * One point per integer cell, jittered inside the cell.
 *
 * @param {number} seed  permutation seed (from Rng)
 * @param {{ minX: number, maxX: number, minZ: number, maxZ: number, cellSize: number }} opts
 *   Uses XZ naming to match the crystal ground plane (Y is up).
 * @returns {Array<[number, number]>}  [x, z] world positions
 */
export function worleyFeaturePointsXZ(seed, opts) {
  const { minX, maxX, minZ, maxZ, cellSize } = opts;
  if (!(cellSize > 0)) throw new Error('[worley] cellSize must be > 0');

  const i0 = Math.floor(minX / cellSize) - 1;
  const i1 = Math.floor(maxX / cellSize) + 1;
  const j0 = Math.floor(minZ / cellSize) - 1;
  const j1 = Math.floor(maxZ / cellSize) + 1;

  const points = [];
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const [jx, jz] = cellJitter(i, j, seed);
      const x = (i + jx) * cellSize;
      const z = (j + jz) * cellSize;
      if (x < minX || x > maxX || z < minZ || z > maxZ) continue;
      points.push([x, z]);
    }
  }
  return points;
}

/**
 * Worley feature points inside a disk on the XZ plane, sorted nearest-first
 * from the origin. Used by crystal nucleation to pick satellite sites.
 *
 * @param {number} seed
 * @param {{ radius: number, cellSize: number, excludeRadius?: number }} opts
 * @returns {Array<{ x: number, z: number, dist: number }>}
 */
export function worleyDiskPoints(seed, opts) {
  const radius = opts.radius;
  const cellSize = opts.cellSize;
  const excludeRadius = opts.excludeRadius ?? 0;
  const r2 = radius * radius;
  const ex2 = excludeRadius * excludeRadius;

  const raw = worleyFeaturePointsXZ(seed, {
    minX: -radius,
    maxX: radius,
    minZ: -radius,
    maxZ: radius,
    cellSize,
  });

  const inside = [];
  for (const [x, z] of raw) {
    const d2 = x * x + z * z;
    if (d2 > r2 || d2 < ex2) continue;
    inside.push({ x, z, dist: Math.sqrt(d2) });
  }
  inside.sort((a, b) => a.dist - b.dist);
  return inside;
}
