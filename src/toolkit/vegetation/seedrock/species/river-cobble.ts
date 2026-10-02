// @ts-nocheck
/* eslint-disable */
// Vendored from SeedRock (github.com/reed-soul/SeedRock), MIT licence, see ../THIRD_PARTY.md.
// Only the geometry generator is used; erosion and rendering are left out.

// River cobble — water-worn rounded stones, smooth low-profile silhouette.
// Silhouette rounding is driven by Domokos–Firey pebble abrasion
// (docs/generation-design.md §3.4), not just noise amplitude.

export const riverCobble = {
  id: 'riverCobble',
  name: 'River Cobble',
  latin: 'Glarea fluvialis',
  biome: 'temperate',
  color: 0x7a756e,
  roughness: 0.78,
  metalness: 0.01,
  textures: {
    albedo: 'river_cobble_albedo.png',
    normal: 'river_cobble_normal.png',
    roughness: 'river_cobble_roughness.png',
    triplanarScale: 0.52,
  },
  shape: {
    radius: 0.85,
    detail: 4,
    squash: 0.62,
    stretch: [1.12, 0.68, 1.08],
    offset: [0, 0.05, 0],
  },
  noise: {
    scale: 1.4,
    offset: [0.8, 0.6, 1.4],
    octaves: 4,
    lacunarity: 2.0,
    gain: 0.38,
    amplitude: 0.16,
    microAmplitude: 0.02,
    ridged: false,
  },
  erosion: {
    // Lighter terrain-style passes — cobbles round by collision, not by
    // hillslope diffusion. Hydraulic still adds subtle fluvial texture.
    thermal: { enabled: true, iterations: 10, talus: 0.03, rate: 0.3 },
    hydraulic: { enabled: true, droplets: 80, steps: 24, erosion: 0.18, deposit: 0.1 },
    // edgeWear is redundant once pebbleAbrade runs (both are curvature-
    // driven); keep it off so Domokos owns the rounding story.
    edgeWear: { enabled: false },
    // Domokos–Firey collisional abrasion — the species' defining pass.
    pebbleAbrade: {
      enabled: true,
      iterations: 10,
      rate: 0.14,        // Phase I: curvature-driven edge rounding
      sphericity: 0.45,  // Phase II: blend toward the sphere attractor
    },
  },
  lod: {
    full: { detail: 4 },
    reduced: { detail: 2 },
    impostor: { detail: 1 },
  },

  controls: [
    {
      key: 'roundness', name: 'Roundness', group: 'erosion',
      min: 0, max: 1, step: 0.05,
      // Domokos Phase II — how far the cobble has converged toward a sphere.
      get: (s) => s.erosion.pebbleAbrade?.sphericity ?? 0.45,
      set: (s, v) => { s.erosion.pebbleAbrade.sphericity = v; },
    },
    {
      key: 'abrasion', name: 'Abrasion', group: 'erosion',
      min: 0, max: 1, step: 0.01,
      // Domokos Phase I rate — how aggressively high-curvature edges chip.
      get: (s) => Math.min(1, (s.erosion.pebbleAbrade?.rate ?? 0.14) / 0.3),
      set: (s, v) => { s.erosion.pebbleAbrade.rate = v * 0.3; },
    },
    {
      key: 'surfacePolish', name: 'Surface polish', group: 'surface',
      min: 0, max: 1, step: 0.01,
      // river-worn smoothness — inversely maps to micro amplitude.
      get: (s) => 1 - (s.noise.microAmplitude ?? 0.02) / 0.05,
      set: (s, v) => { s.noise.microAmplitude = (1 - v) * 0.05; },
    },
    {
      key: 'fluvialWear', name: 'Fluvial wear', group: 'erosion',
      min: 0, max: 1, step: 0.01,
      // residual hydraulic carving — secondary to collisional abrasion.
      get: (s) => Math.min(1, (s.erosion.hydraulic?.erosion ?? 0.18) / 0.4),
      set: (s, v) => { s.erosion.hydraulic.erosion = v * 0.4; },
    },
  ],
};
