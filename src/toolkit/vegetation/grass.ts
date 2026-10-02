import type { Mat4 } from 'playcanvas';

import { writeGlb } from './glb-writer';
import { SampleBuffer, srgbToLinear } from '../lighting/samples';

// Procedural grass: a patch of curved, tapering blades with flowers scattered
// in it. The blades are generated from a seed, so the same parameters always
// give the same field. They become either a mesh (.glb, a texture atlas
// carries the colours) or gaussians directly: a few long, thin splats along
// each blade, which looks better than sampling the thin mesh and needs far
// fewer splats.

type Rgb = [number, number, number];

// where a brushed patch grows: within `radius` of the stroke (a polyline of
// x y z points, relative to the patch's origin). One point = a round patch.
type GrassArea = {
    points: number[];
    radius: number;
};

type GrassParams = {
    seed: number;
    width: number;              // patch size along x, world units
    depth: number;              // patch size along z
    density: number;            // blades per square unit
    height: number;             // blade height
    heightVariance: number;     // 0..1
    bladeWidth: number;
    bend: number;               // 0 = straight up .. 1 = strongly curved over
    windAngle: number;          // degrees: the direction the blades lean
    windStrength: number;       // 0 = lean every way .. 1 = all lean with the wind
    clumping: number;           // 0 = even .. 1 = tufts
    rootColor: Rgb;             // sRGB
    tipColor: Rgb;
    dryness: number;            // share of dry, straw coloured blades
    flowers: number;            // flowers per square unit
    flowerPalette: string;
    direct?: boolean;           // convert as blade-shaped splats (else by sampling the mesh)
    // brushed patches (newer): the stroke's area instead of width x depth, and
    // amounts relative to the blade size, so small blades fill a big stroke
    // and big blades leave just a few in it
    area?: GrassArea;
    fullness?: number;          // 0..1: how close the blades stand, relative to their size
    thickness?: number;         // blade width as a share of its height
    flowerAmount?: number;      // 0..1: share of flowers among the blades (up to 15%)
};

const MAX_BLADES = 100000;
// random positions tried when filling a stroke's area
const MAX_TRIALS = 4000000;
const SEGMENTS = 4;

const flowerPalettes: Record<string, Rgb[]> = {
    meadow: [[0.95, 0.95, 0.92], [0.98, 0.82, 0.2], [0.55, 0.45, 0.9], [0.95, 0.45, 0.6]],
    white: [[0.97, 0.97, 0.95], [0.95, 0.94, 0.85], [0.98, 0.96, 0.9], [0.9, 0.9, 0.88]],
    yellow: [[0.99, 0.85, 0.15], [0.98, 0.75, 0.1], [1.0, 0.9, 0.35], [0.95, 0.7, 0.2]],
    blue: [[0.35, 0.45, 0.95], [0.5, 0.4, 0.9], [0.4, 0.6, 0.98], [0.6, 0.5, 0.95]],
    poppies: [[0.9, 0.12, 0.08], [0.95, 0.2, 0.1], [0.85, 0.1, 0.1], [0.98, 0.3, 0.15]]
};

const defaultGrass = (size: number): GrassParams => ({
    seed: 1,
    width: size,
    depth: size,
    density: 30000 / (size * size),
    height: size * 0.04,
    heightVariance: 0.4,
    bladeWidth: size * 0.04 * 0.035,
    fullness: 0.45,
    thickness: 0.035,
    flowerAmount: 0,
    bend: 0.45,
    windAngle: 30,
    windStrength: 0.4,
    clumping: 0.35,
    rootColor: [0.12, 0.28, 0.06],
    tipColor: [0.45, 0.65, 0.2],
    dryness: 0.15,
    flowers: 0,
    flowerPalette: 'meadow'
});

// mulberry32
const rng = (seed: number) => {
    let a = (seed >>> 0) || 1;
    return () => {
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
};

type Blade = {
    x: number; y: number; z: number;
    height: number;
    width: number;
    facing: number;             // angle of the blade's flat side
    leanX: number; leanZ: number;
    bend: number;
    variation: number;          // 0..1, picks the dry / fresh colour
    flower: number;             // -1 = grass, else the flower colour index
};

// blade width and blades per square unit, from either way of setting them
const bladeWidthOf = (p: GrassParams) => (p.thickness !== undefined ? p.height * p.thickness : p.bladeWidth);
const bladesPerArea = (p: GrassParams) => {
    if (p.fullness === undefined) return p.density;
    const f = Math.min(1, Math.max(0, p.fullness));
    // from a few blades a blade-height apart to a dense lawn
    return (0.3 + 160 * f * f) / Math.max(1e-6, p.height * p.height);
};

// ---- the area of a brushed patch: within `radius` of the stroke

type AreaTest = {
    min: [number, number];
    max: [number, number];
    // square units covered (estimated)
    size: number;
    // the ground height at x z when it is inside the area, else null
    inside: (x: number, z: number) => number | null;
};

const areaTest = (area: GrassArea): AreaTest => {
    const pts = area.points;
    const n = Math.max(1, Math.floor(pts.length / 3));
    const r = Math.max(1e-6, area.radius);
    const min: [number, number] = [Infinity, Infinity];
    const max: [number, number] = [-Infinity, -Infinity];
    let length = 0;
    for (let i = 0; i < n; ++i) {
        min[0] = Math.min(min[0], pts[i * 3] - r);
        min[1] = Math.min(min[1], pts[i * 3 + 2] - r);
        max[0] = Math.max(max[0], pts[i * 3] + r);
        max[1] = Math.max(max[1], pts[i * 3 + 2] + r);
        if (i > 0) length += Math.hypot(pts[i * 3] - pts[i * 3 - 3], pts[i * 3 + 2] - pts[i * 3 - 1]);
    }
    const boxArea = (max[0] - min[0]) * (max[1] - min[1]);
    const size = Math.min(boxArea, Math.PI * r * r + 2 * r * length);

    // segments (a lone point is a segment of length 0) bucketed in a grid of
    // radius-sized cells, so a test only looks at the few nearby ones
    const segments = Math.max(1, n - 1);
    const cols = Math.max(1, Math.ceil((max[0] - min[0]) / r));
    const rows = Math.max(1, Math.ceil((max[1] - min[1]) / r));
    const cells = new Map<number, number[]>();
    for (let k = 0; k < segments; ++k) {
        const i0 = k;
        const i1 = Math.min(n - 1, k + 1);
        const x0 = Math.min(pts[i0 * 3], pts[i1 * 3]) - r;
        const x1 = Math.max(pts[i0 * 3], pts[i1 * 3]) + r;
        const z0 = Math.min(pts[i0 * 3 + 2], pts[i1 * 3 + 2]) - r;
        const z1 = Math.max(pts[i0 * 3 + 2], pts[i1 * 3 + 2]) + r;
        const cx0 = Math.max(0, Math.floor((x0 - min[0]) / r));
        const cx1 = Math.min(cols - 1, Math.floor((x1 - min[0]) / r));
        const cz0 = Math.max(0, Math.floor((z0 - min[1]) / r));
        const cz1 = Math.min(rows - 1, Math.floor((z1 - min[1]) / r));
        for (let cz = cz0; cz <= cz1; ++cz) {
            for (let cx = cx0; cx <= cx1; ++cx) {
                const key = cz * cols + cx;
                let list = cells.get(key);
                if (!list) cells.set(key, list = []);
                list.push(k);
            }
        }
    }

    const r2 = r * r;
    const inside = (x: number, z: number) => {
        const cx = Math.min(cols - 1, Math.max(0, Math.floor((x - min[0]) / r)));
        const cz = Math.min(rows - 1, Math.max(0, Math.floor((z - min[1]) / r)));
        const list = cells.get(cz * cols + cx);
        if (!list) return null;
        let best = Infinity;
        let y = 0;
        for (let j = 0; j < list.length; ++j) {
            const k = list[j];
            const i1 = Math.min(n - 1, k + 1);
            const ax = pts[k * 3], ay = pts[k * 3 + 1], az = pts[k * 3 + 2];
            const dx = pts[i1 * 3] - ax, dy = pts[i1 * 3 + 1] - ay, dz = pts[i1 * 3 + 2] - az;
            const ll = dx * dx + dz * dz;
            const t = ll > 0 ? Math.min(1, Math.max(0, ((x - ax) * dx + (z - az) * dz) / ll)) : 0;
            const ex = ax + dx * t - x;
            const ez = az + dz * t - z;
            const d2 = ex * ex + ez * ez;
            if (d2 < best) {
                best = d2;
                // the ground follows the stroke
                y = ay + dy * t;
            }
        }
        return best <= r2 ? y : null;
    };
    return { min, max, size, inside };
};

// square units the patch covers
const patchArea = (p: GrassParams) => (p.area ? areaTest(p.area).size : p.width * p.depth);

// blades in the patch (an estimate for a brushed one, before generating)
const bladeCount = (p: GrassParams) => Math.min(MAX_BLADES, Math.round(bladesPerArea(p) * patchArea(p)));

const flowerCountOf = (p: GrassParams, blades: number) => (p.flowerAmount !== undefined ?
    Math.round(blades * 0.15 * Math.min(1, Math.max(0, p.flowerAmount))) :
    Math.min(Math.round(p.flowers * p.width * p.depth), Math.round(blades * 0.2)));

// root positions: x y z per blade
const bladeRoots = (p: GrassParams, random: () => number): { roots: number[], area: number } => {
    const roots: number[] = [];
    if (p.area) {
        const test = areaTest(p.area);
        const box = (test.max[0] - test.min[0]) * (test.max[1] - test.min[1]);
        const trials = Math.min(MAX_TRIALS, Math.round(bladesPerArea(p) * box));
        // uniform random tries in the bounds, kept when inside: the density
        // comes out right whatever the stroke's shape
        for (let i = 0; i < trials && roots.length < MAX_BLADES * 3; ++i) {
            const x = test.min[0] + random() * (test.max[0] - test.min[0]);
            const z = test.min[1] + random() * (test.max[1] - test.min[1]);
            const y = test.inside(x, z);
            if (y !== null) roots.push(x, y, z);
        }
        return { roots, area: test.size };
    }
    const count = bladeCount(p);
    for (let i = 0; i < count; ++i) {
        roots.push((random() - 0.5) * p.width, 0, (random() - 0.5) * p.depth);
    }
    return { roots, area: p.width * p.depth };
};

const generateBlades = (p: GrassParams): Blade[] => {
    const random = rng(p.seed);
    const { roots, area } = bladeRoots(p, random);
    const count = roots.length / 3;
    const flowerCount = Math.min(count, flowerCountOf(p, count));
    const bladeWidth = bladeWidthOf(p);
    const test = p.area ? areaTest(p.area) : null;
    const halfW = p.width / 2;
    const halfD = p.depth / 2;

    // tufts: a share of the blades gathers around random centres (taken from
    // the roots, so they lie in the patch)
    const tufts = Math.max(1, Math.round(count / 40));
    const centres: number[] = [];
    if (count > 0) {
        for (let i = 0; i < tufts; ++i) {
            const k = Math.floor(random() * count);
            centres.push(roots[k * 3], roots[k * 3 + 1], roots[k * 3 + 2]);
        }
    }
    const tuftRadius = Math.sqrt(area / tufts) * 0.6;
    const windRad = p.windAngle * Math.PI / 180;
    const blades: Blade[] = [];

    for (let i = 0; i < count; ++i) {
        let x = roots[i * 3];
        let y = roots[i * 3 + 1];
        let z = roots[i * 3 + 2];
        if (centres.length && random() < p.clumping) {
            const c = Math.floor(random() * tufts);
            const a = random() * Math.PI * 2;
            const r = Math.sqrt(random()) * tuftRadius;
            const tx = centres[c * 3] + Math.cos(a) * r;
            const tz = centres[c * 3 + 2] + Math.sin(a) * r;
            if (test) {
                const ty = test.inside(tx, tz);
                if (ty !== null) {
                    x = tx; y = ty; z = tz;
                }
            } else {
                x = Math.max(-halfW, Math.min(halfW, tx));
                z = Math.max(-halfD, Math.min(halfD, tz));
            }
        }
        // the last ones are the flowers
        const flower = i >= count - flowerCount;
        const lean = windRad + (random() - 0.5) * Math.PI * 2 * (1 - p.windStrength);
        const h = p.height * (1 - p.heightVariance * random()) * (flower ? 1.15 : 1);
        blades.push({
            x,
            y,
            z,
            height: h,
            width: bladeWidth * (0.7 + 0.6 * random()) * (flower ? 0.45 : 1),
            facing: random() * Math.PI * 2,
            leanX: Math.cos(lean),
            leanZ: Math.sin(lean),
            bend: p.bend * (0.4 + 0.6 * random()) * (flower ? 0.4 : 1),
            variation: random(),
            flower: flower ? Math.floor(random() * 4) : -1
        });
    }
    return blades;
};

// splats the patch becomes as blades (an estimate)
const grassSplatCount = (p: GrassParams) => {
    const blades = bladeCount(p);
    return blades * SEGMENTS + flowerCountOf(p, blades);
};

// colour of a blade at height t (0 root .. 1 tip), sRGB
const bladeColor = (p: GrassParams, variation: number, t: number, out: number[]) => {
    const k = Math.pow(t, 0.8);
    const dry = variation < p.dryness ? 0.75 * (1 - variation / Math.max(p.dryness, 1e-6)) + 0.25 : 0;
    const shade = 0.85 + 0.3 * ((variation * 7.31) % 1);
    for (let c = 0; c < 3; ++c) {
        const fresh = p.rootColor[c] + (p.tipColor[c] - p.rootColor[c]) * k;
        const straw = [0.62, 0.55, 0.3][c] * (0.6 + 0.4 * k);
        out[c] = Math.min(1, (fresh + (straw - fresh) * dry) * shade);
    }
    return out;
};

// point and tangent along a blade's curve (quadratic bezier), t 0..1
const bladeCurve = (b: Blade, t: number, out: number[]) => {
    const h = b.height;
    const p1y = h * 0.6;
    const p2x = b.leanX * h * b.bend;
    const p2z = b.leanZ * h * b.bend;
    const p2y = h * (1 - 0.45 * b.bend);
    const u = 1 - t;
    out[0] = b.x + t * t * p2x;
    out[1] = b.y + 2 * u * t * p1y + t * t * p2y;
    out[2] = b.z + t * t * p2z;
    // derivative
    out[3] = 2 * t * p2x;
    out[4] = 2 * u * p1y + 2 * t * (p2y - p1y);
    out[5] = 2 * t * p2z;
    return out;
};

// ---- texture atlas: 48 columns of blade colours (variation x height), then
// four flower colour bands of 4 columns
const ATLAS = 64;

const atlasPng = async (p: GrassParams): Promise<Uint8Array> => {
    const canvas = document.createElement('canvas');
    canvas.width = ATLAS;
    canvas.height = ATLAS;
    const context = canvas.getContext('2d');
    const image = context.createImageData(ATLAS, ATLAS);
    const c = [0, 0, 0];
    const palette = flowerPalettes[p.flowerPalette] ?? flowerPalettes.meadow;
    for (let y = 0; y < ATLAS; ++y) {
        for (let x = 0; x < ATLAS; ++x) {
            if (x < 48) {
                bladeColor(p, (x + 0.5) / 48, 1 - (y + 0.5) / ATLAS, c);
            } else {
                const f = palette[Math.min(3, Math.floor((x - 48) / 4))];
                c[0] = f[0]; c[1] = f[1]; c[2] = f[2];
            }
            const o = (y * ATLAS + x) * 4;
            image.data[o] = Math.round(c[0] * 255);
            image.data[o + 1] = Math.round(c[1] * 255);
            image.data[o + 2] = Math.round(c[2] * 255);
            image.data[o + 3] = 255;
        }
    }
    context.putImageData(image, 0, 0);
    const blob = await new Promise<Blob>((resolve) => {
        canvas.toBlob(resolve, 'image/png');
    });
    return new Uint8Array(await blob.arrayBuffer());
};

// ---- mesh

const grassGlb = async (p: GrassParams): Promise<{ glb: ArrayBuffer, blades: number }> => {
    const blades = generateBlades(p);
    const vertsPerBlade = SEGMENTS * 2 + 1;
    const flowerVerts = 7;
    const flowers = blades.filter(b => b.flower >= 0).length;
    const vertexCount = blades.length * vertsPerBlade + flowers * flowerVerts;
    const positions = new Float32Array(vertexCount * 3);
    const normals = new Float32Array(vertexCount * 3);
    const uvs = new Float32Array(vertexCount * 2);
    const indices = new Uint32Array(blades.length * (SEGMENTS * 2 - 1) * 3 + flowers * 6 * 3);
    const curve = new Array(6).fill(0);
    let v = 0;
    let i = 0;

    const put = (x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, w: number) => {
        positions[v * 3] = x; positions[v * 3 + 1] = y; positions[v * 3 + 2] = z;
        normals[v * 3] = nx; normals[v * 3 + 1] = ny; normals[v * 3 + 2] = nz;
        uvs[v * 2] = u; uvs[v * 2 + 1] = w;
        return v++;
    };

    blades.forEach((b) => {
        const wx = Math.cos(b.facing), wz = Math.sin(b.facing);
        const u = b.flower >= 0 ? 0.05 : (b.variation * 47 + 0.5) / ATLAS;
        const base = v;
        for (let s = 0; s <= SEGMENTS; ++s) {
            const t = s / SEGMENTS;
            bladeCurve(b, t, curve);
            // normal: tangent x width direction
            let nx = curve[4] * wz;
            let ny = curve[5] * wx - curve[3] * wz;
            let nz = -curve[4] * wx;
            const nl = Math.hypot(nx, ny, nz) || 1;
            nx /= nl; ny /= nl; nz /= nl;
            const vv = 1 - t * (ATLAS - 1) / ATLAS - 0.5 / ATLAS;
            if (s === SEGMENTS) {
                put(curve[0], curve[1], curve[2], nx, ny, nz, u, vv);
            } else {
                const half = b.width * 0.5 * Math.pow(1 - t, 0.6);
                put(curve[0] - wx * half, curve[1], curve[2] - wz * half, nx, ny, nz, u, vv);
                put(curve[0] + wx * half, curve[1], curve[2] + wz * half, nx, ny, nz, u, vv);
            }
        }
        for (let s = 0; s < SEGMENTS - 1; ++s) {
            const a = base + s * 2;
            indices[i++] = a; indices[i++] = a + 1; indices[i++] = a + 2;
            indices[i++] = a + 1; indices[i++] = a + 3; indices[i++] = a + 2;
        }
        const last = base + (SEGMENTS - 1) * 2;
        indices[i++] = last; indices[i++] = last + 1; indices[i++] = last + 2;

        // flower head: a small six-petal disc on top of the stem
        if (b.flower >= 0) {
            bladeCurve(b, 1, curve);
            const r = b.width * 4.5;
            const fu = (48 + b.flower * 4 + 2) / ATLAS;
            const centre = put(curve[0], curve[1] + r * 0.15, curve[2], 0, 1, 0, fu, 0.5);
            for (let k = 0; k < 6; ++k) {
                const a = k / 6 * Math.PI * 2 + b.facing;
                put(curve[0] + Math.cos(a) * r, curve[1], curve[2] + Math.sin(a) * r, 0, 1, 0, fu, 0.5);
            }
            for (let k = 0; k < 6; ++k) {
                indices[i++] = centre; indices[i++] = centre + 1 + k; indices[i++] = centre + 1 + (k + 1) % 6;
            }
        }
    });

    const png = await atlasPng(p);
    const glb = writeGlb([{
        name: 'grass',
        positions,
        normals,
        uvs,
        indices,
        material: {
            name: 'grass',
            baseColor: [1, 1, 1, 1],
            texture: { mimeType: 'image/png', bytes: png, repeat: false },
            doubleSided: true,
            roughness: 0.8
        }
    }]);
    return { glb, blades: blades.length };
};

// ---- gaussians, straight from the blades

const quatFromBasis = (m00: number, m10: number, m20: number, m01: number, m11: number, m21: number, m02: number, m12: number, m22: number) => {
    const trace = m00 + m11 + m22;
    let w, x, y, z;
    if (trace > 0) {
        const k = 0.5 / Math.sqrt(trace + 1);
        w = 0.25 / k; x = (m21 - m12) * k; y = (m02 - m20) * k; z = (m10 - m01) * k;
    } else if (m00 > m11 && m00 > m22) {
        const k = 2 * Math.sqrt(1 + m00 - m11 - m22);
        w = (m21 - m12) / k; x = 0.25 * k; y = (m01 + m10) / k; z = (m02 + m20) / k;
    } else if (m11 > m22) {
        const k = 2 * Math.sqrt(1 + m11 - m00 - m22);
        w = (m02 - m20) / k; x = (m01 + m10) / k; y = 0.25 * k; z = (m12 + m21) / k;
    } else {
        const k = 2 * Math.sqrt(1 + m22 - m00 - m11);
        w = (m10 - m01) / k; x = (m02 + m20) / k; y = (m12 + m21) / k; z = 0.25 * k;
    }
    return [w, x, y, z];
};

// one gaussian per blade segment, in world space through `transform` (the
// grass model's own space -> world)
const grassSamples = (p: GrassParams, transform: Mat4, out: SampleBuffer, tint: [number, number, number] = [1, 1, 1]) => {
    const start = out.count;
    const blades = generateBlades(p);
    const m = transform.data;
    const scale = Math.hypot(m[0], m[1], m[2]);
    const curve = new Array(6).fill(0);
    const next = new Array(6).fill(0);
    const c = [0, 0, 0];
    const material = { roughness: 0.75, metalness: 0, twoSided: true };
    const palette = flowerPalettes[p.flowerPalette] ?? flowerPalettes.meadow;
    const tp = (x: number, y: number, z: number) => [
        m[0] * x + m[4] * y + m[8] * z + m[12],
        m[1] * x + m[5] * y + m[9] * z + m[13],
        m[2] * x + m[6] * y + m[10] * z + m[14]
    ];
    const tv = (x: number, y: number, z: number) => {
        const r = [m[0] * x + m[4] * y + m[8] * z, m[1] * x + m[5] * y + m[9] * z, m[2] * x + m[6] * y + m[10] * z];
        const l = Math.hypot(r[0], r[1], r[2]) || 1;
        return [r[0] / l, r[1] / l, r[2] / l];
    };

    blades.forEach((b) => {
        const wx = Math.cos(b.facing), wz = Math.sin(b.facing);
        for (let s = 0; s < SEGMENTS; ++s) {
            const t0 = s / SEGMENTS, t1 = (s + 1) / SEGMENTS;
            bladeCurve(b, t0, curve);
            bladeCurve(b, t1, next);
            const mx = (curve[0] + next[0]) / 2, my = (curve[1] + next[1]) / 2, mz = (curve[2] + next[2]) / 2;
            const dx = next[0] - curve[0], dy = next[1] - curve[1], dz = next[2] - curve[2];
            const length = Math.hypot(dx, dy, dz);
            if (!(length > 0)) continue;
            // frame: along the blade, across it, its normal
            const ax = tv(dx, dy, dz);
            const across = tv(wx, 0, wz);
            let n = [ax[1] * across[2] - ax[2] * across[1], ax[2] * across[0] - ax[0] * across[2], ax[0] * across[1] - ax[1] * across[0]];
            const nl = Math.hypot(n[0], n[1], n[2]) || 1;
            n = [n[0] / nl, n[1] / nl, n[2] / nl];
            const bx = [n[1] * ax[2] - n[2] * ax[1], n[2] * ax[0] - n[0] * ax[2], n[0] * ax[1] - n[1] * ax[0]];
            const q = quatFromBasis(ax[0], ax[1], ax[2], bx[0], bx[1], bx[2], n[0], n[1], n[2]);
            const tm = (t0 + t1) / 2;
            const halfWidth = b.width * 0.5 * Math.pow(1 - tm, 0.6);
            if (b.flower >= 0) {
                c[0] = 0.2; c[1] = 0.42; c[2] = 0.12;
            } else {
                bladeColor(p, b.variation, tm, c);
            }
            const pos = tp(mx, my, mz);
            out.add(
                pos[0], pos[1], pos[2],
                q[0], q[1], q[2], q[3],
                length * 0.6 * scale, Math.max(halfWidth, b.width * 0.12) * 0.9 * scale, b.width * 0.08 * scale,
                srgbToLinear(c[0]) * tint[0], srgbToLinear(c[1]) * tint[1], srgbToLinear(c[2]) * tint[2], 1,
                n[0], n[1], n[2],
                material
            );
        }
        if (b.flower >= 0) {
            bladeCurve(b, 1, curve);
            const r = b.width * 4.5;
            const f = palette[b.flower];
            const pos = tp(curve[0], curve[1] + r * 0.05, curve[2]);
            const up = tv(0, 1, 0);
            const side = tv(wx, 0, wz);
            const other = [up[1] * side[2] - up[2] * side[1], up[2] * side[0] - up[0] * side[2], up[0] * side[1] - up[1] * side[0]];
            const q = quatFromBasis(side[0], side[1], side[2], other[0], other[1], other[2], up[0], up[1], up[2]);
            out.add(
                pos[0], pos[1], pos[2],
                q[0], q[1], q[2], q[3],
                r * 0.55 * scale, r * 0.55 * scale, r * 0.08 * scale,
                srgbToLinear(f[0]) * tint[0], srgbToLinear(f[1]) * tint[1], srgbToLinear(f[2]) * tint[2], 1,
                up[0], up[1], up[2],
                material
            );
        }
    });
    return out.count - start;
};

export { GrassParams, GrassArea, defaultGrass, grassGlb, grassSamples, bladeCount, grassSplatCount, bladesPerArea, flowerPalettes, MAX_BLADES };
