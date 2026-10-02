// @ts-nocheck
/* eslint-disable */
// Vendored from SeedRock (github.com/reed-soul/SeedRock), MIT licence, see ../THIRD_PARTY.md.
// Only the geometry generator is used; erosion and rendering are left out.

// Crystal — radiating prism cluster (quartz/amethyst habit). High metalness
// reads as faceted gem; pairs well with the toon style for stylized ore.

export const crystal = {
  id: 'crystal',
  name: 'Crystal Cluster',
  latin: 'Crystallus',
  biome: 'underground',
  color: 0xb8d4e8,
  roughness: 0.18,
  metalness: 0.6,
  textures: {
    albedo: 'crystal_albedo.png',
    normal: 'crystal_normal.png',
    roughness: 'crystal_roughness.png',
    triplanarScale: 0.6,
  },
  shape: {
    form: 'crystal',
    // Worley 1996 cellular feature points seed satellite nucleation sites
    // (docs/generation-design.md §4). Default for new crystal species; the
    // legacy angular fan remains available via nucleation: 'fan'.
    nucleation: 'worley',
    nucleationDensity: 0.55,
    habit: 'radiating',
    radius: 1,
    detail: 4,
    squash: 1,
    stretch: [1, 1, 1],
    offset: [0, 0, 0],
  },
  noise: {
    scale: 1.5,
    offset: [0.3, 0.7, 0.5],
    octaves: 3,
    lacunarity: 2,
    gain: 0.45,
    amplitude: 0.06,
    microAmplitude: 0.02,
    ridged: false,
  },
  erosion: {
    thermal: { enabled: false },
    hydraulic: { enabled: false },
    edgeWear: { enabled: true, strength: 0.03 },
  },
  lod: {
    full: { detail: 4 },
    reduced: { detail: 2 },
    impostor: { detail: 1 },
  },

  controls: [
    {
      key: 'clusterDensity', name: 'Cluster density', group: 'shape',
      min: 0, max: 1, step: 0.05,
      // Footprint of the cluster — bigger radius = wider Worley disk.
      get: (s) => Math.min(1, (s.shape.radius - 0.6) / 1.4),
      set: (s, v) => { s.shape.radius = 0.6 + v * 1.4; },
    },
    {
      key: 'nucleationDensity', name: 'Nucleation density', group: 'shape',
      min: 0, max: 1, step: 0.05,
      // Worley lattice fineness — denser cells → more candidate sites →
      // tighter satellite packing after thinning.
      get: (s) => s.shape.nucleationDensity ?? 0.55,
      set: (s, v) => { s.shape.nucleationDensity = v; },
    },
    {
      key: 'facetCrispness', name: 'Facet crispness', group: 'surface',
      min: 0, max: 1, step: 0.05,
      // ridged noise → sharp prism facets; smooth → frosted/abraded crystal.
      get: (s) => (s.noise.ridged ? 0.8 : 0.2),
      set: (s, v) => { s.noise.ridged = v >= 0.5; },
    },
    {
      key: 'tipChipping', name: 'Tip chipping', group: 'erosion',
      min: 0, max: 1, step: 0.01,
      // crystals chip at tips/edges — the only erosion pass crystals use.
      get: (s) => (s.erosion.edgeWear?.strength ?? 0.03) / 0.1,
      set: (s, v) => { s.erosion.edgeWear.strength = v * 0.1; },
    },
  ],
};
