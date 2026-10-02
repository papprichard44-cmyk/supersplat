// @ts-nocheck
/* eslint-disable */
// Vendored from SeedRock (github.com/reed-soul/SeedRock), MIT licence, see ../THIRD_PARTY.md.
// Only the geometry generator is used; erosion and rendering are left out.

// Slate — fine-grained metamorphic rock, foliated plate form, splits into sheets.

export const slate = {
  id: 'slate',
  name: 'Slate',
  latin: 'Slate (metamorphic)',
  biome: 'alpine',
  color: 0x3a3f4a,
  roughness: 0.86,
  metalness: 0.03,
  textures: {
    albedo: 'slate_albedo.png',
    normal: 'slate_normal.png',
    roughness: 'slate_roughness.png',
    triplanarScale: 0.5,
  },
  shape: {
    form: 'slate',
    radius: 1,
    detail: 4,
    squash: 1,
    stretch: [1, 1, 1],
    offset: [0, 0, 0],
  },
  noise: {
    scale: 2.0,
    offset: [0.5, 1.0, 0.6],
    octaves: 4,
    lacunarity: 2.2,
    gain: 0.5,
    amplitude: 0.14,
    microAmplitude: 0.03,
    ridged: false,
  },
  erosion: {
    thermal: { enabled: true, iterations: 6, talus: 0.05, rate: 0.2 },
    hydraulic: { enabled: true, droplets: 40, steps: 14, erosion: 0.12, deposit: 0.06 },
    edgeWear: { enabled: true, strength: 0.08 },
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
      // how pronounced the foliation layering reads — slate.js slab count is
      // 3–5 from rng; amplitude scales the surface grain that picks out strata.
      get: (s) => Math.min(1, (s.noise.amplitude ?? 0.14) / 0.3),
      set: (s, v) => { s.noise.amplitude = v * 0.3; },
    },
    {
      key: 'surfaceFlakes', name: 'Surface flakes', group: 'surface',
      min: 0, max: 1, step: 0.01,
      // micro-displacement expresses the flaky foliation surface.
      get: (s) => (s.noise.microAmplitude ?? 0.03) / 0.06,
      set: (s, v) => { s.noise.microAmplitude = v * 0.06; },
    },
    {
      key: 'edgeSplinter', name: 'Edge splinter', group: 'erosion',
      min: 0, max: 1, step: 0.01,
      // slate edges splinter rather than round — high edgeWear strength.
      get: (s) => (s.erosion.edgeWear?.strength ?? 0.08) / 0.15,
      set: (s, v) => { s.erosion.edgeWear.strength = v * 0.15; },
    },
  ],
};
