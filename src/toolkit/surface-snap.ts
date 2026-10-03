import { Mat4 } from 'playcanvas';

import type { Splat } from '../splat';
import { State } from '../splat-state';
import { BASE } from './stamp-math';

// Snap to surface: gaussians that drifted off a surface during training
// (floaters in front of a wall, a fuzzy halo around an object) are put back
// onto it instead of being deleted - deleting them leaves holes, because they
// carry part of the surface's colour.
//
// For each selected gaussian the nearest well-formed gaussian (opaque, not a
// big blob, not selected; of any visible layer) is found; the surface there is
// the plane through its neighbourhood (opacity-weighted PCA, refitted without
// outliers). The gaussian is moved onto that plane and its shape is squashed
// onto it (covariance A·Σ·Aᵀ with A projecting along the normal), so it
// becomes a flat disc on the surface covering the footprint it covered from
// the front.
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
    deleteRest: boolean;    // drop those with no surface within reach
};

type Neighbours = {
    count: number;
    pos: Float32Array;      // xyz
    weight: Float32Array;   // opacity
    sigmaMin: Float32Array; // smallest / largest axis, PLY units
    sigmaMax: Float32Array;
    dc: Float32Array | null;
};

type Progress = (fraction: number) => void;

// a neighbour must be at least this opaque to count as surface
const MIN_OPACITY = 0.25;
// ... and no wider than this many times the typical gaussian (big blobs are
// floaters themselves, not surface)
const MAX_BLOB = 8;
// gaussians in a surface patch
const PATCH = 32;
// a snapped gaussian may be this many times wider than the surface's own
const SIZE_LIMIT = 3;
// view-dependent colour is kept at this share when calmed
const CALM_SH = 0.25;
// gaussians snapped between breaks for the UI
const BATCH = 20000;

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
const nextFrame = () => new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
});

// ---- where to look: the cells around the selected gaussians

type CellFilter = { cell: number, keys: Set<number> };

const cellKey = (x: number, y: number, z: number, cell: number) => {
    const ix = Math.floor(x / cell) & 1023;
    const iy = Math.floor(y / cell) & 1023;
    const iz = Math.floor(z / cell) & 1023;
    // wrapping keys can collide, which only lets a few extra neighbours in
    return (ix << 20) | (iy << 10) | iz;
};

// the cells (at least `reach` wide) holding a selected gaussian, and the ones
// around them: only gaussians there can be the surface for one of them
const selectionCells = (sets: { rows: Float32Array, rest: number }[], reach: number): CellFilter => {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (const { rows, rest } of sets) {
        const stride = BASE + rest;
        for (let o = 0; o < rows.length; o += stride) {
            for (let a = 0; a < 3; ++a) {
                if (rows[o + a] < min[a]) min[a] = rows[o + a];
                if (rows[o + a] > max[a]) max[a] = rows[o + a];
            }
        }
    }
    const extent = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2], 1e-9);
    const cell = Math.max(reach, extent / 512);
    const occupied = new Set<number>();
    const centres: number[] = [];
    for (const { rows, rest } of sets) {
        const stride = BASE + rest;
        for (let o = 0; o < rows.length; o += stride) {
            const key = cellKey(rows[o], rows[o + 1], rows[o + 2], cell);
            if (!occupied.has(key)) {
                occupied.add(key);
                centres.push(rows[o], rows[o + 1], rows[o + 2]);
            }
        }
    }
    // grow by one cell (and a bit more when the cells are about the reach,
    // so the patch around a surface point at the edge of the reach is there)
    const ring = cell > reach * 2 ? 1 : 2;
    const keys = new Set<number>();
    for (let i = 0; i < centres.length; i += 3) {
        for (let dz = -ring; dz <= ring; ++dz) {
            for (let dy = -ring; dy <= ring; ++dy) {
                for (let dx = -ring; dx <= ring; ++dx) {
                    keys.add(cellKey(centres[i] + dx * cell, centres[i + 1] + dy * cell, centres[i + 2] + dz * cell, cell));
                }
            }
        }
    }
    return { cell, keys };
};

// ---- reading the surface: the other gaussians of the visible layers

class NeighbourBuffer {
    capacity = 1 << 16;
    count = 0;
    pos = new Float32Array(this.capacity * 3);
    weight = new Float32Array(this.capacity);
    sigmaMin = new Float32Array(this.capacity);
    sigmaMax = new Float32Array(this.capacity);
    dc: Float32Array | null;

    constructor(withColor: boolean) {
        this.dc = withColor ? new Float32Array(this.capacity * 3) : null;
    }

    reserve() {
        if (this.count < this.capacity) return;
        this.capacity *= 2;
        const g = (a: Float32Array, n: number) => {
            const b = new Float32Array(this.capacity * n);
            b.set(a);
            return b;
        };
        this.pos = g(this.pos, 3);
        this.weight = g(this.weight, 1);
        this.sigmaMin = g(this.sigmaMin, 1);
        this.sigmaMax = g(this.sigmaMax, 1);
        if (this.dc) this.dc = g(this.dc, 3);
    }
}

// one layer's gaussians that are not selected (and not deleted) and lie in
// the filter's cells, in PLY space
const readLayer = async (splat: Splat, filter: CellFilter, out: NeighbourBuffer, progress: (done: number) => void) => {
    const { resource, instances } = splat;
    const source = resource.source;
    const meta = source.meta;

    // transform palette index per static row (-1: no live, unselected instance)
    const rowTransform = new Int32Array(resource.numRows).fill(-1);
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

    const { cell, keys } = filter;
    const withColor = !!out.dc;
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
                if (!keys.has(cellKey(x, y, z, cell))) continue;
                out.reserve();
                const k = out.count++;
                out.pos[k * 3] = x;
                out.pos[k * 3 + 1] = y;
                out.pos[k * 3 + 2] = z;
                out.weight[k] = opacity;
                const s0 = Math.exp(geometric[i * 8 + 4]);
                const s1 = Math.exp(geometric[i * 8 + 5]);
                const s2 = Math.exp(geometric[i * 8 + 6]);
                out.sigmaMin[k] = Math.min(s0, s1, s2) * scale;
                out.sigmaMax[k] = Math.max(s0, s1, s2) * scale;
                if (out.dc && color) {
                    out.dc[k * 3] = color[i * colorStride];
                    out.dc[k * 3 + 1] = color[i * colorStride + 1];
                    out.dc[k * 3 + 2] = color[i * colorStride + 2];
                }
            }
        } finally {
            Object.values(chunks).forEach(chunk => chunk.release());
        }
        progress(n);
    }
};

// the surface candidates around the selection, from every given layer
const readNeighbours = async (splats: Splat[], filter: CellFilter, withColor: boolean, progress?: Progress): Promise<Neighbours> => {
    const out = new NeighbourBuffer(withColor);
    const total = splats.reduce((sum, s) => sum + s.resource.numRows, 0) || 1;
    const read = { rows: 0 };
    const advance = (n: number) => {
        read.rows += n;
        progress?.(read.rows / total);
    };
    for (const splat of splats) {
        await readLayer(splat, filter, out, advance);
    }
    return { count: out.count, pos: out.pos, weight: out.weight, sigmaMin: out.sigmaMin, sigmaMax: out.sigmaMax, dc: out.dc };
};

// the neighbours that can be surface: not much bigger than the typical one
const surfaceIndices = (nb: Neighbours) => {
    if (nb.count === 0) return new Uint32Array(0);
    const step = Math.max(1, Math.floor(nb.count / 20000));
    const sample: number[] = [];
    for (let i = 0; i < nb.count; i += step) sample.push(nb.sigmaMax[i]);
    sample.sort((a, b) => a - b);
    const limit = sample[Math.floor(sample.length / 2)] * MAX_BLOB;
    const result = new Uint32Array(nb.count);
    let n = 0;
    for (let i = 0; i < nb.count; ++i) {
        if (nb.sigmaMax[i] <= limit) result[n++] = i;
    }
    return result.slice(0, n);
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

    // over the points `indices` of `pos` (xyz per point)
    constructor(pos: Float32Array, indices: Uint32Array) {
        this.pos = pos;
        this.idx = indices;
        const count = indices.length;
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
    rows: Float32Array;     // the snapped gaussians (without the dropped ones)
    moved: number;          // gaussians put onto a surface
    unmoved: number;        // no surface within reach: left as they were
    deleted: number;        // no surface within reach: dropped (deleteRest)
    distance: number;       // mean distance moved
};

// the surface patch around a surface gaussian: centre, normal, typical
// thickness and width, colour. Robust: fitted twice, the second time without
// the gaussians far off the first plane
type Plane = { cx: number, cy: number, cz: number, nx: number, ny: number, nz: number, thin: number, wide: number, r: number, g: number, b: number };

const planeOf = (nb: Neighbours, near: Int32Array, n: number, cov: Float64Array, vec: Float64Array): Plane | null => {
    const use = new Uint8Array(n).fill(1);
    let plane: Plane | null = null;
    for (let pass = 0; pass < 2; ++pass) {
        let wsum = 0, cx = 0, cy = 0, cz = 0, thin = 0, wide = 0, r = 0, g = 0, b = 0;
        for (let k = 0; k < n; ++k) {
            if (!use[k]) continue;
            const i = near[k];
            const w = nb.weight[i];
            wsum += w;
            cx += nb.pos[i * 3] * w;
            cy += nb.pos[i * 3 + 1] * w;
            cz += nb.pos[i * 3 + 2] * w;
            thin += nb.sigmaMin[i] * w;
            wide += nb.sigmaMax[i] * w;
            if (nb.dc) {
                r += nb.dc[i * 3] * w;
                g += nb.dc[i * 3 + 1] * w;
                b += nb.dc[i * 3 + 2] * w;
            }
        }
        if (wsum <= 0) return plane;
        cx /= wsum; cy /= wsum; cz /= wsum;
        cov.fill(0);
        for (let k = 0; k < n; ++k) {
            if (!use[k]) continue;
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
        plane = {
            cx,
            cy,
            cz,
            nx: vec[smallest],
            ny: vec[3 + smallest],
            nz: vec[6 + smallest],
            thin: thin / wsum,
            wide: wide / wsum,
            r: r / wsum,
            g: g / wsum,
            b: b / wsum
        };
        if (pass === 1) break;

        // drop the gaussians far off the plane (stray ones in the patch) and fit again
        let rms = 0;
        let used = 0;
        const dist = new Float64Array(n);
        for (let k = 0; k < n; ++k) {
            const i = near[k];
            dist[k] = Math.abs((nb.pos[i * 3] - cx) * plane.nx + (nb.pos[i * 3 + 1] - cy) * plane.ny + (nb.pos[i * 3 + 2] - cz) * plane.nz);
            rms += dist[k] * dist[k];
        }
        rms = Math.sqrt(rms / n);
        for (let k = 0; k < n; ++k) {
            use[k] = dist[k] <= rms * 2 + 1e-12 ? 1 : 0;
            used += use[k];
        }
        if (used === n || used < 5) break;
    }
    return plane;
};

const snapRows = async (rows: Float32Array, rest: number, nb: Neighbours, tree: KdTree | null, options: SnapOptions, progress?: Progress): Promise<SnapResult> => {
    const stride = BASE + rest;
    const count = rows.length / stride;
    const out = rows.slice();
    const kept = new Uint8Array(count).fill(1);
    const near = new Int32Array(PATCH);
    const cov = new Float64Array(9);
    const vec = new Float64Array(9);
    const sig = new Float64Array(9);
    const rot = new Float64Array(9);
    const q = [1, 0, 0, 0];
    const s = Math.max(0, Math.min(1, options.strength));
    const reach2 = options.reach * options.reach;
    // gaussians snapping to the same surface gaussian share its plane
    const planes = new Map<number, Plane | null>();

    let moved = 0;
    let unmoved = 0;
    let distance = 0;

    for (let r = 0; r < count; ++r) {
        if (r % BATCH === BATCH - 1) {
            progress?.(r / count);
            await nextFrame();
        }
        const o = r * stride;
        const px = rows[o], py = rows[o + 1], pz = rows[o + 2];

        // the nearest surface gaussian within reach, and the surface there
        let plane: Plane | null = null;
        if (tree && tree.nearest(px, py, pz, 1, reach2, near) > 0) {
            const anchor = near[0];
            if (planes.has(anchor)) {
                plane = planes.get(anchor);
            } else {
                const n = tree.nearest(nb.pos[anchor * 3], nb.pos[anchor * 3 + 1], nb.pos[anchor * 3 + 2], PATCH, Infinity, near);
                plane = n >= 3 ? planeOf(nb, near, n, cov, vec) : null;
                planes.set(anchor, plane);
            }
        }
        if (!plane) {
            unmoved++;
            if (options.deleteRest) kept[r] = 0;
            continue;
        }
        const { cx, cy, cz, nx, ny, nz, thin, wide } = plane;

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
            out[o + 3] += (plane.r - out[o + 3]) * k;
            out[o + 4] += (plane.g - out[o + 4]) * k;
            out[o + 5] += (plane.b - out[o + 5]) * k;
        }
        if (options.calmSH) {
            for (let k = 0; k < rest; ++k) out[o + BASE + k] *= CALM_SH;
        }
        moved++;
    }
    progress?.(1);

    // without the dropped ones
    let result = out;
    const deleted = options.deleteRest ? unmoved : 0;
    if (deleted) {
        result = new Float32Array((count - deleted) * stride);
        let w = 0;
        for (let r = 0; r < count; ++r) {
            if (kept[r]) result.set(out.subarray(r * stride, (r + 1) * stride), (w++) * stride);
        }
    }
    return { rows: result, moved, unmoved: unmoved - deleted, deleted, distance: moved ? distance / moved : 0 };
};

// a tree over the surface candidates (null when there are too few)
const surfaceTree = (nb: Neighbours) => {
    const indices = surfaceIndices(nb);
    return indices.length >= 3 ? new KdTree(nb.pos, indices) : null;
};

export { readNeighbours, selectionCells, snapRows, surfaceTree, KdTree, SnapOptions, SnapResult, Neighbours };
