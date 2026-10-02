import { Mat4, Vec3 } from 'playcanvas';

import { MeshPrimitive } from './mesh-primitive';
import { MeshData, readGlb, triangleArea } from '../mesh-to-splat';

// GLB model -> world-space triangles. The surface sampling itself is the GLB
// converter in src/mesh-to-splat.ts; this only moves the triangles (and their
// normals) to where the model primitive stands in the scene.

const modelWorldMesh = async (primitive: MeshPrimitive): Promise<MeshData> => {
    const mesh = await readGlb(await (await fetch(primitive.model)).arrayBuffer());
    const transform = primitive.modelTransform;
    const normalMatrix = new Mat4().copy(transform).invert().transpose();
    const point = new Vec3();

    let surfaceArea = 0;
    mesh.batches.forEach((batch) => {
        const p = batch.positions;
        for (let i = 0; i < p.length; i += 3) {
            transform.transformPoint(point.set(p[i], p[i + 1], p[i + 2]), point);
            p[i] = point.x;
            p[i + 1] = point.y;
            p[i + 2] = point.z;
        }
        const n = batch.normals;
        if (n) {
            for (let i = 0; i < n.length; i += 3) {
                normalMatrix.transformVector(point.set(n[i], n[i + 1], n[i + 2]), point).normalize();
                n[i] = point.x;
                n[i + 1] = point.y;
                n[i + 2] = point.z;
            }
        }
        const idx = batch.indices;
        for (let t = 0; t < idx.length; t += 3) {
            surfaceArea += triangleArea(p, idx[t], idx[t + 1], idx[t + 2]);
        }
    });
    mesh.surfaceArea = surfaceArea;
    return mesh;
};

export { modelWorldMesh };
