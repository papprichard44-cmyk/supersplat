import { buildShadowScene } from './bvh';
import { S_ALBEDO, S_ALPHA, S_LAYER, S_LIGHTMASK, S_METAL, S_NORMAL, S_OCCLUDER, S_POS, S_ROUGH, S_TWO_SIDED, STRIDE, SampleBuffer, SplatColors, restCount } from './samples';
import { KernelResult, KernelScene, shadeKernel } from './shade-kernel';
import { LT_POINT, LT_RECT, LT_RING, LT_SPOT, LT_SUN } from './shading';
import type { Occluder } from '../primitive-to-splat';

// Runs the bake (shade-kernel.ts) over all samples on a pool of web workers,
// one per spare CPU core, reporting progress and allowing cancellation.

// floats per light in the bake (a superset of the preview layout, see shading.ts):
//  0..23 as the preview, 21 specular radius, 22..24 right vector, 25 grid points
const BAKE_LIGHT_FLOATS = 32;
const GRID = 4;

// a studio light as the bake and the preview see it
type LightParams = {
    type: number;
    position: [number, number, number];
    forward: [number, number, number];     // unit, the direction the light points
    up: [number, number, number];          // unit, perpendicular to forward
    width: number;                         // emitter width / diameter
    height: number;                        // rect only
    color: [number, number, number];       // linear colour x intensity
    castShadows: boolean;
    cosOuter: number;                      // spot cone
    cosInner: number;
    exponent: number;                      // emitter falloff (grid / honeycomb tightness)
    sunAngle: number;                      // sun angular radius, radians
    ringInner: number;                     // ring light inner radius ratio
};

type BakeSettings = {
    degree: number;                        // SH degree of the result, 0..3
    shadowSamples: number;                 // rays per light and sample, 0 = no shadows
    aoSamples: number;                     // ambient occlusion rays, 0 = off
    exposure: number;                      // linear multiplier
    tonemap: number;                       // TONEMAP_*
    sky: [number, number, number];         // ambient from above, linear
    ground: [number, number, number];      // ambient from below, linear
    sceneSize: number;                     // diagonal of everything that is baked
    cell: number;                          // typical spacing between samples
    // relight existing splats: share of their own light that is kept
    splatBase?: number;
    // splat layers casting shadows (density grids, see splat-relight.ts)
    grids?: KernelScene['grids'];
};

const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = (a: number[]) => {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
};

// pack a light into the preview layout (LIGHT_FLOATS) or the bake layout
const packLight = (light: LightParams, out: Float32Array, offset: number, bake: boolean) => {
    const f = normalize(light.forward);
    const right = normalize(cross(f, light.up));
    const up = cross(right, f);
    out.set([
        light.position[0], light.position[1], light.position[2], light.type,
        f[0], f[1], f[2], light.width,
        up[0], up[1], up[2], light.height,
        light.color[0], light.color[1], light.color[2], light.castShadows ? 1 : 0,
        light.cosOuter, light.cosInner, light.exponent, light.sunAngle,
        light.ringInner, 0, 0, 0
    ], offset);
    if (bake) {
        const radius = light.type === LT_RECT ? Math.sqrt(light.width * light.height) * 0.5 : light.width * 0.5;
        out[offset + 21] = radius;
        out[offset + 22] = right[0];
        out[offset + 23] = right[1];
        out[offset + 24] = right[2];
        out[offset + 25] = light.type === LT_SUN ? 0 : (light.type === LT_POINT || light.type === LT_SPOT ? 1 : GRID * GRID);
    }
};

// emitter grid points, matching emitterPoint() in the kernel
const gridPoints = (light: LightParams, out: Float32Array, offset: number) => {
    const f = normalize(light.forward);
    const right = normalize(cross(f, light.up));
    const up = cross(right, f);
    const p = light.position;
    if (light.type === LT_POINT || light.type === LT_SPOT || light.type === LT_SUN) {
        out.set(p, offset);
        return;
    }
    let k = 0;
    for (let j = 0; j < GRID; ++j) {
        for (let i = 0; i < GRID; ++i) {
            const u = (i + 0.5) / GRID * 2 - 1;
            const v = (j + 0.5) / GRID * 2 - 1;
            let a: number, b: number;
            if (light.type === LT_RECT) {
                a = u * light.width * 0.5;
                b = v * light.height * 0.5;
            } else {
                const ang = Math.atan2(v, u);
                const r = Math.max(Math.abs(u), Math.abs(v));
                const inner = light.type === LT_RING ? light.ringInner : 0;
                const rr = (inner + (1 - inner) * r) * light.width * 0.5;
                a = Math.cos(ang) * rr;
                b = Math.sin(ang) * rr;
            }
            out[offset + k * 3] = p[0] + right[0] * a + up[0] * b;
            out[offset + k * 3 + 1] = p[1] + right[1] * a + up[1] * b;
            out[offset + k * 3 + 2] = p[2] + right[2] * a + up[2] * b;
            k++;
        }
    }
};

// the renderer's SH basis, see shade-kernel.ts
const evalBasis = (x: number, y: number, z: number, out: Float64Array) => {
    const xx = x * x, yy = y * y, zz = z * z, xy = x * y, yz = y * z, xz = x * z;
    out[0] = 0.28209479177387814;
    out[1] = -0.4886025119029199 * y;
    out[2] = 0.4886025119029199 * z;
    out[3] = -0.4886025119029199 * x;
    out[4] = 1.0925484305920792 * xy;
    out[5] = -1.0925484305920792 * yz;
    out[6] = 0.31539156525252005 * (2 * zz - xx - yy);
    out[7] = -1.0925484305920792 * xz;
    out[8] = 0.5462742152960396 * (xx - yy);
    out[9] = -0.5900435899266435 * y * (3 * xx - yy);
    out[10] = 2.890611442640554 * xy * z;
    out[11] = -0.4570457994644658 * y * (4 * zz - xx - yy);
    out[12] = 0.3731763325901154 * z * (2 * zz - 3 * xx - 3 * yy);
    out[13] = -0.4570457994644658 * x * (4 * zz - xx - yy);
    out[14] = 1.445305721320277 * z * (xx - yy);
    out[15] = -0.5900435899266435 * x * (xx - 3 * yy);
};

// evenly spread directions on the sphere
const fibonacciDirections = (count: number) => {
    const dirs = new Float32Array(count * 3);
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < count; ++i) {
        const y = 1 - (i + 0.5) / count * 2;
        const r = Math.sqrt(1 - y * y);
        const a = golden * i;
        dirs[i * 3] = Math.cos(a) * r;
        dirs[i * 3 + 1] = y;
        dirs[i * 3 + 2] = Math.sin(a) * r;
    }
    return dirs;
};

// least-squares projection matrix (A^T A)^-1 A^T for the first n basis functions
const fitMatrix = (dirs: Float32Array, n: number) => {
    const K = dirs.length / 3;
    const b = new Float64Array(16);
    const A = new Float64Array(K * n);
    for (let k = 0; k < K; ++k) {
        evalBasis(dirs[k * 3], dirs[k * 3 + 1], dirs[k * 3 + 2], b);
        for (let i = 0; i < n; ++i) A[k * n + i] = b[i];
    }
    // normal matrix and its inverse (Gauss-Jordan)
    const M = new Float64Array(n * n * 2);
    const w = n * 2;
    for (let i = 0; i < n; ++i) {
        for (let j = 0; j < n; ++j) {
            let s = 0;
            for (let k = 0; k < K; ++k) s += A[k * n + i] * A[k * n + j];
            M[i * w + j] = s;
        }
        M[i * w + n + i] = 1;
    }
    for (let c = 0; c < n; ++c) {
        let pivot = c;
        for (let r = c + 1; r < n; ++r) {
            if (Math.abs(M[r * w + c]) > Math.abs(M[pivot * w + c])) pivot = r;
        }
        if (pivot !== c) {
            for (let j = 0; j < w; ++j) {
                const t = M[c * w + j];
                M[c * w + j] = M[pivot * w + j];
                M[pivot * w + j] = t;
            }
        }
        const d = M[c * w + c];
        for (let j = 0; j < w; ++j) M[c * w + j] /= d;
        for (let r = 0; r < n; ++r) {
            if (r === c) continue;
            const f = M[r * w + c];
            if (f === 0) continue;
            for (let j = 0; j < w; ++j) M[r * w + j] -= f * M[c * w + j];
        }
    }
    const fit = new Float32Array(n * K);
    for (let i = 0; i < n; ++i) {
        for (let k = 0; k < K; ++k) {
            let s = 0;
            for (let j = 0; j < n; ++j) s += M[i * w + n + j] * A[k * n + j];
            fit[i * K + k] = s;
        }
    }
    return fit;
};

const directionCount = [32, 32, 48, 72];

const CHUNK = 8192;

class BakeCancelled extends Error {
    constructor() {
        super('cancelled');
    }
}

type BakeProgress = (fraction: number) => void;

type BakeControl = { cancelled: boolean };

const workerSource = () => `
const shadeKernel = ${shadeKernel.toString()};
let scene = null;
self.onmessage = (event) => {
    const message = event.data;
    if (message.type === 'init') {
        scene = message.scene;
        return;
    }
    const result = shadeKernel(scene, message.job);
    self.postMessage({ id: message.id, result }, [result.dc.buffer, result.rest.buffer]);
};
`;

// everything the kernel needs besides the samples
const createKernelScene = (occluders: Occluder[], lights: LightParams[], settings: BakeSettings): KernelScene => {
    const degree = Math.max(0, Math.min(3, settings.degree));
    const needCasters = (settings.shadowSamples > 0 && lights.some(l => l.castShadows)) || settings.aoSamples > 0;
    if (!needCasters) settings = { ...settings, grids: [] };
    const shadow = buildShadowScene(needCasters ? occluders : []);

    const packed = new Float32Array(Math.max(1, lights.length) * BAKE_LIGHT_FLOATS);
    const grid = new Float32Array(Math.max(1, lights.length) * GRID * GRID * 3);
    lights.forEach((light, i) => {
        packLight(light, packed, i * BAKE_LIGHT_FLOATS, true);
        gridPoints(light, grid, i * GRID * GRID * 3);
    });

    const dirs = fibonacciDirections(directionCount[degree]);
    return {
        layout: {
            stride: STRIDE,
            pos: S_POS,
            albedo: S_ALBEDO,
            alpha: S_ALPHA,
            normal: S_NORMAL,
            rough: S_ROUGH,
            metal: S_METAL,
            twoSided: S_TWO_SIDED,
            occluder: S_OCCLUDER,
            mask: S_LIGHTMASK,
            layer: S_LAYER
        },
        ...shadow,
        lights: packed,
        grid,
        numLights: lights.length,
        exposure: settings.exposure,
        tonemap: settings.tonemap,
        grids: settings.grids ?? [],
        splatMode: settings.splatBase !== undefined,
        splatBase: settings.splatBase ?? 1,
        sky: settings.sky,
        ground: settings.ground,
        degree,
        shadowSamples: settings.shadowSamples,
        aoSamples: settings.aoSamples,
        aoRange: settings.sceneSize * 0.25,
        eps: Math.max(settings.sceneSize * 2e-4, settings.cell * 0.25),
        dirs,
        fit: fitMatrix(dirs, (degree + 1) * (degree + 1)),
        K: dirs.length / 3
    };
};

const bakeSamples = async (
    samples: SampleBuffer,
    occluders: Occluder[],
    lights: LightParams[],
    settings: BakeSettings,
    onProgress: BakeProgress,
    control: BakeControl
): Promise<SplatColors> => {
    const count = samples.count;
    const degree = Math.max(0, Math.min(3, settings.degree));
    const nRest = restCount(degree);
    const scene = createKernelScene(occluders, lights, settings);

    const dc = new Float32Array(count * 3);
    const rest = nRest > 0 ? new Float32Array(count * nRest * 3) : null;
    const store = (start: number, n: number, result: KernelResult) => {
        dc.set(result.dc, start * 3);
        if (rest) rest.set(result.rest, start * nRest * 3);
    };

    const chunks: { start: number, n: number }[] = [];
    for (let start = 0; start < count; start += CHUNK) {
        chunks.push({ start, n: Math.min(CHUNK, count - start) });
    }
    let done = 0;
    const report = () => onProgress(count ? done / count : 1);

    const makeJob = (chunk: { start: number, n: number }) => ({
        samples: samples.data.slice(chunk.start * STRIDE, (chunk.start + chunk.n) * STRIDE),
        count: chunk.n,
        base: chunk.start
    });

    // the pool
    let workers: Worker[] = [];
    let url: string | null = null;
    try {
        url = URL.createObjectURL(new Blob([workerSource()], { type: 'text/javascript' }));
        const size = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1, chunks.length));
        for (let i = 0; i < size; ++i) {
            const worker = new Worker(url);
            worker.postMessage({ type: 'init', scene });
            workers.push(worker);
        }
    } catch (error) {
        console.warn('toolkit: bake workers unavailable, baking on the main thread', error);
        workers.forEach(w => w.terminate());
        workers = [];
    }

    try {
        if (workers.length === 0) {
            // fallback: same kernel, in slices with a breather for the ui
            for (const chunk of chunks) {
                if (control.cancelled) throw new BakeCancelled();
                store(chunk.start, chunk.n, shadeKernel(scene, makeJob(chunk)));
                done += chunk.n;
                report();
                await new Promise((resolve) => {
                    setTimeout(resolve, 0);
                });
            }
        } else {
            await new Promise<void>((resolve, reject) => {
                let next = 0;
                let active = 0;
                let failed = false;
                const cancelTimer = window.setInterval(() => {
                    if (control.cancelled && !failed) {
                        failed = true;
                        window.clearInterval(cancelTimer);
                        reject(new BakeCancelled());
                    }
                }, 100);
                const dispatch = (worker: Worker) => {
                    if (failed) return;
                    if (next >= chunks.length) {
                        if (active === 0) {
                            window.clearInterval(cancelTimer);
                            resolve();
                        }
                        return;
                    }
                    const id = next++;
                    active++;
                    const job = makeJob(chunks[id]);
                    worker.postMessage({ type: 'job', id, job }, [job.samples.buffer]);
                };
                workers.forEach((worker) => {
                    worker.onmessage = (event: MessageEvent) => {
                        const { id, result } = event.data;
                        const chunk = chunks[id];
                        store(chunk.start, chunk.n, result);
                        done += chunk.n;
                        active--;
                        report();
                        dispatch(worker);
                    };
                    worker.onerror = (event: ErrorEvent) => {
                        if (failed) return;
                        failed = true;
                        window.clearInterval(cancelTimer);
                        reject(new Error(`Lighting bake failed: ${event.message}`));
                    };
                    dispatch(worker);
                });
            });
        }
    } finally {
        workers.forEach(w => w.terminate());
        if (url) URL.revokeObjectURL(url);
    }

    return { dc, rest, degree };
};

export { bakeSamples, createKernelScene, packLight, BakeCancelled, BakeSettings, BakeControl, LightParams, BAKE_LIGHT_FLOATS };
