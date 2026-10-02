import { createSampler, Panorama, PanoramaSampler } from './panorama';
import { createNoise, fbm, mulberry32, Noise2, smoothstep } from './sky-noise';

// The sky generator: a dome of flat gaussians around the scene, coloured by a
// procedural sky, a panorama (jpg / png / hdr) or a single colour, plus
// optional layers in front of it for depth: a sun, 3D clouds at a real height,
// rings of distant mountains, stars, and (for panoramas) the lower half of the
// picture projected onto a flat ground.
//
// Light by default: one splat per direction on an even (Fibonacci) lattice,
// colour only (no view dependent SH), so 50k splats already make a clean sky.
// Everything is deterministic for its parameters (seeded noise).
//
// The idea of a Fibonacci-sphere splat sky comes from 3dgs_skybox_generator
// (RobLinkA, Apache-2.0); this is a new implementation.

type RGB = [number, number, number];

type SkySource = 'procedural' | 'panorama' | 'solid';
type SkyQuality = 'light' | 'balanced' | 'high' | 'ultra';

type SkyParams = {
    source: SkySource;

    // gradient
    zenith: RGB;
    horizon: RGB;
    ground: RGB;
    curve: number;          // how fast the zenith colour takes over (gamma)
    haze: number;           // brightening along the horizon, 0..1

    // sun (or moon)
    sun: boolean;
    sunAzimuth: number;     // degrees, 0 = -Z, 90 = +X
    sunElevation: number;   // degrees
    sunSize: number;        // angular diameter, degrees
    sunGlow: number;        // 0..2
    sunColor: RGB;

    // clouds
    clouds: number;         // coverage 0..1
    cloudSoftness: number;  // 0..1
    cloudScale: number;     // size of the clouds, 0.2..4
    cloudShadow: number;    // darker undersides, 0..1
    cloudColor: RGB;
    cloudSeed: number;
    cloud3d: boolean;       // a real layer at cloudHeight instead of painted on the dome
    cloudHeight: number;    // fraction of the radius
    cloudThickness: number; // fraction of the cloud height

    // stars
    stars: number;          // 0..1
    starBrightness: number; // 0..2

    // distant mountains
    mountains: number;          // ranges, 0..3
    mountainHeight: number;     // degrees above the horizon at the highest
    mountainRoughness: number;  // 0..1
    mountainColor: RGB;
    mountainHaze: number;       // 0..1, far ranges fade into the horizon
    mountainSeed: number;

    // panorama
    yaw: number;            // degrees
    exposure: number;       // EV
    groundProjection: boolean;
    eyeHeight: number;      // scene units, camera height of the panorama

    // solid colour
    color: RGB;

    // placement and budget
    quality: SkyQuality;
    upperOnly: boolean;     // skip the lower half (it's under the ground anyway)
    radius: number;         // 0 = automatic
    horizonY: number | null;    // null = automatic
};

// splats on a whole sphere at each quality; a half dome uses half as many
const QUALITY_SPLATS: Record<SkyQuality, number> = {
    light: 50000,
    balanced: 140000,
    high: 400000,
    ultra: 1000000
};

const defaultParams = (): SkyParams => ({
    source: 'procedural',
    zenith: [0.22, 0.45, 0.85],
    horizon: [0.72, 0.83, 0.95],
    ground: [0.36, 0.34, 0.31],
    curve: 0.55,
    haze: 0.3,
    sun: true,
    sunAzimuth: 140,
    sunElevation: 50,
    sunSize: 1.5,
    sunGlow: 0.5,
    sunColor: [1, 0.97, 0.9],
    clouds: 0.3,
    cloudSoftness: 0.4,
    cloudScale: 1,
    cloudShadow: 0.4,
    cloudColor: [1, 1, 1],
    cloudSeed: 1,
    cloud3d: false,
    cloudHeight: 0.2,
    cloudThickness: 0.15,
    stars: 0,
    starBrightness: 1,
    mountains: 0,
    mountainHeight: 6,
    mountainRoughness: 0.5,
    mountainColor: [0.32, 0.38, 0.42],
    mountainHaze: 0.5,
    mountainSeed: 1,
    yaw: 0,
    exposure: 0,
    groundProjection: true,
    eyeHeight: 1.6,
    color: [0.5, 0.5, 0.52],
    quality: 'light',
    upperOnly: false,
    radius: 0,
    horizonY: null
});

type SkyPreset = { id: string, name: string, params: Partial<SkyParams> };

const presets: SkyPreset[] = [{
    id: 'clear',
    name: 'Clear day',
    params: { zenith: [0.22, 0.45, 0.85], horizon: [0.72, 0.83, 0.95], ground: [0.36, 0.34, 0.31], curve: 0.55, haze: 0.3, sun: true, sunElevation: 50, sunSize: 1.5, sunGlow: 0.5, sunColor: [1, 0.97, 0.9], clouds: 0.3, cloudSoftness: 0.4, cloudShadow: 0.4, cloudColor: [1, 1, 1], stars: 0 }
}, {
    id: 'golden',
    name: 'Golden hour',
    params: { zenith: [0.3, 0.45, 0.75], horizon: [1, 0.8, 0.55], ground: [0.3, 0.25, 0.2], curve: 0.6, haze: 0.5, sun: true, sunElevation: 8, sunSize: 1.8, sunGlow: 1, sunColor: [1, 0.8, 0.5], clouds: 0.35, cloudSoftness: 0.45, cloudShadow: 0.5, cloudColor: [1, 0.9, 0.78], stars: 0 }
}, {
    id: 'sunset',
    name: 'Sunset',
    params: { zenith: [0.17, 0.2, 0.42], horizon: [1, 0.47, 0.26], ground: [0.15, 0.1, 0.1], curve: 0.5, haze: 0.6, sun: true, sunElevation: 1.5, sunSize: 2.2, sunGlow: 1.4, sunColor: [1, 0.56, 0.26], clouds: 0.4, cloudSoftness: 0.4, cloudShadow: 0.6, cloudColor: [1, 0.62, 0.46], stars: 0.15 }
}, {
    id: 'overcast',
    name: 'Overcast',
    params: { zenith: [0.6, 0.63, 0.68], horizon: [0.78, 0.8, 0.82], ground: [0.3, 0.3, 0.3], curve: 0.8, haze: 0.4, sun: false, clouds: 0.85, cloudSoftness: 0.7, cloudShadow: 0.5, cloudColor: [0.86, 0.87, 0.89], stars: 0 }
}, {
    id: 'night',
    name: 'Night',
    params: { zenith: [0.01, 0.015, 0.045], horizon: [0.05, 0.07, 0.14], ground: [0.02, 0.02, 0.03], curve: 0.5, haze: 0.2, sun: true, sunElevation: 35, sunSize: 1.2, sunGlow: 0.15, sunColor: [0.85, 0.9, 1], clouds: 0.12, cloudSoftness: 0.5, cloudShadow: 0.3, cloudColor: [0.16, 0.18, 0.24], stars: 0.7 }
}, {
    id: 'studio',
    name: 'Studio grey',
    params: { zenith: [0.33, 0.33, 0.35], horizon: [0.56, 0.56, 0.57], ground: [0.26, 0.26, 0.27], curve: 1, haze: 0, sun: false, clouds: 0, stars: 0, mountains: 0 }
}];

// ---- small vector helpers

type Vec = [number, number, number];
type Quat = [number, number, number, number];    // w x y z

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const mixRgb = (a: RGB | number[], b: RGB | number[], t: number, out: number[]) => {
    out[0] = lerp(a[0], b[0], t);
    out[1] = lerp(a[1], b[1], t);
    out[2] = lerp(a[2], b[2], t);
    return out;
};

// the rotation that turns +Z into n (unit)
const quatFromZ = (nx: number, ny: number, nz: number): Quat => {
    const w = 1 + nz;
    if (w < 1e-6) return [0, 1, 0, 0];
    const l = Math.hypot(w, ny, nx);
    return [w / l, -ny / l, nx / l, 0];
};

// the rotation whose columns are the given orthonormal axes
const quatFromBasis = (x: Vec, y: Vec, z: Vec): Quat => {
    const m00 = x[0], m10 = x[1], m20 = x[2];
    const m01 = y[0], m11 = y[1], m21 = y[2];
    const m02 = z[0], m12 = z[1], m22 = z[2];
    const trace = m00 + m11 + m22;
    if (trace > 0) {
        const s = Math.sqrt(trace + 1) * 2;
        return [0.25 * s, (m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s];
    }
    if (m00 > m11 && m00 > m22) {
        const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
        return [(m21 - m12) / s, 0.25 * s, (m01 + m10) / s, (m02 + m20) / s];
    }
    if (m11 > m22) {
        const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
        return [(m02 - m20) / s, (m01 + m10) / s, 0.25 * s, (m12 + m21) / s];
    }
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    return [(m10 - m01) / s, (m02 + m20) / s, (m12 + m21) / s, 0.25 * s];
};

const UP_QUAT = quatFromZ(0, 1, 0);

const sunDirection = (p: SkyParams): Vec => {
    const az = p.sunAzimuth * Math.PI / 180;
    const el = p.sunElevation * Math.PI / 180;
    return [Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)];
};

// ---- the procedural sky as a function of direction

type SkyModel = {
    // display colour of the dome in a direction; clouds painted on when asked
    dome: (dx: number, dy: number, dz: number, paintClouds: boolean, out: number[]) => void;
    // cloud density 0..1 and colour at plane coordinates (height 1 above the eye)
    cloud: (qx: number, qz: number, out: number[]) => number;
    // the top of mountain range i in a direction (radians above the horizon)
    ridge: (range: number, azimuth: number) => number;
    // display colour of mountain range i at an elevation (radians)
    rock: (range: number, azimuth: number, elevation: number, top: number, out: number[]) => void;
    sun: Vec;
};

const createModel = (p: SkyParams, octaves: number): SkyModel => {
    const cloudNoise = createNoise(p.cloudSeed);
    const mountainNoise: Noise2[] = [0, 1, 2].map(i => createNoise(p.mountainSeed * 31 + i * 101));
    const sun = sunDirection(p);
    const sunFlat = Math.hypot(sun[0], sun[2]) > 1e-3 ? [sun[0] / Math.hypot(sun[0], sun[2]), sun[2] / Math.hypot(sun[0], sun[2])] : [0.6, 0.8];
    const freq = 1.6 / Math.max(0.05, p.cloudScale);
    const threshold = 0.5 + (0.5 - p.clouds) * 0.62;
    const soft = 0.03 + p.cloudSoftness * 0.25;
    const hazeColor = p.horizon.map(c => Math.min(1, c * 1.08 + 0.03));
    const sunOn = p.sun && p.sunElevation > -6;
    const tmp: number[] = [0, 0, 0];

    const density = (qx: number, qz: number) => {
        if (p.clouds <= 0) return 0;
        const n = fbm(cloudNoise, qx * freq + 37.1, qz * freq + 11.3, octaves);
        return smoothstep(threshold - soft, threshold + soft, n);
    };

    const cloud = (qx: number, qz: number, out: number[]) => {
        const d = density(qx, qz);
        if (d <= 0) return 0;
        // thicker toward the sun = the side we see is in shadow
        const step = 0.12 / freq;
        const toward = density(qx + sunFlat[0] * step, qz + sunFlat[1] * step);
        const light = Math.max(0, 1 - p.cloudShadow * (0.35 + 0.65 * toward) * 0.9);
        const core = 1 - 0.25 * p.cloudShadow * d;
        const sunTint = sunOn ? p.sunGlow * 0.15 * light : 0;
        for (let c = 0; c < 3; ++c) {
            out[c] = p.cloudColor[c] * (0.5 + 0.5 * light) * core + p.sunColor[c] * sunTint;
        }
        return d;
    };

    const dome = (dx: number, dy: number, dz: number, paintClouds: boolean, out: number[]) => {
        if (dy >= 0) {
            mixRgb(p.horizon, p.zenith, Math.pow(dy, p.curve), out);
        } else {
            mixRgb(p.horizon, p.ground, smoothstep(0, 0.06, -dy), out);
        }
        const h = p.haze * Math.exp(-Math.abs(dy) * 10);
        if (h > 0) mixRgb(out, hazeColor, h, out);
        if (sunOn) {
            const cosA = Math.max(0, dx * sun[0] + dy * sun[1] + dz * sun[2]);
            const mie = p.sunGlow * (0.12 * Math.pow(cosA, 4) + 0.35 * Math.pow(cosA, 48));
            const below = dy > -0.02 ? 1 : Math.max(0, 1 + (dy + 0.02) * 30);
            for (let c = 0; c < 3; ++c) out[c] += p.sunColor[c] * mie * below;
        }
        if (paintClouds && p.clouds > 0 && dy > 0.004) {
            const k = 1 / (dy + 0.08);
            const d = cloud(dx * k, dz * k, tmp) * smoothstep(0.004, 0.12, dy);
            if (d > 0) mixRgb(out, tmp, d, out);
        }
    };

    // ranges, 0 = nearest (lowest), the last the farthest (tallest, haziest)
    const ridge = (range: number, azimuth: number) => {
        const f = 1.5 + p.mountainRoughness * 5;
        const n = fbm(mountainNoise[range], Math.cos(azimuth) * f + 5, Math.sin(azimuth) * f + 9, 5, 0.45 + p.mountainRoughness * 0.2);
        const ridged = Math.pow(n, 1.6 + p.mountainRoughness);
        const count = Math.max(1, Math.round(p.mountains));
        const tall = count === 1 ? 1 : 0.55 + 0.45 * range / (count - 1);
        return p.mountainHeight * Math.PI / 180 * tall * (0.15 + 1.5 * ridged);
    };

    const rock = (range: number, azimuth: number, elevation: number, top: number, out: number[]) => {
        const count = Math.max(1, Math.round(p.mountains));
        const far = count === 1 ? 0.5 : range / (count - 1);
        const light = sunOn ? 0.85 + 0.25 * Math.max(0, Math.sin(azimuth) * sun[0] - Math.cos(azimuth) * sun[2]) : 0.9;
        const up = 0.8 + 0.3 * (top > 0 ? Math.max(0, elevation) / top : 0);
        for (let c = 0; c < 3; ++c) out[c] = p.mountainColor[c] * light * up;
        mixRgb(out, hazeColor, Math.min(1, p.mountainHaze * (0.2 + 0.7 * far)), out);
    };

    return { dome, cloud, ridge, rock, sun };
};

// ---- output rows (PLY convention, like samples.ts: 180 degrees about Z)

const SH_C0 = 0.28209479177387814;
const FLOATS = 14;

class Rows {
    data = new Float32Array(FLOATS * 4096);
    count = 0;

    reserve(extra: number) {
        const need = (this.count + extra) * FLOATS;
        if (need > this.data.length) {
            const next = new Float32Array(Math.max(need, this.data.length * 2));
            next.set(this.data.subarray(0, this.count * FLOATS));
            this.data = next;
        }
    }

    push(x: number, y: number, z: number, color: number[], alpha: number, sx: number, sy: number, sz: number, q: Quat) {
        this.reserve(1);
        const d = this.data;
        let o = this.count * FLOATS;
        d[o++] = -x;
        d[o++] = -y;
        d[o++] = z;
        d[o++] = (color[0] - 0.5) / SH_C0;
        d[o++] = (color[1] - 0.5) / SH_C0;
        d[o++] = (color[2] - 0.5) / SH_C0;
        const a = Math.min(0.999, Math.max(0.001, alpha));
        d[o++] = Math.log(a / (1 - a));
        d[o++] = Math.log(Math.max(1e-9, sx));
        d[o++] = Math.log(Math.max(1e-9, sy));
        d[o++] = Math.log(Math.max(1e-9, sz));
        d[o++] = q[3];
        d[o++] = q[2];
        d[o++] = -q[1];
        d[o++] = -q[0];
        this.count++;
    }
}

const plyOf = (rows: Rows, comment: string) => {
    const props = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
    const header = [
        'ply',
        'format binary_little_endian 1.0',
        `comment ${comment}`,
        `element vertex ${rows.count}`,
        ...props.map(name => `property float ${name}`),
        'end_header',
        ''
    ].join('\n');
    return new Blob([header, rows.data.subarray(0, rows.count * FLOATS)], { type: 'application/ply' });
};

// ---- the generator

type SkyPlacement = { center: Vec, radius: number };

type SkyStats = { dome: number, ground: number, clouds: number, mountains: number, stars: number, sun: number, total: number };

const GOLDEN = Math.PI * (3 - Math.sqrt(5));

// even directions with y in [yMin, yMax]: Fibonacci lattice on that band
const forBand = (count: number, yMin: number, yMax: number, fn: (x: number, y: number, z: number) => void) => {
    for (let i = 0; i < count; ++i) {
        const y = yMax - (i + 0.5) / count * (yMax - yMin);
        const r = Math.sqrt(Math.max(0, 1 - y * y));
        const theta = GOLDEN * i;
        fn(Math.cos(theta) * r, y, Math.sin(theta) * r);
    }
};

const generateSky = (p: SkyParams, place: SkyPlacement, panorama: Panorama | null): { ply: Blob, stats: SkyStats } => {
    const full = QUALITY_SPLATS[p.quality];
    // angle between neighbouring splats, and the gaussian size that closes the gaps
    const spacing = Math.sqrt(4 * Math.PI / full);
    const K = 0.72;
    const [cx, cy, cz] = place.center;
    const R = place.radius;
    const rows = new Rows();
    const stats: SkyStats = { dome: 0, ground: 0, clouds: 0, mountains: 0, stars: 0, sun: 0, total: 0 };
    const color: number[] = [0, 0, 0];
    const random = mulberry32(p.cloudSeed * 97 + p.mountainSeed * 13 + 5);

    const octaves = p.quality === 'light' ? 4 : p.quality === 'balanced' ? 5 : 6;
    const model = createModel(p, octaves);
    const procedural = p.source === 'procedural';
    const sampler: PanoramaSampler | null = p.source === 'panorama' && panorama ?
        createSampler(panorama, Math.round(2 * Math.PI / spacing * 1.5), p.yaw, p.exposure) : null;
    const project = p.source === 'panorama' && p.groundProjection && p.eyeHeight > 0;

    const colorAt = (x: number, y: number, z: number, out: number[]) => {
        if (sampler) sampler(x, y, z, out);
        else if (procedural) model.dome(x, y, z, !p.cloud3d, out);
        else if (p.source === 'panorama') mixRgb(p.horizon, p.zenith, 0.5, out);
        else {
            out[0] = p.color[0];
            out[1] = p.color[1];
            out[2] = p.color[2];
        }
    };

    // ---- the dome (and the projected ground)
    const yMin = p.upperOnly ? -Math.sin(8 * Math.PI / 180) : -1;
    const domeCount = Math.round(full * (1 - yMin) / 2);
    rows.reserve(domeCount);
    forBand(domeCount, yMin, 1, (x, y, z) => {
        colorAt(x, y, z, color);
        const t = project && y < 0 ? Math.min(R, p.eyeHeight / -y) : R;
        if (t < R) {
            // on the ground plane: flat, stretched away from the eye
            const h = Math.hypot(x, z) || 1;
            const along: Vec = [x / h, 0, z / h];
            const across: Vec = [-along[2], 0, along[0]];
            const sAcross = K * spacing * t;
            const sAlong = Math.min(sAcross / Math.max(0.05, -y), sAcross * 20);
            rows.push(cx + x * t, cy + y * t, cz + z * t, color, 0.995, sAcross, sAlong, sAcross * 0.03, quatFromBasis(across, along, [0, 1, 0]));
            stats.ground++;
        } else {
            const s = K * spacing * R;
            rows.push(cx + x * R, cy + y * R, cz + z * R, color, 0.995, s, s, s * 0.03, quatFromZ(x, y, z));
            stats.dome++;
        }
    });

    if (procedural) {
        const tmp: number[] = [0, 0, 0];
        const cloudAt = (x: number, y: number, z: number) => (p.clouds > 0 && y > 0.004 ?
            model.cloud(x / (y + 0.08), z / (y + 0.08), tmp) * smoothstep(0.004, 0.12, y) : 0);

        // ---- distant mountains: walls of splats facing the eye
        const ranges = Math.round(p.mountains);
        for (let range = ranges - 1; range >= 0; --range) {
            const r = R * (ranges === 1 ? 0.6 : 0.32 + 0.5 * range / (ranges - 1));
            const columns = Math.ceil(2 * Math.PI / spacing);
            const bottom = -3 * Math.PI / 180;
            for (let i = 0; i < columns; ++i) {
                const az = (i + 0.5 * (range % 2)) / columns * 2 * Math.PI;
                const top = model.ridge(range, az);
                const hx = Math.sin(az);
                const hz = -Math.cos(az);
                const q = quatFromZ(hx, 0, hz);
                for (let el = top; el > bottom; el -= spacing) {
                    model.rock(range, az, el, top, color);
                    const s = K * spacing * r;
                    // the top row a touch smaller, for a cleaner ridge line
                    const edge = el === top ? 0.75 : 1;
                    rows.push(cx + hx * r, cy + Math.tan(el) * r - (edge < 1 ? s * 0.25 : 0), cz + hz * r, color, 0.995, s * edge, s * edge, s * 0.03, q);
                    stats.mountains++;
                }
            }
        }

        // ---- clouds as a layer at a real height: they move against the sky
        if (p.cloud3d && p.clouds > 0) {
            const H = Math.max(1e-3, p.cloudHeight) * R;
            const reach = Math.sqrt(Math.max(0, R * R - H * H)) * 0.97;
            const yLow = H / Math.hypot(H, reach);
            const count = Math.round(full * (1 - yLow) / 2);
            const thick = Math.max(0, p.cloudThickness) * H;
            forBand(count, yLow, 1, (x, y, z) => {
                const t = H / y;
                const d = model.cloud(x * t / H, z * t / H, color);
                if (d < 0.03) return;
                const puffs = d > 0.55 && thick > 0 ? 2 : 1;
                const s = K * spacing * t / Math.sqrt(Math.max(0.15, y));
                for (let k = 0; k < puffs; ++k) {
                    const lift = thick * (random() - 0.5) * d;
                    rows.push(cx + x * t, cy + H + lift, cz + z * t, color, Math.min(0.97, d * 1.25), s, s, Math.max(s * 0.05, thick * (0.25 + 0.5 * d)), UP_QUAT);
                    stats.clouds++;
                }
            });
        }

        // ---- stars, in front of the dome, hidden by clouds
        const starCount = Math.round(Math.min(1, p.stars) * 7000);
        for (let i = 0; i < starCount; ++i) {
            const y = 0.03 + random() * 0.97;
            const a = random() * 2 * Math.PI;
            const rr = Math.sqrt(1 - y * y);
            const x = Math.cos(a) * rr;
            const z = Math.sin(a) * rr;
            const b = Math.pow(random(), 3);
            const cover = p.cloud3d ? 0 : cloudAt(x, y, z);
            const alpha = (0.35 + 0.65 * b) * smoothstep(0.03, 0.25, y) * (1 - cover) * Math.min(1, p.starBrightness);
            if (alpha < 0.03) continue;
            const tint = random();
            const v = (0.7 + 0.9 * b) * Math.max(0.3, p.starBrightness);
            color[0] = v * (tint < 0.2 ? 0.8 : 1);
            color[1] = v * 0.95;
            color[2] = v * (tint > 0.8 ? 0.8 : 1);
            const d = R * 0.985;
            const s = d * 0.0011 * (0.7 + 0.8 * b);
            rows.push(cx + x * d, cy + y * d, cz + z * d, color, alpha, s, s, s * 0.05, quatFromZ(x, y, z));
            stats.stars++;
        }

        // ---- the sun (or moon): a crisp disc and two glows, dimmed by clouds
        if (p.sun && p.sunElevation > -2) {
            const [sx, sy, sz] = model.sun;
            const cover = p.cloud3d ? 0 : cloudAt(sx, sy, sz);
            const size = p.sunSize * Math.PI / 180;
            const q = quatFromZ(sx, sy, sz);
            const layers: [number, number, number, number][] = [
                // distance, sigma (x angular diameter), alpha, brightness
                [0.975, 2.6, 0.12 * p.sunGlow, 1],
                [0.972, 1.0, 0.3 * p.sunGlow, 1.1],
                [0.97, 0.32, 1, 1.6]
            ];
            layers.forEach(([dist, sigma, alpha, bright]) => {
                const a = alpha * (1 - 0.85 * cover);
                if (a < 0.01) return;
                const d = R * dist;
                const s = d * size * sigma;
                for (let c = 0; c < 3; ++c) color[c] = p.sunColor[c] * bright;
                rows.push(cx + sx * d, cy + sy * d, cz + sz * d, color, a, s, s, s * 0.03, q);
                stats.sun++;
            });
        }
    }

    stats.total = rows.count;
    return { ply: plyOf(rows, 'Generated by SuperSplat toolkit sky'), stats };
};

// a rough splat count before generating (clouds and mountains depend on the noise)
const estimateSplats = (p: SkyParams) => {
    const full = QUALITY_SPLATS[p.quality];
    const spacing = Math.sqrt(4 * Math.PI / full);
    let n = full * (p.upperOnly ? (1 + Math.sin(8 * Math.PI / 180)) / 2 : 1);
    if (p.source === 'procedural') {
        if (p.cloud3d) n += full * 0.45 * Math.min(1, p.clouds * 1.3) * 1.3;
        const ranges = Math.round(p.mountains);
        n += ranges * (2 * Math.PI / spacing) * ((p.mountainHeight * 0.6 + 3) * Math.PI / 180 / spacing);
        n += Math.min(1, p.stars) * 6000;
    }
    return Math.round(n);
};

// ---- preview: the sky as an equirectangular picture (what the dome will show)

const renderPreview = (p: SkyParams, panorama: Panorama | null, width: number, height: number, out: Uint8ClampedArray) => {
    const model = createModel(p, 4);
    const sampler = p.source === 'panorama' && panorama ? createSampler(panorama, width, p.yaw, p.exposure) : null;
    const color: number[] = [0, 0, 0];
    const ranges = p.source === 'procedural' ? Math.round(p.mountains) : 0;
    const sunCos = Math.cos(p.sunSize * Math.PI / 180 * 0.5);
    for (let j = 0; j < height; ++j) {
        const el = (0.5 - (j + 0.5) / height) * Math.PI;
        const dy = Math.sin(el);
        const cr = Math.cos(el);
        for (let i = 0; i < width; ++i) {
            const az = ((i + 0.5) / width - 0.5) * 2 * Math.PI;
            const dx = Math.sin(az) * cr;
            const dz = -Math.cos(az) * cr;
            if (sampler) {
                sampler(dx, dy, dz, color);
            } else if (p.source === 'procedural') {
                model.dome(dx, dy, dz, true, color);
                if (p.sun && p.sunElevation > -2) {
                    const c = dx * model.sun[0] + dy * model.sun[1] + dz * model.sun[2];
                    if (c > sunCos) {
                        for (let k = 0; k < 3; ++k) color[k] = p.sunColor[k] * 1.4;
                    }
                }
                // nearest range in front
                const azm = (az + 2 * Math.PI) % (2 * Math.PI);
                for (let range = 0; range < ranges; ++range) {
                    const top = model.ridge(range, azm);
                    if (el < top && el > -0.05) {
                        model.rock(range, azm, el, top, color);
                        break;
                    }
                }
            } else {
                color[0] = p.color[0];
                color[1] = p.color[1];
                color[2] = p.color[2];
            }
            const o = (j * width + i) * 4;
            out[o] = color[0] * 255;
            out[o + 1] = color[1] * 255;
            out[o + 2] = color[2] * 255;
            out[o + 3] = 255;
        }
    }
};

export {
    generateSky,
    estimateSplats,
    renderPreview,
    defaultParams,
    presets,
    QUALITY_SPLATS,
    SkyParams,
    SkyPreset,
    SkyQuality,
    SkySource,
    SkyStats,
    SkyPlacement,
    RGB
};
