import { LIGHT_FLOATS, MAX_PREVIEW_LIGHTS } from './shading';

// Studio lights as the splat renderer sees them. The studio module fills this
// every frame; the projector pass reads it (see projected-splat-renderer.ts)
// and lights every splat layer whose `studioMask` has bits set.
const splatLighting = {
    count: 0,
    lights: new Float32Array(MAX_PREVIEW_LIGHTS * LIGHT_FLOATS),
    // how much of the splats' own (captured) light is kept, 1 = all of it
    base: 1,
    // linear multiplier of the lamps' light
    exposure: 1
};

export { splatLighting };
