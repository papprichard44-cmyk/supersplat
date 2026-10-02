import { Vec3 } from 'playcanvas';

import { ElementType } from '../element';
import type { Events } from '../events';
import type { Scene } from '../scene';
import { buildShadowScene, ShadowScene } from './lighting/bvh';
import { MeshPrimitive } from './mesh-primitive';
import { primitiveOccluder } from './primitive-to-splat';

// Closest-hit ray casts against the visible mesh primitives and models of the
// scene, on the CPU. Uses the same BVH the light bake builds, so alpha-tested
// leaves and cut-outs are only hit where they are opaque. The BVH is rebuilt
// lazily, when a mesh was added, removed, moved or changed.

type MeshHit = {
    t: number;
    position: Vec3;
    normal: Vec3;           // geometric, facing the ray origin
    primitive: MeshPrimitive;
};

class MeshRaycaster {
    private scene: Scene;
    private bvh: ShadowScene | null = null;
    private owners: MeshPrimitive[] = [];   // triangle -> primitive, via triOccluder
    private triOwner: Int32Array = new Int32Array(0);
    private key = '';
    private dirty = true;
    private building: Promise<void> | null = null;
    private stack = new Int32Array(128);

    constructor(scene: Scene, events: Events) {
        this.scene = scene;
        const invalidate = () => {
            this.dirty = true;
        };
        events.on('scene.elementAdded', invalidate);
        events.on('scene.elementRemoved', invalidate);
        events.on('toolkit.primitive.changed', invalidate);
        events.on('scene.clear', invalidate);
    }

    private primitives() {
        return this.scene.getElementsByType(ElementType.model)
        .filter(e => e instanceof MeshPrimitive && (e as MeshPrimitive).entity.enabled) as MeshPrimitive[];
    }

    private currentKey(primitives: MeshPrimitive[]) {
        return primitives.map(p => `${p.uid}:${Array.from(p.entity.getWorldTransform().data).map(v => v.toFixed(5)).join(',')}`).join('|');
    }

    get empty() {
        return this.primitives().length === 0;
    }

    // make sure the BVH matches the scene
    async update() {
        if (this.building) {
            await this.building;
        }
        const primitives = this.primitives();
        const key = this.currentKey(primitives);
        if (!this.dirty && key === this.key) return;
        this.building = (async () => {
            const occluders = [];
            const owners: MeshPrimitive[] = [];
            for (const primitive of primitives) {
                try {
                    const occluder = await primitiveOccluder(primitive);
                    if (occluder && occluder.positions.length > 0) {
                        // every triangle names its mesh, so hits can report it
                        occluders.push({ ...occluder, convex: true });
                        owners.push(primitive);
                    }
                } catch (e) {
                    console.warn('mesh raycast: skipping', primitive.name, e);
                }
            }
            this.bvh = occluders.length ? buildShadowScene(occluders) : null;
            this.owners = owners;
            this.triOwner = this.bvh ? this.bvh.triOccluder : new Int32Array(0);
            this.key = key;
            this.dirty = false;
        })();
        try {
            await this.building;
        } finally {
            this.building = null;
        }
    }

    // closest hit along origin + t * direction (direction need not be unit)
    cast(origin: Vec3, direction: Vec3, tmax = Infinity): MeshHit | null {
        const scene = this.bvh;
        if (!scene || scene.numTris === 0) return null;
        const { nodeBounds: nb, nodeInfo: ni, tris, triMask, triUv, masks } = scene;
        const ox = origin.x, oy = origin.y, oz = origin.z;
        const dx = direction.x, dy = direction.y, dz = direction.z;
        const ix = 1 / dx, iy = 1 / dy, iz = 1 / dz;
        let best = tmax;
        let bestTri = -1;
        let stack = this.stack;
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
            if (tf < Math.max(tn, 0) || tn > best) continue;

            const info = node * 3;
            const count = ni[info + 1];
            if (count === 0) {
                if (sp + 2 > stack.length) {
                    const grown = new Int32Array(stack.length * 2);
                    grown.set(stack);
                    stack = grown;
                    this.stack = grown;
                }
                stack[sp++] = ni[info];
                stack[sp++] = ni[info + 2];
                continue;
            }
            const first = ni[info];
            for (let t = first; t < first + count; ++t) {
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
                if (hit <= 1e-6 || hit >= best) continue;
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
                best = hit;
                bestTri = t;
            }
        }
        if (bestTri < 0) return null;

        const k = bestTri * 9;
        const e1 = new Vec3(tris[k + 3] - tris[k], tris[k + 4] - tris[k + 1], tris[k + 5] - tris[k + 2]);
        const e2 = new Vec3(tris[k + 6] - tris[k], tris[k + 7] - tris[k + 1], tris[k + 8] - tris[k + 2]);
        const normal = new Vec3().cross(e1, e2).normalize();
        if (normal.dot(direction) > 0) normal.mulScalar(-1);
        return {
            t: best,
            position: new Vec3(ox + dx * best, oy + dy * best, oz + dz * best),
            normal,
            primitive: this.owners[this.triOwner[bestTri]] ?? null
        };
    }
}

export { MeshRaycaster, MeshHit };
