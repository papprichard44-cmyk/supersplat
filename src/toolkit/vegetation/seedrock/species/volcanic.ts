// @ts-nocheck
/* eslint-disable */
// Vendored from SeedRock (github.com/reed-soul/SeedRock), MIT licence, see ../THIRD_PARTY.md.
// Only the geometry generator is used; erosion and rendering are left out.

// Volcanic tuff — porous, vesicular, rough pumice-like cavities.

export const volcanic = {
  id: 'volcanic',
  name: 'Volcanic Tuff',
  latin: 'Tuffa',
  biome: 'volcanic',
  color: 0x6b4a42,
  roughness: 0.98,
  metalness: 0,
  textures: {
    albedo: 'volcanic_albedo.png',
    normal: 'volcanic_normal.png',
    roughness: 'volcanic_roughness.png',
    triplanarScale: 0.42,
  },
  shape: {
    radius: 1,
    detail: 4,
    squash: 0.9,
    stretch: [1.0, 0.95, 1.0],
    offset: [0, 0.1, 0],
  },
  noise: {
    scale: 3.0,
    offset: [2.2, 0.9, 1.5],
    octaves: 6,
    lacunarity: 2.4,
    gain: 0.55,
    amplitude: 0.32,
    microAmplitude: 0.05,
    ridged: false,
  },
  erosion: {
    thermal: { enabled: true, iterations: 9, talus: 0.04, rate: 0.28 },
    hydraulic: { enabled: true, droplets: 70, steps: 20, erosion: 0.18, deposit: 0.09 },
    edgeWear: { enabled: true, strength: 0.08 },
  },
  lod: {
    full: { detail: 4 },
    reduced: { detail: 2 },
    impostor: { detail: 1 },
  },

  controls: [
    {
      key: 'vesicularity', name: 'Vesicularity', group: 'shape',
      min: 0, max: 1, step: 0.05,
      // pumice/tuff porosity — amplitude drives the cavity scale.
      get: (s) => Math.min(1, (s.noise.amplitude ?? 0.32) / 0.45),
      set: (s, v) => { s.noise.amplitude = v * 0.45; },
    },
    {
      key: 'vesicleDetail', name: 'Vesicle detail', group: 'surface',
      min: 0, max: 1, step: 0.01,
      get: (s) => (s.noise.microAmplitude ?? 0.05) / 0.08,
      set: (s, v) => { s.noise.microAmplitude = v * 0.08; },
    },
    {
      key: 'angularity', name: 'Angularity', group: 'surface',
      min: 0, max: 1, step: 0.05,
      get: (s) => (s.noise.ridged ? 0.85 : 0.3),
      set: (s, v) => { s.noise.ridged = v >= 0.5; },
    },
    {
      key: 'edgeRoughness', name: 'Edge roughness', group: 'erosion',
      min: 0, max: 1, step: 0.01,
      get: (s) => (s.erosion.edgeWear?.strength ?? 0.08) / 0.15,
      set: (s, v) => { s.erosion.edgeWear.strength = v * 0.15; },
    },
  ],
};
