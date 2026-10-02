// Surface samples: one flat gaussian per sample, described before it is
// coloured. Every mesh-like source (primitives, extruded pictures, GLB models)
// fills a SampleBuffer; the result is then either written as is (unlit, the
// surface colour straight into the splat) or shaded by the studio lights first.
//
// Everything in here is in editor world space. Only the PLY writer moves the
// data into the PLY convention (rotated 180 degrees about Z, which the loader
// undoes), so a generated layer behaves like any imported file.

// floats per sample
const STRIDE = 23;

// offsets into a sample
const S_POS = 0;        // x y z
const S_ROT = 3;        // quaternion w x y z: the disc's frame (z = disc normal)
const S_SCALE = 7;      // linear sigma along the disc's x y z
const S_ALBEDO = 10;    // base colour, linear
const S_ALPHA = 13;     // coverage 0..1
const S_NORMAL = 14;    // shading normal (unit)
const S_ROUGH = 17;     // perceptual roughness 0..1
const S_METAL = 18;     // metalness 0..1
const S_TWO_SIDED = 19; // 1 = thin surface seen from both sides, 0 = closed
const S_SHADE = 20;     // brightness factor applied only when written unlit
const S_OCCLUDER = 21;  // occluder the sample lies on (skipped by its own shadow rays), -1 none
const S_LIGHTMASK = 22; // bit per light: which lights reach the sample

// every light (masks fit 24 bits exactly in a float)
const ALL_LIGHTS = 0xffffff;

const SH_C0 = 0.28209479177387814;

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const linearToSrgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

type SurfaceMaterial = {
    roughness: number;
    metalness: number;
    twoSided: boolean;
};

class SampleBuffer {
    data = new Float32Array(STRIDE * 4096);
    count = 0;

    private reserve(extra: number) {
        const needed = (this.count + extra) * STRIDE;
        if (needed > this.data.length) {
            let size = this.data.length;
            while (size < needed) size *= 2;
            const grown = new Float32Array(size);
            grown.set(this.data.subarray(0, this.count * STRIDE));
            this.data = grown;
        }
    }

    // returns the offset of a new, zeroed sample
    alloc() {
        this.reserve(1);
        const o = this.count * STRIDE;
        this.data.fill(0, o, o + STRIDE);
        this.data[o + S_OCCLUDER] = -1;
        this.data[o + S_SHADE] = 1;
        this.data[o + S_LIGHTMASK] = ALL_LIGHTS;
        this.count++;
        return o;
    }

    add(
        px: number, py: number, pz: number,
        qw: number, qx: number, qy: number, qz: number,
        sx: number, sy: number, sz: number,
        r: number, g: number, b: number, alpha: number,
        nx: number, ny: number, nz: number,
        material: SurfaceMaterial,
        shade = 1
    ) {
        const d = this.data;
        const o = this.alloc();
        d[o + S_POS] = px; d[o + S_POS + 1] = py; d[o + S_POS + 2] = pz;
        d[o + S_ROT] = qw; d[o + S_ROT + 1] = qx; d[o + S_ROT + 2] = qy; d[o + S_ROT + 3] = qz;
        d[o + S_SCALE] = sx; d[o + S_SCALE + 1] = sy; d[o + S_SCALE + 2] = sz;
        d[o + S_ALBEDO] = r; d[o + S_ALBEDO + 1] = g; d[o + S_ALBEDO + 2] = b;
        d[o + S_ALPHA] = alpha;
        d[o + S_NORMAL] = nx; d[o + S_NORMAL + 1] = ny; d[o + S_NORMAL + 2] = nz;
        d[o + S_ROUGH] = material.roughness;
        d[o + S_METAL] = material.metalness;
        d[o + S_TWO_SIDED] = material.twoSided ? 1 : 0;
        d[o + S_SHADE] = shade;
    }

    // tag samples [from, count) with the occluder they were taken from
    setOccluder(from: number, id: number) {
        for (let i = from; i < this.count; ++i) {
            this.data[i * STRIDE + S_OCCLUDER] = id;
        }
    }

    // set the light mask of samples [from, count)
    setLightMask(from: number, mask: number) {
        for (let i = from; i < this.count; ++i) {
            this.data[i * STRIDE + S_LIGHTMASK] = mask;
        }
    }

    append(other: SampleBuffer) {
        this.reserve(other.count);
        this.data.set(other.data.subarray(0, other.count * STRIDE), this.count * STRIDE);
        this.count += other.count;
    }

    get view() {
        return this.data.subarray(0, this.count * STRIDE);
    }
}

// Colours ready to write: f_dc per sample (3 floats) and, for SH degree > 0,
// the higher order coefficients per sample in the renderer's order
// (coefficient-major, rgb interleaved: k0.rgb, k1.rgb, ...).
type SplatColors = {
    dc: Float32Array;
    rest: Float32Array | null;
    degree: number;
};

const restCount = (degree: number) => [0, 3, 8, 15][degree];

// the surface colour as is, for scenes without studio lights
const unlitColors = (samples: SampleBuffer): SplatColors => {
    const d = samples.data;
    const dc = new Float32Array(samples.count * 3);
    for (let i = 0; i < samples.count; ++i) {
        const o = i * STRIDE;
        const shade = d[o + S_SHADE];
        for (let c = 0; c < 3; ++c) {
            const display = linearToSrgb(Math.min(1, Math.max(0, d[o + S_ALBEDO + c]))) * shade;
            dc[i * 3 + c] = (display - 0.5) / SH_C0;
        }
    }
    return { dc, rest: null, degree: 0 };
};

// Standard 3DGS PLY in the PLY convention: positions and frames are rotated
// 180 degrees about Z here, and the loader rotates them back. SH coefficients
// must already be expressed in that rotated space (the shader evaluates them
// in the layer's local frame).
const writeSplatPly = (samples: SampleBuffer, colors: SplatColors): Blob => {
    const { count, data: d } = samples;
    const nRest = restCount(colors.degree);
    const props = [
        'x', 'y', 'z',
        'f_dc_0', 'f_dc_1', 'f_dc_2',
        ...Array.from({ length: nRest * 3 }, (_, i) => `f_rest_${i}`),
        'opacity',
        'scale_0', 'scale_1', 'scale_2',
        'rot_0', 'rot_1', 'rot_2', 'rot_3'
    ];
    const header = [
        'ply',
        'format binary_little_endian 1.0',
        'comment Generated by SuperSplat toolkit',
        `element vertex ${count}`,
        ...props.map(name => `property float ${name}`),
        'end_header',
        ''
    ].join('\n');

    const n = props.length;
    const out = new Float32Array(count * n);
    const rest = colors.rest;
    for (let i = 0; i < count; ++i) {
        const o = i * STRIDE;
        let w = i * n;
        out[w++] = -d[o + S_POS];
        out[w++] = -d[o + S_POS + 1];
        out[w++] = d[o + S_POS + 2];
        out[w++] = colors.dc[i * 3];
        out[w++] = colors.dc[i * 3 + 1];
        out[w++] = colors.dc[i * 3 + 2];
        // f_rest is channel-major in the file: all red coefficients, then green, then blue
        for (let c = 0; c < 3; ++c) {
            for (let k = 0; k < nRest; ++k) {
                out[w++] = rest[(i * nRest + k) * 3 + c];
            }
        }
        const alpha = Math.min(0.999, Math.max(0.001, d[o + S_ALPHA]));
        out[w++] = Math.log(alpha / (1 - alpha));
        out[w++] = Math.log(Math.max(1e-12, d[o + S_SCALE]));
        out[w++] = Math.log(Math.max(1e-12, d[o + S_SCALE + 1]));
        out[w++] = Math.log(Math.max(1e-12, d[o + S_SCALE + 2]));
        // rotate the frame by 180 degrees about Z: q' = conj(qz180) * q
        const qw = d[o + S_ROT], qx = d[o + S_ROT + 1], qy = d[o + S_ROT + 2], qz = d[o + S_ROT + 3];
        out[w++] = qz;
        out[w++] = qy;
        out[w++] = -qx;
        out[w++] = -qw;
    }

    return new Blob([header, out], { type: 'application/ply' });
};

export {
    STRIDE, S_POS, S_ROT, S_SCALE, S_ALBEDO, S_ALPHA, S_NORMAL, S_ROUGH, S_METAL, S_TWO_SIDED, S_SHADE, S_OCCLUDER, S_LIGHTMASK, ALL_LIGHTS,
    SampleBuffer, SplatColors, SurfaceMaterial,
    restCount, unlitColors, writeSplatPly, srgbToLinear, linearToSrgb
};
