// @ts-nocheck
/* eslint-disable */
// Vendored from SeedRock (github.com/reed-soul/SeedRock), MIT licence, see ../THIRD_PARTY.md.
// Only the geometry generator is used; erosion and rendering are left out.

// Boulder StructureGraph — displacement-field graph.
//
// This is the dominant form (10 of 15 species). Unlike the structural forms,
// boulder gets its silhouette from radial noise displacement. The graph stores
// the FIELD (origin + stretch/squash + noise params + live sampler), not a
// baked vertex list, so the same structure can be meshed at any icosahedron
// `detail` without rebuilding topology or re-drawing rng:
//
//   build once → mesh(detail=4) / mesh(detail=2) / mesh(detail=1)
//
// At the build-time detail, output is byte-identical to the legacy
// buildBoulder + displaceRadial path (same formula, same origin draws).
//
// Migrated from the node-precompute variant; see docs/structure-skeleton.md.

import { IcosahedronGeometry, Vector3 } from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const _v = new Vector3();
const _origin = new Vector3();

/**
 * Build the boulder graph: pure displacement-field data (no triangles).
 *
 * rng draw order matches the legacy factory: three `vary` calls for origin.
 * Noise sampling is deferred to the mesher so LOD can re-evaluate the same
 * field at a different vertex density.
 *
 * @param {object} shape
 * @param {object} p  noise params
 * @param {import('../../core/noise.js').Noise3D} noise
 * @param {import('../../core/rng.js').Rng} rng
 */
export function buildBoulderGraph(shape, p, noise, rng) {
  const ox = rng.vary(shape.offset?.[0] ?? 0, 0.08);
  const oy = rng.vary(shape.offset?.[1] ?? 0, 0.05);
  const oz = rng.vary(shape.offset?.[2] ?? 0, 0.08);

  return {
    origin: [ox, oy, oz],
    baseRadius: shape.radius,
    stretch: shape.stretch ?? [1, 1, 1],
    squash: shape.squash,
    detail: shape.detail,
    field: {
      scale: p.scale,
      offset: [p.offset[0], p.offset[1], p.offset[2]],
      octaves: p.octaves,
      lacunarity: p.lacunarity,
      gain: p.gain,
      amplitude: p.amplitude,
      microAmplitude: p.microAmplitude ?? 0.04,
      ridged: !!p.ridged,
    },
    // Live sampler from the (species, seed) noise table. Kept on the graph so
    // remeshing at another detail does not need to reconstruct the permutation.
    noise,
  };
}

/**
 * Sample the boulder displacement field at a single base-sphere vertex.
 * Shared by meshBoulder and the forms/ shim so the formula stays one place.
 *
 * @param {import('three').Vector3} out  mutated; base position relative to origin in, displaced world position out
 * @param {object} field
 * @param {import('../../core/noise.js').Noise3D} noise
 * @param {[number, number, number]} stretch
 * @param {number} [squash]
 * @param {import('three').Vector3} origin
 */
export function displaceVertex(out, field, noise, stretch, squash, origin) {
  out.sub(origin);
  const len = out.length();
  if (len < 1e-12) {
    out.copy(origin);
    return out;
  }
  const dirX = out.x / len;
  const dirY = out.y / len;
  const dirZ = out.z / len;

  const nx = dirX * field.scale + field.offset[0];
  const ny = dirY * field.scale + field.offset[1];
  const nz = dirZ * field.scale + field.offset[2];

  let displacement = field.ridged
    ? noise.ridged(nx, ny, nz, field.octaves, field.lacunarity, field.gain) * 2 - 1
    : noise.fbm(nx, ny, nz, field.octaves, field.lacunarity, field.gain);
  displacement *= field.amplitude;
  displacement += noise.noise(nx * 2.7, ny * 2.7, nz * 2.7) * field.microAmplitude;

  const r = len + displacement;
  out.set(dirX * r, dirY * r, dirZ * r);
  out.x *= stretch[0];
  out.y *= stretch[1];
  out.z *= stretch[2];
  if (squash) out.y *= squash;
  out.add(origin);
  return out;
}

/**
 * Mesh a boulder graph at the requested icosahedron detail. Same field, any
 * resolution — the LOD contract StructureGraph exists for.
 *
 * @param {object} graph  from buildBoulderGraph
 * @param {{ detail?: number }} [opts]
 * @returns {import('three').BufferGeometry}
 */
export function meshBoulder(graph, opts = {}) {
  const detail = opts.detail ?? graph.detail;
  const base = mergeVertices(new IcosahedronGeometry(graph.baseRadius, detail));
  const pos = base.attributes.position;
  const { field, noise, stretch, squash } = graph;
  _origin.set(graph.origin[0], graph.origin[1], graph.origin[2]);

  for (let i = 0; i < pos.count; i++) {
    _v.set(pos.getX(i), pos.getY(i), pos.getZ(i));
    displaceVertex(_v, field, noise, stretch, squash, _origin);
    pos.setXYZ(i, _v.x, _v.y, _v.z);
  }
  pos.needsUpdate = true;
  // Legacy path did NOT recompute normals after displacement (mesh.js calls
  // computeVertexNormals after the form returns); leave base normals here.
  return base;
}
