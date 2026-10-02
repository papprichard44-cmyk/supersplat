// @ts-nocheck
/* eslint-disable */
// Vendored from SeedRock (github.com/reed-soul/SeedRock), MIT licence, see ../THIRD_PARTY.md.
// Only the geometry generator is used; erosion and rendering are left out.

// Ore — mineral vein outcrop: a crystal-cluster form with metallic/
// emissive-leaning material so it reads as a glowing precious-metal deposit.
// Pairs naturally with the toon style for stylized mining-game assets.

export const ore = {
  id: 'ore',
  name: 'Ore Deposit',
  latin: 'Minera',
  biome: 'underground',
  color: 0x5a6b78,
  roughness: 0.4,
  metalness: 0.75,
  textures: {
    albedo: 'ore_albedo.png',
    normal: 'ore_normal.png',
    roughness: 'ore_roughness.png',
    triplanarScale: 0.55,
  },
  shape: {
    form: 'crystal',
    radius: 1,
    detail: 4,
    squash: 1,
    stretch: [1, 1, 1],
    offset: [0, 0, 0],
  },
  noise: {
    scale: 1.4,
    offset: [0.4, 0.9, 0.6],
    octaves: 3,
    lacunarity: 2,
    gain: 0.45,
    amplitude: 0.05,
    microAmplitude: 0.02,
    ridged: false,
  },
  erosion: {
    thermal: { enabled: false },
    hydraulic: { enabled: false },
    edgeWear: { enabled: true, strength: 0.04 },
  },
  lod: {
    full: { detail: 4 },
    reduced: { detail: 2 },
    impostor: { detail: 1 },
  },

  controls: [
    {
      key: 'veinDensity', name: 'Vein density', group: 'shape',
      min: 0, max: 1, step: 0.05,
      get: (s) => Math.min(1, (s.shape.radius - 0.6) / 1.4),
      set: (s, v) => { s.shape.radius = 0.6 + v * 1.4; },
    },
    {
      key: 'crystalCrispness', name: 'Crystal crispness', group: 'surface',
      min: 0, max: 1, step: 0.05,
      get: (s) => (s.noise.ridged ? 0.8 : 0.2),
      set: (s, v) => { s.noise.ridged = v >= 0.5; },
    },
    {
      key: 'encrusting', name: 'Encrusting', group: 'erosion',
      min: 0, max: 1, step: 0.01,
      get: (s) => (s.erosion.edgeWear?.strength ?? 0.04) / 0.1,
      set: (s, v) => { s.erosion.edgeWear.strength = v * 0.1; },
    },
  ],
};
