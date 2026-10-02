// Small seeded noise for the procedural sky: 2D gradient noise, fBm on top of
// it, and a tiny PRNG. Everything is deterministic for a seed, so a sky can be
// regenerated (or re-loaded with a project) exactly.

const mulberry32 = (seed: number) => {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
};

type Noise2 = (x: number, y: number) => number;

// gradient noise in -1..1 (roughly), on a 256 lattice that wraps
const createNoise = (seed: number): Noise2 => {
    const random = mulberry32(seed * 7919 + 17);
    const perm = new Uint8Array(512);
    const p = Array.from({ length: 256 }, (_, i) => i);
    for (let i = 255; i > 0; --i) {
        const j = Math.floor(random() * (i + 1));
        [p[i], p[j]] = [p[j], p[i]];
    }
    for (let i = 0; i < 512; ++i) perm[i] = p[i & 255];
    const gx = new Float32Array(256);
    const gy = new Float32Array(256);
    for (let i = 0; i < 256; ++i) {
        const a = random() * Math.PI * 2;
        gx[i] = Math.cos(a);
        gy[i] = Math.sin(a);
    }
    const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

    return (x: number, y: number) => {
        const xf = Math.floor(x);
        const yf = Math.floor(y);
        const xi = xf & 255;
        const yi = yf & 255;
        const dx = x - xf;
        const dy = y - yf;
        const g = (ix: number, iy: number, ox: number, oy: number) => {
            const h = perm[perm[ix] + iy];
            return gx[h] * ox + gy[h] * oy;
        };
        const n00 = g(xi, yi, dx, dy);
        const n10 = g(xi + 1, yi, dx - 1, dy);
        const n01 = g(xi, yi + 1, dx, dy - 1);
        const n11 = g(xi + 1, yi + 1, dx - 1, dy - 1);
        const u = fade(dx);
        const v = fade(dy);
        const a = n00 + u * (n10 - n00);
        const b = n01 + u * (n11 - n01);
        return (a + v * (b - a)) * 1.414;
    };
};

// fractal sum, mapped to 0..1
const fbm = (noise: Noise2, x: number, y: number, octaves: number, gain = 0.5) => {
    let sum = 0;
    let amp = 0.5;
    let norm = 0;
    let fx = x;
    let fy = y;
    for (let o = 0; o < octaves; ++o) {
        sum += amp * noise(fx, fy);
        norm += amp;
        amp *= gain;
        // rotate a little each octave so lattice lines don't stack up
        const nx = fx * 1.6 + fy * 1.2;
        fy = -fx * 1.2 + fy * 1.6;
        fx = nx + 13.7;
    }
    return Math.min(1, Math.max(0, 0.5 + 0.5 * sum / norm * 1.6));
};

const smoothstep = (a: number, b: number, x: number) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
};

export { mulberry32, createNoise, fbm, smoothstep, Noise2 };
