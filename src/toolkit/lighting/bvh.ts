import type { Occluder } from '../primitive-to-splat';

// Bounding volume hierarchy over every shadow-casting triangle of the scene,
// built once per bake with a binned surface area heuristic. The layout is flat
// typed arrays so it can be posted to the bake workers as is:
//
//  nodeBounds  6 floats per node: min xyz, max xyz
//  nodeInfo    3 ints per node: leaf -> (first triangle, count, -), inner -> (left, 0, right)
//  tris        9 floats per triangle, in node order
//  triOccluder occluder id per triangle (convex occluders skip their own triangles)
//  triMask     index into `masks` per triangle, -1 = opaque
//  triUv       6 floats per triangle, only meaningful for masked triangles

type ShadowMask = { width: number, height: number, alpha: Float32Array, cutoff: number };

type ShadowScene = {
    nodeBounds: Float32Array;
    nodeInfo: Int32Array;
    tris: Float32Array;
    triOccluder: Int32Array;
    triMask: Int32Array;
    triUv: Float32Array;
    masks: ShadowMask[];
    numTris: number;
};

const LEAF_SIZE = 4;
const BINS = 12;

const buildShadowScene = (occluders: Occluder[]): ShadowScene => {
    const numTris = occluders.reduce((sum, o) => sum + o.positions.length / 9, 0);
    const srcTris = new Float32Array(numTris * 9);
    const srcOccluder = new Int32Array(numTris);
    const srcMask = new Int32Array(numTris).fill(-1);
    const srcUv = new Float32Array(numTris * 6);
    const masks: ShadowMask[] = [];

    let t = 0;
    occluders.forEach((occluder, id) => {
        const count = occluder.positions.length / 9;
        srcTris.set(occluder.positions, t * 9);
        const maskBase = masks.length;
        masks.push(...occluder.masks);
        for (let i = 0; i < count; ++i) {
            // only convex occluders identify themselves: anything else may cast
            // shadows onto itself
            srcOccluder[t + i] = occluder.convex ? id : -1;
            const local = occluder.maskIndex ? occluder.maskIndex[i] : -1;
            if (local >= 0) {
                srcMask[t + i] = maskBase + local;
                srcUv.set(occluder.uvs.subarray(i * 6, i * 6 + 6), (t + i) * 6);
            }
        }
        t += count;
    });

    // per-triangle bounds and centroids
    const tmin = new Float32Array(numTris * 3);
    const tmax = new Float32Array(numTris * 3);
    const cent = new Float32Array(numTris * 3);
    for (let i = 0; i < numTris; ++i) {
        for (let a = 0; a < 3; ++a) {
            const v0 = srcTris[i * 9 + a], v1 = srcTris[i * 9 + 3 + a], v2 = srcTris[i * 9 + 6 + a];
            tmin[i * 3 + a] = Math.min(v0, v1, v2);
            tmax[i * 3 + a] = Math.max(v0, v1, v2);
            cent[i * 3 + a] = (v0 + v1 + v2) / 3;
        }
    }

    const order = new Uint32Array(numTris);
    for (let i = 0; i < numTris; ++i) order[i] = i;

    let capacity = Math.max(1, numTris * 2);
    let nodeBounds = new Float32Array(capacity * 6);
    let nodeInfo = new Int32Array(capacity * 3);
    let numNodes = 0;

    const allocNode = () => {
        if (numNodes === capacity) {
            capacity *= 2;
            const nb = new Float32Array(capacity * 6);
            nb.set(nodeBounds);
            nodeBounds = nb;
            const ni = new Int32Array(capacity * 3);
            ni.set(nodeInfo);
            nodeInfo = ni;
        }
        return numNodes++;
    };

    const binCount = new Int32Array(BINS);
    const binMin = new Float32Array(BINS * 3);
    const binMax = new Float32Array(BINS * 3);
    const leftArea = new Float32Array(BINS);
    const leftCount = new Int32Array(BINS);
    const area = (minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number) => {
        const dx = maxX - minX, dy = maxY - minY, dz = maxZ - minZ;
        return dx < 0 ? 0 : dx * dy + dy * dz + dz * dx;
    };

    const build = (start: number, end: number, depth: number): number => {
        const node = allocNode();

        // node bounds and centroid bounds
        let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        let cminX = Infinity, cminY = Infinity, cminZ = Infinity, cmaxX = -Infinity, cmaxY = -Infinity, cmaxZ = -Infinity;
        for (let i = start; i < end; ++i) {
            const tri = order[i];
            minX = Math.min(minX, tmin[tri * 3]); minY = Math.min(minY, tmin[tri * 3 + 1]); minZ = Math.min(minZ, tmin[tri * 3 + 2]);
            maxX = Math.max(maxX, tmax[tri * 3]); maxY = Math.max(maxY, tmax[tri * 3 + 1]); maxZ = Math.max(maxZ, tmax[tri * 3 + 2]);
            cminX = Math.min(cminX, cent[tri * 3]); cminY = Math.min(cminY, cent[tri * 3 + 1]); cminZ = Math.min(cminZ, cent[tri * 3 + 2]);
            cmaxX = Math.max(cmaxX, cent[tri * 3]); cmaxY = Math.max(cmaxY, cent[tri * 3 + 1]); cmaxZ = Math.max(cmaxZ, cent[tri * 3 + 2]);
        }
        nodeBounds[node * 6] = minX; nodeBounds[node * 6 + 1] = minY; nodeBounds[node * 6 + 2] = minZ;
        nodeBounds[node * 6 + 3] = maxX; nodeBounds[node * 6 + 4] = maxY; nodeBounds[node * 6 + 5] = maxZ;

        const count = end - start;
        const leaf = () => {
            nodeInfo[node * 3] = start;
            nodeInfo[node * 3 + 1] = count;
            nodeInfo[node * 3 + 2] = -1;
            return node;
        };
        if (count <= LEAF_SIZE || depth > 60) {
            return leaf();
        }

        // pick the split with the lowest SAH cost over all three axes
        const cmin = [cminX, cminY, cminZ];
        const cext = [cmaxX - cminX, cmaxY - cminY, cmaxZ - cminZ];
        let bestCost = Infinity;
        let bestAxis = -1;
        let bestBin = -1;
        for (let axis = 0; axis < 3; ++axis) {
            if (cext[axis] <= 1e-12) continue;
            binCount.fill(0);
            binMin.fill(Infinity);
            binMax.fill(-Infinity);
            const scale = BINS / cext[axis];
            for (let i = start; i < end; ++i) {
                const tri = order[i];
                const b = Math.min(BINS - 1, Math.floor((cent[tri * 3 + axis] - cmin[axis]) * scale));
                binCount[b]++;
                for (let a = 0; a < 3; ++a) {
                    binMin[b * 3 + a] = Math.min(binMin[b * 3 + a], tmin[tri * 3 + a]);
                    binMax[b * 3 + a] = Math.max(binMax[b * 3 + a], tmax[tri * 3 + a]);
                }
            }
            // sweep: left areas/counts from the left, right ones from the right
            let lx0 = Infinity, ly0 = Infinity, lz0 = Infinity, lx1 = -Infinity, ly1 = -Infinity, lz1 = -Infinity, lc = 0;
            for (let b = 0; b < BINS - 1; ++b) {
                lc += binCount[b];
                if (binCount[b]) {
                    lx0 = Math.min(lx0, binMin[b * 3]); ly0 = Math.min(ly0, binMin[b * 3 + 1]); lz0 = Math.min(lz0, binMin[b * 3 + 2]);
                    lx1 = Math.max(lx1, binMax[b * 3]); ly1 = Math.max(ly1, binMax[b * 3 + 1]); lz1 = Math.max(lz1, binMax[b * 3 + 2]);
                }
                leftCount[b] = lc;
                leftArea[b] = lc ? area(lx0, ly0, lz0, lx1, ly1, lz1) : 0;
            }
            let rx0 = Infinity, ry0 = Infinity, rz0 = Infinity, rx1 = -Infinity, ry1 = -Infinity, rz1 = -Infinity, rc = 0;
            for (let b = BINS - 1; b > 0; --b) {
                rc += binCount[b];
                if (binCount[b]) {
                    rx0 = Math.min(rx0, binMin[b * 3]); ry0 = Math.min(ry0, binMin[b * 3 + 1]); rz0 = Math.min(rz0, binMin[b * 3 + 2]);
                    rx1 = Math.max(rx1, binMax[b * 3]); ry1 = Math.max(ry1, binMax[b * 3 + 1]); rz1 = Math.max(rz1, binMax[b * 3 + 2]);
                }
                const l = leftCount[b - 1];
                if (!l || !rc) continue;
                const cost = l * leftArea[b - 1] + rc * area(rx0, ry0, rz0, rx1, ry1, rz1);
                if (cost < bestCost) {
                    bestCost = cost;
                    bestAxis = axis;
                    bestBin = b;
                }
            }
        }

        const leafCost = count * area(minX, minY, minZ, maxX, maxY, maxZ);
        if (bestAxis < 0 || (bestCost >= leafCost && count <= 16)) {
            return leaf();
        }

        // partition the triangle range by the chosen bin
        const scale = BINS / cext[bestAxis];
        let i = start;
        let j = end - 1;
        while (i <= j) {
            const b = Math.min(BINS - 1, Math.floor((cent[order[i] * 3 + bestAxis] - cmin[bestAxis]) * scale));
            if (b < bestBin) {
                i++;
            } else {
                const tmp = order[i];
                order[i] = order[j];
                order[j] = tmp;
                j--;
            }
        }
        const mid = (i === start || i === end) ? (start + end) >> 1 : i;

        const left = build(start, mid, depth + 1);
        const right = build(mid, end, depth + 1);
        nodeInfo[node * 3] = left;
        nodeInfo[node * 3 + 1] = 0;
        nodeInfo[node * 3 + 2] = right;
        return node;
    };

    if (numTris > 0) {
        build(0, numTris, 0);
    }

    // triangles and their attributes in leaf order
    const tris = new Float32Array(numTris * 9);
    const triOccluder = new Int32Array(numTris);
    const triMask = new Int32Array(numTris);
    const triUv = new Float32Array(numTris * 6);
    for (let i = 0; i < numTris; ++i) {
        const src = order[i];
        tris.set(srcTris.subarray(src * 9, src * 9 + 9), i * 9);
        triOccluder[i] = srcOccluder[src];
        triMask[i] = srcMask[src];
        if (srcMask[src] >= 0) {
            triUv.set(srcUv.subarray(src * 6, src * 6 + 6), i * 6);
        }
    }

    return {
        nodeBounds: nodeBounds.slice(0, numNodes * 6),
        nodeInfo: nodeInfo.slice(0, numNodes * 3),
        tris,
        triOccluder,
        triMask,
        triUv,
        masks,
        numTris
    };
};

export { buildShadowScene, ShadowScene, ShadowMask };
