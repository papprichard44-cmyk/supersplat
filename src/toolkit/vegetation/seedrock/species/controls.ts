// @ts-nocheck
/* eslint-disable */
// Vendored from SeedRock (github.com/reed-soul/SeedRock), MIT licence, see ../THIRD_PARTY.md.
// Only the geometry generator is used; erosion and rendering are left out.

// Per-species semantic control vocabulary + the bridges between a controls
// object and a species preset. This is the SeedRock analogue of SeedThree's
// `ui/controls.js` bridging layer (`controlsFromSpecies` / `applySpeciesControls`),
// kept in `species/` so the Headless API (Phase 4) can import it without pulling
// in lil-gui or any DOM code.
//
// Each species may declare a `controls: []` array of semantic knobs:
//   { key, name, min, max, step | dropdown, get(preset), set(preset, v), group? }
// `get`/`set` read/write the preset's own fields (shape / noise / erosion / ...),
// so the UI shows a human name ("Blockiness") that maps to a model term
// (`noise.ridged`). Presets stay data-only — no generator logic here.
//
// The controls object produced by `controlsFromSpecies` is a SUPERSET of the
// legacy `state` shape (shape/erosion/overlay/...): the legacy fields are kept
// verbatim for back-compat with main.js / showcase.js / url-state.js, and a new
// `params: {}` sub-object carries the per-species semantic-knob values. Old call
// sites that read `state.shape.radius` etc. keep working unchanged.

/**
 * Default values for the shared (non-species-specific) controls. These mirror
 * the fields `createShowcaseState()` already populates, so a fresh controls
 * object round-trips with the existing UI state.
 *
 * `params` is the per-species extension: each entry of a species' `controls[]`
 * seeds a key here via its `get(preset)`.
 */
function sharedDefaults(preset) {
  return {
    seed: 1,
    // Legacy shape/erosion/overlay fields (back-compat with main.js state).
    shape: {
      radius: preset.shape.radius,
      detail: preset.shape.detail,
      squash: preset.shape.squash ?? 1,
      amplitude: preset.noise.amplitude,
    },
    erosion: {
      thermal: preset.erosion.thermal?.enabled !== false,
      hydraulic: preset.erosion.hydraulic?.enabled !== false,
      edgeWear: preset.erosion.edgeWear?.enabled !== false,
    },
    overlay: { moss: 0, snow: 0, useMossTexture: true, useSnowTexture: true },
    style: 'pbr',
    // Per-species semantic-knob values (Phase 2). Populated below from controls[].
    params: {},
  };
}

/**
 * Build a fresh controls object for a species: shared defaults + every
 * species-specific `controls[]` entry read through its `get(preset)`.
 *
 * @param {object} preset  a species preset
 * @returns {object} a controls object (compatible with legacy `state` + `params`)
 */
export function controlsFromSpecies(preset) {
  const c = sharedDefaults(preset);
  for (const d of preset.controls ?? []) {
    c.params[d.key] = d.get(preset);
  }
  return c;
}

/**
 * Apply a controls object onto a deep clone of a preset, producing the "shaped"
 * preset the generator consumes. Both legacy fields (shape/erosion/overlay) and
 * the new per-species `params` are written back.
 *
 * Legacy field mapping mirrors the old `applyOverrides()` in ui/controls.js, so
 * this function is a drop-in superset of it.
 *
 * @param {object} preset
 * @param {object} c  controls object (from controlsFromSpecies, or a partial override)
 * @returns {object} a new preset with overrides applied
 */
export function applySpeciesControls(preset, c = {}) {
  const s = {
    ...preset,
    shape: { ...preset.shape },
    noise: { ...preset.noise },
    erosion: {
      thermal: { ...preset.erosion.thermal },
      hydraulic: { ...preset.erosion.hydraulic },
      edgeWear: { ...preset.erosion.edgeWear },
      // Domokos pass is opt-in; clone when present so set() cannot mutate the
      // shared species registry entry.
      ...(preset.erosion.pebbleAbrade
        ? { pebbleAbrade: { ...preset.erosion.pebbleAbrade } }
        : {}),
    },
  };

  // Legacy shape/noise fields.
  if (c.shape) {
    if (c.shape.radius !== undefined) s.shape.radius = c.shape.radius;
    if (c.shape.detail !== undefined) s.shape.detail = Math.round(c.shape.detail);
    if (c.shape.squash !== undefined) s.shape.squash = c.shape.squash;
    if (c.shape.amplitude !== undefined) s.noise.amplitude = c.shape.amplitude;
  }
  // Legacy erosion enable toggles.
  if (c.erosion) {
    if (c.erosion.thermal !== undefined) s.erosion.thermal.enabled = c.erosion.thermal;
    if (c.erosion.hydraulic !== undefined) s.erosion.hydraulic.enabled = c.erosion.hydraulic;
    if (c.erosion.edgeWear !== undefined) s.erosion.edgeWear.enabled = c.erosion.edgeWear;
  }

  // Per-species semantic knobs: each `set(preset, v)` writes its own field(s).
  // Only keys declared in the species' controls[] are honored — unknown keys in
  // c.params are ignored (no silent field clobbering).
  const declared = new Set((preset.controls ?? []).map((d) => d.key));
  for (const d of preset.controls ?? []) {
    if (d.key in (c.params ?? {})) d.set(s, c.params[d.key]);
  }
  // `declared` is exported implicitly via controls[]; keeping the variable makes
  // the contract explicit for readers (and future validators).
  void declared;

  return s;
}

/**
 * Merge a partial controls override over a base controls object (shallow on the
 * legacy sub-objects, deep on `params` so setting one knob doesn't wipe others).
 * Mirrors SeedThree's `mergeControls`.
 *
 * @param {object} base
 * @param {object} override
 * @returns {object}
 */
export function mergeControls(base, override = {}) {
  const out = { ...base, ...override };
  out.shape = { ...(base.shape ?? {}), ...(override.shape ?? {}) };
  out.erosion = { ...(base.erosion ?? {}), ...(override.erosion ?? {}) };
  out.overlay = { ...(base.overlay ?? {}), ...(override.overlay ?? {}) };
  out.params = { ...(base.params ?? {}), ...(override.params ?? {}) };
  return out;
}
