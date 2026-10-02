// The lighting model shared by the viewport preview (WGSL below) and the bake
// (shade-kernel.ts). Both follow the same formulas so that what the meshes show
// while lights are placed is what the splats get:
//
//  - radiance is computed in linear space without the 1/pi of the Lambert
//    term: a white surface lit with irradiance 1 has radiance 1
//  - diffuse: base colour x (1 - metalness) x irradiance, area lights are
//    integrated over a small grid of points on the emitter
//  - specular: GGX with Smith visibility and Schlick fresnel, the light's size
//    widening the lobe (a big softbox gives a broad, soft highlight)
//  - ambient: a sky / ground hemisphere, diffuse plus a reflection term
//  - display: exposure, tone mapping, then sRGB encoding
//
// Lights are packed into LIGHT_VEC4S vec4s each, identical for both consumers.

const MAX_PREVIEW_LIGHTS = 16;
const LIGHT_VEC4S = 6;
const LIGHT_FLOATS = LIGHT_VEC4S * 4;

// light types
const LT_POINT = 0;     // bulb: a small sphere radiating in all directions
const LT_SPOT = 1;      // fresnel: a lens of `size`, beam limited to a cone
const LT_RECT = 2;      // softbox / panel: a rectangle emitting forwards
const LT_DISK = 3;      // umbrella / beauty dish: a disk emitting forwards
const LT_SUN = 4;       // directional, `angle` = angular radius of the sun disk
const LT_RING = 5;      // ring light: an annulus emitting forwards

// packed layout (floats):
//  0..2  position              3  type
//  4..6  forward (beam axis)   7  width (diameter for point/spot/disk/ring)
//  8..10 up (rect orientation) 11 height (rect only)
//  12..14 linear colour x intensity, 15 casts shadows (0/1)
//  16 cos outer cone, 17 cos inner cone, 18 emitter falloff exponent, 19 sun angular radius (rad)
//  20 ring inner radius ratio, 21..23 spare

// splat lighting: where added light starts to roll off, and the share of a
// light that a round (not flat) gaussian receives
const SPLAT_KNEE = 0.8;
const SPLAT_OMNI = 0.5;

const TONEMAP_NONE = 0;
const TONEMAP_FILMIC = 1;
const TONEMAP_NEUTRAL = 2;

// smallest GGX alpha the splats' view-dependent colour (SH of a given degree)
// can still show as a highlight: sharper highlights are blurred by the bake,
// so the preview blurs them the same way
const minAlphaForDegree = (degree: number) => [1.0, 0.72, 0.5, 0.38][degree] ?? 0.38;

// ---- JS reference versions (used on the main thread, e.g. auto exposure)

const tonemapFilmic = (x: number) => {
    // Narkowicz ACES fit
    const v = (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14);
    return Math.min(1, Math.max(0, v));
};

// Khronos PBR Neutral, per channel helper operates on rgb triples
const tonemapNeutral = (rgb: number[]) => {
    const startCompression = 0.8 - 0.04;
    const desaturation = 0.15;
    let [r, g, b] = rgb;
    const x = Math.min(r, g, b);
    const offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
    r -= offset; g -= offset; b -= offset;
    const peak = Math.max(r, g, b);
    if (peak < startCompression) return [r, g, b];
    const d = 1 - startCompression;
    const newPeak = 1 - d * d / (peak + d - startCompression);
    r *= newPeak / peak; g *= newPeak / peak; b *= newPeak / peak;
    const gm = 1 - 1 / (desaturation * (peak - newPeak) + 1);
    return [r * (1 - gm) + newPeak * gm, g * (1 - gm) + newPeak * gm, b * (1 - gm) + newPeak * gm];
};

// access to the packed lights, for a given uniform array expression
const lightFunctionsWGSL = (source: string) => /* wgsl */`
fn studioLight(i: i32, k: i32) -> vec4f {
    return ${source}[i * ${LIGHT_VEC4S} + k];
}

// emission of light i towards direction w (from the light to the point)
fn studioEmit(i: i32, w: vec3f) -> f32 {
    let p0 = studioLight(i, 0);
    let p1 = studioLight(i, 1);
    let p4 = studioLight(i, 4);
    let t = i32(p0.w + 0.5);
    let c = dot(p1.xyz, w);
    if (t == ${LT_SPOT}) {
        return smoothstep(p4.x, p4.y, c);
    }
    if (t == ${LT_RECT} || t == ${LT_DISK} || t == ${LT_RING}) {
        return pow(max(c, 0.0), p4.z);
    }
    return 1.0;
}

// emitter point (u, v in -1..1) of light i
fn studioEmitterPoint(i: i32, u: f32, v: f32) -> vec3f {
    let p0 = studioLight(i, 0);
    let p1 = studioLight(i, 1);
    let p2 = studioLight(i, 2);
    let p5 = studioLight(i, 5);
    let t = i32(p0.w + 0.5);
    let up = p2.xyz;
    let right = normalize(cross(p1.xyz, up));
    if (t == ${LT_RECT}) {
        return p0.xyz + right * (u * p1.w * 0.5) + up * (v * p2.w * 0.5);
    }
    if (t == ${LT_DISK} || t == ${LT_RING}) {
        // concentric-ish mapping of the square onto the disk / ring
        let a = atan2(v, u);
        let r = max(abs(u), abs(v));
        let inner = select(0.0, p5.x, t == ${LT_RING});
        let rr = mix(inner, 1.0, r) * p1.w * 0.5;
        return p0.xyz + right * (cos(a) * rr) + up * (sin(a) * rr);
    }
    return p0.xyz;
}
`;

// ---- WGSL, included by every mesh-primitive fragment shader

const litChunkWGSL = /* wgsl */`
uniform studioCount: f32;
uniform studioLights: array<vec4f, ${MAX_PREVIEW_LIGHTS * LIGHT_VEC4S}>;
uniform studioSky: vec3f;
uniform studioGround: vec3f;
uniform studioExposure: f32;
uniform studioTonemap: f32;
uniform studioMinAlpha: f32;
uniform primRoughness: f32;
uniform primMetalness: f32;
// bit i set = light i reaches this mesh (lights can be limited to chosen objects)
uniform primStudioMask: f32;

fn studioSrgbToLinear(c: vec3f) -> vec3f {
    let lo = c / 12.92;
    let hi = pow((max(c, vec3f(0.0)) + 0.055) / 1.055, vec3f(2.4));
    return select(hi, lo, c <= vec3f(0.04045));
}

fn studioLinearToSrgb(c: vec3f) -> vec3f {
    let lo = c * 12.92;
    let hi = 1.055 * pow(max(c, vec3f(0.0)), vec3f(1.0 / 2.4)) - 0.055;
    return select(hi, lo, c <= vec3f(0.0031308));
}

fn studioTonemapColor(x: vec3f) -> vec3f {
    if (uniform.studioTonemap > 1.5) {
        // Khronos PBR Neutral
        var c = x;
        let m = min(c.r, min(c.g, c.b));
        let offset = select(0.04, m - 6.25 * m * m, m < 0.08);
        c = c - vec3f(offset);
        let peak = max(c.r, max(c.g, c.b));
        let startCompression = 0.76;
        if (peak < startCompression) {
            return clamp(c, vec3f(0.0), vec3f(1.0));
        }
        let d = 1.0 - startCompression;
        let newPeak = 1.0 - d * d / (peak + d - startCompression);
        c = c * (newPeak / peak);
        let g = 1.0 - 1.0 / (0.15 * (peak - newPeak) + 1.0);
        return clamp(mix(c, vec3f(newPeak), g), vec3f(0.0), vec3f(1.0));
    }
    if (uniform.studioTonemap > 0.5) {
        return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), vec3f(0.0), vec3f(1.0));
    }
    return clamp(x, vec3f(0.0), vec3f(1.0));
}

${lightFunctionsWGSL('uniform.studioLights')}
fn studioGgx(nIn: vec3f, v: vec3f, l: vec3f, alpha: f32, f0: vec3f) -> vec3f {
    let h = normalize(l + v);
    let nl = max(dot(nIn, l), 1e-4);
    let nv = max(dot(nIn, v), 1e-4);
    let nh = max(dot(nIn, h), 0.0);
    let vh = max(dot(v, h), 0.0);
    let a2 = alpha * alpha;
    let dd = nh * nh * (a2 - 1.0) + 1.0;
    let D = a2 / (3.14159265 * dd * dd);
    let k = alpha * 0.5;
    let G = (nl / (nl * (1.0 - k) + k)) * (nv / (nv * (1.0 - k) + k));
    let F = f0 + (vec3f(1.0) - f0) * pow(1.0 - vh, 5.0);
    // times pi: radiance is kept without the lambert 1/pi
    return 3.14159265 * D * G * F / (4.0 * nv);
}

// displayColor: the surface colour as the unlit editor shows it (sRGB)
// fallback: what to draw when the studio has no lights
fn studioShade(displayColor: vec3f, nIn: vec3f, worldPos: vec3f, viewPos: vec3f, fallback: vec3f) -> vec3f {
    let count = i32(uniform.studioCount + 0.5);
    if (count == 0) {
        return fallback;
    }

    let albedo = studioSrgbToLinear(displayColor);
    let v = normalize(viewPos - worldPos);
    // thin and closed surfaces alike are lit on the side that faces the viewer
    var n = normalize(nIn);
    if (dot(n, v) < 0.0) {
        n = -n;
    }
    let rough = clamp(uniform.primRoughness, 0.045, 1.0);
    let metal = clamp(uniform.primMetalness, 0.0, 1.0);
    let alpha = rough * rough;
    let diffuseColor = albedo * (1.0 - metal);
    let f0 = mix(vec3f(0.04), albedo, metal);

    var radiance = vec3f(0.0);
    let mask = u32(uniform.primStudioMask + 0.5);
    for (var i = 0; i < count; i++) {
        if (((mask >> u32(i)) & 1u) == 0u) {
            continue;
        }
        let p0 = studioLight(i, 0);
        let p1 = studioLight(i, 1);
        let p3 = studioLight(i, 3);
        let p4 = studioLight(i, 4);
        let t = i32(p0.w + 0.5);
        let intensity = p3.xyz;

        if (t == ${LT_SUN}) {
            let l = -p1.xyz;
            let nl = max(dot(n, l), 0.0);
            if (nl > 0.0) {
                let a = max(min(1.0, alpha + p4.w * 0.5), uniform.studioMinAlpha);
                radiance += intensity * nl * (diffuseColor + studioGgx(n, v, l, a, f0));
            }
            continue;
        }

        // diffuse: integrate the emitter over a 3x3 grid (1 point for small lights)
        var irradiance = 0.0;
        let grid = select(1, 3, t == ${LT_RECT} || t == ${LT_DISK} || t == ${LT_RING});
        for (var gy = 0; gy < grid; gy++) {
            for (var gx = 0; gx < grid; gx++) {
                let u = select(0.0, (f32(gx) + 0.5) / f32(grid) * 2.0 - 1.0, grid > 1);
                let w = select(0.0, (f32(gy) + 0.5) / f32(grid) * 2.0 - 1.0, grid > 1);
                let q = studioEmitterPoint(i, u, w);
                let d = q - worldPos;
                let d2 = max(dot(d, d), 1e-6);
                let l = d * inverseSqrt(d2);
                irradiance += studioEmit(i, -l) * max(dot(n, l), 0.0) / d2;
            }
        }
        irradiance /= f32(grid * grid);
        radiance += intensity * irradiance * diffuseColor;

        // specular from the emitter centre, the lobe widened by the emitter size
        let d = p0.xyz - worldPos;
        let dist = max(length(d), 1e-4);
        let l = d / dist;
        let nl = max(dot(n, l), 0.0);
        if (nl > 0.0) {
            let radius = select(p1.w, sqrt(p1.w * studioLight(i, 2).w), t == ${LT_RECT}) * 0.5;
            let a = max(min(1.0, alpha + radius / (2.0 * dist)), uniform.studioMinAlpha);
            let e = studioEmit(i, -l) * nl / (dist * dist);
            radiance += intensity * e * studioGgx(n, v, l, a, f0);
        }
    }

    // ambient sky / ground: diffuse plus a blurred reflection
    let ambientDiffuse = mix(uniform.studioGround, uniform.studioSky, 0.5 + 0.5 * n.y);
    radiance += diffuseColor * ambientDiffuse;
    let r = reflect(-v, n);
    let envSharp = mix(uniform.studioGround, uniform.studioSky, 0.5 + 0.5 * r.y);
    let env = mix(envSharp, ambientDiffuse, rough);
    let nv = max(dot(n, v), 0.0);
    let fEnv = f0 + (max(vec3f(1.0 - rough), f0) - f0) * pow(1.0 - nv, 5.0);
    radiance += env * fEnv;

    return studioLinearToSrgb(studioTonemapColor(radiance * uniform.studioExposure));
}
`;

// Studio light on an existing gaussian splat (live in the projector compute
// shader, and the same in the bake): the splat's colour is taken as its
// surface colour, the original light is kept (scaled by the base factor) and
// the lamps add diffuse light on top. The gaussian's shortest axis is its
// normal, as much as it is flat; round gaussians take light from every side.
const splatLightChunkWGSL = /* wgsl */`
${lightFunctionsWGSL('uniforms.studioLights')}

fn studioSplatSrgbToLinear(c: vec3f) -> vec3f {
    let lo = c / 12.92;
    let hi = pow((max(c, vec3f(0.0)) + 0.055) / 1.055, vec3f(2.4));
    return select(hi, lo, c <= vec3f(0.04045));
}

fn studioSplatLinearToSrgb(c: vec3f) -> vec3f {
    let lo = c * 12.92;
    let hi = 1.055 * pow(max(c, vec3f(0.0)), vec3f(1.0 / 2.4)) - 0.055;
    return select(hi, lo, c <= vec3f(0.0031308));
}

// soft roll-off of light added above white
fn studioSplatShoulder(x: vec3f) -> vec3f {
    let over = max(x - vec3f(${SPLAT_KNEE}), vec3f(0.0));
    return min(x, vec3f(${SPLAT_KNEE})) + (1.0 - ${SPLAT_KNEE}) * (vec3f(1.0) - exp(-over / (1.0 - ${SPLAT_KNEE})));
}

fn studioLightSplat(c: vec3f, p: vec3f, nIn: vec3f, flatness: f32, mask: u32) -> vec3f {
    let count = i32(uniforms.studioCount);
    let albedo = studioSplatSrgbToLinear(clamp(c, vec3f(0.0), vec3f(1.0)));
    var n = normalize(nIn);
    if (dot(n, uniforms.cameraPosition - p) < 0.0) {
        n = -n;
    }
    var e = vec3f(0.0);
    for (var i = 0; i < count; i++) {
        if (((mask >> u32(i)) & 1u) == 0u) {
            continue;
        }
        let p0 = studioLight(i, 0);
        let p1 = studioLight(i, 1);
        let p3 = studioLight(i, 3);
        let t = i32(p0.w + 0.5);
        if (t == ${LT_SUN}) {
            let l = -p1.xyz;
            e += p3.xyz * mix(${SPLAT_OMNI}, max(dot(n, l), 0.0), flatness);
            continue;
        }
        var irradiance = 0.0;
        let grid = select(1, 3, t == ${LT_RECT} || t == ${LT_DISK} || t == ${LT_RING});
        for (var gy = 0; gy < grid; gy++) {
            for (var gx = 0; gx < grid; gx++) {
                let u = select(0.0, (f32(gx) + 0.5) / f32(grid) * 2.0 - 1.0, grid > 1);
                let w = select(0.0, (f32(gy) + 0.5) / f32(grid) * 2.0 - 1.0, grid > 1);
                let q = studioEmitterPoint(i, u, w);
                let d = q - p;
                let d2 = max(dot(d, d), 1e-6);
                let l = d * inverseSqrt(d2);
                irradiance += studioEmit(i, -l) * mix(${SPLAT_OMNI}, max(dot(n, l), 0.0), flatness) / d2;
            }
        }
        e += p3.xyz * irradiance / f32(grid * grid);
    }
    let lit = albedo * (uniforms.studioBase + e * uniforms.studioExposure);
    return studioSplatLinearToSrgb(studioSplatShoulder(lit));
}
`;

export {
    SPLAT_KNEE, SPLAT_OMNI, splatLightChunkWGSL,
    MAX_PREVIEW_LIGHTS, LIGHT_VEC4S, LIGHT_FLOATS,
    LT_POINT, LT_SPOT, LT_RECT, LT_DISK, LT_SUN, LT_RING,
    TONEMAP_NONE, TONEMAP_FILMIC, TONEMAP_NEUTRAL,
    minAlphaForDegree, tonemapFilmic, tonemapNeutral, litChunkWGSL
};
