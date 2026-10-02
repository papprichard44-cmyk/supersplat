// @ts-nocheck
/* eslint-disable */
// Vendored from SeedRock (github.com/reed-soul/SeedRock), MIT licence, see ../THIRD_PARTY.md.
// Only the geometry generator is used; erosion and rendering are left out.

// Columnar StructureGraph — basalt columnar jointing as a joint-set topology.
// Migrated byte-for-byte from forms/columnar.js: buildColumnarGraph captures the
// per-column parameters (hex close-pack centres + jitter + height/tilt/radius),
// meshColumnar recreates the CylinderGeometry colonnade. Same rng order, same
// merge order → identical vertex output at the build-time detail.
//
// LOD: the same joint set remeshes at lower radial resolution without rebuilding
// topology — StructureGraph's reason to exist.

import { CylinderGeometry, Vector3, Matrix4, Quaternion, Euler } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Build the columnar graph: a hex close-pack of joint columns. Pure data.
 * rng draw order matches legacy buildColumnar() exactly.
 *
 * @param {object} shape
 * @param {object} _noise  (unused for the primary form — columnar is structural)
 * @param {import('../../core/rng.js').Rng} rng
 * @returns {{ columns: Array<{ x: number, z: number, h: number, r: number, euler: [number,number,number] }>, baseRadius: number, detail: number }}
 */
export function buildColumnarGraph(shape, _noise, rng) {
  const radius = shape.radius ?? 1;
  // Column count scales with the rock's overall radius; tighter packing for
  // bigger clusters. 5–9 is the range that reads as a real outcrop.
  const count = Math.max(4, Math.round(4 + radius * 3) + rng.int(0, 2));
  const colRadius = radius * rng.range(0.18, 0.26);
  const heightBase = radius * rng.range(1.4, 2.2);

  // Hexagonal close-pack centres: ring + centre, then jittered.
  const centres = [[0, 0]];
  const ringN = 6;
  for (let i = 0; i < ringN; i++) {
    const a = (i / ringN) * Math.PI * 2;
    centres.push([Math.cos(a) * colRadius * 1.7, Math.sin(a) * colRadius * 1.7]);
  }
  // Outer ring for bigger clusters
  if (count > 7) {
    const ringN2 = 6;
    for (let i = 0; i < ringN2; i++) {
      const a = (i / ringN2) * Math.PI * 2 + Math.PI / 6;
      centres.push([Math.cos(a) * colRadius * 3.3, Math.sin(a) * colRadius * 3.3]);
    }
  }

  const columns = [];
  for (let c = 0; c < Math.min(count, centres.length); c++) {
    const [cx, cz] = centres[c];
    const jitter = rng.range(0, colRadius * 0.3);
    const ja = rng.range(0, Math.PI * 2);
    const x = cx + Math.cos(ja) * jitter;
    const z = cz + Math.sin(ja) * jitter;

    // Each column: own height (fractured tops), slight tilt, own radius.
    const h = heightBase * rng.range(0.65, 1.15);
    const r = colRadius * rng.range(0.85, 1.1);
    // Slight tilt — real colonnades lean. Stored as the Euler angles the legacy
    // factory applied (x, y, z order). mesher reconstructs the same Quaternion.
    const ex = rng.vary(0, 0.12);
    const ey = rng.range(0, Math.PI * 2);
    const ez = rng.vary(0, 0.12);
    columns.push({ x, z, h, r, euler: [ex, ey, ez] });
  }
  return { columns, baseRadius: radius, detail: shape.detail ?? 4 };
}

/**
 * Radial segments for a columnar mesh at a given LOD detail.
 * detail ≥ 3 keeps the hex (6) silhouette of the legacy full mesh.
 */
export function columnarRadialSegments(detail) {
  if (detail >= 3) return 6;
  if (detail === 2) return 5;
  return 4;
}

const _pos = new Vector3();
const _quat = new Quaternion();
const _eul = new Euler();
const _mat = new Matrix4();

/**
 * Mesh a columnar graph into a BufferGeometry. Recreates the legacy colonnade
 * at full detail: 6-sided (hex) CylinderGeometry per column → translate to base →
 * Euler tilt → compose → applyMatrix4 → mergeGeometries. Lower details drop
 * radial segments while keeping the same joint centres.
 *
 * @param {object} graph  from buildColumnarGraph
 * @param {{ detail?: number }} [opts]
 * @returns {import('three').BufferGeometry}
 */
export function meshColumnar(graph, opts = {}) {
  const detail = opts.detail ?? graph.detail;
  const radial = columnarRadialSegments(detail);
  const geos = [];
  for (const col of graph.columns) {
    // Top radius tapers slightly (r*0.85) like the legacy.
    const colGeo = new CylinderGeometry(col.r * 0.85, col.r, col.h, radial, 1);
    // Origin at base; recenter so the cylinder sits with base at y=0.
    colGeo.translate(0, col.h / 2, 0);

    // Slight tilt — real colonnades lean. Same Euler order as the legacy factory.
    _eul.set(col.euler[0], col.euler[1], col.euler[2]);
    _quat.setFromEuler(_eul);
    _pos.set(col.x, 0, col.z);
    _mat.compose(_pos, _quat, new Vector3(1, 1, 1));
    colGeo.applyMatrix4(_mat);
    geos.push(colGeo);
  }

  const geo = mergeGeometries(geos, false);
  geos.forEach((g) => g.dispose());
  // Origin near base centre — downstream seating uses bounding box min.y.
  return geo;
}
