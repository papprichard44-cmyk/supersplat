// @ts-nocheck
/* eslint-disable */
// Vendored from SeedRock (github.com/reed-soul/SeedRock), MIT licence, see ../THIRD_PARTY.md.
// Only the geometry generator is used; erosion and rendering are left out.

// Glacial erratic — frost-fractured boulder, blue-gray ice-scoured surfaces.

export const glacial = {
  id: 'glacial',
  name: 'Glacial Erratic',
  latin: 'Erraticum glacialem',
  biome: 'alpine',
  color: 0x8a939c,
  roughness: 0.86,
  metalness: 0.03,
  textures: {
    albedo: 'glacial_albedo.png',
    normal: 'glacial_normal.png',
    roughness: 'glacial_roughness.png',
    triplanarScale: 0.46,
  },
  shape: {
    radius: 1.05,
    detail: 4,
    squash: 0.85,
    stretch: [1.02, 0.92, 1.08],
    offset: [0, 0.1, 0],
  },
  noise: {
    scale: 2.0,
    offset: [0.9, 1.8, 0.5],
    octaves: 5,
    lacunarity: 2.2,
    gain: 0.5,
    amplitude: 0.26,
    microAmplitude: 0.04,
    ridged: true,
  },
  erosion: {
    thermal: { enabled: true, iterations: 12, talus: 0.038, rate: 0.34 },
    hydraulic: { enabled: true, droplets: 100, steps: 24, erosion: 0.22, deposit: 0.11 },
    edgeWear: { enabled: true, strength: 0.06 },
  },
  lod: {
    full: { detail: 4 },
    reduced: { detail: 2 },
    impostor: { detail: 1 },
  },

  controls: [
    {
      key: 'frostFracturing', name: 'Frost fracturing', group: 'shape',
      min: 0, max: 1, step: 0.05,
      // frost-shattered faces — ridged angular blocks.
      get: (s) => (s.noise.ridged ? 0.85 : 0.25),
      set: (s, v) => { s.noise.ridged = v >= 0.5; },
    },
    {
      key: 'iceScouring', name: 'Ice scouring', group: 'surface',
      min: 0, max: 1, step: 0.01,
      // glacial polish vs coarse — micro amplitude.
      get: (s) => (s.noise.microAmplitude ?? 0.04) / 0.08,
      set: (s, v) => { s.noise.microAmplitude = v * 0.08; },
    },
    {
      key: 'massLoss', name: 'Mass loss', group: 'erosion',
      min: 0, max: 1, step: 0.01,
      // glacial quarrying — hydraulic proxy (meltwater).
      get: (s) => Math.min(1, (s.erosion.hydraulic?.erosion ?? 0.22) / 0.4),
      set: (s, v) => { s.erosion.hydraulic.erosion = v * 0.4; },
    },
    {
      key: 'edgeChipping', name: 'Edge chipping', group: 'erosion',
      min: 0, max: 1, step: 0.01,
      get: (s) => (s.erosion.edgeWear?.strength ?? 0.06) / 0.12,
      set: (s, v) => { s.erosion.edgeWear.strength = v * 0.12; },
    },
  ],
};
