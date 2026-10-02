import { S_LAYER, S_LIGHTMASK, S_ROUGH, STRIDE, SampleBuffer, srgbToLinear } from './samples';

// Relighting an existing splat layer: the layer is exported to a PLY in
// memory, every gaussian becomes a sample for the bake (its colour as the
// surface colour, its shortest axis as the normal), and the lit colours are
// written back into a copy of the file, which is loaded as a new layer.

const SH_C0 = 0.28209479177387814;

type PlyLayout = {
    count: number;
    stride: number;
    dataStart: number;
    offsets: Record<string, number>;
};

const required = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];

const typeSizes: Record<string, number> = {
    char: 1,
    uchar: 1,
    int8: 1,
    uint8: 1,
    short: 2,
    ushort: 2,
    int16: 2,
    uint16: 2,
    int: 4,
    uint: 4,
    int32: 4,
    uint32: 4,
    float: 4,
    float32: 4,
    double: 8,
    float64: 8
};

// header of a binary little-endian PLY with float gaussian properties
const readPlyLayout = (buffer: ArrayBuffer): PlyLayout => {
    const bytes = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 65536));
    const text = new TextDecoder().decode(bytes);
    const end = text.indexOf('end_header\n');
    if (end < 0 || !text.startsWith('ply')) {
        throw new Error('The exported layer is not a PLY file');
    }
    if (!text.includes('binary_little_endian')) {
        throw new Error('The exported layer is not a binary PLY');
    }
    let count = 0;
    let stride = 0;
    let inVertex = false;
    const offsets: Record<string, number> = {};
    text.slice(0, end).split('\n').forEach((line) => {
        const words = line.trim().split(/\s+/);
        if (words[0] === 'element') {
            inVertex = words[1] === 'vertex';
            if (inVertex) count = parseInt(words[2], 10);
        } else if (words[0] === 'property' && inVertex) {
            if (words[1] === 'float' || words[1] === 'float32') {
                offsets[words[2]] = stride;
            }
            stride += typeSizes[words[1]] ?? 4;
        }
    });
    const missing = required.filter(name => offsets[name] === undefined);
    if (missing.length) {
        throw new Error(`The exported layer has no ${missing.join(', ')}`);
    }
    return { count, stride, dataStart: new TextEncoder().encode(text.slice(0, end + 'end_header\n'.length)).length, offsets };
};

// the gaussians as bake samples, in world space (the PLY convention is
// rotated 180 degrees about Z). Normals face the camera, as in the preview.
const splatSamples = (buffer: ArrayBuffer, layout: PlyLayout, mask: number, camera: { x: number, y: number, z: number }, ownGrid = -1) => {
    const view = new DataView(buffer, layout.dataStart);
    const o = layout.offsets;
    const samples = new SampleBuffer();
    const material = { roughness: 1, metalness: 0, twoSided: true };
    for (let i = 0; i < layout.count; ++i) {
        const base = i * layout.stride;
        const f = (name: string) => view.getFloat32(base + o[name], true);
        const px = -f('x'), py = -f('y'), pz = f('z');
        // gaussian frame (PLY space), its shortest axis
        let w = f('rot_0'), x = f('rot_1'), y = f('rot_2'), z = f('rot_3');
        const ql = Math.hypot(w, x, y, z) || 1;
        w /= ql; x /= ql; y /= ql; z /= ql;
        const s0 = Math.exp(f('scale_0')), s1 = Math.exp(f('scale_1')), s2 = Math.exp(f('scale_2'));
        const smax = Math.max(s0, s1, s2);
        const smin = Math.min(s0, s1, s2);
        const smid = s0 + s1 + s2 - smax - smin;
        let ax: number, ay: number, az: number;
        if (s0 <= s1 && s0 <= s2) {
            ax = 1 - 2 * (y * y + z * z); ay = 2 * (x * y + w * z); az = 2 * (x * z - w * y);
        } else if (s1 <= s2) {
            ax = 2 * (x * y - w * z); ay = 1 - 2 * (x * x + z * z); az = 2 * (y * z + w * x);
        } else {
            ax = 2 * (x * z + w * y); ay = 2 * (y * z - w * x); az = 1 - 2 * (x * x + y * y);
        }
        // to world space, facing the camera
        let nx = -ax, ny = -ay, nz = az;
        if (nx * (camera.x - px) + ny * (camera.y - py) + nz * (camera.z - pz) < 0) {
            nx = -nx; ny = -ny; nz = -nz;
        }
        const flatness = Math.min(1, Math.max(0, 1 - smin / Math.max(smid, 1e-12)));
        const r = srgbToLinear(Math.min(1, Math.max(0, 0.5 + SH_C0 * f('f_dc_0'))));
        const g = srgbToLinear(Math.min(1, Math.max(0, 0.5 + SH_C0 * f('f_dc_1'))));
        const b = srgbToLinear(Math.min(1, Math.max(0, 0.5 + SH_C0 * f('f_dc_2'))));
        samples.add(px, py, pz, 1, 0, 0, 0, s0, s1, s2, r, g, b, 1, nx, ny, nz, material);
        // the flatness rides in the roughness slot (see the kernel's splat mode)
        const k = (samples.count - 1) * STRIDE;
        samples.data[k + S_ROUGH] = flatness;
        samples.data[k + S_LIGHTMASK] = mask;
        samples.data[k + S_LAYER] = ownGrid;
    }
    return samples;
};

// a copy of the file with new f_dc values
const writeDc = (buffer: ArrayBuffer, layout: PlyLayout, dc: Float32Array) => {
    const copy = buffer.slice(0);
    const view = new DataView(copy, layout.dataStart);
    const o = layout.offsets;
    for (let i = 0; i < layout.count; ++i) {
        const base = i * layout.stride;
        view.setFloat32(base + o.f_dc_0, dc[i * 3], true);
        view.setFloat32(base + o.f_dc_1, dc[i * 3 + 1], true);
        view.setFloat32(base + o.f_dc_2, dc[i * 3 + 2], true);
    }
    return copy;
};

type ShadowGrid = { min: number[], voxel: number, nx: number, ny: number, nz: number, data: Float32Array };

// A splat layer as a shadow caster: its gaussians deposited on a voxel grid
// as extinction (optical depth per unit length), so a shadow ray passing
// through the layer is dimmed by what it crosses. Each gaussian is a blob of
// radius r (two standard deviations of its in-plane size) whose cross-section
// absorbs -ln(1 - alpha) of the light, spread over the voxels it covers.
const buildShadowGrid = (buffer: ArrayBuffer, layout: PlyLayout, maxRes = 128): ShadowGrid | null => {
    const view = new DataView(buffer, layout.dataStart);
    const o = layout.offsets;
    const n = layout.count;
    if (n === 0) return null;
    const hasOpacity = o.opacity !== undefined;

    // centres (world) and their bound; robust to a few far away floaters
    const centres = new Float32Array(n * 3);
    const xs: number[] = [];
    const ys: number[] = [];
    const zs: number[] = [];
    for (let i = 0; i < n; ++i) {
        const base = i * layout.stride;
        const x = -view.getFloat32(base + o.x, true), y = -view.getFloat32(base + o.y, true), z = view.getFloat32(base + o.z, true);
        centres[i * 3] = x; centres[i * 3 + 1] = y; centres[i * 3 + 2] = z;
        if (i % Math.max(1, Math.floor(n / 20000)) === 0) {
            xs.push(x); ys.push(y); zs.push(z);
        }
    }
    const range = (values: number[]) => {
        values.sort((a, b) => a - b);
        const lo = values[Math.floor(values.length * 0.002)];
        const hi = values[Math.min(values.length - 1, Math.ceil(values.length * 0.998))];
        return [lo, hi];
    };
    const [x0, x1] = range(xs);
    const [y0, y1] = range(ys);
    const [z0, z1] = range(zs);
    const extent = Math.max(x1 - x0, y1 - y0, z1 - z0, 1e-6);
    const voxel = extent / (maxRes - 4);
    const min = [x0 - 2 * voxel, y0 - 2 * voxel, z0 - 2 * voxel];
    const nx = Math.ceil((x1 - x0) / voxel) + 4;
    const ny = Math.ceil((y1 - y0) / voxel) + 4;
    const nz = Math.ceil((z1 - z0) / voxel) + 4;
    const data = new Float32Array(nx * ny * nz);
    const volume = voxel * voxel * voxel;
    const maxSpan = 6;

    for (let i = 0; i < n; ++i) {
        const base = i * layout.stride;
        const alpha = hasOpacity ? 1 / (1 + Math.exp(-view.getFloat32(base + o.opacity, true))) : 1;
        if (!(alpha > 0.02)) continue;
        const s0 = Math.exp(view.getFloat32(base + o.scale_0, true));
        const s1 = Math.exp(view.getFloat32(base + o.scale_1, true));
        const s2 = Math.exp(view.getFloat32(base + o.scale_2, true));
        const smax = Math.max(s0, s1, s2);
        const smid = s0 + s1 + s2 - smax - Math.min(s0, s1, s2);
        const r = Math.min(2 * Math.sqrt(smax * smid), maxSpan * voxel);
        if (!(r > 0)) continue;
        const absorb = Math.PI * r * r * -Math.log(1 - Math.min(alpha, 0.995));
        const cx = (centres[i * 3] - min[0]) / voxel - 0.5;
        const cy = (centres[i * 3 + 1] - min[1]) / voxel - 0.5;
        const cz = (centres[i * 3 + 2] - min[2]) / voxel - 0.5;
        const rv = Math.max(0.5, r / voxel);
        const ix0 = Math.max(0, Math.floor(cx - rv)), ix1 = Math.min(nx - 1, Math.ceil(cx + rv));
        const iy0 = Math.max(0, Math.floor(cy - rv)), iy1 = Math.min(ny - 1, Math.ceil(cy + rv));
        const iz0 = Math.max(0, Math.floor(cz - rv)), iz1 = Math.min(nz - 1, Math.ceil(cz + rv));
        if (ix0 > ix1 || iy0 > iy1 || iz0 > iz1) continue;
        // gaussian weights over the covered voxels, normalised
        const k = 2 / (rv * rv);
        let sum = 0;
        for (let z = iz0; z <= iz1; ++z) {
            for (let y = iy0; y <= iy1; ++y) {
                for (let x = ix0; x <= ix1; ++x) {
                    const dx = x - cx, dy = y - cy, dz = z - cz;
                    sum += Math.exp(-k * (dx * dx + dy * dy + dz * dz));
                }
            }
        }
        if (!(sum > 0)) continue;
        const scale = absorb / (sum * volume);
        for (let z = iz0; z <= iz1; ++z) {
            for (let y = iy0; y <= iy1; ++y) {
                const row = nx * (y + ny * z);
                for (let x = ix0; x <= ix1; ++x) {
                    const dx = x - cx, dy = y - cy, dz = z - cz;
                    data[row + x] += scale * Math.exp(-k * (dx * dx + dy * dy + dz * dz));
                }
            }
        }
    }

    return { min, voxel, nx, ny, nz, data };
};

export { readPlyLayout, splatSamples, writeDc, buildShadowGrid, PlyLayout, ShadowGrid };
