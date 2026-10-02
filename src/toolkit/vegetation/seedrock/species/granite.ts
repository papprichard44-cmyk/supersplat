// @ts-nocheck
/* eslint-disable */
// Vendored from SeedRock (github.com/reed-soul/SeedRock), MIT licence, see ../THIRD_PARTY.md.
// Only the geometry generator is used; erosion and rendering are left out.

// Granite — coarse-grained igneous rock with blocky fractures and rounded edges.

/** @typedef {typeof granite} RockPreset */

export const granite = {
  id: 'granite',
  name: 'Granite',
  latin: 'Granitum',
  biome: 'temperate',
  color: 0x9a9590,
  roughness: 0.92,
  metalness: 0.02,
  textures: {
    albedo: 'granite_albedo.png',
    normal: 'granite_normal.png',
    roughness: 'granite_roughness.png',
    triplanarScale: 0.45,
  },
  shape: {
    radius: 1,
    detail: 4,
    squash: 0.88,
    stretch: [1.0, 1.05, 0.95],
    offset: [0, 0.15, 0],
  },
  noise: {
    scale: 1.8,
    offset: [0.4, 1.2, 0.7],
    octaves: 5,
    lacunarity: 2.1,
    gain: 0.48,
    amplitude: 0.28,
    microAmplitude: 0.035,
    ridged: true,
  },
  erosion: {
    thermal: { enabled: true, iterations: 10, talus: 0.035, rate: 0.3 },
    hydraulic: { enabled: true, droplets: 90, steps: 22, erosion: 0.2, deposit: 0.1 },
    edgeWear: { enabled: true, strength: 0.05 },
  },
  lod: {
    full: { detail: 4 },
    reduced: { detail: 2 },
    impostor: { detail: 1 },
  },

  // Semantic knobs → preset fields. UI shows the human name; set() writes the
  // model term. See src/species/controls.js for the bridge.
  controls: [
    {
      key: 'blockiness', name: 'Blockiness', group: 'shape',
      min: 0, max: 1, step: 0.05,
      // ridged noise → sharp angular blocks; smooth fBm → rounded mass.
      get: (s) => (s.noise.ridged ? 0.8 : 0.2),
      set: (s, v) => { s.noise.ridged = v >= 0.5; },
    },
    {
      key: 'grainRoughness', name: 'Grain roughness', group: 'surface',
      min: 0, max: 1, step: 0.01,
      // coarse-grained granite → high micro displacement.
      get: (s) => s.noise.microAmplitude ?? 0.035,
      set: (s, v) => { s.noise.microAmplitude = v; },
    },
    {
      key: 'fractureWeathering', name: 'Fracture weathering', group: 'erosion',
      min: 0, max: 1, step: 0.01,
      // how rounded the block edges become — maps to edgeWear strength.
      get: (s) => s.erosion.edgeWear?.strength ?? 0.05,
      set: (s, v) => { s.erosion.edgeWear.strength = v; },
    },
    {
      key: 'rainwear', name: 'Rainwear', group: 'erosion',
      min: 0, max: 1, step: 0.01,
      // hydraulic erosion intensity — grooves carved by runoff.
      get: (s) => Math.min(1, (s.erosion.hydraulic?.erosion ?? 0.2) / 0.4),
      set: (s, v) => { s.erosion.hydraulic.erosion = v * 0.4; },
    },
  ],
};
