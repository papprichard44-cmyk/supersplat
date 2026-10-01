import { Mat4, Quat, Vec3 } from 'playcanvas';

import { traceRims } from './image-extrude';
import { MeshPrimitive, loadImage } from './mesh-primitive';

// Mesh -> 3D gaussian splat conversion for toolkit primitives.
//
// This follows the surface-splatting method of EA's Mesh2Splat
// (github.com/electronicarts/mesh2splat): every surface is sampled on a regular
// grid in its own 2D parameter space, each sample becomes one flat gaussian
// lying in the surface, scaled from the size of a grid cell, coloured from the
// texture, with degree-0 SH colour `(c - 0.5) / C0`. Mesh2Splat itself needs
// desktop OpenGL 4.3+ (geometry shaders, SSBOs) and builds on Windows/Linux
// only, so it cannot run on macOS; our primitives are simple enough to sample
// on the CPU here instead.

const SH_C0 = 0.28209479177387814;
const SIGMA = 0.7;          // gaussian std-dev in grid cells: neighbours overlap enough to look solid
const FLATNESS = 0.1;       // thickness of a gaussian relative to its smaller in-surface size
const OPACITY = Math.log(0.999 / 0.001);
const FLOATS = 14;          // x y z, f_dc 0..2, opacity, scale 0..2, rot 0..3
const WALL_SHADE = 0.85;    // side walls a touch darker so the form still reads once it is a splat

type Rgb = [number, number, number];

class GaussianBuffer {
    data: number[] = [];

    get count() {
        return this.data.length / FLOATS;
    }

    add(position: Vec3, color: Rgb, rotation: Quat, sx: number, sy: number, sz: number) {
        this.data.push(
            position.x, position.y, position.z,
            (color[0] - 0.5) / SH_C0, (color[1] - 0.5) / SH_C0, (color[2] - 0.5) / SH_C0,
            OPACITY,
            Math.log(sx), Math.log(sy), Math.log(sz),
            rotation.w, rotation.x, rotation.y, rotation.z
        );
    }

    // standard 3DGS .ply, little endian
    toPly(): ArrayBuffer {
        const properties = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
        const header = new TextEncoder().encode([
            'ply',
            'format binary_little_endian 1.0',
            `element vertex ${this.count}`,
            ...properties.map(name => `property float ${name}`),
            'end_header',
            ''
        ].join('\n'));
        const result = new Uint8Array(header.length + this.data.length * 4);
        result.set(header, 0);
        const view = new DataView(result.buffer, header.length);
        for (let i = 0; i < this.data.length; ++i) {
            view.setFloat32(i * 4, this.data[i], true);
        }
        return result.buffer;
    }
}

const basis = new Mat4();
const worldU = new Vec3();
const worldV = new Vec3();
const normal = new Vec3();
const local = new Vec3();
const world = new Vec3();

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
    return new Quat().setFromMat4(basis);
};

// sample a parallelogram face: origin + s * axisU + t * axisV (local space), s,t in 0..1
const sampleFace = (
    out: GaussianBuffer,
    transform: Mat4,
    origin: Vec3,
    axisU: Vec3,
    axisV: Vec3,
    cell: number,
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
    const rotation = frameRotation(worldU, worldV);
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
            out.add(world, color, rotation, su, sv, Math.min(su, sv) * FLATNESS);
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

// density = number of gaussians along the primitive's longest side
const primitiveToSplat = async (primitive: MeshPrimitive, density: number): Promise<GaussianBuffer> => {
    const out = new GaussianBuffer();
    const transform = primitive.entity.getWorldTransform();
    const scale = transform.getScale();
    const longest = primitive.kind === 'plane' ? Math.max(scale.x, scale.z) : Math.max(scale.x, scale.y, scale.z);
    const cell = longest / Math.max(1, density);
    const tint = primitive.color;

    if (primitive.kind === 'plane') {
        sampleFace(out, transform, new Vec3(-0.5, 0, -0.5), new Vec3(1, 0, 0), new Vec3(0, 0, 1), cell, () => tint);
        return out;
    }

    if (primitive.kind === 'box') {
        boxFaces.forEach(([origin, axisU, axisV]) => sampleFace(out, transform, origin, axisU, axisV, cell, () => tint));
        return out;
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

    const pixelAt = (u: number, v: number, shade: number, testAlpha: boolean): Rgb | null => {
        const x = Math.min(width - 1, Math.max(0, Math.floor(u * width)));
        const y = Math.min(height - 1, Math.max(0, Math.floor(v * height)));
        const o = (x + y * width) * 4;
        if (testAlpha && pixels[o + 3] < cutoff) return null;
        return [pixels[o] / 255 * tint[0] * shade, pixels[o + 1] / 255 * tint[1] * shade, pixels[o + 2] / 255 * tint[2] * shade];
    };

    // the two faces
    [0.5, -0.5].forEach((y) => {
        sampleFace(out, transform, new Vec3(-0.5, y, -0.5), new Vec3(1, 0, 0), new Vec3(0, 0, 1), cell, (s, t) => pixelAt(s, t, 1, true));
    });

    // the side walls: walk each rim and drop a column of gaussians every `cell`
    // of world-space distance (rim points are much denser than that)
    if (primitive.alphaGrid) {
        const along = new Vec3();
        const up = new Vec3();
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
                const rotation = frameRotation(along, up);
                const color = pixelAt(a.u + (b.u - a.u) * f, a.v + (b.v - a.v) * f, WALL_SHADE, false);
                const su = step * SIGMA;
                for (let t = 0; t < nt; ++t) {
                    local.set(a.x + (b.x - a.x) * f, -0.5 + (t + 0.5) / nt, a.z + (b.z - a.z) * f);
                    transform.transformPoint(local, world);
                    out.add(world, color, rotation, su, st, Math.min(su, st) * FLATNESS);
                }
            }
        });
    }

    return out;
};

export { primitiveToSplat };
