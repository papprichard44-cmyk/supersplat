// @ts-nocheck
/* eslint-disable */
// Vendored from SeedRock (github.com/reed-soul/SeedRock), MIT licence, see ../THIRD_PARTY.md.
// Only the geometry generator is used; erosion and rendering are left out.

// Ice — translucent frozen water, not a rock. Uses the crystal form (icicle
// cluster) with a physical material (transmission + ior 1.31) so light
// passes through and picks up a faint blue attenuation. Only renders
// correctly under the PBR style; lowpoly/toon fall back to standard.

export const ice = {
  id: 'ice',
  name: 'Ice',
  latin: 'Glacies',
  biome: 'alpine',
  color: 0xd8eef8,
  roughness: 0.08,
  metalness: 0,
  // Physical-material switches (consumed only when style === 'pbr')
  material: 'physical',
  transmission: 1,
  thickness: 0.6,
  ior: 1.31,                 // refractive index of ice
  attenuationDistance: 4,
  attenuationColor: 0xc8e6f5,
  textures: {
    albedo: 'ice_albedo.png',
    normal: 'ice_normal.png',
    roughness: 'ice_roughness.png',
    triplanarScale: 0.5,
  },
  shape: {
    form: 'crystal',
    // Same Worley nucleation as crystal — icicles seed irregularly on a
    // substrate rather than on a clock-face fan.
    nucleation: 'worley',
    nucleationDensity: 0.45,
    habit: 'radiating',
    radius: 1,
    detail: 4,
    squash: 1,
    stretch: [1, 1.1, 1],
    offset: [0, 0, 0],
  },
  noise: {
    scale: 1.2,
    offset: [0.5, 0.8, 0.4],
    octaves: 3,
    lacunarity: 2,
    gain: 0.4,
    amplitude: 0.04,
    microAmplitude: 0.015,
    ridged: false,
  },
  erosion: {
    thermal: { enabled: false },
    hydraulic: { enabled: false },
    edgeWear: { enabled: true, strength: 0.02 },
  },
  lod: {
    full: { detail: 4 },
    reduced: { detail: 2 },
    impostor: { detail: 1 },
  },

  controls: [
    {
      key: 'icicleDensity', name: 'Icicle density', group: 'shape',
      min: 0, max: 1, step: 0.05,
      get: (s) => Math.min(1, (s.shape.radius - 0.6) / 1.4),
      set: (s, v) => { s.shape.radius = 0.6 + v * 1.4; },
    },
    {
      key: 'nucleationDensity', name: 'Nucleation density', group: 'shape',
      min: 0, max: 1, step: 0.05,
      get: (s) => s.shape.nucleationDensity ?? 0.45,
      set: (s, v) => { s.shape.nucleationDensity = v; },
    },
    {
      key: 'clarity', name: 'Clarity', group: 'surface',
      min: 0, max: 1, step: 0.01,
      // clear ice vs frosted — inverse of micro amplitude.
      get: (s) => 1 - (s.noise.microAmplitude ?? 0.015) / 0.04,
      set: (s, v) => { s.noise.microAmplitude = (1 - v) * 0.04; },
    },
    {
      key: 'melting', name: 'Melting', group: 'erosion',
      min: 0, max: 1, step: 0.01,
      // rounded dripping tips — edge wear is ice's only erosion pass.
      get: (s) => (s.erosion.edgeWear?.strength ?? 0.02) / 0.06,
      set: (s, v) => { s.erosion.edgeWear.strength = v * 0.06; },
    },
  ],
};
