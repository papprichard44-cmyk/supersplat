// @ts-nocheck
/* eslint-disable */
// Vendored from SeedRock (github.com/reed-soul/SeedRock), MIT licence, see ../THIRD_PARTY.md.
// Only the geometry generator is used; erosion and rendering are left out.

// Karst — limestone dissolution: pitted surface, sharp ridges, cave-weathered forms.

export const karst = {
  id: 'karst',
  name: 'Karst',
  latin: 'Karsticus',
  biome: 'temperate',
  color: 0xc8c0b0,
  roughness: 0.9,
  metalness: 0,
  textures: {
    albedo: 'karst_albedo.png',
    normal: 'karst_normal.png',
    roughness: 'karst_roughness.png',
    triplanarScale: 0.44,
  },
  shape: {
    radius: 1,
    detail: 5,
    squash: 0.92,
    stretch: [0.95, 1.1, 1.0],
    offset: [0, 0.18, 0],
  },
  noise: {
    scale: 2.8,
    offset: [1.6, 0.5, 2.1],
    octaves: 6,
    lacunarity: 2.5,
    gain: 0.58,
    amplitude: 0.34,
    microAmplitude: 0.055,
    ridged: true,
  },
  erosion: {
    thermal: { enabled: true, iterations: 11, talus: 0.032, rate: 0.32 },
    hydraulic: { enabled: true, droplets: 110, steps: 26, erosion: 0.26, deposit: 0.12 },
    edgeWear: { enabled: true, strength: 0.09 },
  },
  lod: {
    full: { detail: 5 },
    reduced: { detail: 3 },
    impostor: { detail: 1 },
  },

  controls: [
    {
      key: 'pinnacleSharpness', name: 'Pinnacle sharpness', group: 'shape',
      min: 0, max: 1, step: 0.05,
      // karst pinnacles — ridged noise + high amplitude.
      get: (s) => (s.noise.ridged ? 0.85 : 0.25),
      set: (s, v) => { s.noise.ridged = v >= 0.5; },
    },
    {
      key: 'dissolutionDepth', name: 'Dissolution depth', group: 'shape',
      min: 0, max: 1, step: 0.05,
      get: (s) => Math.min(1, (s.noise.amplitude ?? 0.34) / 0.45),
      set: (s, v) => { s.noise.amplitude = v * 0.45; },
    },
    {
      key: 'rillenDetail', name: 'Rillen detail', group: 'surface',
      min: 0, max: 1, step: 0.01,
      // rillenkarren — solution flutes on the surface.
      get: (s) => (s.noise.microAmplitude ?? 0.055) / 0.08,
      set: (s, v) => { s.noise.microAmplitude = v * 0.08; },
    },
    {
      key: 'edgeSharpness', name: 'Edge sharpness', group: 'erosion',
      min: 0, max: 1, step: 0.01,
      get: (s) => (s.erosion.edgeWear?.strength ?? 0.09) / 0.15,
      set: (s, v) => { s.erosion.edgeWear.strength = v * 0.15; },
    },
  ],
};
