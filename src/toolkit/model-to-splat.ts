import { Vec3 } from 'playcanvas';

import { meshToSplatPly, readGlb } from '../mesh-to-splat';
import { MeshPrimitive } from './mesh-primitive';

// GLB model -> gaussian splats. The surface sampling itself is the GLB
// converter in src/mesh-to-splat.ts; this only moves the triangles to where the
// model primitive stands in the scene and picks the splat count from the
// density setting.

const MAX_SPLATS = 4_000_000;

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

// density = number of splats along the model's longest side
const modelToSplat = async (primitive: MeshPrimitive, density: number): Promise<{ blob: Blob, count: number }> => {
    const mesh = await readGlb(await (await fetch(primitive.model)).arrayBuffer());
    const transform = primitive.modelTransform;
    const point = new Vec3();

    // bake the primitive's placement (and tint) into the triangles
    let surfaceArea = 0;
    let longest = 0;
    const min = new Vec3(Infinity, Infinity, Infinity);
    const max = new Vec3(-Infinity, -Infinity, -Infinity);
    const tinted = new Set<object>();
    const a = new Vec3();
    const b = new Vec3();
    const c = new Vec3();
    mesh.batches.forEach((batch) => {
        const p = batch.positions;
        for (let i = 0; i < p.length; i += 3) {
            transform.transformPoint(point.set(p[i], p[i + 1], p[i + 2]), point);
            p[i] = point.x;
            p[i + 1] = point.y;
            p[i + 2] = point.z;
            min.min(point);
            max.max(point);
        }
        const idx = batch.indices;
        for (let t = 0; t < idx.length; t += 3) {
            a.set(p[idx[t] * 3], p[idx[t] * 3 + 1], p[idx[t] * 3 + 2]);
            b.set(p[idx[t + 1] * 3], p[idx[t + 1] * 3 + 1], p[idx[t + 1] * 3 + 2]).sub(a);
            c.set(p[idx[t + 2] * 3], p[idx[t + 2] * 3 + 1], p[idx[t + 2] * 3 + 2]).sub(a);
            surfaceArea += b.cross(b, c).length() * 0.5;
        }
        if (!tinted.has(batch.material)) {
            tinted.add(batch.material);
            for (let i = 0; i < 3; ++i) {
                batch.material.baseColor[i] *= srgbToLinear(primitive.color[i]);
            }
        }
    });
    mesh.surfaceArea = surfaceArea;
    longest = Math.max(max.x - min.x, max.y - min.y, max.z - min.z);

    const cell = longest / Math.max(1, density);
    const target = Math.min(MAX_SPLATS, Math.max(1000, Math.round(surfaceArea / (cell * cell))));
    return meshToSplatPly(mesh, target);
};

export { modelToSplat };
