// @ts-nocheck
/* eslint-disable */
// Vendored from SeedRock (github.com/reed-soul/SeedRock), MIT licence, see ../THIRD_PARTY.md.
// Only the geometry generator is used; erosion and rendering are left out.

// Schist — foliated metamorphic rock with flaky micaceous layers.
// Example community species (see CONTRIBUTING.md).

export const schist = {
  id: 'schist',
  name: 'Schist',
  latin: 'Schistum',
  biome: 'temperate',
  color: 0x6e6a62,
  roughness: 0.91,
  metalness: 0.05,
  textures: {
    albedo: 'schist_albedo.png',
    normal: 'schist_normal.png',
    roughness: 'schist_roughness.png',
    triplanarScale: 0.4,
  },
  shape: {
    radius: 1,
    detail: 4,
    squash: 0.78,
    stretch: [1.18, 0.72, 1.12],
    offset: [0, 0.08, 0],
  },
  noise: {
    scale: 2.6,
    offset: [0.3, 1.6, 0.9],
    octaves: 5,
    lacunarity: 2.3,
    gain: 0.44,
    amplitude: 0.22,
    microAmplitude: 0.045,
    ridged: false,
  },
  erosion: {
    thermal: { enabled: true, iterations: 14, talus: 0.03, rate: 0.4 },
    hydraulic: { enabled: true, droplets: 110, steps: 26, erosion: 0.28, deposit: 0.14 },
    edgeWear: { enabled: true, strength: 0.04 },
  },
  lod: {
    full: { detail: 4 },
    reduced: { detail: 2 },
    impostor: { detail: 1 },
  },

  controls: [
    {
      key: 'schistosity', name: 'Schistosity', group: 'shape',
      min: 0, max: 1, step: 0.05,
      // foliation relief — the flaky mica layering.
      get: (s) => Math.min(1, (s.noise.amplitude ?? 0.22) / 0.35),
      set: (s, v) => { s.noise.amplitude = v * 0.35; },
    },
    {
      key: 'micaFlakes', name: 'Mica flakes', group: 'surface',
      min: 0, max: 1, step: 0.01,
      get: (s) => (s.noise.microAmplitude ?? 0.045) / 0.08,
      set: (s, v) => { s.noise.microAmplitude = v * 0.08; },
    },
    {
      key: 'platyWeathering', name: 'Platy weathering', group: 'erosion',
      min: 0, max: 1, step: 0.01,
      // schist weathers along foliation planes.
      get: (s) => (s.erosion.edgeWear?.strength ?? 0.04) / 0.1,
      set: (s, v) => { s.erosion.edgeWear.strength = v * 0.1; },
    },
  ],
};
