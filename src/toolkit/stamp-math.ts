// Maths for the stamp brush. A stamp is a patch of gaussians captured from the
// scene; painting places rigidly transformed copies of it on the surface under
// the cursor. This is the "clone a 3D patch along a stroke" idea of gaussian
// splat brushes (e.g. "Painting with 3D Gaussian Splat Brushes", 2025) in its
// simplest form: no deformation of the patch, no blending at the seams.
//
// Everything here works in PLY space (the space splat files are stored in).

type Vec = [number, number, number];
type Quat = [number, number, number, number];       // w x y z, as stored in a PLY

// floats per gaussian: x y z, f_dc 0..2, opacity, scale 0..2, rot 0..3
const FLOATS = 14;
const properties = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];

type Stamp = {
    count: number;
    rows: Float32Array;     // FLOATS per gaussian, positions relative to the centre
    normal: Vec;            // the patch's own "up": the direction it is thinnest in
    radius: number;         // rough half width of the patch
};

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

// read the gaussians of a binary little-endian 3DGS .ply
const parsePly = (buffer: ArrayBuffer): Float32Array => {
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
    let count = 0;
    let inVertex = false;
    let stride = 0;
    const offsets = new Map<string, { offset: number, type: string }>();
    lines.forEach((line) => {
        const words = line.trim().split(/\s+/);
        if (words[0] === 'element') {
            inVertex = words[1] === 'vertex';
            if (inVertex) count = parseInt(words[2], 10);
        } else if (words[0] === 'property' && inVertex) {
            offsets.set(words[2], { offset: stride, type: words[1] });
            stride += typeSizes[words[1]] ?? 4;
        }
    });
    const columns = properties.map((name) => {
        const column = offsets.get(name);
        if (!column || (column.type !== 'float' && column.type !== 'float32')) {
            throw new Error(`the PLY has no float '${name}' property`);
        }
        return column.offset;
    });
    const view = new DataView(buffer, end);
    const rows = new Float32Array(count * FLOATS);
    for (let i = 0; i < count; ++i) {
        for (let c = 0; c < FLOATS; ++c) {
            rows[i * FLOATS + c] = view.getFloat32(i * stride + columns[c], true);
        }
    }
    return rows;
};

const writePly = (rows: Float32Array): Blob => {
    const header = [
        'ply',
        'format binary_little_endian 1.0',
        `element vertex ${rows.length / FLOATS}`,
        ...properties.map(name => `property float ${name}`),
        'end_header',
        ''
    ].join('\n');
    // the editor runs on little-endian platforms, so the floats are written as-is
    return new Blob([header, rows as BlobPart]);
};

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

const quatAxisAngle = (axis: Vec, angle: number): Quat => {
    const s = Math.sin(angle / 2);
    return [Math.cos(angle / 2), axis[0] * s, axis[1] * s, axis[2] * s];
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

// Turn captured gaussians into a stamp: centre them, and find the direction the
// patch is thinnest in (its normal), pointing towards `eye`.
const makeStamp = (source: Float32Array, eye: Vec): Stamp => {
    const count = source.length / FLOATS;
    const rows = source.slice();
    const centre: Vec = [0, 0, 0];
    for (let i = 0; i < count; ++i) {
        for (let k = 0; k < 3; ++k) centre[k] += rows[i * FLOATS + k] / count;
    }
    const cov = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let i = 0; i < count; ++i) {
        for (let k = 0; k < 3; ++k) rows[i * FLOATS + k] -= centre[k];
        for (let r = 0; r < 3; ++r) {
            for (let c = 0; c < 3; ++c) {
                cov[r][c] += rows[i * FLOATS + r] * rows[i * FLOATS + c] / count;
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
    return { count, rows, normal, radius: 2 * Math.sqrt(Math.max(values[wide], 1e-12)) };
};

// write one copy of the stamp into out[offset...]: rotated by q, scaled by k,
// centred on `point`
const placeStamp = (stamp: Stamp, out: Float32Array, offset: number, point: Vec, q: Quat, k: number) => {
    const { rows, count } = stamp;
    const [w, x, y, z] = q;
    const logK = Math.log(k);
    for (let i = 0; i < count; ++i) {
        const s = i * FLOATS;
        const d = offset + s;
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
        out[d + 3] = rows[s + 3];
        out[d + 4] = rows[s + 4];
        out[d + 5] = rows[s + 5];
        out[d + 6] = rows[s + 6];
        out[d + 7] = rows[s + 7] + logK;
        out[d + 8] = rows[s + 8] + logK;
        out[d + 9] = rows[s + 9] + logK;
        const r = quatMul(q, [rows[s + 10], rows[s + 11], rows[s + 12], rows[s + 13]]);
        out[d + 10] = r[0];
        out[d + 11] = r[1];
        out[d + 12] = r[2];
        out[d + 13] = r[3];
    }
};

export { FLOATS, Stamp, Vec, Quat, parsePly, writePly, makeStamp, placeStamp, dot, cross, normalize, quatMul, quatAxisAngle, quatBetween };
