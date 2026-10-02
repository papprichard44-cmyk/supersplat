// @ts-nocheck
/* eslint-disable */
// Vendored from SeedRock (github.com/reed-soul/SeedRock), MIT licence, see ../THIRD_PARTY.md.
// Only the geometry generator is used; erosion and rendering are left out.

// Obsidian — volcanic glass, near-black with conchoidal (shell-like) fractures.
// High metalness + very low roughness reads as glassy; ridged noise + strong
// edge wear give the sharp broken-glass silhouette.

export const obsidian = {
  id: 'obsidian',
  name: 'Obsidian',
  latin: 'Lapis obsidianus',
  biome: 'volcanic',
  color: 0x14161a,
  roughness: 0.14,
  metalness: 0.55,
  textures: {
    albedo: 'obsidian_albedo.png',
    normal: 'obsidian_normal.png',
    roughness: 'obsidian_roughness.png',
    triplanarScale: 0.4,
  },
  shape: {
    radius: 1,
    detail: 4,
    squash: 0.95,
    stretch: [1.05, 1.1, 0.95],
    offset: [0, 0.12, 0],
  },
  noise: {
    scale: 2.8,
    offset: [1.5, 0.6, 1.2],
    octaves: 5,
    lacunarity: 2.4,
    gain: 0.5,
    amplitude: 0.26,
    microAmplitude: 0.02,
    ridged: true,
  },
  erosion: {
    thermal: { enabled: true, iterations: 6, talus: 0.04, rate: 0.2 },
    hydraulic: { enabled: false },
    edgeWear: { enabled: true, strength: 0.11 },
  },
  lod: {
    full: { detail: 4 },
    reduced: { detail: 2 },
    impostor: { detail: 1 },
  },

  controls: [
    {
      key: 'conchoidalFracture', name: 'Conchoidal fracture', group: 'shape',
      min: 0, max: 1, step: 0.05,
      // shell-like broken-glass facets — ridged noise is the driver.
      get: (s) => (s.noise.ridged ? 0.85 : 0.25),
      set: (s, v) => { s.noise.ridged = v >= 0.5; },
    },
    {
      key: 'glassiness', name: 'Glassiness', group: 'surface',
      min: 0, max: 1, step: 0.01,
      // smooth glass vs micro-cracked — inverse of micro amplitude.
      get: (s) => 1 - (s.noise.microAmplitude ?? 0.02) / 0.05,
      set: (s, v) => { s.noise.microAmplitude = (1 - v) * 0.05; },
    },
    {
      key: 'shardSharpness', name: 'Shard sharpness', group: 'erosion',
      min: 0, max: 1, step: 0.01,
      // obsidian keeps the sharpest edges in the set — high edgeWear.
      get: (s) => (s.erosion.edgeWear?.strength ?? 0.11) / 0.2,
      set: (s, v) => { s.erosion.edgeWear.strength = v * 0.2; },
    },
  ],
};
