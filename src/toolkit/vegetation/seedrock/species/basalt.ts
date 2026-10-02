// @ts-nocheck
/* eslint-disable */
// Vendored from SeedRock (github.com/reed-soul/SeedRock), MIT licence, see ../THIRD_PARTY.md.
// Only the geometry generator is used; erosion and rendering are left out.

// Basalt — dark volcanic igneous rock, columnar fractures, angular silhouette.

export const basalt = {
  id: 'basalt',
  name: 'Basalt',
  latin: 'Basaltum',
  biome: 'volcanic',
  color: 0x3a3a42,
  roughness: 0.88,
  metalness: 0.04,
  textures: {
    albedo: 'basalt_albedo.png',
    normal: 'basalt_normal.png',
    roughness: 'basalt_roughness.png',
    triplanarScale: 0.38,
  },
  shape: {
    form: 'columnar',
    radius: 1,
    detail: 4,
    squash: 1.05,
    stretch: [0.92, 1.18, 0.92],
    offset: [0, 0.08, 0],
  },
  noise: {
    scale: 2.4,
    offset: [1.1, 0.3, 0.8],
    octaves: 5,
    lacunarity: 2.3,
    gain: 0.52,
    amplitude: 0.24,
    microAmplitude: 0.03,
    ridged: true,
  },
  erosion: {
    thermal: { enabled: true, iterations: 8, talus: 0.045, rate: 0.25 },
    hydraulic: { enabled: true, droplets: 60, steps: 18, erosion: 0.15, deposit: 0.08 },
    edgeWear: { enabled: true, strength: 0.07 },
  },
  lod: {
    full: { detail: 4 },
    reduced: { detail: 2 },
    impostor: { detail: 1 },
  },

  controls: [
    {
      key: 'columnDensity', name: 'Column density', group: 'shape',
      min: 0, max: 1, step: 0.05,
      // more columns in the cluster → tighter hex pack. Maps to radius-driven
      // count in columnar.js (count scales with radius).
      get: (s) => Math.min(1, (s.shape.radius - 0.6) / 1.4),
      set: (s, v) => { s.shape.radius = 0.6 + v * 1.4; },
    },
    {
      key: 'columnHeightVar', name: 'Column height variance', group: 'shape',
      min: 0, max: 1, step: 0.05,
      // fractured colonnade tops — the displacement amplitude on a columnar
      // cluster rides on noise.amplitude (structural form uses it as grain).
      get: (s) => Math.min(1, (s.noise.amplitude ?? 0.24) / 0.4),
      set: (s, v) => { s.noise.amplitude = v * 0.4; },
    },
    {
      key: 'angularity', name: 'Angularity', group: 'surface',
      min: 0, max: 1, step: 0.05,
      // ridged noise → sharp column edges; smooth → weathered faces.
      get: (s) => (s.noise.ridged ? 0.85 : 0.3),
      set: (s, v) => { s.noise.ridged = v >= 0.5; },
    },
    {
      key: 'blockWeathering', name: 'Block weathering', group: 'erosion',
      min: 0, max: 1, step: 0.01,
      get: (s) => s.erosion.edgeWear?.strength ?? 0.07,
      set: (s, v) => { s.erosion.edgeWear.strength = v; },
    },
  ],
};
