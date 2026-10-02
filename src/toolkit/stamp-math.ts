import { Mat3, Quat as PcQuat } from 'playcanvas';

import { SHRotation } from '../sh-utils';

// Maths for the stamp brush. A stamp is a patch of gaussians captured from the
// scene; painting places rigidly transformed copies of it on the surface under
// the cursor. This is the "clone a 3D patch along a stroke" idea of gaussian
// splat brushes (e.g. "Painting with 3D Gaussian Splat Brushes", 2025): the
// patch itself is not deformed, but its edge can be feathered so neighbouring
// copies blend instead of meeting at a hard seam.
//
// Everything here works in PLY space (the space splat files are stored in).
// A row is the 14 base floats followed by the patch's f_rest SH coefficients,
// stored channel-major like in the file (all red, then green, then blue).

type Vec = [number, number, number];
type Quat = [number, number, number, number];       // w x y z, as stored in a PLY

// base floats per gaussian: x y z, f_dc 0..2, opacity, scale 0..2, rot 0..3
const BASE = 14;
const baseProperties = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
const SH_C0 = 0.28209479177387814;

// f_rest counts per SH band level
const restCounts = [0, 9, 24, 45];

type Stamp = {
    name: string;
    count: number;
    rest: number;           // f_rest floats per gaussian
    rows: Float32Array;     // BASE + rest floats per gaussian, positions relative to the centre
    normal: Vec;            // the patch's own "up": the direction it is thinnest in
    tangent: Vec;           // the direction it is widest in
    radius: number;         // half width of the patch (95% of it lies within)
    edge: Float32Array;     // per gaussian: distance from the centre, 1 = the patch's rim
};

const floatsOf = (rest: number) => BASE + rest;

const typeSizes: Record<string, number> = {
    char: 1,
    uchar: 1,
    int8: 1,
    uint8: 1,
    short: 2,
    ushort: 2,
    int16: 2,
    uint16: 2,
    int: 4,
    uint: 4,
    int32: 4,
    uint32: 4,
    float: 4,
    float32: 4,
    double: 8,
    float64: 8
};

// read the gaussians of a binary little-endian 3DGS .ply, with whatever SH
// bands it carries
const parsePly = (buffer: ArrayBuffer): { rows: Float32Array, rest: number, comments: string[] } => {
    const bytes = new Uint8Array(buffer);
    const marker = new TextEncoder().encode('end_header\n');
    let end = -1;
    for (let i = 0; i <= Math.min(bytes.length, 65536) - marker.length && end < 0; ++i) {
        let match = true;
        for (let j = 0; j < marker.length && match; ++j) {
            match = bytes[i + j] === marker[j];
        }
        if (match) end = i + marker.length;
    }
    if (end < 0) {
        throw new Error('not a PLY file');
    }
    const lines = new TextDecoder().decode(bytes.subarray(0, end)).split('\n');
    if (!lines.some(line => line.trim() === 'format binary_little_endian 1.0')) {
        throw new Error('only binary little-endian PLY files can be used as stamps');
    }
    let count = 0;
    let inVertex = false;
    let vertexDone = false;
    let elements = 0;
    let stride = 0;
    const comments: string[] = [];
    const offsets = new Map<string, { offset: number, type: string }>();
    lines.forEach((line) => {
        const words = line.trim().split(/\s+/);
        if (words[0] === 'comment') {
            comments.push(line.trim().slice(8));
        } else if (words[0] === 'element') {
            if (inVertex) vertexDone = true;
            inVertex = words[1] === 'vertex';
            if (inVertex && elements > 0) {
                throw new Error('the PLY stores other data ahead of its splats');
            }
            if (inVertex) count = parseInt(words[2], 10);
            elements++;
        } else if (words[0] === 'property' && inVertex && !vertexDone) {
            offsets.set(words[2], { offset: stride, type: words[1] });
            stride += typeSizes[words[1]] ?? 4;
        }
    });
    let rest = 0;
    while (offsets.has(`f_rest_${rest}`)) rest++;
    rest = restCounts.reduce((best, n) => (n <= rest ? n : best), 0);
    const names = baseProperties.concat(Array.from({ length: rest }, (_, i) => `f_rest_${i}`));
    const columns = names.map((name) => {
        const column = offsets.get(name);
        if (!column || (column.type !== 'float' && column.type !== 'float32')) {
            throw new Error(`the PLY has no float '${name}' property`);
        }
        return column.offset;
    });
    const floats = floatsOf(rest);
    const view = new DataView(buffer, end);
    const rows = new Float32Array(count * floats);
    for (let i = 0; i < count; ++i) {
        for (let c = 0; c < floats; ++c) {
            rows[i * floats + c] = view.getFloat32(i * stride + columns[c], true);
        }
    }
    return { rows, rest, comments };
};

const plyHeader = (count: number, rest: number, comments: string[] = []) => [
    'ply',
    'format binary_little_endian 1.0',
    ...comments.map(c => `comment ${c}`),
    `element vertex ${count}`,
    ...baseProperties.map(name => `property float ${name}`),
    ...Array.from({ length: rest }, (_, i) => `property float f_rest_${i}`),
    'end_header',
    ''
].join('\n');

// a PLY around raw row bytes (BASE + rest floats per gaussian). Blobs compose
// without copying, which is what keeps growing a stamp layer cheap
const plyBlob = (body: Blob | Float32Array, count: number, rest: number, comments?: string[]): Blob => {
    // the editor runs on little-endian platforms, so the floats are written as-is
    return new Blob([plyHeader(count, rest, comments), body as BlobPart]);
};

const writePly = (rows: Float32Array, rest: number): Blob => plyBlob(rows, rows.length / floatsOf(rest), rest);

const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec, b: Vec): Vec => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = (a: Vec): Vec => {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
};

const quatMul = (a: Quat, b: Quat): Quat => [
    a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
    a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
    a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
    a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0]
];

const quatConj = (q: Quat): Quat => [q[0], -q[1], -q[2], -q[3]];

const quatAxisAngle = (axis: Vec, angle: number): Quat => {
    const s = Math.sin(angle / 2);
    return [Math.cos(angle / 2), axis[0] * s, axis[1] * s, axis[2] * s];
};

// rotate v by the unit quaternion q
const quatRotate = (q: Quat, v: Vec): Vec => {
    const [w, x, y, z] = q;
    const cx = y * v[2] - z * v[1];
    const cy = z * v[0] - x * v[2];
    const cz = x * v[1] - y * v[0];
    return [
        v[0] + 2 * (w * cx + y * cz - z * cy),
        v[1] + 2 * (w * cy + z * cx - x * cz),
        v[2] + 2 * (w * cz + x * cy - y * cx)
    ];
};

// shortest rotation taking unit vector a onto unit vector b
const quatBetween = (a: Vec, b: Vec): Quat => {
    const d = dot(a, b);
    if (d < -0.999999) {
        // opposite: half a turn about any axis perpendicular to a
        const axis = normalize(Math.abs(a[0]) < 0.9 ? cross(a, [1, 0, 0]) : cross(a, [0, 1, 0]));
        return [0, axis[0], axis[1], axis[2]];
    }
    const c = cross(a, b);
    const q: Quat = [1 + d, c[0], c[1], c[2]];
    const l = Math.hypot(q[0], q[1], q[2], q[3]);
    return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
};

// small seeded generator (mulberry32), so a stroke can be repeated exactly
const createRandom = (seed: number) => {
    let a = (seed >>> 0) || 0x9e3779b9;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
};

// eigenvectors of a symmetric 3x3 matrix (cyclic Jacobi); returns them as the
// columns of v together with the eigenvalues
const eigen = (m: number[][]) => {
    const a = m.map(row => row.slice());
    const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    for (let sweep = 0; sweep < 24; ++sweep) {
        for (let p = 0; p < 2; ++p) {
            for (let q = p + 1; q < 3; ++q) {
                if (Math.abs(a[p][q]) < 1e-20) continue;
                const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
                const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
                const c = 1 / Math.sqrt(t * t + 1);
                const s = t * c;
                for (let k = 0; k < 3; ++k) {
                    const akp = a[k][p];
                    const akq = a[k][q];
                    a[k][p] = c * akp - s * akq;
                    a[k][q] = s * akp + c * akq;
                }
                for (let k = 0; k < 3; ++k) {
                    const apk = a[p][k];
                    const aqk = a[q][k];
                    a[p][k] = c * apk - s * aqk;
                    a[q][k] = s * apk + c * aqk;
                }
                for (let k = 0; k < 3; ++k) {
                    const vkp = v[k][p];
                    const vkq = v[k][q];
                    v[k][p] = c * vkp - s * vkq;
                    v[k][q] = s * vkp + c * vkq;
                }
            }
        }
    }
    return { values: [a[0][0], a[1][1], a[2][2]], vectors: v };
};

const percentile = (values: Float32Array, p: number) => {
    if (values.length === 0) return 0;
    const sorted = values.slice().sort();
    return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
};

// Turn captured gaussians into a stamp: centre them (opacity weighted, so
// faint floaters don't pull the centre), and find the direction the patch is
// thinnest in (its normal), pointing towards `eye`.
const makeStamp = (source: Float32Array, rest: number, eye: Vec, name = 'Stamp', orient?: { normal: Vec, tangent: Vec }): Stamp => {
    const floats = floatsOf(rest);
    const count = source.length / floats;
    const rows = source.slice();

    const weights = new Float32Array(count);
    let total = 0;
    for (let i = 0; i < count; ++i) {
        weights[i] = 1 / (1 + Math.exp(-rows[i * floats + 6]));
        total += weights[i];
    }
    if (total <= 0) {
        weights.fill(1);
        total = count;
    }

    const centre: Vec = [0, 0, 0];
    for (let i = 0; i < count; ++i) {
        for (let k = 0; k < 3; ++k) centre[k] += rows[i * floats + k] * weights[i] / total;
    }
    const cov = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let i = 0; i < count; ++i) {
        for (let k = 0; k < 3; ++k) rows[i * floats + k] -= centre[k];
        for (let r = 0; r < 3; ++r) {
            for (let c = 0; c < 3; ++c) {
                cov[r][c] += rows[i * floats + r] * rows[i * floats + c] * weights[i] / total;
            }
        }
    }
    const { values, vectors } = eigen(cov);
    let thin = 0;
    let wide = 0;
    for (let k = 1; k < 3; ++k) {
        if (values[k] < values[thin]) thin = k;
        if (values[k] > values[wide]) wide = k;
    }
    let normal = normalize([vectors[0][thin], vectors[1][thin], vectors[2][thin]]);
    const toEye: Vec = [eye[0] - centre[0], eye[1] - centre[1], eye[2] - centre[2]];
    if (dot(normal, toEye) < 0) {
        normal = [-normal[0], -normal[1], -normal[2]];
    }
    let tangent = normalize([vectors[0][wide], vectors[1][wide], vectors[2][wide]]);
    if (orient) {
        normal = orient.normal;
        tangent = orient.tangent;
    }
    const bitangent = cross(normal, tangent);

    // in-plane distances: plain for the size, and normalised to the patch's
    // own (elliptical) outline for the feathered rim
    const planar = new Float32Array(count);
    const us = new Float32Array(count);
    const vs = new Float32Array(count);
    for (let i = 0; i < count; ++i) {
        const p: Vec = [rows[i * floats], rows[i * floats + 1], rows[i * floats + 2]];
        us[i] = dot(p, tangent);
        vs[i] = dot(p, bitangent);
        planar[i] = Math.hypot(us[i], vs[i]);
    }
    const radius = Math.max(1e-6, percentile(planar, 0.95));
    const ru = Math.max(1e-6, percentile(us.map(Math.abs), 0.95));
    const rv = Math.max(1e-6, percentile(vs.map(Math.abs), 0.95));
    const edge = new Float32Array(count);
    for (let i = 0; i < count; ++i) {
        edge[i] = Math.hypot(us[i] / ru, vs[i] / rv);
    }
    const rim = Math.max(1e-6, percentile(edge, 0.97));
    for (let i = 0; i < count; ++i) edge[i] /= rim;

    return { name, count, rest, rows, normal, tangent, radius, edge };
};

type PlaceOptions = {
    destRest: number;       // f_rest floats per gaussian of the layer the copy goes into
    feather: number;        // 0..1: how much of the patch fades out towards its rim
    tone: number;           // brightness multiplier for this copy
};

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
const logit = (a: number) => Math.log(a / (1 - a));

const smoothstep = (lo: number, hi: number, x: number) => {
    const t = Math.max(0, Math.min(1, (x - lo) / Math.max(1e-6, hi - lo)));
    return t * t * (3 - 2 * t);
};

const shTmp = new Float32Array(15);
const pcQuat = new PcQuat();
const pcMat3 = new Mat3();

// write one copy of the stamp into out[offset...]: rotated by q, scaled by k,
// centred on `point`. Gaussians feathered away entirely are left out; returns
// the number written.
const placeStamp = (stamp: Stamp, out: Float32Array, offset: number, point: Vec, q: Quat, k: number, options: PlaceOptions) => {
    const { rows, count, rest, edge } = stamp;
    const floats = floatsOf(rest);
    const destRest = options.destRest;
    const destFloats = floatsOf(destRest);
    const srcCoeffs = rest / 3;
    const dstCoeffs = destRest / 3;
    const coeffs = Math.min(srcCoeffs, dstCoeffs);
    const [w, x, y, z] = q;
    const logK = Math.log(k);
    const feather = Math.max(0, Math.min(1, options.feather));
    const tone = options.tone;

    // view dependent colour turns with the copy
    let shRot: SHRotation | null = null;
    if (coeffs > 0) {
        pcQuat.set(x, y, z, w);
        pcMat3.setFromQuat(pcQuat);
        shRot = new SHRotation(pcMat3);
    }

    let written = 0;
    for (let i = 0; i < count; ++i) {
        const s = i * floats;

        let opacity = rows[s + 6];
        if (feather > 0) {
            const f = 1 - smoothstep(1 - feather, 1 + 0.1 * feather, edge[i]);
            if (f < 0.03) continue;
            if (f < 1) {
                opacity = logit(Math.max(1e-6, Math.min(1 - 1e-6, sigmoid(opacity) * f)));
            }
        }

        const d = offset + written * destFloats;
        written++;
        // v' = v + 2w(u x v) + 2u x (u x v)
        const vx = rows[s] * k;
        const vy = rows[s + 1] * k;
        const vz = rows[s + 2] * k;
        const cx = y * vz - z * vy;
        const cy = z * vx - x * vz;
        const cz = x * vy - y * vx;
        out[d] = point[0] + vx + 2 * (w * cx + y * cz - z * cy);
        out[d + 1] = point[1] + vy + 2 * (w * cy + z * cx - x * cz);
        out[d + 2] = point[2] + vz + 2 * (w * cz + x * cy - y * cx);
        for (let c = 0; c < 3; ++c) {
            const dc = rows[s + 3 + c];
            out[d + 3 + c] = tone === 1 ? dc : ((0.5 + SH_C0 * dc) * tone - 0.5) / SH_C0;
        }
        out[d + 6] = opacity;
        out[d + 7] = rows[s + 7] + logK;
        out[d + 8] = rows[s + 8] + logK;
        out[d + 9] = rows[s + 9] + logK;
        const r = quatMul(q, [rows[s + 10], rows[s + 11], rows[s + 12], rows[s + 13]]);
        out[d + 10] = r[0];
        out[d + 11] = r[1];
        out[d + 12] = r[2];
        out[d + 13] = r[3];

        if (destRest > 0) {
            for (let c = 0; c < 3; ++c) {
                const src = s + BASE + c * srcCoeffs;
                const dst = d + BASE + c * dstCoeffs;
                if (shRot) {
                    const tmp = shTmp.subarray(0, srcCoeffs);
                    tmp.set(rows.subarray(src, src + srcCoeffs));
                    shRot.apply(tmp);
                    for (let j = 0; j < dstCoeffs; ++j) {
                        out[dst + j] = j < coeffs ? tmp[j] * tone : 0;
                    }
                } else {
                    out.fill(0, dst, dst + dstCoeffs);
                }
            }
        }
    }
    return written;
};

// a stamp as a .ply file. The comment keeps its orientation, so a stamp that
// is saved and loaded again lies the same way up
const STAMP_COMMENT = 'supersplat-stamp';

const stampToPly = (stamp: Stamp): Blob => plyBlob(stamp.rows, stamp.count, stamp.rest, [
    `${STAMP_COMMENT} ${[...stamp.normal, ...stamp.tangent].map(v => v.toFixed(6)).join(' ')} ${JSON.stringify(stamp.name)}`
]);

const stampFromPly = (buffer: ArrayBuffer, fallbackName: string): Stamp => {
    const { rows, rest, comments } = parsePly(buffer);
    const count = rows.length / floatsOf(rest);
    if (count === 0) {
        throw new Error('the file has no splats');
    }
    const meta = comments.find(c => c.startsWith(STAMP_COMMENT));
    let orient: { normal: Vec, tangent: Vec } | undefined;
    let name = fallbackName;
    if (meta) {
        const words = meta.slice(STAMP_COMMENT.length).trim().split(' ');
        const v = words.slice(0, 6).map(parseFloat);
        if (v.every(Number.isFinite)) {
            orient = { normal: normalize([v[0], v[1], v[2]]), tangent: normalize([v[3], v[4], v[5]]) };
        }
        try {
            name = JSON.parse(words.slice(6).join(' ')) || name;
        } catch {
            // keep the file name
        }
    }
    // a plain splat file: lie it flat on its thinnest side, facing PLY up (-y)
    return makeStamp(rows, rest, [0, -1e6, 0], name, orient);
};

// a small top-down picture of the stamp, for the stamp list
const stampThumbnail = (stamp: Stamp, size: number): Uint8ClampedArray<ArrayBuffer> => {
    const pixels = new Float32Array(size * size * 4);
    const { rows, count, rest, normal, tangent, radius } = stamp;
    const floats = floatsOf(rest);
    const bitangent = cross(normal, tangent);
    const step = Math.max(1, Math.floor(count / 40000));
    const order: number[] = [];
    for (let i = 0; i < count; i += step) order.push(i);
    // back to front along the normal
    const height = (i: number) => rows[i * floats] * normal[0] + rows[i * floats + 1] * normal[1] + rows[i * floats + 2] * normal[2];
    order.sort((a, b) => height(a) - height(b));
    const half = size / 2;
    const scale = half / (radius * 1.15);
    order.forEach((i) => {
        const s = i * floats;
        const p: Vec = [rows[s], rows[s + 1], rows[s + 2]];
        const px = half + dot(p, tangent) * scale;
        const py = half - dot(p, bitangent) * scale;
        const extent = Math.exp(Math.max(rows[s + 7], rows[s + 8], rows[s + 9])) * scale;
        const r = Math.max(0.6, Math.min(size / 6, extent));
        const alpha = sigmoid(rows[s + 6]);
        const col = [0, 1, 2].map(c => Math.max(0, Math.min(1, 0.5 + SH_C0 * rows[s + 3 + c])));
        const x0 = Math.max(0, Math.floor(px - r));
        const x1 = Math.min(size - 1, Math.ceil(px + r));
        const y0 = Math.max(0, Math.floor(py - r));
        const y1 = Math.min(size - 1, Math.ceil(py + r));
        for (let yy = y0; yy <= y1; ++yy) {
            for (let xx = x0; xx <= x1; ++xx) {
                const d2 = ((xx + 0.5 - px) ** 2 + (yy + 0.5 - py) ** 2) / (r * r);
                if (d2 > 1) continue;
                const a = alpha * Math.exp(-2 * d2);
                const o = (yy * size + xx) * 4;
                for (let c = 0; c < 3; ++c) pixels[o + c] = pixels[o + c] * (1 - a) + col[c] * a;
                pixels[o + 3] = pixels[o + 3] * (1 - a) + a;
            }
        }
    });
    const out = new Uint8ClampedArray(size * size * 4);
    for (let i = 0; i < size * size; ++i) {
        const a = pixels[i * 4 + 3];
        for (let c = 0; c < 3; ++c) {
            // un-premultiply
            const v = a > 1e-4 ? pixels[i * 4 + c] / a : 0;
            out[i * 4 + c] = Math.round(255 * Math.min(1, v));
        }
        out[i * 4 + 3] = Math.round(255 * Math.min(1, a));
    }
    return out;
};

export {
    BASE, Stamp, Vec, Quat, PlaceOptions,
    floatsOf, parsePly, plyBlob, writePly, stampToPly, stampFromPly, makeStamp, placeStamp, stampThumbnail,
    dot, cross, normalize, quatMul, quatConj, quatRotate, quatAxisAngle, quatBetween, createRandom
};
