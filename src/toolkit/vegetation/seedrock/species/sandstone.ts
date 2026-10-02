// @ts-nocheck
/* eslint-disable */
// Vendored from SeedRock (github.com/reed-soul/SeedRock), MIT licence, see ../THIRD_PARTY.md.
// Only the geometry generator is used; erosion and rendering are left out.

// Sandstone — sedimentary layers, softer edges, horizontal stratification bias.

export const sandstone = {
  id: 'sandstone',
  name: 'Sandstone',
  latin: 'Arenarium',
  biome: 'desert',
  color: 0xc4a574,
  roughness: 0.96,
  metalness: 0,
  textures: {
    albedo: 'sandstone_albedo.png',
    normal: 'sandstone_normal.png',
    roughness: 'sandstone_roughness.png',
    triplanarScale: 0.48,
  },
  shape: {
    radius: 1,
    detail: 4,
    squash: 0.72,
    stretch: [1.15, 0.75, 1.1],
    offset: [0, 0.1, 0],
  },
  noise: {
    scale: 2.2,
    offset: [0.2, 0.5, 1.1],
    octaves: 4,
    lacunarity: 2.0,
    gain: 0.42,
    amplitude: 0.22,
    microAmplitude: 0.025,
    ridged: false,
  },
  erosion: {
    thermal: { enabled: true, iterations: 14, talus: 0.03, rate: 0.38 },
    hydraulic: { enabled: true, droplets: 120, steps: 28, erosion: 0.28, deposit: 0.14 },
    edgeWear: { enabled: true, strength: 0.04 },
  },
  lod: {
    full: { detail: 4 },
    reduced: { detail: 2 },
    impostor: { detail: 1 },
  },

  controls: [
    {
      key: 'beddingRelief', name: 'Bedding relief', group: 'shape',
      min: 0, max: 1, step: 0.05,
      get: (s) => Math.min(1, (s.noise.amplitude ?? 0.22) / 0.4),
      set: (s, v) => { s.noise.amplitude = v * 0.4; },
    },
    {
      key: 'grainFineness', name: 'Grain fineness', group: 'surface',
      min: 0, max: 1, step: 0.01,
      get: (s) => (s.noise.microAmplitude ?? 0.025) / 0.06,
      set: (s, v) => { s.noise.microAmplitude = v * 0.06; },
    },
    {
      key: 'waterGrooves', name: 'Water grooves', group: 'erosion',
      min: 0, max: 1, step: 0.01,
      get: (s) => Math.min(1, (s.erosion.hydraulic?.erosion ?? 0.28) / 0.4),
      set: (s, v) => { s.erosion.hydraulic.erosion = v * 0.4; },
    },
    {
      key: 'edgeSoftness', name: 'Edge softness', group: 'erosion',
      min: 0, max: 1, step: 0.01,
      get: (s) => (s.erosion.edgeWear?.strength ?? 0.04) / 0.1,
      set: (s, v) => { s.erosion.edgeWear.strength = v * 0.1; },
    },
  ],
};
