import { S_ALPHA, S_NORMAL, S_POS, S_SCALE, STRIDE, SampleBuffer, SplatColors, restCount } from './samples';

// Far-view backing for converted meshes.
//
// Splat renderers - the editor's and the PlayCanvas engine's, so every
// published or exported viewer too - drop gaussians that end up smaller than
// about half a pixel on screen (minPixelSize) or that carry too little opacity
// mass (minContribution). A mesh turned into splats is made of equally tiny
// gaussians, so they all cross that limit at the same distance and the whole
// object vanishes at once, while a captured scene, with gaussians of every
// size, just loses detail.
//
// The backing gives such objects mip levels: copies of the surface made of
// 2x, 4x, 8x... larger gaussians, each sitting a little *inside* the object,
// behind the fine surface. Up close the fine, opaque surface hides them; once
// the fine gaussians are culled, the next level shows instead. They are only
// placed where they stay invisible up close:
//
//  - behind opaque parts only (see-through paint would reveal them),
//  - away from rims and creases, so they never stick out past the silhouette,
//  - deep enough that depth sorting keeps them behind the surface from every
//    angle: a disc of radius R sunk d below a surface stays sorted behind all
//    of the surface it overlaps on screen when d >= R sin(2a) / 2 for every
//    view angle a, i.e. d >= R / 2.
//
// Closed solids (box, sphere, cylinder, cone, torus) and extruded pictures
// (the backing lies in the middle of the slab) qualify; flat sheets (planes,
// backdrops) and models have no inside to hide it in.

type BackingTarget = {
    start: number;                  // the object's samples [start, end)
    end: number;
    cell: number;                   // spacing of its samples
    // solid: inside a closed surface, no deeper than `depth`
    // slab: in the middle plane of a slab `depth` thick on each side, under the face
    // whose outward normal is `front`
    shape: 'solid' | 'slab';
    depth: number;
    front?: [number, number, number];
    longest: number;                // longest side of the object
};

const SIGMA = 0.8;          // coarse gaussian sigma, in coarse cells
const REACH = 2.5;          // sigmas a disc reaches before it is invisible
const FLAT = 0.1;           // thickness of a disc relative to its width
const COVER = 0.75;         // share of the expected surface samples a disc must find under it
const COHERENT = 0.9;       // cos of the largest normal deviation under a disc
const OPAQUE = 0.98;        // surface opacity a disc may hide behind
const MAX_LEVELS = 6;

const keyOf = (x: number, y: number, z: number) => `${x},${y},${z}`;

// quaternion (w x y z) of a frame whose z axis is n
const frameOf = (nx: number, ny: number, nz: number) => {
    // any tangent
    let tx: number, ty: number, tz: number;
    if (Math.abs(nx) < 0.9) {
        tx = 0; ty = nz; tz = -ny;
    } else {
        tx = -nz; ty = 0; tz = nx;
    }
    const tl = Math.hypot(tx, ty, tz) || 1;
    tx /= tl; ty /= tl; tz /= tl;
    const bx = ny * tz - nz * ty, by = nz * tx - nx * tz, bz = nx * ty - ny * tx;
    // columns t, b, n
    const m00 = tx, m10 = ty, m20 = tz;
    const m01 = bx, m11 = by, m21 = bz;
    const m02 = nx, m12 = ny, m22 = nz;
    const trace = m00 + m11 + m22;
    if (trace > 0) {
        const k = 0.5 / Math.sqrt(trace + 1);
        return [0.25 / k, (m21 - m12) * k, (m02 - m20) * k, (m10 - m01) * k];
    }
    if (m00 > m11 && m00 > m22) {
        const k = 2 * Math.sqrt(1 + m00 - m11 - m22);
        return [(m21 - m12) / k, 0.25 * k, (m01 + m10) / k, (m02 + m20) / k];
    }
    if (m11 > m22) {
        const k = 2 * Math.sqrt(1 + m11 - m00 - m22);
        return [(m02 - m20) / k, (m01 + m10) / k, 0.25 * k, (m12 + m21) / k];
    }
    const k = 2 * Math.sqrt(1 + m22 - m00 - m11);
    return [(m10 - m01) / k, (m02 + m20) / k, (m12 + m21) / k, 0.25 * k];
};

const material = { roughness: 1, metalness: 0, twoSided: true };

/**
 * Append the backing of `targets` to `samples` and `colors` (whose colours
 * are final: lit or unlit). Returns the extended colours and how many
 * gaussians were added.
 */
const addFarViewBacking = (samples: SampleBuffer, colors: SplatColors, targets: BackingTarget[]) => {
    const nRest = restCount(colors.degree);
    const d = samples.data;
    const extraDc: number[] = [];
    const extraRest: number[] = [];
    const counter = { added: 0 };

    targets.forEach((target) => {
        // the samples the backing hides behind
        const members: number[] = [];
        for (let i = target.start; i < target.end; ++i) {
            const o = i * STRIDE;
            if (target.shape === 'slab') {
                const f = target.front;
                const dn = d[o + S_NORMAL] * f[0] + d[o + S_NORMAL + 1] * f[1] + d[o + S_NORMAL + 2] * f[2];
                if (dn < 0.9) continue;
            }
            members.push(i);
        }
        if (members.length < 16) return;

        for (let level = 1; level <= MAX_LEVELS; ++level) {
            const c = target.cell * Math.pow(2, level);
            if (c > target.longest / 4) break;
            const sigma = SIGMA * c;
            const reach = REACH * sigma;
            // sorted behind the surface from every angle
            const depth = target.shape === 'slab' ? target.depth : reach / 2;
            if (reach / 2 > target.depth) break;

            // members hashed by the reach, for the disc queries
            const hash = new Map<string, number[]>();
            members.forEach((i) => {
                const o = i * STRIDE;
                const key = keyOf(Math.floor(d[o] / reach), Math.floor(d[o + 1] / reach), Math.floor(d[o + 2] / reach));
                let list = hash.get(key);
                if (!list) hash.set(key, list = []);
                list.push(i);
            });
            // members clustered by the coarse cell: one disc per occupied cell
            const cells = new Map<string, number[]>();
            members.forEach((i) => {
                const o = i * STRIDE;
                const key = keyOf(Math.floor(d[o] / c), Math.floor(d[o + 1] / c), Math.floor(d[o + 2] / c));
                let list = cells.get(key);
                if (!list) cells.set(key, list = []);
                list.push(i);
            });

            const expected = Math.PI * reach * reach / (target.cell * target.cell);
            const dc = [0, 0, 0];
            const rest = new Float64Array(nRest * 3);

            cells.forEach((list) => {
                // the surface point and normal of the cell
                let px = 0, py = 0, pz = 0, nx = 0, ny = 0, nz = 0;
                list.forEach((i) => {
                    const o = i * STRIDE;
                    px += d[o]; py += d[o + 1]; pz += d[o + 2];
                    nx += d[o + S_NORMAL]; ny += d[o + S_NORMAL + 1]; nz += d[o + S_NORMAL + 2];
                });
                px /= list.length; py /= list.length; pz /= list.length;
                const nl = Math.hypot(nx, ny, nz);
                if (nl < COHERENT * list.length) return;
                nx /= nl; ny /= nl; nz /= nl;

                // everything the disc would cover: opaque, the same way up,
                // and all there (no rim within reach)
                const gx = Math.floor(px / reach), gy = Math.floor(py / reach), gz = Math.floor(pz / reach);
                let found = 0;
                let weight = 0;
                dc[0] = dc[1] = dc[2] = 0;
                rest.fill(0);
                for (let z = gz - 1; z <= gz + 1; ++z) {
                    for (let y = gy - 1; y <= gy + 1; ++y) {
                        for (let x = gx - 1; x <= gx + 1; ++x) {
                            const near = hash.get(keyOf(x, y, z));
                            if (!near) continue;
                            for (const i of near) {
                                const o = i * STRIDE;
                                const dx = d[o] - px, dy = d[o + 1] - py, dz = d[o + 2] - pz;
                                const r2 = dx * dx + dy * dy + dz * dz;
                                if (r2 > reach * reach) continue;
                                if (d[o + S_ALPHA] < OPAQUE) return;
                                if (d[o + S_NORMAL] * nx + d[o + S_NORMAL + 1] * ny + d[o + S_NORMAL + 2] * nz < COHERENT) return;
                                found++;
                                // colour: the surface under the disc, gaussian weighted
                                const w = Math.exp(-0.5 * r2 / (sigma * sigma));
                                weight += w;
                                dc[0] += colors.dc[i * 3] * w;
                                dc[1] += colors.dc[i * 3 + 1] * w;
                                dc[2] += colors.dc[i * 3 + 2] * w;
                                for (let k = 0; k < nRest * 3; ++k) {
                                    rest[k] += colors.rest[i * nRest * 3 + k] * w;
                                }
                            }
                        }
                    }
                }
                if (found < COVER * expected || weight <= 0) return;

                // sunk below the surface (to the middle of a slab)
                const sx = px - nx * depth, sy = py - ny * depth, sz = pz - nz * depth;
                const q = frameOf(nx, ny, nz);
                samples.add(
                    sx, sy, sz,
                    q[0], q[1], q[2], q[3],
                    sigma, sigma, Math.max(sigma * FLAT, d[list[0] * STRIDE + S_SCALE + 2]),
                    0, 0, 0, 0.999,
                    nx, ny, nz,
                    material
                );
                extraDc.push(dc[0] / weight, dc[1] / weight, dc[2] / weight);
                for (let k = 0; k < nRest * 3; ++k) {
                    extraRest.push(rest[k] / weight);
                }
                counter.added++;
            });
        }
    });

    const added = counter.added;
    if (added === 0) {
        return { colors, added };
    }
    const dcAll = new Float32Array(colors.dc.length + extraDc.length);
    dcAll.set(colors.dc);
    dcAll.set(extraDc, colors.dc.length);
    let restAll: Float32Array | null = null;
    if (colors.rest) {
        restAll = new Float32Array(colors.rest.length + extraRest.length);
        restAll.set(colors.rest);
        restAll.set(extraRest, colors.rest.length);
    }
    return { colors: { dc: dcAll, rest: restAll, degree: colors.degree }, added };
};

export { BackingTarget, addFarViewBacking };
