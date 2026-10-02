// @ts-nocheck
/* eslint-disable */
// Vendored from SeedRock (github.com/reed-soul/SeedRock), MIT licence, see ../THIRD_PARTY.md.
// Only the geometry generator is used; erosion and rendering are left out.

// Crystal StructureGraph — radiating prism cluster as a nucleation pattern.
// Migrated byte-for-byte from forms/crystal.js for the legacy `fan` path.
//
// Nucleation modes (shape.nucleation):
//   • 'fan'    — uniform angular fan + jitter (legacy; golden-baseline path)
//   • 'worley' — Worley 1996 cellular feature points as nucleation sites
//                (geologically closer: crystals seed where supersaturation
//                first hits, not on a regular clock face)
//
// The mesher is mode-agnostic: it only consumes `shards[]`.
// LOD: nucleation pattern stays fixed; radial sides scale with detail
// (habit preserved at detail ≥ 3, then softens — same pattern as columnar).

import { ConeGeometry, Vector3, Matrix4, Quaternion } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { worleyDiskPoints } from '../core/worley';

const _up = new Vector3(0, 1, 0);

/**
 * Shared habit / size draws used by both nucleation modes so a species that
 * flips `nucleation` keeps the same facet count and shard budget.
 * @param {object} shape
 * @param {import('../../core/rng.js').Rng} rng
 */
function drawHabit(shape, rng) {
  const radius = shape.radius ?? 1;
  // 6-sided cones read as hexagonal prisms (quartz habit). 4-sided gives a
  // sharper "shard" — pick per-cluster for variety.
  const sides = rng.next() < 0.5 ? 6 : 4;
  const count = rng.int(5, 9);
  return { radius, sides, count };
}

/**
 * Central tall shard — identical across nucleation modes.
 * @param {number} radius
 * @param {number} sides
 * @param {import('../../core/rng.js').Rng} rng
 */
function buildCenterShard(radius, sides, rng) {
  const centerH = radius * rng.range(1.6, 2.1);
  const centerR = radius * rng.range(0.22, 0.3);
  return {
    h: centerH, r: centerR, sides,
    dir: [_up.x, _up.y, _up.z],
    pos: [0, 0, 0],
    isCenter: true,
  };
}

/**
 * Legacy fan nucleation: satellites on a roughly uniform angular ring + jitter.
 * Preserves the pre-Worley rng draw order byte-for-byte.
 */
function buildFanSatellites(radius, sides, count, rng) {
  const shards = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + rng.vary(0, 0.4);
    const h = radius * rng.range(0.8, 1.5);
    const r = radius * rng.range(0.16, 0.24);
    const tilt = rng.range(0.4, 1.0);
    const dir = [
      Math.sin(tilt) * Math.cos(a),
      Math.cos(tilt),
      Math.sin(tilt) * Math.sin(a),
    ];
    const placeR = radius * rng.range(0.15, 0.35);
    const pos = [Math.cos(a) * placeR, 0, Math.sin(a) * placeR];
    shards.push({ h, r, sides, dir, pos, isCenter: false });
  }
  return shards;
}

/**
 * Worley nucleation: satellite bases are cellular feature points in a disk.
 * Growth axes radiate from the cluster origin through each site (plus a small
 * tilt jitter), so denser Worley cells → tighter crystal clusters.
 *
 * @param {object} shape
 * @param {number} radius
 * @param {number} sides
 * @param {number} count
 * @param {import('../../core/rng.js').Rng} rng
 */
function buildWorleySatellites(shape, radius, sides, count, rng) {
  // Density 0 → coarse lattice (sparse sites); 1 → fine lattice (many candidates).
  const density = Math.min(1, Math.max(0, shape.nucleationDensity ?? 0.55));
  // cellSize relative to cluster radius: denser → smaller cells → more points.
  const cellSize = radius * (0.42 - density * 0.22);
  const diskR = radius * (0.28 + density * 0.12);
  // Keep the centre clear so satellites don't collide with the primary shard.
  const excludeR = radius * 0.08;

  const worleySeed = rng.int(1, 1_000_000);
  const candidates = worleyDiskPoints(worleySeed, {
    radius: diskR,
    cellSize,
    excludeRadius: excludeR,
  });

  // Prefer a well-spaced subset: walk nearest-first, reject points too close to
  // an already-accepted site (Poisson-ish thinning on the Worley set).
  const minSep = cellSize * 0.55;
  const minSep2 = minSep * minSep;
  const chosen = [];
  for (const p of candidates) {
    if (chosen.length >= count) break;
    let ok = true;
    for (const c of chosen) {
      const dx = p.x - c.x;
      const dz = p.z - c.z;
      if (dx * dx + dz * dz < minSep2) { ok = false; break; }
    }
    if (ok) chosen.push(p);
  }
  // If the lattice was too sparse (tiny radius / low density), fall back to
  // taking the nearest candidates without thinning so we still hit `count`.
  if (chosen.length < count) {
    for (const p of candidates) {
      if (chosen.length >= count) break;
      if (chosen.includes(p)) continue;
      chosen.push(p);
    }
  }

  const shards = [];
  for (let i = 0; i < count; i++) {
    const h = radius * rng.range(0.8, 1.5);
    const r = radius * rng.range(0.16, 0.24);
    const tiltJitter = rng.vary(0, 0.15);

    if (i < chosen.length) {
      const p = chosen[i];
      const dist = Math.max(1e-6, p.dist);
      // Base growth axis: from origin through the nucleation site, then tip
      // upward (crystal clusters grow out of a substrate).
      const outX = p.x / dist;
      const outZ = p.z / dist;
      const baseTilt = 0.55 + (dist / diskR) * 0.35; // outer sites lean more
      const tilt = Math.min(1.15, Math.max(0.35, baseTilt + tiltJitter));
      const dir = [
        Math.sin(tilt) * outX,
        Math.cos(tilt),
        Math.sin(tilt) * outZ,
      ];
      shards.push({
        h, r, sides, dir,
        pos: [p.x, 0, p.z],
        isCenter: false,
      });
    } else {
      // Extremely sparse lattice: pad with a tiny fan so shard count is stable.
      const a = (i / count) * Math.PI * 2;
      const tilt = 0.6 + tiltJitter;
      shards.push({
        h, r, sides,
        dir: [Math.sin(tilt) * Math.cos(a), Math.cos(tilt), Math.sin(tilt) * Math.sin(a)],
        pos: [Math.cos(a) * radius * 0.2, 0, Math.sin(a) * radius * 0.2],
        isCenter: false,
      });
    }
  }
  return shards;
}

/**
 * Build the crystal graph: a central tall shard + satellite shards.
 * Pure data — no geometry.
 *
 * @param {object} shape
 * @param {import('../../core/rng.js').Rng} rng
 * @returns {{ shards: Array, baseRadius: number, habit: string, nucleation: string, detail: number }}
 */
export function buildCrystalGraph(shape, rng) {
  const nucleation = shape.nucleation === 'worley' ? 'worley' : 'fan';
  const habit = shape.habit ?? 'radiating';
  const { radius, sides, count } = drawHabit(shape, rng);

  const shards = [buildCenterShard(radius, sides, rng)];
  if (nucleation === 'worley') {
    shards.push(...buildWorleySatellites(shape, radius, sides, count, rng));
  } else {
    shards.push(...buildFanSatellites(radius, sides, count, rng));
  }

  return {
    shards,
    baseRadius: radius,
    habit,
    nucleation,
    detail: shape.detail ?? 4,
  };
}

/**
 * Radial sides for a crystal shard at a given LOD detail.
 * At detail ≥ 3 the geological habit (`storedSides`, 4 or 6) is preserved —
 * that is the byte-identical full mesh. Lower LODs drop sides the same way
 * columnar drops radial segments: silhouette softens at distance, topology
 * (shard count / placement) stays fixed.
 */
export function crystalRadialSides(storedSides, detail) {
  if (detail >= 3) return storedSides;
  if (detail === 2) return Math.max(4, storedSides - 2); // 6→4, 4→4
  return 3;
}

const _dir = new Vector3();
const _pos = new Vector3();
const _quat = new Quaternion();
const _mat = new Matrix4();

/**
 * Mesh a crystal graph into a BufferGeometry. Mode-agnostic: ConeGeometry per
 * shard → translate → (rotate for satellites) → compose → mergeGeometries.
 * Lower details reduce radial sides while keeping the same nucleation pattern.
 *
 * @param {object} graph  from buildCrystalGraph
 * @param {{ detail?: number }} [opts]
 * @returns {import('three').BufferGeometry}
 */
export function meshCrystal(graph, opts = {}) {
  const detail = opts.detail ?? graph.detail;
  const geos = [];
  for (const s of graph.shards) {
    const sides = crystalRadialSides(s.sides, detail);
    const cone = new ConeGeometry(s.r, s.h, sides, 1);
    cone.translate(0, s.h / 2, 0);

    if (s.isCenter) {
      geos.push(cone);
    } else {
      _dir.set(s.dir[0], s.dir[1], s.dir[2]).normalize();
      _quat.setFromUnitVectors(_up, _dir);
      _pos.set(s.pos[0], s.pos[1], s.pos[2]);
      _mat.compose(_pos, _quat, new Vector3(1, 1, 1));
      cone.applyMatrix4(_mat);
      geos.push(cone);
    }
  }

  const geo = mergeGeometries(geos, false);
  geos.forEach((g) => g.dispose());
  return geo;
}
