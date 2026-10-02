// @ts-nocheck
/* eslint-disable */
// Vendored from SeedRock (github.com/reed-soul/SeedRock), MIT licence, see ../THIRD_PARTY.md.
// Only the geometry generator is used; erosion and rendering are left out.

// StructureGraph — a topology-first intermediate representation produced BEFORE
// meshing, so the same structure can be meshed at multiple LOD levels. The rock
// analogue of SeedThree's `stems[]`. See docs/structure-skeleton.md for the
// design contract.
//
// A StructureGraph is a tagged union: a `form` discriminator plus a form-specific
// payload (boulder | columnar | slate | crystal). Each form has a builder that
// produces the graph from a preset + rng (pure data, no triangles) and a mesher
// that turns the graph into a BufferGeometry. builders use the SAME rng draw
// order as the legacy form factories did, so (species, seed) output is identical
// at the build-time detail.

import { buildBoulderGraph, meshBoulder } from './boulder';
import { buildColumnarGraph, meshColumnar } from './columnar';
import { buildSlateGraph, meshSlate } from './slate';
import { buildCrystalGraph, meshCrystal } from './crystal';

/**
 * Build the StructureGraph for a preset. Dispatches on `preset.shape.form`.
 *
 * @param {object} preset
 * @param {import('../../core/rng.js').Rng} rng   threaded RNG (draw order = legacy)
 * @param {import('../../core/noise.js').Noise3D} [noise]  seeded noise (boulder)
 * @returns {object} a StructureGraph (`{ form, seed, species, <formPayload> }`)
 */
export function buildStructureGraph(preset, rng, noise) {
  const form = preset.shape.form ?? 'boulder';
  const base = { form, species: preset.id };

  if (form === 'columnar') {
    return { ...base, columnar: buildColumnarGraph(preset.shape, noise, rng) };
  }
  if (form === 'slate') {
    return { ...base, slate: buildSlateGraph(preset.shape, rng) };
  }
  if (form === 'crystal') {
    return { ...base, crystal: buildCrystalGraph(preset.shape, rng) };
  }
  // default: boulder — needs noise + noiseParams, same as mesh.js's dispatch.
  return {
    ...base,
    boulder: buildBoulderGraph(preset.shape, preset.noise, noise, rng),
  };
}

/**
 * Mesh a StructureGraph into a BufferGeometry at the requested detail / style.
 * Dispatches on `graph.form`. Pure geometry — caller handles normals/erosion.
 * The same graph may be meshed repeatedly at different details (LOD reuse).
 *
 * @param {object} graph  from buildStructureGraph
 * @param {{ detail?: number, style?: string }} [opts]
 * @returns {import('three').BufferGeometry}
 */
export function meshStructureGraph(graph, opts = {}) {
  if (graph.form === 'boulder')  return meshBoulder(graph.boulder, opts);
  if (graph.form === 'columnar') return meshColumnar(graph.columnar, opts);
  if (graph.form === 'slate')    return meshSlate(graph.slate, opts);
  if (graph.form === 'crystal')  return meshCrystal(graph.crystal, opts);
  throw new Error(`[structure] unknown graph form "${graph.form}"`);
}

/**
 * Default (build-time) detail stored on a StructureGraph payload.
 * @param {object} graph
 * @returns {number}
 */
export function graphDetail(graph) {
  const payload = graph[graph.form];
  return payload?.detail ?? 4;
}
