// Surface paint of the toolkit's primitives: a colour with opacity, optionally
// a two-stop gradient (each stop with its own opacity), optionally a picture
// mapped on top with tiling, offset, rotation and a wrap mode.
//
// The same maths runs twice: in WGSL for the viewport (paintChunkWGSL) and in
// TypeScript for the conversion to splats and the light bake (createPaint), so
// what you see on the mesh is what the splats get. Colours are in display
// (sRGB) space, like the primitives' plain colour; gradients blend with
// premultiplied alpha, so the colour of a fully transparent stop never bleeds
// into the visible one.

type Rgb = [number, number, number];

type PaintGradient = {
    color: Rgb;                 // end stop (the start stop is the primitive's own colour)
    opacity: number;            // end stop opacity
    type: 'linear' | 'radial';
    // surface: follows the mesh's uv layout (planes: across the plane;
    // backdrop: from its front edge up the wall). object: in the primitive's
    // own space, angle 0 = bottom to top
    space: 'surface' | 'object';
    angle: number;              // degrees
    start: number;              // where the transition starts, 0..1 along the direction
    end: number;                // where it ends
    balance: number;            // 0..1: where between start and end it is half way
    smooth: boolean;            // ease in / out instead of a straight blend
};

type PaintWrap = 'repeat' | 'mirror' | 'clamp' | 'decal';

type PaintTexture = {
    image: string;              // data url
    name: string;
    tiling: [number, number];   // repeats across the surface
    offset: [number, number];   // in repeats
    rotation: number;           // degrees
    wrap: PaintWrap;
};

const defaultGradient = (): PaintGradient => ({
    color: [1, 1, 1],
    opacity: 0,
    type: 'linear',
    space: 'surface',
    angle: 90,
    start: 0,
    end: 1,
    balance: 0.5,
    smooth: false
});

const defaultTexture = (image: string, name: string): PaintTexture => ({
    image,
    name,
    tiling: [1, 1],
    offset: [0, 0],
    rotation: 0,
    wrap: 'repeat'
});

const wrapModes: PaintWrap[] = ['repeat', 'mirror', 'clamp', 'decal'];

// exponent that puts the half-way point of the blend at `balance`
const balanceExponent = (balance: number) => {
    const b = Math.min(0.95, Math.max(0.05, balance));
    return Math.log(0.5) / Math.log(b);
};

// uv -> texture uv, as two rows of a 2x3 matrix: centred, scaled by the
// tiling, turned and shifted
const textureMatrix = (t: PaintTexture): [number, number, number, number, number, number] => {
    const a = -t.rotation * Math.PI / 180;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const [sx, sy] = t.tiling;
    // texUv = R * S * (uv - 0.5) + 0.5 - offset
    const m00 = c * sx, m01 = -s * sy;
    const m10 = s * sx, m11 = c * sy;
    return [
        m00, m01, -0.5 * (m00 + m01) + 0.5 - t.offset[0],
        m10, m11, -0.5 * (m10 + m11) + 0.5 - t.offset[1]
    ];
};

type PaintState = {
    color: Rgb;
    opacity: number;
    gradient: PaintGradient | null;
    texture: PaintTexture | null;
};

type PaintPixels = { width: number, height: number, data: Uint8ClampedArray };

// whether anything about the paint can make the surface see-through
const paintHasAlpha = (p: PaintState, pixels: PaintPixels | null) => {
    if (p.opacity < 0.999) return true;
    if (p.gradient && p.gradient.opacity < 0.999) return true;
    if (p.texture && p.texture.wrap !== 'decal' && pixels) {
        for (let i = 3; i < pixels.data.length; i += 4) {
            if (pixels.data[i] < 255) return true;
        }
    }
    return false;
};

// whether the paint's opacity changes with the position in the primitive's own space
const paintAlphaUsesObjectSpace = (p: PaintState) => !!p.gradient && p.gradient.space === 'object' &&
    (p.gradient.opacity < 0.999 || p.opacity < 0.999);

const frac = (x: number) => x - Math.floor(x);

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const toDisplay = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

// a picture's mip chain: each level the 2x2 average of the one before, in
// linear light and premultiplied by alpha (so see-through pixels don't bleed)
type MipLevel = { width: number, height: number, data: Float32Array };
const mipChains = new WeakMap<PaintPixels, MipLevel[]>();
const mipChainOf = (pixels: PaintPixels) => {
    let chain = mipChains.get(pixels);
    if (chain) return chain;
    const { width, height, data } = pixels;
    const base = new Float32Array(width * height * 4);
    for (let i = 0; i < width * height; ++i) {
        const a = data[i * 4 + 3] / 255;
        for (let c = 0; c < 3; ++c) base[i * 4 + c] = toLinear(data[i * 4 + c] / 255) * a;
        base[i * 4 + 3] = a;
    }
    chain = [{ width, height, data: base }];
    let level = chain[0];
    while (level.width > 1 || level.height > 1) {
        const w = Math.max(1, level.width >> 1);
        const h = Math.max(1, level.height >> 1);
        const next = new Float32Array(w * h * 4);
        for (let y = 0; y < h; ++y) {
            for (let x = 0; x < w; ++x) {
                for (let c = 0; c < 4; ++c) {
                    let sum = 0;
                    for (let dy = 0; dy < 2; ++dy) {
                        for (let dx = 0; dx < 2; ++dx) {
                            sum += level.data[(Math.min(level.height - 1, y * 2 + dy) * level.width + Math.min(level.width - 1, x * 2 + dx)) * 4 + c];
                        }
                    }
                    next[(y * w + x) * 4 + c] = sum / 4;
                }
            }
        }
        level = { width: w, height: h, data: next };
        chain.push(level);
    }
    mipChains.set(pixels, chain);
    return chain;
};

/**
 * The paint as a function of a surface point: `uv` from the mesh, `local` the
 * point in the primitive's own (unscaled) space. Writes display-space rgb and
 * straight alpha into `out`.
 */
const createPaint = (p: PaintState, half: Rgb, pixels: PaintPixels | null) => {
    const g = p.gradient;
    const angle = (g?.angle ?? 0) * Math.PI / 180;
    const ca = Math.cos(angle);
    const sa = Math.sin(angle);
    const exponent = g ? balanceExponent(g.balance) : 1;
    const t = p.texture && pixels ? p.texture : null;
    const m = t ? textureMatrix(t) : null;
    const wrap = t ? wrapModes.indexOf(t.wrap) : -1;
    // texels per unit of the surface's uv area
    const texelDensity = t ? pixels.width * pixels.height * Math.abs(m[0] * m[4] - m[1] * m[3]) : 0;

    // texel index along one axis of a level, wrapping like the picture
    const index = (i: number, n: number) => {
        if (wrap === 0) return ((i % n) + n) % n;
        if (wrap === 1) {
            const k = ((i % (2 * n)) + 2 * n) % (2 * n);
            return k < n ? k : 2 * n - 1 - k;
        }
        return Math.min(n - 1, Math.max(0, i));
    };
    const mipA = [0, 0, 0, 0];
    const mipB = [0, 0, 0, 0];
    const bilinear = (level: MipLevel, tu: number, tv: number, o4: number[]) => {
        const x = tu * level.width - 0.5;
        const y = tv * level.height - 0.5;
        const x0 = Math.floor(x);
        const y0 = Math.floor(y);
        const fx = x - x0;
        const fy = y - y0;
        const ax = index(x0, level.width), bx = index(x0 + 1, level.width);
        const ay = index(y0, level.height), by = index(y0 + 1, level.height);
        const d = level.data;
        const w = level.width;
        for (let c = 0; c < 4; ++c) {
            o4[c] = (d[(ay * w + ax) * 4 + c] * (1 - fx) + d[(ay * w + bx) * 4 + c] * fx) * (1 - fy) +
                (d[(by * w + ax) * 4 + c] * (1 - fx) + d[(by * w + bx) * 4 + c] * fx) * fy;
        }
    };

    // `footprint`: the uv area one sample stands for. Given, the picture is
    // read as its average over that area (a mip level, trilinear), not as one
    // pixel: clean at any splat density.
    const paint = (u: number, v: number, lx: number, ly: number, lz: number, out: Float32Array, footprint = 0) => {
        let r = p.color[0], gg = p.color[1], b = p.color[2], a = p.opacity;
        if (g) {
            let k: number;
            if (g.space === 'object') {
                const qx = lx / Math.max(half[0], 1e-6);
                const qy = ly / Math.max(half[1], 1e-6);
                const qz = lz / Math.max(half[2], 1e-6);
                k = g.type === 'radial' ? Math.hypot(qx, qz) : (qx * sa + qy * ca) / (Math.abs(sa) + Math.abs(ca)) * 0.5 + 0.5;
            } else {
                const px = u - 0.5;
                const py = v - 0.5;
                k = g.type === 'radial' ? Math.hypot(px, py) * 2 : (px * ca + py * sa) / (Math.abs(ca) + Math.abs(sa)) + 0.5;
            }
            const span = g.end - g.start;
            k = Math.abs(span) > 1e-5 ? Math.min(1, Math.max(0, (k - g.start) / span)) : (k >= g.start ? 1 : 0);
            k = Math.pow(k, exponent);
            if (g.smooth) k = k * k * (3 - 2 * k);
            const a0 = p.opacity, a1 = g.opacity;
            const ma = a0 + (a1 - a0) * k;
            if (ma > 1e-5) {
                r = (p.color[0] * a0 + (g.color[0] * a1 - p.color[0] * a0) * k) / ma;
                gg = (p.color[1] * a0 + (g.color[1] * a1 - p.color[1] * a0) * k) / ma;
                b = (p.color[2] * a0 + (g.color[2] * a1 - p.color[2] * a0) * k) / ma;
            }
            a = ma;
        }
        if (t) {
            const tu = m[0] * u + m[1] * v + m[2];
            const tv = m[3] * u + m[4] * v + m[5];
            let wu: number, wv: number;
            if (wrap === 0) {
                wu = frac(tu); wv = frac(tv);
            } else if (wrap === 1) {
                wu = 1 - Math.abs(frac(tu * 0.5) * 2 - 1);
                wv = 1 - Math.abs(frac(tv * 0.5) * 2 - 1);
            } else {
                wu = Math.min(1, Math.max(0, tu));
                wv = Math.min(1, Math.max(0, tv));
            }
            let tr: number, tg: number, tb: number, ta: number;
            const lod = footprint > 0 ? 0.5 * Math.log2(footprint * texelDensity) : 0;
            if (lod > 0.25) {
                const chain = mipChainOf(pixels);
                const l = Math.min(chain.length - 1, lod);
                const l0 = Math.floor(l);
                const l1 = Math.min(chain.length - 1, l0 + 1);
                const k = l - l0;
                // the unwrapped coordinates: the level's own wrapping applies
                const cu = wrap === 0 || wrap === 1 ? tu : wu;
                const cv = wrap === 0 || wrap === 1 ? tv : wv;
                bilinear(chain[l0], cu, cv, mipA);
                if (k > 0 && l1 !== l0) {
                    bilinear(chain[l1], cu, cv, mipB);
                    for (let c = 0; c < 4; ++c) mipA[c] += (mipB[c] - mipA[c]) * k;
                }
                ta = mipA[3];
                const inv = ta > 1e-6 ? 1 / ta : 0;
                tr = toDisplay(Math.min(1, mipA[0] * inv));
                tg = toDisplay(Math.min(1, mipA[1] * inv));
                tb = toDisplay(Math.min(1, mipA[2] * inv));
            } else {
                const x = Math.min(pixels.width - 1, Math.floor(wu * pixels.width));
                const y = Math.min(pixels.height - 1, Math.floor(wv * pixels.height));
                const o = (y * pixels.width + x) * 4;
                tr = pixels.data[o] / 255;
                tg = pixels.data[o + 1] / 255;
                tb = pixels.data[o + 2] / 255;
                ta = pixels.data[o + 3] / 255;
            }
            if (wrap === 3) {
                const inside = tu >= 0 && tu <= 1 && tv >= 0 && tv <= 1;
                const kk = inside ? ta : 0;
                r += (tr - r) * kk;
                gg += (tg - gg) * kk;
                b += (tb - b) * kk;
            } else {
                r *= tr; gg *= tg; b *= tb; a *= ta;
            }
        }
        out[0] = r;
        out[1] = gg;
        out[2] = b;
        out[3] = a;
    };
    return paint;
};

type PaintFunction = ReturnType<typeof createPaint>;

// Overlapping gaussians stack their opacity: on a surface sampled every cell
// with gaussians `sigma` cells wide, a point is covered by several of them at
// once, so each needs less opacity than the coverage wanted. This finds the
// per-gaussian opacity that gives `coverage` on average, from a table per sigma.
const coverageTables = new Map<number, Float32Array>();

const coverageOpacity = (coverage: number, sigma: number) => {
    if (coverage >= 0.999) return coverage;
    if (coverage <= 0) return 0;
    let table = coverageTables.get(sigma);
    if (!table) {
        // weights of the lattice neighbours, at a few spots inside a cell
        const reach = Math.ceil(sigma * 3.5);
        const spots: number[][] = [];
        for (let sy = 0; sy < 4; ++sy) {
            for (let sx = 0; sx < 4; ++sx) {
                const px = (sx + 0.5) / 4;
                const py = (sy + 0.5) / 4;
                const weights: number[] = [];
                for (let j = -reach; j <= reach + 1; ++j) {
                    for (let i = -reach; i <= reach + 1; ++i) {
                        const d2 = (i - px) ** 2 + (j - py) ** 2;
                        const w = Math.exp(-0.5 * d2 / (sigma * sigma));
                        if (w > 1e-4) weights.push(w);
                    }
                }
                spots.push(weights);
            }
        }
        // coverage as a function of the per-gaussian opacity, sampled finely
        const steps = 1024;
        const covered = new Float32Array(steps + 1);
        for (let k = 0; k <= steps; ++k) {
            const a = k / steps;
            let mean = 0;
            spots.forEach((weights) => {
                let t = 1;
                weights.forEach((w) => {
                    t *= 1 - a * w;
                });
                mean += 1 - t;
            });
            covered[k] = mean / spots.length;
        }
        // inverted into a table over the wanted coverage
        table = new Float32Array(257);
        let k = 0;
        for (let i = 0; i <= 256; ++i) {
            const want = i / 256;
            while (k < steps && covered[k + 1] < want) k++;
            const lo = covered[k];
            const hi = covered[Math.min(steps, k + 1)];
            const f = hi > lo ? (want - lo) / (hi - lo) : 0;
            table[i] = Math.min(1, (k + f) / steps);
        }
        coverageTables.set(sigma, table);
    }
    const x = coverage * 256;
    const i = Math.min(255, Math.floor(x));
    return table[i] + (table[i + 1] - table[i]) * (x - i);
};

const paintChunkWGSL = /* wgsl */`
uniform primAlpha: f32;
uniform primColorB: vec4f;
// x: gradient on, y: radial, z: object space, w: angle (radians)
uniform primGrad: vec4f;
// x: start, y: end, z: balance exponent, w: smooth
uniform primGradRange: vec4f;
uniform primHalf: vec3f;
// 0: no picture, 1 repeat, 2 mirror, 3 clamp, 4 decal
uniform primTexMode: f32;
uniform primTexRow0: vec3f;
uniform primTexRow1: vec3f;
var primPaintTex: texture_2d<f32>;
var primPaintTex_sampler: sampler;

fn paintColor(uv: vec2f, local: vec3f) -> vec4f {
    var c = vec4f(uniform.primColor, uniform.primAlpha);
    let g = uniform.primGrad;
    if (g.x > 0.5) {
        var k: f32;
        let ca = cos(g.w);
        let sa = sin(g.w);
        if (g.z > 0.5) {
            let q = local / max(uniform.primHalf, vec3f(1e-6));
            if (g.y > 0.5) {
                k = length(q.xz);
            } else {
                k = (q.x * sa + q.y * ca) / (abs(sa) + abs(ca)) * 0.5 + 0.5;
            }
        } else {
            let p = uv - vec2f(0.5);
            if (g.y > 0.5) {
                k = length(p) * 2.0;
            } else {
                k = (p.x * ca + p.y * sa) / (abs(ca) + abs(sa)) + 0.5;
            }
        }
        let r = uniform.primGradRange;
        let span = r.y - r.x;
        if (abs(span) > 1e-5) {
            k = clamp((k - r.x) / span, 0.0, 1.0);
        } else {
            k = select(0.0, 1.0, k >= r.x);
        }
        k = pow(k, r.z);
        if (r.w > 0.5) {
            k = k * k * (3.0 - 2.0 * k);
        }
        let b = uniform.primColorB;
        let ma = mix(c.a, b.a, k);
        let rgb = (c.rgb * c.a + (b.rgb * b.a - c.rgb * c.a) * k) / max(ma, 1e-5);
        c = vec4f(select(c.rgb, rgb, ma > 1e-5), ma);
    }
    let mode = uniform.primTexMode;
    if (mode > 0.5) {
        let tuv = vec2f(dot(uniform.primTexRow0, vec3f(uv, 1.0)), dot(uniform.primTexRow1, vec3f(uv, 1.0)));
        var w: vec2f;
        if (mode < 1.5) {
            w = fract(tuv);
        } else if (mode < 2.5) {
            w = vec2f(1.0) - abs(fract(tuv * 0.5) * 2.0 - vec2f(1.0));
        } else {
            w = clamp(tuv, vec2f(0.0), vec2f(1.0));
        }
        // derivatives of the unwrapped coordinates: no seams where the
        // picture repeats
        let texel = textureSampleGrad(primPaintTex, primPaintTex_sampler, w, dpdx(tuv), dpdy(tuv));
        if (mode > 3.5) {
            let inside = all(tuv >= vec2f(0.0)) && all(tuv <= vec2f(1.0));
            let kk = select(0.0, texel.a, inside);
            c = vec4f(mix(c.rgb, texel.rgb, kk), c.a);
        } else {
            c = c * texel;
        }
    }
    return c;
}
`;

// the uniforms paintChunkWGSL reads, for a mesh instance
const paintUniforms = (p: PaintState, half: Rgb, hasTexture: boolean) => {
    const g = p.gradient;
    const t = p.texture && hasTexture ? p.texture : null;
    const m = t ? textureMatrix(t) : [1, 0, 0, 0, 1, 0];
    return {
        primAlpha: p.opacity,
        primColorB: g ? [g.color[0], g.color[1], g.color[2], g.opacity] : [0, 0, 0, 0],
        primGrad: [g ? 1 : 0, g?.type === 'radial' ? 1 : 0, g?.space === 'object' ? 1 : 0, (g?.angle ?? 0) * Math.PI / 180],
        primGradRange: [g?.start ?? 0, g?.end ?? 1, g ? balanceExponent(g.balance) : 1, g?.smooth ? 1 : 0],
        primHalf: half,
        primTexMode: t ? wrapModes.indexOf(t.wrap) + 1 : 0,
        primTexRow0: [m[0], m[1], m[2]],
        primTexRow1: [m[3], m[4], m[5]]
    };
};

// CSS for a preview of the gradient (over a checkerboard, so opacity shows)
const gradientCss = (p: PaintState) => {
    const css = (c: Rgb, a: number) => `rgba(${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(c[2] * 255)}, ${a.toFixed(3)})`;
    if (!p.gradient) return css(p.color, p.opacity);
    const g = p.gradient;
    const exponent = balanceExponent(g.balance);
    const stops: string[] = [];
    for (let i = 0; i <= 16; ++i) {
        const x = i / 16;
        const span = g.end - g.start;
        let k = Math.abs(span) > 1e-5 ? Math.min(1, Math.max(0, (x - g.start) / span)) : (x >= g.start ? 1 : 0);
        k = Math.pow(k, exponent);
        if (g.smooth) k = k * k * (3 - 2 * k);
        const ma = p.opacity + (g.opacity - p.opacity) * k;
        const rgb: Rgb = ma > 1e-5 ? [0, 1, 2].map(c => (p.color[c] * p.opacity + (g.color[c] * g.opacity - p.color[c] * p.opacity) * k) / ma) as Rgb : p.color;
        stops.push(`${css(rgb, ma)} ${(x * 100).toFixed(1)}%`);
    }
    return `linear-gradient(to right, ${stops.join(', ')})`;
};

export {
    PaintGradient, PaintTexture, PaintWrap, PaintState, PaintPixels, PaintFunction,
    defaultGradient, defaultTexture, wrapModes, textureMatrix, balanceExponent,
    createPaint, coverageOpacity, paintHasAlpha, paintAlphaUsesObjectSpace, paintChunkWGSL, paintUniforms, gradientCss
};
