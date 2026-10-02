// @ts-nocheck
/* eslint-disable */
// Vendored from SeedRock (github.com/reed-soul/SeedRock), MIT licence, see ../THIRD_PARTY.md.
// Only the geometry generator is used; erosion and rendering are left out.

// Slate StructureGraph — foliated plate as a layer-stack topology.
// Migrated byte-for-byte from forms/slate.js: buildSlateGraph captures the per-
// layer parameters (the rng draw sequence), meshSlate recreates the BoxGeometry
// stack from them. Same rng order, same merge order → identical vertex output
// at the build-time detail.
//
// LOD: slab footprints stay fixed; per-slab segment counts scale with detail.

import { BoxGeometry, Vector3, Matrix4 } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Build the slate graph: a stack of foliated slabs. Pure data — no geometry.
 * rng draw order is identical to the legacy buildSlate() so output matches.
 *
 * @param {object} shape
 * @param {import('../../core/rng.js').Rng} rng
 * @returns {{ slabs: Array<{ w: number, d: number, thick: number, segW: number, segD: number, ox: number, oz: number, oy: number }>, baseRadius: number, detail: number }}
 */
export function buildSlateGraph(shape, rng) {
  const radius = shape.radius ?? 1;
  // Slate is flat and wide: thickness ≈ 30% of footprint.
  const width = radius * rng.range(1.8, 2.4);
  const depth = radius * rng.range(1.6, 2.2);
  const slabThick = radius * rng.range(0.12, 0.18);
  const layers = rng.int(3, 5);

  const slabs = [];
  for (let i = 0; i < layers; i++) {
    // Each layer slightly smaller and offset — reads as weathered sheet edges.
    // The rng draw order here MUST match legacy buildSlate exactly: shrink is
    // deterministic (no rng), then w/d each draw once, then ox/oz each vary once.
    const shrink = 1 - i * 0.08;
    const w = width * shrink * rng.range(0.92, 1.04);
    const d = depth * shrink * rng.range(0.92, 1.04);
    const segW = Math.max(2, Math.round(6 * shrink));
    const segD = Math.max(2, Math.round(6 * shrink));
    const ox = rng.vary(0, radius * 0.08);
    const oz = rng.vary(0, radius * 0.08);
    const oy = i * slabThick * 0.95;
    slabs.push({ w, d, thick: slabThick, segW, segD, ox, oz, oy });
  }
  return { slabs, baseRadius: radius, detail: shape.detail ?? 4 };
}

/**
 * Scale a stored slab segment count for a target LOD detail.
 * At graph.detail the factor is 1 → byte-identical to the legacy mesh.
 */
export function slateSegmentsForDetail(storedSeg, detail, graphDetail) {
  const factor = Math.max(1, detail) / Math.max(1, graphDetail);
  return Math.max(1, Math.round(storedSeg * factor));
}

const _pos = new Vector3();
const _mat = new Matrix4();

/**
 * Mesh a slate graph into a BufferGeometry. Recreates the legacy stack exactly
 * at full detail: BoxGeometry per slab → translate → mergeGeometries →
 * re-center on XZ. Lower details reduce per-slab segments.
 *
 * @param {object} graph  from buildSlateGraph
 * @param {{ detail?: number }} [opts]
 * @returns {import('three').BufferGeometry}
 */
export function meshSlate(graph, opts = {}) {
  const detail = opts.detail ?? graph.detail;
  const graphDetail = graph.detail ?? 4;
  const geos = [];
  for (const s of graph.slabs) {
    const segW = slateSegmentsForDetail(s.segW, detail, graphDetail);
    const segD = slateSegmentsForDetail(s.segD, detail, graphDetail);
    const slab = new BoxGeometry(s.w, s.thick, s.d, segW, 1, segD);
    _pos.set(s.ox, s.oy, s.oz);
    _mat.makeTranslation(_pos.x, _pos.y, _pos.z);
    slab.applyMatrix4(_mat);
    geos.push(slab);
  }
  const geo = mergeGeometries(geos, false);
  geos.forEach((g) => g.dispose());
  // Re-centre on XZ; keep base at y=0 for downstream seating.
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  const cx = (bb.min.x + bb.max.x) / 2;
  const cz = (bb.min.z + bb.max.z) / 2;
  geo.translate(-cx, 0, -cz);
  return geo;
}
