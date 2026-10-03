import { Mat4 } from 'playcanvas';

import type { Splat } from '../splat';
import { State } from '../splat-state';
import { BASE } from './stamp-math';

// Snap to surface: gaussians that drifted off a surface during training
// (floaters in front of a wall, a fuzzy halo around an object) are put back
// onto it instead of being deleted - deleting them leaves holes, because they
// carry part of the surface's colour.
//
// For each selected gaussian the nearest well-formed (opaque, not selected)
// gaussian of the same layer is found; the surface there is the plane through
// its neighbourhood (opacity-weighted PCA). The gaussian is moved onto that
// plane and its shape is squashed onto it (covariance A·Σ·Aᵀ with A projecting
// along the normal), so it becomes a flat disc on the surface covering the
// same footprint it covered from the front.
//
// Everything works in PLY space, the space the exporter writes, so the rows of
// the selected gaussians come straight from the exporter and the result loads
// back as a layer that sits exactly where they were.

type SnapOptions = {
    reach: number;          // how far from the surface a gaussian may be (PLY units)
    strength: number;       // 0..1: 1 = right onto the surface
    limitSize: boolean;     // no wider than a few of the surface's own gaussians
    colorBlend: number;     // 0..1 towards the surface's colour
    calmSH: boolean;        // tone down view-dependent colour
};

type Neighbours = {
    count: number;
    pos: Float32Array;      // xyz
    weight: Float32Array;   // opacity
    sigmaMin: Float32Array; // smallest / largest axis, PLY units
    sigmaMax: Float32Array;
    dc: Float32Array | null;
};

// a neighbour must be at least this opaque to count as surface
const MIN_OPACITY = 0.25;
// gaussians in a surface patch
const PATCH = 24;
// a snapped gaussian may be this many times wider than the surface's own
const SIZE_LIMIT = 3;
// view-dependent colour is kept at this share when calmed
const CALM_SH = 0.25;

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

// ---- reading the layer's other gaussians

// the layer's gaussians that are not selected (and not deleted), within the
// box, in PLY space
const readNeighbours = async (splat: Splat, min: number[], max: number[], withColor: boolean): Promise<Neighbours> => {
    const { resource, instances } = splat;
    const source = resource.source;
    const meta = source.meta;
    const numRows = resource.numRows;

    // transform palette index per static row (-1: no live, unselected instance)
    const rowTransform = new Int32Array(numRows).fill(-1);
    for (let i = 0; i < instances.count; ++i) {
        if (instances.flags[i] !== State.selected) {
            rowTransform[instances.sourceRow[i]] = instances.transformIndex(i);
        }
    }

    // into PLY space: undo the load-time rotation, apply the layer's transform
    // and the gaussian's palette transform (as the exporter does)
    const matrices = new Map<number, { m: Float32Array, scale: number }>();
    const world = splat.entity.getWorldTransform();
    const matrixOf = (t: number) => {
        let entry = matrices.get(t);
        if (!entry) {
            const mat = new Mat4().setFromEulerAngles(0, 0, -180);
            mat.mul2(mat, world);
            if (t > 0) {
                const palette = new Mat4();
                splat.transformPalette.getTransform(t, palette);
                mat.mul2(mat, palette);
            }
            const d = mat.data;
            const det = d[0] * (d[5] * d[10] - d[9] * d[6]) - d[4] * (d[1] * d[10] - d[9] * d[2]) + d[8] * (d[1] * d[6] - d[5] * d[2]);
            entry = { m: Float32Array.from(d), scale: Math.cbrt(Math.abs(det)) };
            matrices.set(t, entry);
        }
        return entry;
    };

    let capacity = 1 << 16;
    let count = 0;
    let pos = new Float32Array(capacity * 3);
    let weight = new Float32Array(capacity);
    let sigmaMin = new Float32Array(capacity);
    let sigmaMax = new Float32Array(capacity);
    let dc = withColor ? new Float32Array(capacity * 3) : null;
    const grow = () => {
        capacity *= 2;
        const g = (a: Float32Array, n: number) => {
            const b = new Float32Array(capacity * n);
            b.set(a);
            return b;
        };
        pos = g(pos, 3);
        weight = g(weight, 1);
        sigmaMin = g(sigmaMin, 1);
        sigmaMax = g(sigmaMax, 1);
        if (dc) dc = g(dc, 3);
    };

    const layers: ('position' | 'geometric' | 'color')[] = withColor ? ['position', 'geometric', 'color'] : ['position', 'geometric'];
    const pool = resource.sourcePool;
    const numChunks = meta.numChunks[0];
    for (let chunkIndex = 0; chunkIndex < numChunks; ++chunkIndex) {
        const base = chunkIndex * meta.chunkSize;
        const n = Math.min(meta.chunkSize, meta.numGaussians - base);
        const chunks: Record<string, any> = {};
        for (const layer of layers) {
            chunks[layer] = pool.acquire(layer, meta.layouts[layer], n);
        }
        try {
            await source.read({ chunkIndex, ...chunks });
            const position = new Float32Array(chunks.position.data, 0, n * 3);
            const geometric = new Float32Array(chunks.geometric.data, 0, n * 8);
            const colorStride = withColor ? chunks.color.stride / 4 : 0;
            const color = withColor ? new Float32Array(chunks.color.data, 0, n * colorStride) : null;
            for (let i = 0; i < n; ++i) {
                const t = rowTransform[base + i];
                if (t < 0) continue;
                const opacity = sigmoid(geometric[i * 8 + 7]);
                if (opacity < MIN_OPACITY) continue;
                const { m, scale } = matrixOf(t);
                const x0 = position[i * 3];
                const y0 = position[i * 3 + 1];
                const z0 = position[i * 3 + 2];
                const x = m[0] * x0 + m[4] * y0 + m[8] * z0 + m[12];
                const y = m[1] * x0 + m[5] * y0 + m[9] * z0 + m[13];
                const z = m[2] * x0 + m[6] * y0 + m[10] * z0 + m[14];
                if (x < min[0] || y < min[1] || z < min[2] || x > max[0] || y > max[1] || z > max[2]) continue;
                if (count === capacity) grow();
                pos[count * 3] = x;
                pos[count * 3 + 1] = y;
                pos[count * 3 + 2] = z;
                weight[count] = opacity;
                const s0 = Math.exp(geometric[i * 8 + 4]);
                const s1 = Math.exp(geometric[i * 8 + 5]);
                const s2 = Math.exp(geometric[i * 8 + 6]);
                sigmaMin[count] = Math.min(s0, s1, s2) * scale;
                sigmaMax[count] = Math.max(s0, s1, s2) * scale;
                if (dc && color) {
                    dc[count * 3] = color[i * colorStride];
                    dc[count * 3 + 1] = color[i * colorStride + 1];
                    dc[count * 3 + 2] = color[i * colorStride + 2];
                }
                count++;
            }
        } finally {
            Object.values(chunks).forEach(chunk => chunk.release());
        }
    }
    return { count, pos, weight, sigmaMin, sigmaMax, dc };
};

// ---- k-d tree over the neighbours

class KdTree {
    private pos: Float32Array;
    private idx: Uint32Array;
    private axis: Uint8Array;
    // k nearest search state
    private k = 0;
    private heapIdx: Int32Array;
    private heapDist: Float64Array;
    private size = 0;

    constructor(pos: Float32Array, count: number) {
        this.pos = pos;
        this.idx = new Uint32Array(count);
        for (let i = 0; i < count; ++i) this.idx[i] = i;
        this.axis = new Uint8Array(count);
        this.build(0, count);
        this.heapIdx = new Int32Array(PATCH);
        this.heapDist = new Float64Array(PATCH);
    }

    private build(lo: number, hi: number) {
        if (hi - lo <= 1) return;
        const { pos, idx } = this;
        // split along the longest side
        let min0 = Infinity, min1 = Infinity, min2 = Infinity;
        let max0 = -Infinity, max1 = -Infinity, max2 = -Infinity;
        for (let i = lo; i < hi; ++i) {
            const p = idx[i] * 3;
            const x = pos[p], y = pos[p + 1], z = pos[p + 2];
            if (x < min0) min0 = x;
            if (x > max0) max0 = x;
            if (y < min1) min1 = y;
            if (y > max1) max1 = y;
            if (z < min2) min2 = z;
            if (z > max2) max2 = z;
        }
        const e0 = max0 - min0, e1 = max1 - min1, e2 = max2 - min2;
        const axis = e0 >= e1 && e0 >= e2 ? 0 : (e1 >= e2 ? 1 : 2);
        const mid = (lo + hi) >> 1;
        this.select(lo, hi - 1, mid, axis);
        this.axis[mid] = axis;
        this.build(lo, mid);
        this.build(mid + 1, hi);
    }

    // quickselect: idx[k] gets the k-th smallest along `axis`
    private select(lo: number, hi: number, k: number, axis: number) {
        const { pos, idx } = this;
        while (hi > lo) {
            const pivot = pos[idx[(lo + hi) >> 1] * 3 + axis];
            let i = lo;
            let j = hi;
            while (i <= j) {
                while (pos[idx[i] * 3 + axis] < pivot) i++;
                while (pos[idx[j] * 3 + axis] > pivot) j--;
                if (i <= j) {
                    const t = idx[i];
                    idx[i] = idx[j];
                    idx[j] = t;
                    i++;
                    j--;
                }
            }
            if (k <= j) hi = j;
            else if (k >= i) lo = i;
            else return;
        }
    }

    private push(index: number, dist: number) {
        const { heapIdx, heapDist } = this;
        if (this.size < this.k) {
            // sift up
            let c = this.size++;
            while (c > 0) {
                const p = (c - 1) >> 1;
                if (heapDist[p] >= dist) break;
                heapDist[c] = heapDist[p];
                heapIdx[c] = heapIdx[p];
                c = p;
            }
            heapDist[c] = dist;
            heapIdx[c] = index;
        } else if (dist < heapDist[0]) {
            // replace the farthest, sift down
            let c = 0;
            const n = this.size;
            for (;;) {
                let l = c * 2 + 1;
                if (l >= n) break;
                if (l + 1 < n && heapDist[l + 1] > heapDist[l]) l++;
                if (heapDist[l] <= dist) break;
                heapDist[c] = heapDist[l];
                heapIdx[c] = heapIdx[l];
                c = l;
            }
            heapDist[c] = dist;
            heapIdx[c] = index;
        }
    }

    private search(lo: number, hi: number, x: number, y: number, z: number, limit: number) {
        if (hi <= lo) return;
        const mid = (lo + hi) >> 1;
        const i = this.idx[mid];
        const p = i * 3;
        const dx = this.pos[p] - x;
        const dy = this.pos[p + 1] - y;
        const dz = this.pos[p + 2] - z;
        const d = dx * dx + dy * dy + dz * dz;
        if (d <= limit) this.push(i, d);
        if (hi - lo === 1) return;
        const axis = this.axis[mid];
        const diff = axis === 0 ? x - this.pos[p] : (axis === 1 ? y - this.pos[p + 1] : z - this.pos[p + 2]);
        const first = diff < 0;
        if (first) this.search(lo, mid, x, y, z, limit);
        else this.search(mid + 1, hi, x, y, z, limit);
        // the other side, if it can still hold something nearer
        const worst = this.size < this.k ? limit : Math.min(limit, this.heapDist[0]);
        if (diff * diff <= worst) {
            if (first) this.search(mid + 1, hi, x, y, z, limit);
            else this.search(lo, mid, x, y, z, limit);
        }
    }

    // the k nearest within sqrt(limit): their indices into `out`, returns how many
    nearest(x: number, y: number, z: number, k: number, limit: number, out: Int32Array) {
        this.k = k;
        this.size = 0;
        this.search(0, this.idx.length, x, y, z, limit);
        for (let i = 0; i < this.size; ++i) out[i] = this.heapIdx[i];
        return this.size;
    }
}

// ---- small linear algebra

// eigenvalues / eigenvectors (columns of v) of a symmetric 3x3, cyclic Jacobi
const eigen3 = (a: Float64Array, v: Float64Array) => {
    v.fill(0);
    v[0] = v[4] = v[8] = 1;
    for (let sweep = 0; sweep < 16; ++sweep) {
        const off = a[1] * a[1] + a[2] * a[2] + a[5] * a[5];
        if (off < 1e-30) break;
        for (let p = 0; p < 2; ++p) {
            for (let q = p + 1; q < 3; ++q) {
                const apq = a[p * 3 + q];
                if (Math.abs(apq) < 1e-30) continue;
                const theta = (a[q * 3 + q] - a[p * 3 + p]) / (2 * apq);
                const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
                const c = 1 / Math.sqrt(t * t + 1);
                const s = t * c;
                for (let k = 0; k < 3; ++k) {
                    const akp = a[k * 3 + p];
                    const akq = a[k * 3 + q];
                    a[k * 3 + p] = c * akp - s * akq;
                    a[k * 3 + q] = s * akp + c * akq;
                }
                for (let k = 0; k < 3; ++k) {
                    const apk = a[p * 3 + k];
                    const aqk = a[q * 3 + k];
                    a[p * 3 + k] = c * apk - s * aqk;
                    a[q * 3 + k] = s * apk + c * aqk;
                }
                for (let k = 0; k < 3; ++k) {
                    const vkp = v[k * 3 + p];
                    const vkq = v[k * 3 + q];
                    v[k * 3 + p] = c * vkp - s * vkq;
                    v[k * 3 + q] = s * vkp + c * vkq;
                }
            }
        }
    }
};

// rotation matrix (columns c0 c1 c2, row-major m[r*3+c]) to a unit quaternion w x y z
const quatFromMatrix = (m: Float64Array, out: number[]) => {
    const m00 = m[0], m01 = m[1], m02 = m[2];
    const m10 = m[3], m11 = m[4], m12 = m[5];
    const m20 = m[6], m21 = m[7], m22 = m[8];
    const trace = m00 + m11 + m22;
    let w, x, y, z;
    if (trace > 0) {
        const s = 0.5 / Math.sqrt(trace + 1);
        w = 0.25 / s;
        x = (m21 - m12) * s;
        y = (m02 - m20) * s;
        z = (m10 - m01) * s;
    } else if (m00 > m11 && m00 > m22) {
        const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
        w = (m21 - m12) / s;
        x = 0.25 * s;
        y = (m01 + m10) / s;
        z = (m02 + m20) / s;
    } else if (m11 > m22) {
        const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
        w = (m02 - m20) / s;
        x = (m01 + m10) / s;
        y = 0.25 * s;
        z = (m12 + m21) / s;
    } else {
        const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
        w = (m10 - m01) / s;
        x = (m02 + m20) / s;
        y = (m12 + m21) / s;
        z = 0.25 * s;
    }
    const len = Math.hypot(w, x, y, z) || 1;
    out[0] = w / len;
    out[1] = x / len;
    out[2] = y / len;
    out[3] = z / len;
};

// ---- the snap

type SnapResult = {
    rows: Float32Array;
    moved: number;          // gaussians put onto a surface
    unmoved: number;        // no surface within reach: left as they were
    distance: number;       // mean distance moved
};

const snapRows = (rows: Float32Array, rest: number, nb: Neighbours, options: SnapOptions): SnapResult => {
    const stride = BASE + rest;
    const count = rows.length / stride;
    const out = rows.slice();
    if (nb.count < 3) {
        return { rows: out, moved: 0, unmoved: count, distance: 0 };
    }
    const tree = new KdTree(nb.pos, nb.count);
    const near = new Int32Array(PATCH);
    const cov = new Float64Array(9);
    const vec = new Float64Array(9);
    const sig = new Float64Array(9);
    const rot = new Float64Array(9);
    const q = [1, 0, 0, 0];
    const s = Math.max(0, Math.min(1, options.strength));
    const reach2 = options.reach * options.reach;

    let moved = 0;
    let unmoved = 0;
    let distance = 0;

    for (let r = 0; r < count; ++r) {
        const o = r * stride;
        const px = rows[o], py = rows[o + 1], pz = rows[o + 2];

        // the nearest surface gaussian within reach
        if (tree.nearest(px, py, pz, 1, reach2, near) === 0) {
            unmoved++;
            continue;
        }
        const anchor = near[0];

        // the surface patch around it: weighted centre and normal
        const n = tree.nearest(nb.pos[anchor * 3], nb.pos[anchor * 3 + 1], nb.pos[anchor * 3 + 2], PATCH, Infinity, near);
        if (n < 3) {
            unmoved++;
            continue;
        }
        let wsum = 0, cx = 0, cy = 0, cz = 0, thin = 0, wide = 0;
        let dr = 0, dg = 0, db = 0;
        for (let k = 0; k < n; ++k) {
            const i = near[k];
            const w = nb.weight[i];
            wsum += w;
            cx += nb.pos[i * 3] * w;
            cy += nb.pos[i * 3 + 1] * w;
            cz += nb.pos[i * 3 + 2] * w;
            thin += nb.sigmaMin[i] * w;
            wide += nb.sigmaMax[i] * w;
            if (nb.dc) {
                dr += nb.dc[i * 3] * w;
                dg += nb.dc[i * 3 + 1] * w;
                db += nb.dc[i * 3 + 2] * w;
            }
        }
        cx /= wsum; cy /= wsum; cz /= wsum;
        thin /= wsum; wide /= wsum;
        cov.fill(0);
        for (let k = 0; k < n; ++k) {
            const i = near[k];
            const w = nb.weight[i];
            const x = nb.pos[i * 3] - cx;
            const y = nb.pos[i * 3 + 1] - cy;
            const z = nb.pos[i * 3 + 2] - cz;
            cov[0] += w * x * x; cov[1] += w * x * y; cov[2] += w * x * z;
            cov[4] += w * y * y; cov[5] += w * y * z; cov[8] += w * z * z;
        }
        cov[3] = cov[1]; cov[6] = cov[2]; cov[7] = cov[5];
        eigen3(cov, vec);
        let smallest = 0;
        if (cov[4] < cov[smallest * 4]) smallest = 1;
        if (cov[8] < cov[smallest * 4]) smallest = 2;
        const nx = vec[smallest], ny = vec[3 + smallest], nz = vec[6 + smallest];

        // onto the plane
        const d = (px - cx) * nx + (py - cy) * ny + (pz - cz) * nz;
        out[o] = px - s * d * nx;
        out[o + 1] = py - s * d * ny;
        out[o + 2] = pz - s * d * nz;
        distance += Math.abs(s * d);

        // the shape squashed onto the plane: A Σ Aᵀ + s t² n nᵀ, A = I - s n nᵀ
        let qw = rows[o + 10], qx = rows[o + 11], qy = rows[o + 12], qz = rows[o + 13];
        const ql = Math.hypot(qw, qx, qy, qz) || 1;
        qw /= ql; qx /= ql; qy /= ql; qz /= ql;
        rot[0] = 1 - 2 * (qy * qy + qz * qz); rot[1] = 2 * (qx * qy - qw * qz); rot[2] = 2 * (qx * qz + qw * qy);
        rot[3] = 2 * (qx * qy + qw * qz); rot[4] = 1 - 2 * (qx * qx + qz * qz); rot[5] = 2 * (qy * qz - qw * qx);
        rot[6] = 2 * (qx * qz - qw * qy); rot[7] = 2 * (qy * qz + qw * qx); rot[8] = 1 - 2 * (qx * qx + qy * qy);
        const v0 = Math.exp(2 * rows[o + 7]);
        const v1 = Math.exp(2 * rows[o + 8]);
        const v2 = Math.exp(2 * rows[o + 9]);
        // Σ = R diag(v) Rᵀ
        for (let a = 0; a < 3; ++a) {
            for (let b = a; b < 3; ++b) {
                const value = rot[a * 3] * rot[b * 3] * v0 + rot[a * 3 + 1] * rot[b * 3 + 1] * v1 + rot[a * 3 + 2] * rot[b * 3 + 2] * v2;
                sig[a * 3 + b] = value;
                sig[b * 3 + a] = value;
            }
        }
        // A Σ Aᵀ with A = I - s n nᵀ: Σ - s(n uᵀ + u nᵀ) + s² (nᵀΣn) n nᵀ, u = Σn
        const ux = sig[0] * nx + sig[1] * ny + sig[2] * nz;
        const uy = sig[3] * nx + sig[4] * ny + sig[5] * nz;
        const uz = sig[6] * nx + sig[7] * ny + sig[8] * nz;
        const nsn = nx * ux + ny * uy + nz * uz;
        const nn = [nx, ny, nz];
        const uu = [ux, uy, uz];
        const t2 = thin * thin;
        for (let a = 0; a < 3; ++a) {
            for (let b = 0; b < 3; ++b) {
                cov[a * 3 + b] = sig[a * 3 + b] - s * (nn[a] * uu[b] + uu[a] * nn[b]) + (s * s * nsn + s * t2) * nn[a] * nn[b];
            }
        }
        eigen3(cov, vec);
        const limit = options.limitSize ? (SIZE_LIMIT * wide) ** 2 : Infinity;
        const floor = Math.max(1e-14, t2 * 0.01);
        // right-handed basis
        const det = vec[0] * (vec[4] * vec[8] - vec[5] * vec[7]) - vec[1] * (vec[3] * vec[8] - vec[5] * vec[6]) + vec[2] * (vec[3] * vec[7] - vec[4] * vec[6]);
        if (det < 0) {
            vec[2] = -vec[2]; vec[5] = -vec[5]; vec[8] = -vec[8];
        }
        quatFromMatrix(vec, q);
        out[o + 10] = q[0];
        out[o + 11] = q[1];
        out[o + 12] = q[2];
        out[o + 13] = q[3];
        for (let a = 0; a < 3; ++a) {
            const lambda = Math.min(limit, Math.max(floor, cov[a * 4]));
            out[o + 7 + a] = 0.5 * Math.log(lambda);
        }

        // colour
        if (nb.dc && options.colorBlend > 0) {
            const k = Math.min(1, options.colorBlend);
            out[o + 3] += (dr / wsum - out[o + 3]) * k;
            out[o + 4] += (dg / wsum - out[o + 4]) * k;
            out[o + 5] += (db / wsum - out[o + 5]) * k;
        }
        if (options.calmSH) {
            for (let k = 0; k < rest; ++k) out[o + BASE + k] *= CALM_SH;
        }
        moved++;
    }

    return { rows: out, moved, unmoved, distance: moved ? distance / moved : 0 };
};

// the box the selected rows lie in
const rowsBound = (rows: Float32Array, rest: number) => {
    const stride = BASE + rest;
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let o = 0; o < rows.length; o += stride) {
        for (let a = 0; a < 3; ++a) {
            min[a] = Math.min(min[a], rows[o + a]);
            max[a] = Math.max(max[a], rows[o + a]);
        }
    }
    return { min, max };
};

export { readNeighbours, snapRows, rowsBound, KdTree, SnapOptions, SnapResult, Neighbours };
