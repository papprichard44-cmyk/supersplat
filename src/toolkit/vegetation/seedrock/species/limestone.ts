// @ts-nocheck
/* eslint-disable */
// Vendored from SeedRock (github.com/reed-soul/SeedRock), MIT licence, see ../THIRD_PARTY.md.
// Only the geometry generator is used; erosion and rendering are left out.

// Limestone — sedimentary, pale, karst dissolution pockets and soft rounding.

export const limestone = {
  id: 'limestone',
  name: 'Limestone',
  latin: 'Calx',
  biome: 'temperate',
  color: 0xd8d2c4,
  roughness: 0.94,
  metalness: 0,
  textures: {
    albedo: 'limestone_albedo.png',
    normal: 'limestone_normal.png',
    roughness: 'limestone_roughness.png',
    triplanarScale: 0.5,
  },
  shape: {
    radius: 1,
    detail: 4,
    squash: 0.82,
    stretch: [1.08, 0.88, 1.05],
    offset: [0, 0.12, 0],
  },
  noise: {
    scale: 1.6,
    offset: [0.6, 2.0, 0.4],
    octaves: 4,
    lacunarity: 2.0,
    gain: 0.4,
    amplitude: 0.2,
    microAmplitude: 0.028,
    ridged: false,
  },
  erosion: {
    thermal: { enabled: true, iterations: 16, talus: 0.028, rate: 0.42 },
    hydraulic: { enabled: true, droplets: 140, steps: 30, erosion: 0.32, deposit: 0.16 },
    edgeWear: { enabled: true, strength: 0.035 },
  },
  lod: {
    full: { detail: 4 },
    reduced: { detail: 2 },
    impostor: { detail: 1 },
  },

  controls: [
    {
      key: 'dissolutionPits', name: 'Dissolution pits', group: 'shape',
      min: 0, max: 1, step: 0.05,
      // karst dissolution — amplitude drives cavity depth.
      get: (s) => Math.min(1, (s.noise.amplitude ?? 0.2) / 0.35),
      set: (s, v) => { s.noise.amplitude = v * 0.35; },
    },
    {
      key: 'surfaceGrain', name: 'Surface grain', group: 'surface',
      min: 0, max: 1, step: 0.01,
      get: (s) => (s.noise.microAmplitude ?? 0.028) / 0.06,
      set: (s, v) => { s.noise.microAmplitude = v * 0.06; },
    },
    {
      key: 'karstErosion', name: 'Karst erosion', group: 'erosion',
      min: 0, max: 1, step: 0.01,
      // limestone dissolves aggressively — strongest hydraulic in the set.
      get: (s) => Math.min(1, (s.erosion.hydraulic?.erosion ?? 0.32) / 0.45),
      set: (s, v) => { s.erosion.hydraulic.erosion = v * 0.45; },
    },
    {
      key: 'rounding', name: 'Rounding', group: 'erosion',
      min: 0, max: 1, step: 0.01,
      get: (s) => (s.erosion.edgeWear?.strength ?? 0.035) / 0.1,
      set: (s, v) => { s.erosion.edgeWear.strength = v * 0.1; },
    },
  ],
};
