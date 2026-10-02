import { Mat4, Quat, Vec3 } from 'playcanvas';

import { traceRims, buildExtrudeGeometry } from './image-extrude';
import { SampleBuffer, srgbToLinear, SurfaceMaterial } from './lighting/samples';
import { DEFAULT_METALNESS, DEFAULT_ROUGHNESS, MeshPrimitive, loadImage } from './mesh-primitive';
import { modelWorldMesh } from './model-to-splat';
import { isShapeKind, shapeGeometry } from './shapes';
import { MeshData, sampleMeshSurface, triangleArea } from '../mesh-to-splat';
import { grassSamples } from './vegetation/grass';

// Mesh -> 3D gaussian splat conversion for toolkit primitives.
//
// This follows the surface-splatting method of EA's Mesh2Splat
// (github.com/electronicarts/mesh2splat): every surface is sampled on a regular
// grid in its own 2D parameter space, each sample becomes one flat gaussian
// lying in the surface, scaled from the size of a grid cell, coloured from the
// texture. Mesh2Splat itself needs desktop OpenGL 4.3+ (geometry shaders,
// SSBOs) and builds on Windows/Linux only, so it cannot run on macOS; our
// primitives are simple enough to sample on the CPU here instead.
//
// Planes, boxes and pictures use the regular grid; curved shapes and models
// are triangle meshes sampled evenly by area (mesh-to-splat.ts). Either way the
// samples go into a SampleBuffer and are coloured afterwards: as they are, or
// lit by the studio lights.

const SIGMA = 0.7;          // gaussian std-dev in grid cells: neighbours overlap enough to look solid
const FLATNESS = 0.1;       // thickness of a gaussian relative to its smaller in-surface size
const WALL_SHADE = 0.85;    // unlit side walls a touch darker so the form still reads once it is a splat

type Rgb = [number, number, number];

const basis = new Mat4();
const worldU = new Vec3();
const worldV = new Vec3();
const normal = new Vec3();
const local = new Vec3();
const world = new Vec3();
const faceCenter = new Vec3();
const rotation = new Quat();

// rotation whose x/y axes are the (orthogonal) in-surface directions u and v
const frameRotation = (u: Vec3, v: Vec3) => {
    const ux = u.clone().normalize();
    const vx = v.clone().normalize();
    normal.cross(ux, vx).normalize();
    const d = basis.data;
    d[0] = ux.x; d[1] = ux.y; d[2] = ux.z; d[3] = 0;
    d[4] = vx.x; d[5] = vx.y; d[6] = vx.z; d[7] = 0;
    d[8] = normal.x; d[9] = normal.y; d[10] = normal.z; d[11] = 0;
    d[12] = 0; d[13] = 0; d[14] = 0; d[15] = 1;
    return rotation.setFromMat4(basis);
};

// the surface response of a primitive (models default to their own materials)
const surfaceOf = (primitive: MeshPrimitive, twoSided: boolean): SurfaceMaterial => ({
    roughness: primitive.roughness ?? DEFAULT_ROUGHNESS,
    metalness: primitive.metalness ?? DEFAULT_METALNESS,
    twoSided
});

const addSample = (out: SampleBuffer, position: Vec3, color: Rgb, alpha: number, n: Vec3,
    sx: number, sy: number, sz: number, material: SurfaceMaterial, shade = 1) => {
    out.add(
        position.x, position.y, position.z,
        rotation.w, rotation.x, rotation.y, rotation.z,
        sx, sy, sz,
        srgbToLinear(color[0]), srgbToLinear(color[1]), srgbToLinear(color[2]), alpha,
        n.x, n.y, n.z,
        material, shade
    );
};

// sample a parallelogram face: origin + s * axisU + t * axisV (local space), s,t in 0..1.
// the shading normal points away from `center` (world), which makes closed
// solids face outwards; a flat plane through its own centre keeps u x v.
const sampleFace = (
    out: SampleBuffer,
    transform: Mat4,
    center: Vec3,
    origin: Vec3,
    axisU: Vec3,
    axisV: Vec3,
    cell: number,
    material: SurfaceMaterial,
    colorAt: (s: number, t: number) => Rgb | null
) => {
    transform.transformVector(axisU, worldU);
    transform.transformVector(axisV, worldV);
    const lengthU = worldU.length();
    const lengthV = worldV.length();
    if (lengthU < 1e-9 || lengthV < 1e-9) return;
    const nu = Math.max(1, Math.round(lengthU / cell));
    const nv = Math.max(1, Math.round(lengthV / cell));
    const su = lengthU / nu * SIGMA;
    const sv = lengthV / nv * SIGMA;
    frameRotation(worldU, worldV);
    const n = normal.clone();
    local.set(origin.x + (axisU.x + axisV.x) * 0.5, origin.y + (axisU.y + axisV.y) * 0.5, origin.z + (axisU.z + axisV.z) * 0.5);
    transform.transformPoint(local, faceCenter);
    if (n.dot(faceCenter.sub(center)) < 0) {
        n.mulScalar(-1);
    }
    for (let j = 0; j < nv; ++j) {
        for (let i = 0; i < nu; ++i) {
            const s = (i + 0.5) / nu;
            const t = (j + 0.5) / nv;
            const color = colorAt(s, t);
            if (!color) continue;
            local.set(
                origin.x + axisU.x * s + axisV.x * t,
                origin.y + axisU.y * s + axisV.y * t,
                origin.z + axisU.z * s + axisV.z * t
            );
            transform.transformPoint(local, world);
            addSample(out, world, color, 1, n, su, sv, Math.min(su, sv) * FLATNESS, material);
        }
    }
};

const boxFaces: [Vec3, Vec3, Vec3][] = [
    [new Vec3(-0.5, 0.5, -0.5), new Vec3(1, 0, 0), new Vec3(0, 0, 1)],
    [new Vec3(-0.5, -0.5, -0.5), new Vec3(1, 0, 0), new Vec3(0, 0, 1)],
    [new Vec3(0.5, -0.5, -0.5), new Vec3(0, 1, 0), new Vec3(0, 0, 1)],
    [new Vec3(-0.5, -0.5, -0.5), new Vec3(0, 1, 0), new Vec3(0, 0, 1)],
    [new Vec3(-0.5, -0.5, 0.5), new Vec3(1, 0, 0), new Vec3(0, 1, 0)],
    [new Vec3(-0.5, -0.5, -0.5), new Vec3(1, 0, 0), new Vec3(0, 1, 0)]
];

// a curved shape as a world-space triangle mesh
const shapeWorldMesh = (primitive: MeshPrimitive): MeshData => {
    const geometry = shapeGeometry(primitive.kind as any);
    const m = primitive.entity.getWorldTransform();
    const positions = new Float32Array(geometry.positions.length);
    const normals = new Float32Array(geometry.normals.length);
    const normalMatrix = new Mat4().copy(m).invert().transpose();
    const v = new Vec3();
    for (let i = 0; i < positions.length; i += 3) {
        m.transformPoint(v.set(geometry.positions[i], geometry.positions[i + 1], geometry.positions[i + 2]), v);
        positions[i] = v.x; positions[i + 1] = v.y; positions[i + 2] = v.z;
        normalMatrix.transformVector(v.set(geometry.normals[i], geometry.normals[i + 1], geometry.normals[i + 2]), v).normalize();
        normals[i] = v.x; normals[i + 1] = v.y; normals[i + 2] = v.z;
    }
    const c = primitive.color;
    let surfaceArea = 0;
    for (let t = 0; t < geometry.indices.length; t += 3) {
        surfaceArea += triangleArea(positions, geometry.indices[t], geometry.indices[t + 1], geometry.indices[t + 2]);
    }
    return {
        batches: [{
            positions,
            normals,
            uvs: null,
            mrUvs: null,
            colors: null,
            indices: geometry.indices,
            material: {
                baseColor: [srgbToLinear(c[0]), srgbToLinear(c[1]), srgbToLinear(c[2]), 1],
                texture: null,
                alphaMode: 'OPAQUE',
                alphaCutoff: 0.5,
                roughness: primitive.roughness ?? DEFAULT_ROUGHNESS,
                metalness: primitive.metalness ?? DEFAULT_METALNESS,
                mrTexture: null,
                doubleSided: geometry.twoSided
            }
        }],
        numTriangles: geometry.indices.length / 3,
        surfaceArea
    };
};

// Sample a primitive into `out`. `cell` is the spacing between samples in
// world units. Models and curved shapes are parsed into world-space triangles
// first; pass `meshes` to reuse them (they are also the shadow casters).
const samplePrimitive = async (primitive: MeshPrimitive, cell: number, out: SampleBuffer, meshes?: Map<MeshPrimitive, MeshData>) => {
    const start = out.count;
    const transform = primitive.entity.getWorldTransform();
    const center = transform.getTranslation();
    const scale = transform.getScale();
    const tint = primitive.color;

    // generated grass: gaussians straight along its blades
    if (primitive.kind === 'model' && primitive.generator?.type === 'grass' && primitive.generator.params?.direct !== false && primitive.modelTransform) {
        grassSamples(primitive.generator.params, primitive.modelTransform, out, [srgbToLinear(tint[0]), srgbToLinear(tint[1]), srgbToLinear(tint[2])]);
        return out.count - start;
    }

    if (primitive.kind === 'model' || isShapeKind(primitive.kind)) {
        let mesh = meshes?.get(primitive);
        if (!mesh) {
            mesh = primitive.kind === 'model' ? await modelWorldMesh(primitive) : shapeWorldMesh(primitive);
            meshes?.set(primitive, mesh);
        }
        const target = Math.round(mesh.surfaceArea / (cell * cell));
        if (primitive.kind === 'model') {
            sampleMeshSurface(mesh, target, out, {
                tint: [srgbToLinear(tint[0]), srgbToLinear(tint[1]), srgbToLinear(tint[2])],
                surface: primitive.roughness !== null ? { roughness: primitive.roughness, metalness: primitive.metalness ?? 0 } : null
            });
        } else {
            sampleMeshSurface(mesh, target, out);
        }
        return out.count - start;
    }

    if (primitive.kind === 'plane') {
        sampleFace(out, transform, center, new Vec3(-0.5, 0, -0.5), new Vec3(1, 0, 0), new Vec3(0, 0, 1), cell, surfaceOf(primitive, true), () => tint);
        return out.count - start;
    }

    if (primitive.kind === 'box') {
        const material = surfaceOf(primitive, false);
        boxFaces.forEach(([origin, axisU, axisV]) => sampleFace(out, transform, center, origin, axisU, axisV, cell, material, () => tint));
        return out.count - start;
    }

    // picture: read colour + alpha from a copy scaled to the sampling grid, so
    // every gaussian gets the average of the pixels it covers
    const source = await loadImage(primitive.image);
    const width = Math.max(1, Math.round(scale.x / cell));
    const height = Math.max(1, Math.round(scale.z / cell));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(source, 0, 0, width, height);
    const pixels = context.getImageData(0, 0, width, height).data;
    const cutoff = primitive.alphaCutoff * 255;
    const material = surfaceOf(primitive, false);

    const pixelAt = (u: number, v: number, testAlpha: boolean): Rgb | null => {
        const x = Math.min(width - 1, Math.max(0, Math.floor(u * width)));
        const y = Math.min(height - 1, Math.max(0, Math.floor(v * height)));
        const o = (x + y * width) * 4;
        if (testAlpha && pixels[o + 3] < cutoff) return null;
        return [pixels[o] / 255 * tint[0], pixels[o + 1] / 255 * tint[1], pixels[o + 2] / 255 * tint[2]];
    };

    // the two faces
    [0.5, -0.5].forEach((y) => {
        sampleFace(out, transform, center, new Vec3(-0.5, y, -0.5), new Vec3(1, 0, 0), new Vec3(0, 0, 1), cell, material, (s, t) => pixelAt(s, t, true));
    });

    // the side walls: walk each rim and drop a column of gaussians every `cell`
    // of world-space distance (rim points are much denser than that)
    if (primitive.alphaGrid) {
        const along = new Vec3();
        const up = new Vec3();
        const outward = new Vec3();
        const normalMatrix = new Mat4().copy(transform).invert().transpose();
        transform.transformVector(new Vec3(0, 1, 0), up);
        const thickness = up.length();
        const nt = Math.max(1, Math.round(thickness / cell));
        const st = thickness / nt * SIGMA;

        traceRims(primitive.alphaGrid, primitive.alphaCutoff).forEach((rim) => {
            const n = rim.length;
            const lengths: number[] = [];
            let total = 0;
            for (let i = 0; i < n; ++i) {
                const a = rim[i];
                const b = rim[(i + 1) % n];
                transform.transformVector(local.set(b.x - a.x, 0, b.z - a.z), along);
                lengths.push(along.length());
                total += lengths[i];
            }
            const columns = Math.max(3, Math.round(total / cell));
            const step = total / columns;
            let segment = 0;
            let segmentStart = 0;
            for (let k = 0; k < columns; ++k) {
                const distance = (k + 0.5) * step;
                while (segment < n - 1 && segmentStart + lengths[segment] < distance) {
                    segmentStart += lengths[segment++];
                }
                const a = rim[segment];
                const b = rim[(segment + 1) % n];
                const f = lengths[segment] > 0 ? Math.min(1, (distance - segmentStart) / lengths[segment]) : 0;
                transform.transformVector(local.set(b.x - a.x, 0, b.z - a.z), along);
                if (along.length() < 1e-12) continue;
                frameRotation(along, up);
                normalMatrix.transformVector(outward.set(a.nx, 0, a.nz), outward).normalize();
                const color = pixelAt(a.u + (b.u - a.u) * f, a.v + (b.v - a.v) * f, false);
                const su = step * SIGMA;
                for (let t = 0; t < nt; ++t) {
                    local.set(a.x + (b.x - a.x) * f, -0.5 + (t + 0.5) / nt, a.z + (b.z - a.z) * f);
                    transform.transformPoint(local, world);
                    addSample(out, world, color, 1, outward, su, st, Math.min(su, st) * FLATNESS, material, WALL_SHADE);
                }
            }
        });
    }

    return out.count - start;
};

// ---- shadow casters

type OccluderMask = { width: number, height: number, alpha: Float32Array, cutoff: number };

type Occluder = {
    positions: Float32Array;        // 9 floats per triangle, world space
    uvs: Float32Array | null;       // 6 floats per triangle, for alpha-masked triangles
    maskIndex: Int32Array | null;   // per triangle: which of `masks` cuts it, -1 = opaque
    masks: OccluderMask[];
    convex: boolean;
};

const MASK_MAX = 256;

// a texture's alpha as a shadow mask, at most MASK_MAX on a side
const textureMask = (texture: { width: number, height: number, data: Uint8ClampedArray }, cutoff: number): OccluderMask => {
    const scale = Math.min(1, MASK_MAX / Math.max(texture.width, texture.height));
    const width = Math.max(1, Math.round(texture.width * scale));
    const height = Math.max(1, Math.round(texture.height * scale));
    const alpha = new Float32Array(width * height);
    for (let y = 0; y < height; ++y) {
        const sy = Math.min(texture.height - 1, Math.floor((y + 0.5) / scale));
        for (let x = 0; x < width; ++x) {
            const sx = Math.min(texture.width - 1, Math.floor((x + 0.5) / scale));
            alpha[y * width + x] = texture.data[(sy * texture.width + sx) * 4 + 3] / 255;
        }
    }
    return { width, height, alpha, cutoff };
};

const trianglesOf = (positions: ArrayLike<number>, indices: ArrayLike<number>, transform: Mat4 | null) => {
    const out = new Float32Array(indices.length * 3);
    const v = new Vec3();
    for (let i = 0; i < indices.length; ++i) {
        const k = indices[i] * 3;
        v.set(positions[k], positions[k + 1], positions[k + 2]);
        if (transform) transform.transformPoint(v, v);
        out[i * 3] = v.x;
        out[i * 3 + 1] = v.y;
        out[i * 3 + 2] = v.z;
    }
    return out;
};

const quadPositions = [-0.5, 0, -0.5, 0.5, 0, -0.5, 0.5, 0, 0.5, -0.5, 0, 0.5];
const quadIndices = [0, 1, 2, 0, 2, 3];
const boxPositions = [
    -0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, -0.5,
    -0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5
];
const boxIndices = [
    0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1,
    3, 2, 6, 3, 6, 7, 0, 3, 7, 0, 7, 4, 1, 5, 6, 1, 6, 2
];

// the triangles a primitive casts shadows with
const primitiveOccluder = async (primitive: MeshPrimitive, meshes?: Map<MeshPrimitive, MeshData>): Promise<Occluder | null> => {
    const transform = primitive.entity.getWorldTransform();
    const base = { uvs: null as Float32Array | null, maskIndex: null as Int32Array | null, masks: [] as OccluderMask[] };

    if (primitive.kind === 'plane') {
        return { ...base, positions: trianglesOf(quadPositions, quadIndices, transform), convex: true };
    }
    if (primitive.kind === 'box') {
        return { ...base, positions: trianglesOf(boxPositions, boxIndices, transform), convex: true };
    }
    if (primitive.kind === 'image') {
        if (!primitive.alphaGrid) return null;
        const geometry = buildExtrudeGeometry(primitive.alphaGrid, primitive.alphaCutoff);
        const triangles = geometry.indices.length / 3;
        const uvs = new Float32Array(triangles * 6);
        const maskIndex = new Int32Array(triangles);
        for (let t = 0; t < triangles; ++t) {
            let cap = true;
            for (let k = 0; k < 3; ++k) {
                const vi = geometry.indices[t * 3 + k];
                uvs[t * 6 + k * 2] = geometry.uvs[vi * 2];
                uvs[t * 6 + k * 2 + 1] = geometry.uvs[vi * 2 + 1];
                // the two picture faces have normals along y, the walls don't
                if (Math.abs(geometry.normals[vi * 3 + 1]) < 0.5) cap = false;
            }
            maskIndex[t] = cap ? 0 : -1;
        }
        return {
            positions: trianglesOf(geometry.positions, geometry.indices, transform),
            uvs,
            maskIndex,
            masks: [{ ...primitive.alphaGrid, cutoff: primitive.alphaCutoff }],
            convex: false
        };
    }

    let mesh = meshes?.get(primitive);
    if (!mesh) {
        mesh = primitive.kind === 'model' ? await modelWorldMesh(primitive) : shapeWorldMesh(primitive);
        meshes?.set(primitive, mesh);
    }
    const parts = mesh.batches.map(batch => trianglesOf(batch.positions, batch.indices, null));
    const triangles = parts.reduce((sum, part) => sum + part.length / 9, 0);
    const positions = new Float32Array(triangles * 9);
    // alpha-tested materials (leaves, cut-outs) cut their shadows with their texture
    const anyMasked = mesh.batches.some(b => b.material.alphaMode !== 'OPAQUE' && b.material.texture && b.uvs);
    const uvs = anyMasked ? new Float32Array(triangles * 6) : null;
    const maskIndex = anyMasked ? new Int32Array(triangles).fill(-1) : null;
    const masks: OccluderMask[] = [];
    let t = 0;
    mesh.batches.forEach((batch, bi) => {
        positions.set(parts[bi], t * 9);
        const count = parts[bi].length / 9;
        const m = batch.material;
        if (anyMasked && m.alphaMode !== 'OPAQUE' && m.texture && batch.uvs) {
            const index = masks.length;
            masks.push(textureMask(m.texture, m.alphaMode === 'MASK' ? m.alphaCutoff : 0.5));
            for (let k = 0; k < count; ++k) {
                maskIndex[t + k] = index;
                for (let c = 0; c < 3; ++c) {
                    const vi = batch.indices[k * 3 + c];
                    uvs[(t + k) * 6 + c * 2] = batch.uvs[vi * 2];
                    uvs[(t + k) * 6 + c * 2 + 1] = batch.uvs[vi * 2 + 1];
                }
            }
        }
        t += count;
    });
    const convex = isShapeKind(primitive.kind) && shapeGeometry(primitive.kind).convex;
    return { ...base, positions, uvs, maskIndex, masks, convex };
};

// splats along the longest side -> spacing between samples
const cellForDensity = (primitive: MeshPrimitive, density: number) => {
    const scale = primitive.entity.getWorldTransform().getScale();
    const longest = primitive.kind === 'plane' ? Math.max(scale.x, scale.z) : Math.max(scale.x, scale.y, scale.z);
    return longest / Math.max(1, density);
};

export { samplePrimitive, primitiveOccluder, cellForDensity, Occluder, OccluderMask };
