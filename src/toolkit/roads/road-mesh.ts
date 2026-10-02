import type { RoadParams } from './road-params';
import { roadTextures } from './road-textures';
import { writeGlb, GlbMesh } from '../vegetation/glb-writer';

// A road from its path: a smooth (centripetal Catmull-Rom) curve through the
// control points, cut into cross sections, each laid on the ground (when
// following it). The surface is textured in world units; along its sides go
// a frayed dirt rim, a border row of stones or a raised curb, and skirts close
// the edges so the road has some thickness from low angles. Everything is in
// the road's own space (the control points' space).

type Point = { x: number, y: number, z: number };

// the ground's height under road-space points, or null where it isn't known
type GroundSampler = (points: Point[]) => Promise<(number | null)[]>;

type Centerline = {
    // per cross section: position, unit direction across (to the right), distance along
    x: Float64Array; y: Float64Array; z: Float64Array;
    rx: Float64Array; rz: Float64Array;
    s: Float64Array;
    // the control segment each section lies on (for inserting points)
    segment: Int32Array;
    count: number;
};

const MAX_SECTIONS = 4000;

// world size of one texture tile
const tileOf = (p: RoadParams) => {
    switch (p.style) {
        case 'dirt': return p.patternSize;
        case 'cobble': return p.patternSize * 6;
        case 'pavers': return p.patternSize * (p.pattern === 'slabs' ? 2 : 4);
        default: return p.patternSize;
    }
};
const borderWidthOf = (p: RoadParams) => ((p.style === 'cobble' || p.style === 'pavers') && p.edge > 0 ? Math.min(p.width * 0.3, tileOf(p) * 0.25) : 0);

// ---- the curve

const catmullRom = (pts: number[], samplesPerSegment: number) => {
    const n = pts.length / 3;
    const out: number[] = [];
    const seg: number[] = [];
    const P = (i: number) => {
        // past the ends: mirror the neighbour, so the curve leaves straight
        if (i < 0) return [2 * pts[0] - pts[3], 2 * pts[1] - pts[4], 2 * pts[2] - pts[5]];
        if (i >= n) {
            const a = (n - 1) * 3;
            const b = (n - 2) * 3;
            return [2 * pts[a] - pts[b], 2 * pts[a + 1] - pts[b + 1], 2 * pts[a + 2] - pts[b + 2]];
        }
        return [pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]];
    };
    const dist = (a: number[], b: number[]) => Math.max(1e-6, Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])));
    for (let i = 0; i < n - 1; ++i) {
        const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
        // centripetal parametrisation: no loops or cusps at sharp turns
        const t0 = 0;
        const t1 = t0 + dist(p0, p1);
        const t2 = t1 + dist(p1, p2);
        const t3 = t2 + dist(p2, p3);
        const steps = i === n - 2 ? samplesPerSegment + 1 : samplesPerSegment;
        for (let k = 0; k < steps; ++k) {
            const t = t1 + (t2 - t1) * k / samplesPerSegment;
            for (let c = 0; c < 3; ++c) {
                const a1 = (t1 - t) / (t1 - t0) * p0[c] + (t - t0) / (t1 - t0) * p1[c];
                const a2 = (t2 - t) / (t2 - t1) * p1[c] + (t - t1) / (t2 - t1) * p2[c];
                const a3 = (t3 - t) / (t3 - t2) * p2[c] + (t - t2) / (t3 - t2) * p3[c];
                const b1 = (t2 - t) / (t2 - t0) * a1 + (t - t0) / (t2 - t0) * a2;
                const b2 = (t3 - t) / (t3 - t1) * a2 + (t - t1) / (t3 - t1) * a3;
                out.push((t2 - t) / (t2 - t1) * b1 + (t - t1) / (t2 - t1) * b2);
            }
            seg.push(i);
        }
    }
    return { pts: out, seg };
};

// evenly spaced cross sections along the curve
const centerline = (p: RoadParams): Centerline | null => {
    const n = p.points.length / 3;
    if (n < 2) return null;
    const dense = catmullRom(p.points, 24);
    const m = dense.pts.length / 3;
    const along = new Float64Array(m);
    for (let i = 1; i < m; ++i) {
        along[i] = along[i - 1] + Math.hypot(dense.pts[i * 3] - dense.pts[i * 3 - 3], dense.pts[i * 3 + 2] - dense.pts[i * 3 - 1]);
    }
    const total = along[m - 1];
    if (!(total > 1e-6)) return null;
    const step = Math.max(total / MAX_SECTIONS, Math.min(p.width / 3, tileOf(p) / 2));
    const count = Math.max(2, Math.ceil(total / step) + 1);
    const cl: Centerline = {
        x: new Float64Array(count),
        y: new Float64Array(count),
        z: new Float64Array(count),
        rx: new Float64Array(count),
        rz: new Float64Array(count),
        s: new Float64Array(count),
        segment: new Int32Array(count),
        count
    };
    let j = 0;
    for (let i = 0; i < count; ++i) {
        const at = total * i / (count - 1);
        while (j < m - 2 && along[j + 1] < at) j++;
        const span = along[j + 1] - along[j];
        const f = span > 0 ? Math.min(1, Math.max(0, (at - along[j]) / span)) : 0;
        cl.x[i] = dense.pts[j * 3] + (dense.pts[j * 3 + 3] - dense.pts[j * 3]) * f;
        cl.y[i] = dense.pts[j * 3 + 1] + (dense.pts[j * 3 + 4] - dense.pts[j * 3 + 1]) * f;
        cl.z[i] = dense.pts[j * 3 + 2] + (dense.pts[j * 3 + 5] - dense.pts[j * 3 + 2]) * f;
        cl.s[i] = at;
        cl.segment[i] = dense.seg[j];
    }
    // directions across: perpendicular to the curve, averaged over neighbours
    for (let i = 0; i < count; ++i) {
        const a = Math.max(0, i - 1);
        const b = Math.min(count - 1, i + 1);
        let tx = cl.x[b] - cl.x[a];
        let tz = cl.z[b] - cl.z[a];
        const l = Math.hypot(tx, tz) || 1;
        tx /= l;
        tz /= l;
        cl.rx[i] = -tz;
        cl.rz[i] = tx;
    }
    return cl;
};

// ---- heights

// fill the unknown heights of a row from its known neighbours, then smooth
const settle = (values: (number | null)[], fallback: number[]) => {
    const n = values.length;
    const out = new Float64Array(n);
    const known: number[] = [];
    values.forEach((v, i) => {
        if (v !== null) known.push(i);
    });
    if (!known.length) {
        for (let i = 0; i < n; ++i) out[i] = fallback[i];
        return out;
    }
    // offsets from the fallback carry over the gaps
    let k = 0;
    for (let i = 0; i < n; ++i) {
        while (k < known.length - 1 && known[k + 1] <= i) k++;
        const a = known[k];
        const b = known[Math.min(known.length - 1, k + 1)];
        const da = (values[a] as number) - fallback[a];
        const db = (values[b] as number) - fallback[b];
        let d = da;
        if (i > a && b > a) d = da + (db - da) * (i - a) / (b - a);
        else if (i < a) d = da;
        out[i] = fallback[i] + d;
    }
    // smooth: splat depth is noisy, roads are not
    for (let pass = 0; pass < 3; ++pass) {
        const prev = Float64Array.from(out);
        for (let i = 1; i < n - 1; ++i) out[i] = 0.25 * prev[i - 1] + 0.5 * prev[i] + 0.25 * prev[i + 1];
    }
    return out;
};

// ---- mesh building

class Builder {
    positions: number[] = [];
    uvs: number[] = [];
    indices: number[] = [];

    vertex(x: number, y: number, z: number, u: number, v: number) {
        this.positions.push(x, y, z);
        this.uvs.push(u, v);
        return this.positions.length / 3 - 1;
    }

    // a grid of `rows` x `cols` vertices, row-major; faces up when the
    // columns run to the right of the rows' direction
    grid(first: number, rows: number, cols: number, flip = false) {
        for (let i = 0; i < rows - 1; ++i) {
            for (let k = 0; k < cols - 1; ++k) {
                const a = first + i * cols + k;
                const b = a + 1;
                const c = a + cols;
                const d = c + 1;
                if (flip) this.indices.push(a, c, b, b, c, d);
                else this.indices.push(a, b, c, b, d, c);
            }
        }
    }

    mesh(name: string, material: GlbMesh['material']): GlbMesh | null {
        if (!this.indices.length) return null;
        const positions = new Float32Array(this.positions);
        const normals = new Float32Array(positions.length);
        const idx = this.indices;
        for (let t = 0; t < idx.length; t += 3) {
            const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
            const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
            const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
            const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
            [a, b, c].forEach((o) => {
                normals[o] += nx;
                normals[o + 1] += ny;
                normals[o + 2] += nz;
            });
        }
        for (let o = 0; o < normals.length; o += 3) {
            const l = Math.hypot(normals[o], normals[o + 1], normals[o + 2]) || 1;
            normals[o] /= l;
            normals[o + 1] /= l;
            normals[o + 2] /= l;
        }
        return { name, positions, normals, uvs: new Float32Array(this.uvs), indices: new Uint32Array(idx), material };
    }
}

type RoadBuild = {
    glb: ArrayBuffer;
    centerline: Centerline;
    // ground heights found (x z y, road space), to keep with the road
    ground: number[];
    triangles: number;
};

// ground samples kept with the road: the nearest one within `tolerance`
const lookupGround = (ground: number[] | undefined, x: number, z: number, tolerance: number) => {
    if (!ground) return null;
    let best = tolerance * tolerance;
    let y: number | null = null;
    for (let i = 0; i < ground.length; i += 3) {
        const d = (ground[i] - x) ** 2 + (ground[i + 1] - z) ** 2;
        if (d < best) {
            best = d;
            y = ground[i + 2];
        }
    }
    return y;
};

const buildRoad = async (p: RoadParams, sampleGround?: GroundSampler): Promise<RoadBuild | null> => {
    const cl = centerline(p);
    if (!cl) return null;
    const textures = await roadTextures(p);
    const T = tileOf(p);
    const W = p.width;
    const half = W / 2;
    const bw = borderWidthOf(p);
    const rim = p.style === 'dirt' ? Math.max(0, p.edge) * W : 0;
    const curbHeight = Math.max(0, p.curb);
    const curbWidth = curbHeight > 0 ? Math.max(curbHeight * 1.6, W * 0.06) : 0;
    const depth = p.lift + W * 0.04;
    const n = cl.count;

    // across the road: offsets of the columns that need the ground's height
    const across: number[] = [];
    const cols = p.style === 'dirt' ? 6 : 2;
    for (let k = 0; k <= cols; ++k) across.push(-half + W * k / cols);
    const outer = rim > 0 ? rim : curbWidth;
    if (outer > 0) {
        across.unshift(-half - outer);
        across.push(half + outer);
    }

    // ground heights: probe what is in view, else the samples kept with the
    // road, else the curve's own height
    const fallback = Array.from(cl.y);
    const heights: Float64Array[] = [];
    const keep: number[] = [];
    if (p.followGround) {
        const tolerance = Math.max(W * 0.25, T * 0.1);
        const pts: Point[] = [];
        for (let i = 0; i < n; ++i) {
            across.forEach((o) => {
                pts.push({ x: cl.x[i] + cl.rx[i] * o, y: cl.y[i], z: cl.z[i] + cl.rz[i] * o });
            });
        }
        const probed = sampleGround ? await sampleGround(pts) : pts.map((): null => null);
        const rows: (number | null)[][] = across.map((): (number | null)[] => []);
        pts.forEach((pt, j) => {
            let y = probed[j];
            if (y !== null && y !== undefined) keep.push(pt.x, pt.z, y);
            else y = lookupGround(p.ground, pt.x, pt.z, tolerance);
            rows[j % across.length].push(y);
        });
        rows.forEach(r => heights.push(settle(r, fallback)));
    } else {
        across.forEach(() => heights.push(Float64Array.from(fallback)));
    }

    // height at a section and an offset across: stone roads stay flat across
    // (a plane through the road's two edges), a trail follows every bump
    const first = outer > 0 ? 1 : 0;
    const edgeL = heights[first];
    const edgeR = heights[first + cols];
    const surfaceY = (i: number, o: number) => {
        if (p.style === 'dirt') {
            const f = (o + half) / W * cols;
            const k = Math.min(cols - 1, Math.max(0, Math.floor(f)));
            const t = Math.min(1, Math.max(0, f - k));
            return heights[first + k][i] * (1 - t) + heights[first + k + 1][i] * t + p.lift;
        }
        const t = (o + half) / W;
        return edgeL[i] * (1 - t) + edgeR[i] * t + p.lift;
    };

    const meshes: GlbMesh[] = [];
    const roughness = p.style === 'dirt' ? 0.95 : p.style === 'concrete' ? 0.85 : 0.8;

    // ---- the surface
    // relief: the height map lifts the surface, joints at the base, tops up
    const reliefDepth = p.relief > 0 ? p.relief * T * 0.045 : 0;
    const hSize = textures.heightSize;
    const hMap = textures.height;
    const heightAt = (u: number, v: number) => {
        const x = (((u % 1) + 1) % 1) * hSize - 0.5;
        const y = (((v % 1) + 1) % 1) * hSize - 0.5;
        const x0 = Math.floor(x);
        const y0 = Math.floor(y);
        const fx = x - x0;
        const fy = y - y0;
        const w = (i: number) => ((i % hSize) + hSize) % hSize;
        const at = (i: number, j: number) => hMap[w(j) * hSize + w(i)];
        return (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) + (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy;
    };

    // rows along the road: the sections themselves, or a finer grid when the
    // surface carries relief (vertices close enough to show the stones)
    const total = cl.s[n - 1];
    const inner0 = -half + bw;
    const inner1 = half - bw;
    let rows = n;
    let mainCols = p.style === 'dirt' ? cols + 1 : 5;
    if (reliefDepth > 0) {
        // a custom picture's features are of unknown size: a finer grid
        const spacing = Math.max(T / (p.style === 'custom' ? 80 : 40), Math.sqrt(total * (inner1 - inner0) / 250000));
        rows = Math.max(2, Math.ceil(total / spacing) + 1);
        mainCols = Math.max(2, Math.ceil((inner1 - inner0) / spacing) + 1);
    }
    // a row's frame, between sections
    const frame = (r: number) => {
        const f = rows === n ? r : r / (rows - 1) * (n - 1);
        const i0 = Math.min(n - 1, Math.floor(f));
        const i1 = Math.min(n - 1, i0 + 1);
        const t = f - i0;
        let rx = cl.rx[i0] + (cl.rx[i1] - cl.rx[i0]) * t;
        let rz = cl.rz[i0] + (cl.rz[i1] - cl.rz[i0]) * t;
        const l = Math.hypot(rx, rz) || 1;
        rx /= l;
        rz /= l;
        return {
            x: cl.x[i0] + (cl.x[i1] - cl.x[i0]) * t,
            z: cl.z[i0] + (cl.z[i1] - cl.z[i0]) * t,
            s: cl.s[i0] + (cl.s[i1] - cl.s[i0]) * t,
            rx,
            rz,
            y: (o: number) => surfaceY(i0, o) + (surfaceY(i1, o) - surfaceY(i0, o)) * t
        };
    };
    const reliefY = (o: number, s: number) => (reliefDepth > 0 ? heightAt(o / T, s / T) * reliefDepth : 0);

    const main = new Builder();
    for (let r = 0; r < rows; ++r) {
        const fr = frame(r);
        for (let k = 0; k < mainCols; ++k) {
            const o = inner0 + (inner1 - inner0) * k / (mainCols - 1);
            main.vertex(fr.x + fr.rx * o, fr.y(o) + reliefY(o, fr.s), fr.z + fr.rz * o, o / T, fr.s / T);
        }
    }
    main.grid(0, rows, mainCols);
    // skirts down the sides (under a curb or rim they don't show); with a
    // border row they hang from the border stones instead
    if (rim <= 0) {
        [-half, half].forEach((o, side) => {
            const start = main.positions.length / 3;
            for (let r = 0; r < rows; ++r) {
                const fr = frame(r);
                const y = fr.y(o) + (bw > 0 ? reliefDepth * 0.75 : reliefY(o, fr.s));
                const x = fr.x + fr.rx * o;
                const z = fr.z + fr.rz * o;
                main.vertex(x, y, z, o / T, fr.s / T);
                main.vertex(x, y - depth - reliefDepth, z, o / T + depth / T, fr.s / T);
            }
            main.grid(start, rows, 2, side === 0);
        });
    }
    const mainMesh = main.mesh('road', {
        name: 'road',
        baseColor: [1, 1, 1, 1],
        texture: { mimeType: 'image/png', bytes: textures.main, repeat: true },
        roughness
    });
    if (mainMesh) meshes.push(mainMesh);

    // ---- border stones
    if (bw > 0 && textures.strip) {
        const border = new Builder();
        [[-half, -half + bw], [half - bw, half]].forEach(([a, b], side) => {
            const start = border.positions.length / 3;
            for (let i = 0; i < n; ++i) {
                for (let k = 0; k < 2; ++k) {
                    const o = k === 0 ? a : b;
                    // u 0 at the outside, 1 inside
                    const u = side === 0 ? k : 1 - k;
                    border.vertex(cl.x[i] + cl.rx[i] * o, surfaceY(i, o) + reliefDepth * 0.75, cl.z[i] + cl.rz[i] * o, u, cl.s[i] / T);
                }
            }
            border.grid(start, n, 2);
        });
        const mesh = border.mesh('border', {
            name: 'border',
            baseColor: [1, 1, 1, 1],
            texture: { mimeType: 'image/png', bytes: textures.strip, repeat: true },
            roughness
        });
        if (mesh) meshes.push(mesh);
    }

    // ---- the frayed rim of a dirt trail, onto the ground beside it
    if (rim > 0 && textures.strip) {
        const fray = new Builder();
        const groundL = heights[0];
        const groundR = heights[heights.length - 1];
        [-1, 1].forEach((side) => {
            const start = fray.positions.length / 3;
            const edgeO = side * half;
            const outO = side * (half + rim);
            for (let i = 0; i < n; ++i) {
                const yIn = surfaceY(i, edgeO) + reliefDepth * 0.4;
                const yOut = (side < 0 ? groundL[i] : groundR[i]) + p.lift * 0.4;
                for (let k = 0; k < 3; ++k) {
                    const t = k / 2;
                    const o = edgeO + (outO - edgeO) * t;
                    fray.vertex(cl.x[i] + cl.rx[i] * o, yIn + (yOut - yIn) * t, cl.z[i] + cl.rz[i] * o, t, cl.s[i] / T);
                }
            }
            fray.grid(start, n, 3, side < 0);
        });
        const mesh = fray.mesh('rim', {
            name: 'rim',
            baseColor: [1, 1, 1, 1],
            texture: { mimeType: 'image/png', bytes: textures.strip, repeat: true },
            alphaMode: 'MASK',
            alphaCutoff: 0.5,
            doubleSided: true,
            roughness
        });
        if (mesh) meshes.push(mesh);
    }

    // ---- a raised curb on both sides
    if (curbWidth > 0 && textures.curb) {
        const curb = new Builder();
        const Tc = Math.max(W * 1.5, curbWidth * 4);
        [-1, 1].forEach((side) => {
            const start = curb.positions.length / 3;
            const ground = side < 0 ? heights[0] : heights[heights.length - 1];
            for (let i = 0; i < n; ++i) {
                const o0 = side * half;
                const o1 = side * (half + curbWidth);
                const y0 = surfaceY(i, o0);
                const top = y0 + curbHeight;
                const bottom = Math.min(ground[i], y0) - depth;
                const v = cl.s[i] / Tc;
                const at = (o: number) => [cl.x[i] + cl.rx[i] * o, cl.z[i] + cl.rz[i] * o];
                const [ax, az] = at(o0);
                const [bx, bz] = at(o1);
                // the profile: road edge, up, across the top, down the outside
                curb.vertex(ax, y0, az, 0, v);
                curb.vertex(ax, top, az, 0.3, v);
                curb.vertex(bx, top, bz, 0.7, v);
                curb.vertex(bx, bottom, bz, 1, v);
            }
            curb.grid(start, n, 4, side < 0);
        });
        const mesh = curb.mesh('curb', {
            name: 'curb',
            baseColor: [1, 1, 1, 1],
            texture: { mimeType: 'image/png', bytes: textures.curb, repeat: true },
            roughness: 0.85
        });
        if (mesh) meshes.push(mesh);
    }

    const glb = writeGlb(meshes);
    const triangles = meshes.reduce((sum, m) => sum + m.indices.length / 3, 0);
    // keep the newest ground samples, a bounded number
    const ground = [...keep, ...(p.ground ?? [])].slice(0, 3 * 6000);
    return { glb, centerline: cl, ground, triangles };
};

export { buildRoad, centerline, tileOf, Centerline, GroundSampler, Point };
