// The bake: colours a batch of surface samples under the studio lights.
//
// This function is self-contained on purpose: it is serialised with
// Function.prototype.toString() into the bake workers, so it must not refer to
// anything outside its own body (no imports, no module constants, no helpers
// emitted by the compiler). The formulas mirror the preview in shading.ts.
//
// Per sample:
//  1. irradiance from every light, integrated over a grid of emitter points,
//     times the fraction of shadow rays that reach the emitter
//  2. ambient sky / ground, times ambient occlusion
//  3. a linear-light spherical harmonic (degree 3) of the outgoing radiance:
//     diffuse as a constant (or, on thin surfaces, a front / back step), each
//     light's GGX highlight as a spherical gaussian lobe projected analytically
//  4. that radiance evaluated in K directions, the view-dependent ambient
//     reflection added, exposed, tone mapped and sRGB encoded
//  5. a least-squares fit of the display values to the requested SH degree,
//     which becomes the splat's f_dc / f_rest
//
// All SH work happens in the PLY frame the splat is written in (world rotated
// 180 degrees about Z), with the renderer's convention: the direction runs
// from the camera to the splat.

type KernelScene = {
    // layout of a sample (see samples.ts)
    layout: { stride: number, pos: number, albedo: number, alpha: number, normal: number, rough: number, metal: number, twoSided: number, occluder: number, mask: number };
    // shadow casters (see bvh.ts)
    nodeBounds: Float32Array;
    nodeInfo: Int32Array;
    tris: Float32Array;
    triOccluder: Int32Array;
    triMask: Int32Array;
    triUv: Float32Array;
    masks: { width: number, height: number, alpha: Float32Array, cutoff: number }[];
    numTris: number;
    // lights: BAKE_LIGHT_FLOATS each, plus up to 16 grid points (xyz) each
    lights: Float32Array;
    grid: Float32Array;
    numLights: number;
    // look
    exposure: number;
    tonemap: number;
    sky: number[];
    ground: number[];
    // quality
    degree: number;
    shadowSamples: number;
    aoSamples: number;
    aoRange: number;
    eps: number;
    // relighting existing splats instead of mesh samples: the albedo is the
    // splat's colour, `rough` holds its flatness, and only f_dc is produced
    // (base = share of the splat's own light that is kept)
    splatMode: boolean;
    splatBase: number;
    // fit directions (PLY frame, camera -> splat) and the least-squares matrix
    // for the requested degree: (degree + 1)^2 rows of K
    dirs: Float32Array;
    fit: Float32Array;
    K: number;
};

type KernelJob = {
    samples: Float32Array;
    count: number;
    // index of the first sample, for decorrelated random numbers
    base: number;
};

type KernelResult = {
    dc: Float32Array;
    rest: Float32Array;
};

function shadeKernel(scene: KernelScene, job: KernelJob): KernelResult {
    const PI = Math.PI;
    const C0 = 0.28209479177387814;
    const LF = 32;      // floats per bake light, see bake.ts
    const L = scene.layout;
    const S = L.stride;
    const degree = scene.degree;
    const nRest = [0, 3, 8, 15][degree];
    const nFit = (degree + 1) * (degree + 1);
    const K = scene.K;
    const dirs = scene.dirs;
    const fit = scene.fit;
    const nb = scene.nodeBounds;
    const ni = scene.nodeInfo;
    const tris = scene.tris;
    const triOcc = scene.triOccluder;
    const triMask = scene.triMask;
    const triUv = scene.triUv;
    const masks = scene.masks;
    const lights = scene.lights;
    const grid = scene.grid;
    const numLights = scene.numLights;
    const eps = scene.eps;
    const hasCasters = scene.numTris > 0;
    // mild windowing of the higher bands against ringing
    const win = [1, 0.92, 0.74, 0.5];
    const band = [0, 1, 1, 1, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3, 3];

    const dc = new Float32Array(job.count * 3);
    const rest = new Float32Array(job.count * nRest * 3);

    const stack = new Int32Array(128);
    const basis = new Float64Array(16);
    const lin = new Float64Array(48);       // linear radiance SH, 16 coefficients x rgb
    const acc = new Float64Array(48);       // fitted display SH
    const zon = new Float64Array(4);
    const values = new Float64Array(K * 3); // display values per fit direction
    const rgb = new Float64Array(3);

    // ---- helpers

    function hash(x: number) {
        x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
        x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
        x ^= x >>> 16;
        return (x >>> 0) / 4294967296;
    }

    function rand(i: number, j: number, k: number) {
        return hash((Math.imul(i, 0x9e3779b1) ^ Math.imul(j + 1, 0x85ebca77) ^ Math.imul(k + 7, 0xc2b2ae3d)) | 0);
    }

    // the renderer's real SH basis (direction from camera to splat)
    function evalBasis(x: number, y: number, z: number) {
        const xx = x * x, yy = y * y, zz = z * z, xy = x * y, yz = y * z, xz = x * z;
        basis[0] = C0;
        basis[1] = -0.4886025119029199 * y;
        basis[2] = 0.4886025119029199 * z;
        basis[3] = -0.4886025119029199 * x;
        basis[4] = 1.0925484305920792 * xy;
        basis[5] = -1.0925484305920792 * yz;
        basis[6] = 0.31539156525252005 * (2 * zz - xx - yy);
        basis[7] = -1.0925484305920792 * xz;
        basis[8] = 0.5462742152960396 * (xx - yy);
        basis[9] = -0.5900435899266435 * y * (3 * xx - yy);
        basis[10] = 2.890611442640554 * xy * z;
        basis[11] = -0.4570457994644658 * y * (4 * zz - xx - yy);
        basis[12] = 0.3731763325901154 * z * (2 * zz - 3 * xx - 3 * yy);
        basis[13] = -0.4570457994644658 * x * (4 * zz - xx - yy);
        basis[14] = 1.445305721320277 * z * (xx - yy);
        basis[15] = -0.5900435899266435 * x * (xx - 3 * yy);
    }

    // add a zonal function (Funk-Hecke coefficients zon[l]) whose axis is the
    // world-space outgoing direction (ax, ay, az), scaled per channel
    function addZonal(ax: number, ay: number, az: number, r: number, g: number, b: number) {
        // outgoing world direction -> camera-to-splat direction in the PLY frame:
        // d_world = -v, PLY = (-x, -y, z)
        evalBasis(ax, ay, -az);
        for (let i = 0; i < 16; ++i) {
            const w = win[band[i]] * zon[band[i]] * basis[i];
            lin[i * 3] += w * r;
            lin[i * 3 + 1] += w * g;
            lin[i * 3 + 2] += w * b;
        }
    }

    // spherical gaussian exp(lambda (cos - 1)) -> Funk-Hecke coefficients
    function sgZonal(lambda: number) {
        const lam = Math.max(0.1, lambda);
        const e = Math.exp(-2 * lam);
        const i0 = (1 - e) / lam;
        const i1 = (1 + e) / lam - i0 / lam;
        const i2 = (1 - e) / lam - 2 * i1 / lam;
        const i3 = (1 + e) / lam - 3 * i2 / lam;
        zon[0] = 2 * PI * i0;
        zon[1] = 2 * PI * i1;
        zon[2] = 2 * PI * (3 * i2 - i0) * 0.5;
        zon[3] = 2 * PI * (5 * i3 - 3 * i1) * 0.5;
        return i0;
    }

    function srgb(c: number) {
        return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
    }

    // tone map rgb[] in place (exposed linear -> 0..1)
    function tonemap() {
        const mode = scene.tonemap;
        if (mode === 2) {
            let r = rgb[0], g = rgb[1], b = rgb[2];
            const m = Math.min(r, g, b);
            const offset = m < 0.08 ? m - 6.25 * m * m : 0.04;
            r -= offset; g -= offset; b -= offset;
            const peak = Math.max(r, g, b);
            if (peak >= 0.76) {
                const d = 0.24;
                const newPeak = 1 - d * d / (peak + d - 0.76);
                const s = newPeak / peak;
                r *= s; g *= s; b *= s;
                const gm = 1 - 1 / (0.15 * (peak - newPeak) + 1);
                r += (newPeak - r) * gm; g += (newPeak - g) * gm; b += (newPeak - b) * gm;
            }
            rgb[0] = r; rgb[1] = g; rgb[2] = b;
        } else if (mode === 1) {
            for (let c = 0; c < 3; ++c) {
                const x = rgb[c];
                rgb[c] = (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14);
            }
        }
        for (let c = 0; c < 3; ++c) {
            rgb[c] = Math.min(1, Math.max(0, rgb[c]));
        }
    }

    // any hit along o + t d, t in (0, tmax), ignoring triangles of occluder `skip`
    function occluded(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, tmax: number, skip: number) {
        if (!hasCasters) return false;
        const ix = 1 / dx, iy = 1 / dy, iz = 1 / dz;
        let sp = 0;
        stack[sp++] = 0;
        while (sp > 0) {
            const node = stack[--sp];
            const b = node * 6;
            let t1 = (nb[b] - ox) * ix, t2 = (nb[b + 3] - ox) * ix;
            let tn = Math.min(t1, t2), tf = Math.max(t1, t2);
            t1 = (nb[b + 1] - oy) * iy; t2 = (nb[b + 4] - oy) * iy;
            tn = Math.max(tn, Math.min(t1, t2)); tf = Math.min(tf, Math.max(t1, t2));
            t1 = (nb[b + 2] - oz) * iz; t2 = (nb[b + 5] - oz) * iz;
            tn = Math.max(tn, Math.min(t1, t2)); tf = Math.min(tf, Math.max(t1, t2));
            if (tf < Math.max(tn, 0) || tn > tmax) continue;

            const info = node * 3;
            const count = ni[info + 1];
            if (count === 0) {
                stack[sp++] = ni[info];
                stack[sp++] = ni[info + 2];
                continue;
            }
            const first = ni[info];
            for (let t = first; t < first + count; ++t) {
                if (skip >= 0 && triOcc[t] === skip) continue;
                const k = t * 9;
                const v0x = tris[k], v0y = tris[k + 1], v0z = tris[k + 2];
                const e1x = tris[k + 3] - v0x, e1y = tris[k + 4] - v0y, e1z = tris[k + 5] - v0z;
                const e2x = tris[k + 6] - v0x, e2y = tris[k + 7] - v0y, e2z = tris[k + 8] - v0z;
                const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
                const det = e1x * px + e1y * py + e1z * pz;
                if (det > -1e-14 && det < 1e-14) continue;
                const inv = 1 / det;
                const sx = ox - v0x, sy = oy - v0y, sz = oz - v0z;
                const u = (sx * px + sy * py + sz * pz) * inv;
                if (u < 0 || u > 1) continue;
                const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
                const v = (dx * qx + dy * qy + dz * qz) * inv;
                if (v < 0 || u + v > 1) continue;
                const hit = (e2x * qx + e2y * qy + e2z * qz) * inv;
                if (hit <= 0 || hit >= tmax) continue;
                const mask = triMask[t];
                if (mask >= 0) {
                    const m = masks[mask];
                    const w0 = 1 - u - v;
                    const uu = triUv[t * 6] * w0 + triUv[t * 6 + 2] * u + triUv[t * 6 + 4] * v;
                    const vv = triUv[t * 6 + 1] * w0 + triUv[t * 6 + 3] * u + triUv[t * 6 + 5] * v;
                    const mx = Math.min(m.width - 1, Math.max(0, Math.floor(uu * m.width)));
                    const my = Math.min(m.height - 1, Math.max(0, Math.floor(vv * m.height)));
                    if (m.alpha[mx + my * m.width] < m.cutoff) continue;
                }
                return true;
            }
        }
        return false;
    }

    // point on the emitter of light `o` (offset into lights) for (u, v) in -1..1
    const ep = new Float64Array(3);
    function emitterPoint(o: number, u: number, v: number) {
        const type = lights[o + 3];
        const ux = lights[o + 8], uy = lights[o + 9], uz = lights[o + 10];
        const rx = lights[o + 22], ry = lights[o + 23], rz = lights[o + 24];
        let a = 0, b = 0;
        if (type === 2) {
            a = u * lights[o + 7] * 0.5;
            b = v * lights[o + 11] * 0.5;
        } else if (type === 3 || type === 5) {
            const ang = Math.atan2(v, u);
            const r = Math.max(Math.abs(u), Math.abs(v));
            const inner = type === 5 ? lights[o + 20] : 0;
            const rr = (inner + (1 - inner) * r) * lights[o + 7] * 0.5;
            a = Math.cos(ang) * rr;
            b = Math.sin(ang) * rr;
        } else {
            // point / spot: a disc of the bulb's or lens' radius
            const ang = 2 * PI * (u * 0.5 + 0.5);
            const rr = Math.sqrt(v * 0.5 + 0.5) * lights[o + 7] * 0.5;
            a = Math.cos(ang) * rr;
            b = Math.sin(ang) * rr;
        }
        ep[0] = lights[o] + rx * a + ux * b;
        ep[1] = lights[o + 1] + ry * a + uy * b;
        ep[2] = lights[o + 2] + rz * a + uz * b;
    }

    // emission of light `o` towards direction w (from the light)
    function emit(o: number, wx: number, wy: number, wz: number) {
        const type = lights[o + 3];
        const c = lights[o + 4] * wx + lights[o + 5] * wy + lights[o + 6] * wz;
        if (type === 1) {
            const lo = lights[o + 16], hi = lights[o + 17];
            const t = Math.min(1, Math.max(0, (c - lo) / Math.max(1e-6, hi - lo)));
            return t * t * (3 - 2 * t);
        }
        if (type === 2 || type === 3 || type === 5) {
            return c > 0 ? Math.pow(c, lights[o + 18]) : 0;
        }
        return 1;
    }

    // per side: irradiance from lights (rgb) and ambient
    const eLight = new Float64Array(6);
    const eAmb = new Float64Array(6);
    const ao = new Float64Array(2);

    // ---- relighting existing splats (diffuse light added to their colour)
    if (scene.splatMode) {
        const KNEE = 0.8;
        const OMNI = 0.5;
        for (let i = 0; i < job.count; ++i) {
            const o = i * S;
            const sample = job.base + i;
            const px = job.samples[o + L.pos], py = job.samples[o + L.pos + 1], pz = job.samples[o + L.pos + 2];
            const nx = job.samples[o + L.normal], ny = job.samples[o + L.normal + 1], nz = job.samples[o + L.normal + 2];
            const flat = job.samples[o + L.rough];
            const mask = job.samples[o + L.mask] | 0;
            let er = 0, eg = 0, eb = 0;
            for (let li = 0; li < numLights; ++li) {
                if (((mask >> li) & 1) === 0) continue;
                const lo = li * LF;
                const type = lights[lo + 3];
                let irr = 0;
                let lx = 0, ly = 0, lz = 0;
                if (type === 4) {
                    lx = -lights[lo + 4]; ly = -lights[lo + 5]; lz = -lights[lo + 6];
                    irr = flat * Math.max(0, nx * lx + ny * ly + nz * lz) + (1 - flat) * OMNI;
                } else {
                    const ng = lights[lo + 25];
                    for (let g = 0; g < ng; ++g) {
                        const gk = (li * 16 + g) * 3;
                        const qx = grid[gk] - px, qy = grid[gk + 1] - py, qz = grid[gk + 2] - pz;
                        const d2 = Math.max(1e-10, qx * qx + qy * qy + qz * qz);
                        const inv = 1 / Math.sqrt(d2);
                        const cosr = flat * Math.max(0, (nx * qx + ny * qy + nz * qz) * inv) + (1 - flat) * OMNI;
                        irr += emit(lo, -qx * inv, -qy * inv, -qz * inv) * cosr / d2;
                    }
                    irr /= ng;
                }
                if (irr <= 0) continue;
                // shadows cast by the meshes, from the splat's centre
                if (lights[lo + 15] > 0.5 && scene.shadowSamples > 0 && hasCasters) {
                    const n = scene.shadowSamples;
                    const cols = Math.ceil(Math.sqrt(n));
                    const rows = Math.ceil(n / cols);
                    let blocked = 0;
                    for (let s = 0; s < n; ++s) {
                        const su = ((s % cols) + 0.5 + (rand(sample, li * 64 + s, 0) - 0.5) * 0.35) / cols * 2 - 1;
                        const sv = (Math.floor(s / cols) + 0.5 + (rand(sample, li * 64 + s, 1) - 0.5) * 0.35) / rows * 2 - 1;
                        let dx: number, dy: number, dz: number, tmax: number;
                        if (type === 4) {
                            dx = lx; dy = ly; dz = lz;
                            tmax = 1e30;
                        } else {
                            emitterPoint(lo, Math.max(-1, Math.min(1, su)), Math.max(-1, Math.min(1, sv)));
                            dx = ep[0] - px; dy = ep[1] - py; dz = ep[2] - pz;
                            tmax = Math.sqrt(dx * dx + dy * dy + dz * dz);
                        }
                        const dl = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
                        dx /= dl; dy /= dl; dz /= dl;
                        if (type !== 4) tmax *= 1 - 1e-4;
                        if (occluded(px + dx * eps, py + dy * eps, pz + dz * eps, dx, dy, dz, tmax, -1)) blocked++;
                    }
                    irr *= 1 - blocked / n;
                }
                er += lights[lo + 12] * irr;
                eg += lights[lo + 13] * irr;
                eb += lights[lo + 14] * irr;
            }
            const e = [er, eg, eb];
            for (let c = 0; c < 3; ++c) {
                const albedo = job.samples[o + L.albedo + c];
                let x = albedo * (scene.splatBase + e[c] * scene.exposure);
                // a degenerate gaussian (zero scale, broken rotation) keeps its colour
                if (!Number.isFinite(x)) x = albedo;
                const shaped = x <= KNEE ? x : KNEE + (1 - KNEE) * (1 - Math.exp(-(x - KNEE) / (1 - KNEE)));
                dc[i * 3 + c] = (srgb(Math.max(0, shaped)) - 0.5) / C0;
            }
        }
        return { dc, rest };
    }

    for (let i = 0; i < job.count; ++i) {
        const o = i * S;
        const sample = job.base + i;
        const px = job.samples[o + L.pos], py = job.samples[o + L.pos + 1], pz = job.samples[o + L.pos + 2];
        let nx = job.samples[o + L.normal], ny = job.samples[o + L.normal + 1], nz = job.samples[o + L.normal + 2];
        const nlen = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
        nx /= nlen; ny /= nlen; nz /= nlen;
        const ar = job.samples[o + L.albedo], ag = job.samples[o + L.albedo + 1], ab = job.samples[o + L.albedo + 2];
        const rough = Math.min(1, Math.max(0.045, job.samples[o + L.rough]));
        const metal = Math.min(1, Math.max(0, job.samples[o + L.metal]));
        const twoSided = job.samples[o + L.twoSided] > 0.5;
        const skip = job.samples[o + L.occluder];
        const lightMask = job.samples[o + L.mask] | 0;
        const alpha = rough * rough;
        const dr = ar * (1 - metal), dg = ag * (1 - metal), db = ab * (1 - metal);
        const f0r = 0.04 + (ar - 0.04) * metal, f0g = 0.04 + (ag - 0.04) * metal, f0b = 0.04 + (ab - 0.04) * metal;
        const sides = twoSided ? 2 : 1;

        lin.fill(0);
        eLight.fill(0);
        eAmb.fill(0);

        for (let side = 0; side < sides; ++side) {
            const sn = side === 0 ? 1 : -1;
            const snx = nx * sn, sny = ny * sn, snz = nz * sn;
            const ox = px + snx * eps, oy = py + sny * eps, oz = pz + snz * eps;

            // ---- direct light
            for (let li = 0; li < numLights; ++li) {
                if (((lightMask >> li) & 1) === 0) continue;
                const lo = li * LF;
                const type = lights[lo + 3];
                const ir = lights[lo + 12], ig = lights[lo + 13], ib = lights[lo + 14];
                const casts = lights[lo + 15] > 0.5 && scene.shadowSamples > 0;

                // unshadowed irradiance over the emitter grid
                let irr = 0;
                let lx: number, ly: number, lz: number, dist: number;
                if (type === 4) {
                    lx = -lights[lo + 4]; ly = -lights[lo + 5]; lz = -lights[lo + 6];
                    dist = 1;
                    irr = Math.max(0, snx * lx + sny * ly + snz * lz);
                } else {
                    const ng = lights[lo + 25];
                    for (let g = 0; g < ng; ++g) {
                        const gk = (li * 16 + g) * 3;
                        const qx = grid[gk] - px, qy = grid[gk + 1] - py, qz = grid[gk + 2] - pz;
                        const d2 = Math.max(1e-10, qx * qx + qy * qy + qz * qz);
                        const inv = 1 / Math.sqrt(d2);
                        const cosr = (snx * qx + sny * qy + snz * qz) * inv;
                        if (cosr <= 0) continue;
                        irr += emit(lo, -qx * inv, -qy * inv, -qz * inv) * cosr / d2;
                    }
                    irr /= ng;
                    lx = lights[lo] - px; ly = lights[lo + 1] - py; lz = lights[lo + 2] - pz;
                    dist = Math.sqrt(lx * lx + ly * ly + lz * lz) || 1e-6;
                    lx /= dist; ly /= dist; lz /= dist;
                }
                if (irr <= 0) continue;

                // visibility: the fraction of shadow rays that reach the emitter
                let vis = 1;
                if (casts) {
                    const n = scene.shadowSamples;
                    const cols = Math.ceil(Math.sqrt(n));
                    const rows = Math.ceil(n / cols);
                    let blocked = 0;
                    for (let s = 0; s < n; ++s) {
                        // the same stratified pattern for every sample, only
                        // slightly jittered: neighbouring splats then agree on
                        // their visibility, so penumbras come out as smooth
                        // gradients instead of grain
                        const su = ((s % cols) + 0.5 + (rand(sample, li * 64 + s, 0) - 0.5) * 0.35) / cols * 2 - 1;
                        const sv = (Math.floor(s / cols) + 0.5 + (rand(sample, li * 64 + s, 1) - 0.5) * 0.35) / rows * 2 - 1;
                        let dx: number, dy: number, dz: number, tmax: number;
                        if (type === 4) {
                            // a direction inside the sun's disk
                            const ang = lights[lo + 19];
                            const a = PI * (su + 1);
                            const r = Math.sqrt((sv + 1) * 0.5) * Math.tan(ang);
                            const rx = lights[lo + 22], ry = lights[lo + 23], rz = lights[lo + 24];
                            const ux = lights[lo + 8], uy = lights[lo + 9], uz = lights[lo + 10];
                            dx = lx + (rx * Math.cos(a) + ux * Math.sin(a)) * r;
                            dy = ly + (ry * Math.cos(a) + uy * Math.sin(a)) * r;
                            dz = lz + (rz * Math.cos(a) + uz * Math.sin(a)) * r;
                            tmax = 1e30;
                        } else {
                            emitterPoint(lo, Math.max(-1, Math.min(1, su)), Math.max(-1, Math.min(1, sv)));
                            dx = ep[0] - ox; dy = ep[1] - oy; dz = ep[2] - oz;
                            tmax = Math.sqrt(dx * dx + dy * dy + dz * dz);
                        }
                        const dl = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
                        dx /= dl; dy /= dl; dz /= dl;
                        if (type !== 4) tmax *= 1 - 1e-4;
                        // a ray leaving below the surface is blocked by the surface itself
                        if (dx * snx + dy * sny + dz * snz <= 0) {
                            blocked++;
                            continue;
                        }
                        if (occluded(ox, oy, oz, dx, dy, dz, tmax, skip)) blocked++;
                    }
                    vis = 1 - blocked / n;
                    if (vis <= 0) continue;
                }

                eLight[side * 3] += ir * irr * vis;
                eLight[side * 3 + 1] += ig * irr * vis;
                eLight[side * 3 + 2] += ib * irr * vis;

                // ---- highlight: GGX lobe as a spherical gaussian around the reflection
                const nl = snx * lx + sny * ly + snz * lz;
                if (nl <= 0) continue;
                const radius = lights[lo + 21];
                const a = Math.min(1, alpha + (type === 4 ? lights[lo + 19] * 0.5 : radius / (2 * dist)));
                const ePerp = (type === 4 ? 1 : emit(lo, -lx, -ly, -lz) / (dist * dist)) * vis;
                if (ePerp <= 0) continue;
                const k = a * 0.5;
                const g1 = nl / (nl * (1 - k) + k);
                const G = g1 * g1;
                const fw = Math.pow(1 - nl, 5);
                const lambda = 1 / (2 * a * a * Math.max(nl, 0.25));
                const i0 = sgZonal(lambda);
                // amplitude from energy: the lobe reflects F G of the irradiance
                const amp = G * ePerp * nl / (2 * i0);
                const rx = 2 * nl * snx - lx, ry = 2 * nl * sny - ly, rz = 2 * nl * snz - lz;
                addZonal(rx, ry, rz,
                    amp * ir * (f0r + (1 - f0r) * fw),
                    amp * ig * (f0g + (1 - f0g) * fw),
                    amp * ib * (f0b + (1 - f0b) * fw));
            }

            // ---- ambient with occlusion
            let occ = 1;
            if (scene.aoSamples > 0 && hasCasters) {
                // tangent frame around the side's normal
                const tx0 = Math.abs(snx) < 0.9 ? 1 : 0, ty0 = Math.abs(snx) < 0.9 ? 0 : 1;
                let tx = sny * 0 - snz * ty0, ty = snz * tx0 - snx * 0, tz = snx * ty0 - sny * tx0;
                const tl = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1;
                tx /= tl; ty /= tl; tz /= tl;
                const bx = sny * tz - snz * ty, by = snz * tx - snx * tz, bz = snx * ty - sny * tx;
                let hits = 0;
                const aoCols = Math.ceil(Math.sqrt(scene.aoSamples));
                const aoRows = Math.ceil(scene.aoSamples / aoCols);
                for (let s = 0; s < scene.aoSamples; ++s) {
                    // cosine-weighted hemisphere, the same stratified pattern for
                    // every sample (slightly jittered) so occlusion varies smoothly
                    const u1 = ((Math.floor(s / aoCols)) + 0.5 + (rand(sample, 8192 + s, side) - 0.5) * 0.3) / aoRows;
                    const u2 = ((s % aoCols) + 0.5 + (rand(sample, 12288 + s, side) - 0.5) * 0.3) / aoCols;
                    const r = Math.sqrt(u1);
                    const phi = 2 * PI * u2;
                    const cx = r * Math.cos(phi), cy = r * Math.sin(phi), cz = Math.sqrt(Math.max(0, 1 - u1));
                    const dx = tx * cx + bx * cy + snx * cz;
                    const dy = ty * cx + by * cy + sny * cz;
                    const dz = tz * cx + bz * cy + snz * cz;
                    if (occluded(ox, oy, oz, dx, dy, dz, scene.aoRange, skip)) hits++;
                }
                occ = 1 - hits / scene.aoSamples;
            }
            ao[side] = occ;
            const h = 0.5 + 0.5 * sny;
            for (let c = 0; c < 3; ++c) {
                eAmb[side * 3 + c] = (scene.ground[c] + (scene.sky[c] - scene.ground[c]) * h) * occ;
            }
        }

        // ---- diffuse into the linear SH
        const fr = dr * (eLight[0] + eAmb[0]), fg = dg * (eLight[1] + eAmb[1]), fb = db * (eLight[2] + eAmb[2]);
        if (!twoSided) {
            lin[0] += fr / C0;
            lin[1] += fg / C0;
            lin[2] += fb / C0;
        } else {
            // front (seen with the normal towards the viewer) / back step
            const br = dr * (eLight[3] + eAmb[3]), bg = dg * (eLight[4] + eAmb[4]), bb = db * (eLight[5] + eAmb[5]);
            const sl = [1, 0.5, 0, -0.125];
            const sg = [1, -1, 1, -1];
            evalBasis(nx, ny, -nz);
            for (let k = 0; k < 16; ++k) {
                const l = band[k];
                const w = 2 * PI * sl[l] * win[l] * basis[k];
                lin[k * 3] += w * (fr + sg[l] * br);
                lin[k * 3 + 1] += w * (fg + sg[l] * bg);
                lin[k * 3 + 2] += w * (fb + sg[l] * bb);
            }
        }

        // ---- display values in the fit directions
        let frontSum0 = 0, frontSum1 = 0, frontSum2 = 0, frontN = 0;
        let backSum0 = 0, backSum1 = 0, backSum2 = 0, backN = 0;
        for (let d = 0; d < K; ++d) {
            const qx = dirs[d * 3], qy = dirs[d * 3 + 1], qz = dirs[d * 3 + 2];
            evalBasis(qx, qy, qz);
            let r = 0, g = 0, b = 0;
            for (let k = 0; k < 16; ++k) {
                r += lin[k * 3] * basis[k];
                g += lin[k * 3 + 1] * basis[k];
                b += lin[k * 3 + 2] * basis[k];
            }

            // view direction (towards the viewer) in world space
            let vx = qx, vy = qy, vz = -qz;
            const vn = vx * nx + vy * ny + vz * nz;
            const front = vn >= 0;
            let side = 0;
            let snx = nx, sny = ny, snz = nz;
            if (!front) {
                if (twoSided) {
                    side = 1;
                    snx = -nx; sny = -ny; snz = -nz;
                } else {
                    // a closed surface is never seen from behind: mirror the view
                    vx -= 2 * vn * nx; vy -= 2 * vn * ny; vz -= 2 * vn * nz;
                }
            }
            const nv = Math.max(0, vx * snx + vy * sny + vz * snz);
            // ambient reflection, blurred towards the irradiance with roughness
            const ry = 2 * nv * sny - vy;
            const hr = 0.5 + 0.5 * ry;
            const hn = 0.5 + 0.5 * sny;
            const fw = Math.pow(1 - nv, 5);
            const occ = ao[side];
            for (let c = 0; c < 3; ++c) {
                const sharp = scene.ground[c] + (scene.sky[c] - scene.ground[c]) * hr;
                const blur = scene.ground[c] + (scene.sky[c] - scene.ground[c]) * hn;
                const env = (sharp + (blur - sharp) * rough) * occ;
                const f0 = c === 0 ? f0r : (c === 1 ? f0g : f0b);
                const fe = f0 + (Math.max(1 - rough, f0) - f0) * fw;
                rgb[c] = (c === 0 ? r : (c === 1 ? g : b)) + env * fe;
            }
            // exposure, tone map, encode
            for (let c = 0; c < 3; ++c) {
                rgb[c] = Math.max(0, rgb[c]) * scene.exposure;
            }
            tonemap();
            const y0 = srgb(rgb[0]), y1 = srgb(rgb[1]), y2 = srgb(rgb[2]);
            values[d * 3] = y0;
            values[d * 3 + 1] = y1;
            values[d * 3 + 2] = y2;
            if (front) {
                frontSum0 += y0; frontSum1 += y1; frontSum2 += y2; frontN++;
            } else {
                backSum0 += y0; backSum1 += y1; backSum2 += y2; backN++;
            }
        }

        if (degree === 0) {
            // no view dependence: the average as seen from the visible side(s)
            let m0 = frontSum0 / Math.max(1, frontN), m1 = frontSum1 / Math.max(1, frontN), m2 = frontSum2 / Math.max(1, frontN);
            if (twoSided && backN > 0) {
                const b0 = backSum0 / backN, b1 = backSum1 / backN, b2 = backSum2 / backN;
                if (b0 + b1 + b2 > m0 + m1 + m2) {
                    m0 = b0; m1 = b1; m2 = b2;
                }
            }
            dc[i * 3] = (m0 - 0.5) / C0;
            dc[i * 3 + 1] = (m1 - 0.5) / C0;
            dc[i * 3 + 2] = (m2 - 0.5) / C0;
            continue;
        }

        // least-squares fit of the display values
        acc.fill(0);
        for (let k = 0; k < nFit; ++k) {
            let r = 0, g = 0, b = 0;
            const row = k * K;
            for (let d = 0; d < K; ++d) {
                const w = fit[row + d];
                r += w * values[d * 3];
                g += w * values[d * 3 + 1];
                b += w * values[d * 3 + 2];
            }
            acc[k * 3] = r;
            acc[k * 3 + 1] = g;
            acc[k * 3 + 2] = b;
        }
        dc[i * 3] = acc[0] - 0.5 / C0;
        dc[i * 3 + 1] = acc[1] - 0.5 / C0;
        dc[i * 3 + 2] = acc[2] - 0.5 / C0;
        for (let k = 0; k < nRest; ++k) {
            const w = (i * nRest + k) * 3;
            rest[w] = acc[(k + 1) * 3];
            rest[w + 1] = acc[(k + 1) * 3 + 1];
            rest[w + 2] = acc[(k + 1) * 3 + 2];
        }
    }

    return { dc, rest };
}

export { shadeKernel, KernelScene, KernelJob, KernelResult };
