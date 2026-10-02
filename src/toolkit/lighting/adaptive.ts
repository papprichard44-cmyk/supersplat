import { S_ALPHA, S_NORMAL, S_POS, S_ROT, S_SCALE, STRIDE, SampleBuffer, SplatColors, restCount } from './samples';

// The adaptive solver: from a dense, finely sampled and already lit set of
// surface gaussians, merge the ones that sit on an even patch of colour into
// a few large, flat, anisotropic gaussians - the way a trained splat scene
// covers a plain wall with a handful of big splats and keeps the small ones
// for the detail. Edges stay sharp because nothing is merged near them:
//
// 1. Cells of a grid (the base spacing) that hold an edge - a change of
//    colour, the rim of a surface, a crease, two objects meeting - are
//    marked, and every cell gets its distance from the nearest edge.
// 2. Level by level (2, 4, 8 ... base cells), the gaussians in a cell of that
//    size are merged into one when their colours, opacities and normals
//    agree, they lie in a plane, fill the cell compactly, and are far enough
//    from an edge that the merged gaussian's tail won't spill over it.
// 3. A merged gaussian matches the area it replaces: its covariance comes
//    from the area's second moments, scaled like the base gaussians are to
//    their cells, so it closes the surface just as they did.
//
// The colours are the final, baked ones: shadow edges and highlights are
// edges too.

const SH_C0 = 0.28209479177387814;
// base gaussians' standard deviation in sampling cells (faces 0.7, models 0.85)
const K = 0.75;
// the area of a base sample is that of its cell: c = sigma / K
const MAX_DIST = 255;

type AdaptiveOptions = {
    tolerance: number;      // display colour (0..1) range one merged gaussian may span
    maxLevel: number;       // merged gaussians span up to 2^maxLevel base cells
};

type AdaptiveResult = {
    samples: SampleBuffer;
    colors: SplatColors;
    groups: Int32Array;     // per output sample: the group (object) it belongs to
    before: number;
    after: number;
    // why neighbourhoods were left as they were (diagnostics)
    reasons: Record<string, number>;
    edgeCells: number;
    cells: number;
};

// eigen decomposition of a symmetric 3x3 (Jacobi): values descending, vectors as columns
const eigen3 = (m: number[]) => {
    const a = [[m[0], m[1], m[2]], [m[1], m[3], m[4]], [m[2], m[4], m[5]]];
    const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    for (let sweep = 0; sweep < 12; ++sweep) {
        const off = Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]);
        if (off < 1e-30) break;
        for (let p = 0; p < 2; ++p) {
            for (let q = p + 1; q < 3; ++q) {
                if (Math.abs(a[p][q]) < 1e-30) continue;
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
    const order = [0, 1, 2].sort((i, j) => a[j][j] - a[i][i]);
    return {
        values: order.map(i => Math.max(0, a[i][i])),
        vectors: order.map(i => [v[0][i], v[1][i], v[2][i]])
    };
};

const quatFromBasis = (x: number[], y: number[], z: number[]) => {
    const m00 = x[0], m10 = x[1], m20 = x[2];
    const m01 = y[0], m11 = y[1], m21 = y[2];
    const m02 = z[0], m12 = z[1], m22 = z[2];
    const trace = m00 + m11 + m22;
    if (trace > 0) {
        const s = Math.sqrt(trace + 1) * 2;
        return [0.25 * s, (m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s];
    }
    if (m00 > m11 && m00 > m22) {
        const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
        return [(m21 - m12) / s, 0.25 * s, (m01 + m10) / s, (m02 + m20) / s];
    }
    if (m11 > m22) {
        const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
        return [(m02 - m20) / s, (m01 + m10) / s, 0.25 * s, (m12 + m21) / s];
    }
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    return [(m10 - m01) / s, (m02 + m20) / s, (m12 + m21) / s, 0.25 * s];
};

// rotate the unit axes by a quaternion (w x y z)
const axes = (w: number, x: number, y: number, z: number) => [
    [1 - 2 * (y * y + z * z), 2 * (x * y + w * z), 2 * (x * z - w * y)],
    [2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x)],
    [2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y)]
];

const yieldNow = () => new Promise((resolve) => {
    setTimeout(resolve, 0);
});

const adaptiveSimplify = async (
    samples: SampleBuffer,
    colors: SplatColors,
    groups: Int32Array,
    locked: Uint8Array | null,
    options: AdaptiveOptions,
    progress?: (fraction: number) => void
): Promise<AdaptiveResult> => {
    const N = samples.count;
    const d = samples.data;
    const nRest = restCount(colors.degree);
    const tol = options.tolerance;

    // ---- per sample: display colour, cell size, normal
    const rgb = new Float32Array(N * 3);
    const cell = new Float32Array(N);
    for (let i = 0; i < N; ++i) {
        for (let c = 0; c < 3; ++c) rgb[i * 3 + c] = colors.dc[i * 3 + c] * SH_C0 + 0.5;
        const o = i * STRIDE;
        cell[i] = Math.sqrt(Math.max(1e-24, d[o + S_SCALE] * d[o + S_SCALE + 1])) / K;
    }
    // the base spacing: the median cell
    const probe: number[] = [];
    const step = Math.max(1, Math.floor(N / 20000));
    for (let i = 0; i < N; i += step) probe.push(cell[i]);
    probe.sort((a, b) => a - b);
    const c0 = probe[Math.floor(probe.length / 2)] || 1;

    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < N; ++i) {
        const o = i * STRIDE;
        minX = Math.min(minX, d[o]); maxX = Math.max(maxX, d[o]);
        minY = Math.min(minY, d[o + 1]); maxY = Math.max(maxY, d[o + 1]);
        minZ = Math.min(minZ, d[o + 2]); maxZ = Math.max(maxZ, d[o + 2]);
    }
    // the edge grid: two base cells wide, so that every grid cell a surface
    // passes through holds samples (no gaps that would read as rims)
    const h = 2 * c0;
    const nx = Math.floor((maxX - minX) / h) + 3;
    const ny = Math.floor((maxY - minY) / h) + 3;
    const nz = Math.floor((maxZ - minZ) / h) + 3;
    const reasons: Record<string, number> = {};
    const reject = (why: string) => {
        reasons[why] = (reasons[why] ?? 0) + 1;
    };
    const identity = (): AdaptiveResult => ({ samples, colors, groups, before: N, after: N, reasons, edgeCells: 0, cells: 0 });
    if (!(N > 1) || nx * ny * nz > 2 ** 52) return identity();

    // ---- 1. edges on the base grid
    const cellKey = (x: number, y: number, z: number) => {
        const ix = Math.floor((x - minX) / h) + 1;
        const iy = Math.floor((y - minY) / h) + 1;
        const iz = Math.floor((z - minZ) / h) + 1;
        return ix + nx * (iy + ny * iz);
    };
    const cellIndex = new Map<number, number>();
    const cellOf = new Int32Array(N);
    const keys: number[] = [];
    for (let i = 0; i < N; ++i) {
        const o = i * STRIDE;
        const key = cellKey(d[o], d[o + 1], d[o + 2]);
        let ci = cellIndex.get(key);
        if (ci === undefined) {
            ci = keys.length;
            cellIndex.set(key, ci);
            keys.push(key);
        }
        cellOf[i] = ci;
    }
    const C = keys.length;
    const cCount = new Float32Array(C);
    const cPos = new Float64Array(C * 3);
    const cNrm = new Float32Array(C * 3);
    const cCol = new Float32Array(C * 3);
    const cSq = new Float32Array(C * 3);
    const cGroup = new Int32Array(C).fill(-2);
    const edge = new Uint8Array(C);
    for (let i = 0; i < N; ++i) {
        const ci = cellOf[i];
        const o = i * STRIDE;
        cCount[ci]++;
        for (let k = 0; k < 3; ++k) {
            cPos[ci * 3 + k] += d[o + S_POS + k];
            cNrm[ci * 3 + k] += d[o + S_NORMAL + k];
            const v = rgb[i * 3 + k];
            cCol[ci * 3 + k] += v;
            cSq[ci * 3 + k] += v * v;
        }
        const g = locked && locked[i] ? -1 : groups[i];
        if (cGroup[ci] === -2) cGroup[ci] = g;
        else if (cGroup[ci] !== g) edge[ci] = 1;      // two objects meet
        if (g === -1) edge[ci] = 1;                     // never merged here
    }
    for (let ci = 0; ci < C; ++ci) {
        const n = cCount[ci];
        for (let k = 0; k < 3; ++k) {
            cPos[ci * 3 + k] /= n;
            cCol[ci * 3 + k] /= n;
            // a cell whose colours scatter (more than fine grain): detail
            const variance = cSq[ci * 3 + k] / n - cCol[ci * 3 + k] ** 2;
            if (variance > (tol * 0.75) ** 2) edge[ci] = 1;
        }
    }
    // the occupied cells around a cell, into `around`; returns how many
    const around = new Int32Array(26);
    const neighbours = (ci: number) => {
        const key = keys[ci];
        let n = 0;
        for (let dz = -1; dz <= 1; ++dz) {
            for (let dy = -1; dy <= 1; ++dy) {
                for (let dx = -1; dx <= 1; ++dx) {
                    if (!dx && !dy && !dz) continue;
                    const cj = cellIndex.get(key + dx + nx * (dy + ny * dz));
                    if (cj !== undefined) around[n++] = cj;
                }
            }
        }
        return n;
    };
    for (let ci = 0; ci < C; ++ci) {
        if (edge[ci]) continue;
        let count = 0;
        let ox = 0, oy = 0, oz = 0;
        let colourEdge = false;
        const n = neighbours(ci);
        for (let j = 0; j < n; ++j) {
            const cj = around[j];
            count++;
            ox += cPos[cj * 3] - cPos[ci * 3];
            oy += cPos[cj * 3 + 1] - cPos[ci * 3 + 1];
            oz += cPos[cj * 3 + 2] - cPos[ci * 3 + 2];
            for (let k = 0; k < 3; ++k) {
                if (Math.abs(cCol[cj * 3 + k] - cCol[ci * 3 + k]) > tol) colourEdge = true;
            }
            if (cGroup[cj] !== cGroup[ci]) colourEdge = true;
        }
        // a rim: the neighbours lie to one side (in the surface's plane)
        let nxv = cNrm[ci * 3], nyv = cNrm[ci * 3 + 1], nzv = cNrm[ci * 3 + 2];
        const nl = Math.hypot(nxv, nyv, nzv) || 1;
        nxv /= nl; nyv /= nl; nzv /= nl;
        const along = ox * nxv + oy * nyv + oz * nzv;
        const px = ox - along * nxv, py = oy - along * nyv, pz = oz - along * nzv;
        const rim = count < 4 || Math.hypot(px, py, pz) / count > 0.3 * h;
        if (colourEdge || rim) edge[ci] = 1;
    }

    // distance (in edge-grid cells, 2 base cells each) of every cell from the nearest edge
    const dist = new Uint8Array(C).fill(MAX_DIST);
    const queue = new Int32Array(C);
    let head = 0;
    let tail = 0;
    for (let ci = 0; ci < C; ++ci) {
        if (edge[ci]) {
            dist[ci] = 0;
            queue[tail++] = ci;
        }
    }
    while (head < tail) {
        const ci = queue[head++];
        const next = dist[ci] + 1;
        if (next >= MAX_DIST) continue;
        const n = neighbours(ci);
        for (let j = 0; j < n; ++j) {
            const cj = around[j];
            if (dist[cj] > next) {
                dist[cj] = next;
                queue[tail++] = cj;
            }
        }
    }
    progress?.(0.2);
    await yieldNow();

    // ---- 2. merging, level by level
    // ids < N are the samples themselves, ids >= N merged gaussians
    let capacity = Math.max(1024, N >> 2);
    let mA = new Float64Array(capacity);
    let mMu = new Float64Array(capacity * 3);
    let mR = new Float32Array(capacity * 6);
    let mNrm = new Float32Array(capacity * 3);
    let mCol = new Float32Array(capacity * 3);
    let mSq = new Float32Array(capacity * 3);       // area-weighted mean of squared colour
    let mAlpha = new Float32Array(capacity * 3);   // mean, min, max
    let mThick = new Float32Array(capacity);
    let mDist = new Uint8Array(capacity);
    let mGroup = new Int32Array(capacity);
    let mRep = new Int32Array(capacity);
    let mParent = new Int32Array(capacity).fill(-1);
    let mFrozen = new Uint8Array(capacity);
    let merged = 0;
    const parent = new Int32Array(N).fill(-1);
    const grow = () => {
        capacity *= 2;
        const g64 = (a: Float64Array, k: number) => {
            const b = new Float64Array(capacity * k);
            b.set(a);
            return b;
        };
        const g32 = (a: Float32Array, k: number) => {
            const b = new Float32Array(capacity * k);
            b.set(a);
            return b;
        };
        mA = g64(mA, 1); mMu = g64(mMu, 3);
        mR = g32(mR, 6); mNrm = g32(mNrm, 3); mCol = g32(mCol, 3); mSq = g32(mSq, 3);
        mAlpha = g32(mAlpha, 3); mThick = g32(mThick, 1);
        const d8 = new Uint8Array(capacity); d8.set(mDist); mDist = d8;
        const gi = new Int32Array(capacity); gi.set(mGroup); mGroup = gi;
        const ri = new Int32Array(capacity); ri.set(mRep); mRep = ri;
        const pi = new Int32Array(capacity).fill(-1); pi.set(mParent); mParent = pi;
        const fr = new Uint8Array(capacity); fr.set(mFrozen); mFrozen = fr;
    };

    // the moments of an item (sample or merged): area, centre, region covariance
    const tmpR = [0, 0, 0, 0, 0, 0];
    const leafR = (i: number) => {
        const o = i * STRIDE;
        const ax = axes(d[o + S_ROT], d[o + S_ROT + 1], d[o + S_ROT + 2], d[o + S_ROT + 3]);
        const s = [d[o + S_SCALE], d[o + S_SCALE + 1], d[o + S_SCALE + 2]];
        tmpR.fill(0);
        for (let a = 0; a < 3; ++a) {
            // the cell's region: covariance of the gaussian / (12 K^2)
            const w = s[a] * s[a] / (12 * K * K);
            const v = ax[a];
            tmpR[0] += w * v[0] * v[0]; tmpR[1] += w * v[0] * v[1]; tmpR[2] += w * v[0] * v[2];
            tmpR[3] += w * v[1] * v[1]; tmpR[4] += w * v[1] * v[2]; tmpR[5] += w * v[2] * v[2];
        }
        return tmpR;
    };

    const groupOf = (id: number) => (id < N ? groups[id] : mGroup[id - N]);
    const distOf = (id: number) => (id < N ? dist[cellOf[id]] : mDist[id - N]);
    const muOf = (id: number, k: number) => (id < N ? d[id * STRIDE + S_POS + k] : mMu[(id - N) * 3 + k]);

    let active: number[] = [];
    for (let i = 0; i < N; ++i) {
        if (!(locked && locked[i])) active.push(i);
    }
    const leafFrozen = new Uint8Array(N);
    const isFrozen = (id: number) => (id < N ? leafFrozen[id] : mFrozen[id - N]) === 1;
    const freeze = (id: number) => {
        if (id < N) leafFrozen[id] = 1;
        else mFrozen[id - N] = 1;
    };
    let maxGroup = 0;
    for (let i = 0; i < N; ++i) maxGroup = Math.max(maxGroup, groups[i]);

    const acc = { A: 0, mu: [0, 0, 0], R: [0, 0, 0, 0, 0, 0], nrm: [0, 0, 0], col: [0, 0, 0], sq: [0, 0, 0], aMean: 0, aMin: 0, aMax: 0, thick: 0, dist: 0 };

    for (let level = 1; level <= options.maxLevel; ++level) {
        const size = c0 * 2 ** level;
        // the merged gaussian's tail reaches about its own size past its
        // area: that far (in base cells, plus one) from any edge, or it
        // would wash over fine detail next to it
        const need = Math.min(MAX_DIST - 1, Math.ceil((2 ** level + 1) / 2));
        const lx = Math.floor((maxX - minX) / size) + 2;
        const ly = Math.floor((maxY - minY) / size) + 2;
        const lz = Math.floor((maxZ - minZ) / size) + 2;
        // exact numeric keys while they fit, else strings
        const numeric = lx * ly * lz * (maxGroup + 1) < 2 ** 52;
        const buckets = new Map<number | string, number[]>();
        const next: number[] = [];
        for (const id of active) {
            if (isFrozen(id)) continue;
            const ix = Math.floor((muOf(id, 0) - minX) / size);
            const iy = Math.floor((muOf(id, 1) - minY) / size);
            const iz = Math.floor((muOf(id, 2) - minZ) / size);
            const key = numeric ? ix + lx * (iy + ly * iz) + lx * ly * lz * groupOf(id) : `${ix},${iy},${iz},${groupOf(id)}`;
            let list = buckets.get(key);
            if (!list) buckets.set(key, list = []);
            list.push(id);
        }
        for (const list of buckets.values()) {
            if (list.length < 2) {
                next.push(list[0]);
                continue;
            }
            // far enough from every edge for a gaussian this big
            let ok = true;
            for (const id of list) {
                if (distOf(id) < need) {
                    ok = false;
                    reject('near an edge');
                    break;
                }
            }
            if (ok) {
                // area-weighted moments
                acc.A = 0;
                acc.mu.fill(0);
                acc.nrm.fill(0);
                acc.col.fill(0);
                acc.sq.fill(0);
                acc.aMean = 0;
                acc.aMin = Infinity;
                acc.aMax = -Infinity;
                acc.thick = 0;
                acc.dist = MAX_DIST;
                for (const id of list) {
                    let A: number;
                    if (id < N) {
                        const o = id * STRIDE;
                        A = cell[id] * cell[id];
                        const a = d[o + S_ALPHA];
                        acc.aMean += a * A;
                        acc.aMin = Math.min(acc.aMin, a);
                        acc.aMax = Math.max(acc.aMax, a);
                        acc.thick += d[o + S_SCALE + 2] * A;
                        for (let k = 0; k < 3; ++k) {
                            acc.mu[k] += d[o + S_POS + k] * A;
                            acc.nrm[k] += d[o + S_NORMAL + k] * A;
                            const v = rgb[id * 3 + k];
                            acc.col[k] += v * A;
                            acc.sq[k] += v * v * A;
                        }
                    } else {
                        const m = id - N;
                        A = mA[m];
                        acc.aMean += mAlpha[m * 3] * A;
                        acc.aMin = Math.min(acc.aMin, mAlpha[m * 3 + 1]);
                        acc.aMax = Math.max(acc.aMax, mAlpha[m * 3 + 2]);
                        acc.thick += mThick[m] * A;
                        for (let k = 0; k < 3; ++k) {
                            acc.mu[k] += mMu[m * 3 + k] * A;
                            acc.nrm[k] += mNrm[m * 3 + k] * A;
                            acc.col[k] += mCol[m * 3 + k] * A;
                            acc.sq[k] += mSq[m * 3 + k] * A;
                        }
                    }
                    acc.A += A;
                    acc.dist = Math.min(acc.dist, distOf(id));
                }
                const A = acc.A;
                for (let k = 0; k < 3; ++k) {
                    acc.mu[k] /= A;
                    acc.col[k] /= A;
                    acc.sq[k] /= A;
                    // spread of the colours it would replace: grain is fine,
                    // a real change is not
                    if (acc.sq[k] - acc.col[k] ** 2 > (tol * 0.6) ** 2) ok = false;
                }
                // and none of the parts far from the whole
                if (ok) {
                    for (const id of list) {
                        for (let k = 0; k < 3; ++k) {
                            const v = id < N ? rgb[id * 3 + k] : mCol[(id - N) * 3 + k];
                            if (Math.abs(v - acc.col[k]) > tol * 1.5) ok = false;
                        }
                    }
                }
                if (!ok) reject('colour');
                if (ok && acc.aMax - acc.aMin > 0.08) {
                    ok = false;
                    reject('opacity');
                }
                const nLen = Math.hypot(acc.nrm[0], acc.nrm[1], acc.nrm[2]) / A;
                if (ok && nLen < 0.985) {
                    ok = false;
                    reject('curved');
                }
                if (ok) {
                    // region covariance about the common centre (parallel axes)
                    acc.R.fill(0);
                    for (const id of list) {
                        let A1: number;
                        let R1: number[];
                        if (id < N) {
                            A1 = cell[id] * cell[id];
                            R1 = leafR(id);
                        } else {
                            A1 = mA[id - N];
                            R1 = Array.from(mR.subarray((id - N) * 6, (id - N) * 6 + 6));
                        }
                        const dx = muOf(id, 0) - acc.mu[0];
                        const dy = muOf(id, 1) - acc.mu[1];
                        const dz = muOf(id, 2) - acc.mu[2];
                        acc.R[0] += A1 * (R1[0] + dx * dx);
                        acc.R[1] += A1 * (R1[1] + dx * dy);
                        acc.R[2] += A1 * (R1[2] + dx * dz);
                        acc.R[3] += A1 * (R1[3] + dy * dy);
                        acc.R[4] += A1 * (R1[4] + dy * dz);
                        acc.R[5] += A1 * (R1[5] + dz * dz);
                    }
                    for (let k = 0; k < 6; ++k) acc.R[k] /= A;
                    const { values } = eigen3(acc.R);
                    // flat, and filling its area like a rectangle or an ellipse would
                    if (Math.sqrt(values[2]) > 0.12 * Math.sqrt(values[1])) {
                        ok = false;
                        reject('not flat');
                    }
                    const fill = 12 * Math.sqrt(values[0] * values[1]) / A;
                    if (ok && (fill < 0.7 || fill > 1.35)) {
                        ok = false;
                        reject('shape');
                    }
                }
            }
            if (!ok) {
                // this neighbourhood stays as it is
                for (const id of list) freeze(id);
                continue;
            }
            if (merged >= capacity) grow();
            const m = merged++;
            const id = N + m;
            mA[m] = acc.A;
            for (let k = 0; k < 3; ++k) {
                mMu[m * 3 + k] = acc.mu[k];
                mNrm[m * 3 + k] = acc.nrm[k] / acc.A;
                mCol[m * 3 + k] = acc.col[k];
                mSq[m * 3 + k] = acc.sq[k];
            }
            for (let k = 0; k < 6; ++k) mR[m * 6 + k] = acc.R[k];
            mAlpha[m * 3] = acc.aMean / acc.A;
            mAlpha[m * 3 + 1] = acc.aMin;
            mAlpha[m * 3 + 2] = acc.aMax;
            mThick[m] = acc.thick / acc.A;
            mDist[m] = acc.dist;
            mGroup[m] = groupOf(list[0]);
            mRep[m] = list[0] < N ? list[0] : mRep[list[0] - N];
            for (const child of list) {
                if (child < N) parent[child] = id;
                else mParent[child - N] = id;
            }
            next.push(id);
        }
        active = next;
        progress?.(0.2 + 0.6 * level / options.maxLevel);
        await yieldNow();
    }

    // ---- 3. the result
    const root = (i: number) => {
        let r = parent[i];
        if (r < 0) return -1;
        while (mParent[r - N] >= 0) r = mParent[r - N];
        return r;
    };
    // finals: unmerged samples and top-level merged gaussians, by group
    const finals: number[] = [];
    for (let i = 0; i < N; ++i) if (parent[i] < 0) finals.push(i);
    for (let m = 0; m < merged; ++m) if (mParent[m] < 0) finals.push(N + m);
    finals.sort((a, b) => groupOf(a) - groupOf(b));

    const outIndex = new Map<number, number>();
    finals.forEach((id, k) => {
        if (id >= N) outIndex.set(id, k);
    });
    const M = finals.length;
    const out = new SampleBuffer();
    out.reserveTotal(M + 16);
    const dc = new Float32Array(M * 3);
    const rest = nRest ? new Float32Array(M * nRest * 3) : null;
    const outGroups = new Int32Array(M);

    // higher order SH of a merged gaussian: the area-weighted mean of its members'
    const restWeight = nRest ? new Float64Array(M) : null;
    if (rest) {
        for (let i = 0; i < N; ++i) {
            const r = root(i);
            if (r < 0) continue;
            const k = outIndex.get(r);
            const A = cell[i] * cell[i];
            restWeight[k] += A;
            for (let j = 0; j < nRest * 3; ++j) rest[k * nRest * 3 + j] += colors.rest[i * nRest * 3 + j] * A;
        }
    }

    for (let k = 0; k < M; ++k) {
        const id = finals[k];
        outGroups[k] = groupOf(id);
        if (id < N) {
            // as it was
            const o = out.alloc();
            out.data.set(d.subarray(id * STRIDE, id * STRIDE + STRIDE), o);
            for (let c = 0; c < 3; ++c) dc[k * 3 + c] = colors.dc[id * 3 + c];
            if (rest) rest.set(colors.rest.subarray(id * nRest * 3, (id + 1) * nRest * 3), k * nRest * 3);
            continue;
        }
        const m = id - N;
        const o = out.alloc();
        // material and flags of one member, then the merged shape
        out.data.set(d.subarray(mRep[m] * STRIDE, mRep[m] * STRIDE + STRIDE), o);
        const { values, vectors } = eigen3(Array.from(mR.subarray(m * 6, m * 6 + 6)));
        let n = [mNrm[m * 3], mNrm[m * 3 + 1], mNrm[m * 3 + 2]];
        const nl = Math.hypot(n[0], n[1], n[2]) || 1;
        n = n.map(v => v / nl);
        // in-plane axes: the main eigenvector, made orthogonal to the normal
        let e1 = vectors[0];
        const dn = e1[0] * n[0] + e1[1] * n[1] + e1[2] * n[2];
        e1 = [e1[0] - dn * n[0], e1[1] - dn * n[1], e1[2] - dn * n[2]];
        const l1 = Math.hypot(e1[0], e1[1], e1[2]) || 1;
        e1 = e1.map(v => v / l1);
        const e2 = [n[1] * e1[2] - n[2] * e1[1], n[2] * e1[0] - n[0] * e1[2], n[0] * e1[1] - n[1] * e1[0]];
        const q = quatFromBasis(e1, e2, n);
        const od = out.data;
        for (let c = 0; c < 3; ++c) {
            od[o + S_POS + c] = mMu[m * 3 + c];
            od[o + S_NORMAL + c] = n[c];
        }
        od[o + S_ROT] = q[0]; od[o + S_ROT + 1] = q[1]; od[o + S_ROT + 2] = q[2]; od[o + S_ROT + 3] = q[3];
        // matched to the area, like the base gaussians to their cells
        od[o + S_SCALE] = K * Math.sqrt(12 * values[0]);
        od[o + S_SCALE + 1] = K * Math.sqrt(12 * values[1]);
        od[o + S_SCALE + 2] = mThick[m];
        od[o + S_ALPHA] = mAlpha[m * 3];
        for (let c = 0; c < 3; ++c) dc[k * 3 + c] = (mCol[m * 3 + c] - 0.5) / SH_C0;
        if (rest) {
            const w = restWeight[k] || 1;
            for (let j = 0; j < nRest * 3; ++j) rest[k * nRest * 3 + j] /= w;
        }
    }
    progress?.(1);
    let edgeCells = 0;
    for (let ci = 0; ci < C; ++ci) edgeCells += edge[ci];
    return { samples: out, colors: { dc, rest, degree: colors.degree }, groups: outGroups, before: N, after: M, reasons, edgeCells, cells: C };
};

export { adaptiveSimplify, AdaptiveOptions };
