import type { PaverPattern, RoadParams, RoadStyle } from './road-params';
import { blurWrap, heightFromPicture } from '../height-map';

// Procedural, tileable textures for the road styles. A main texture tiles in
// world units along and across the road (so stones keep their size whatever
// the road's width), and a strip texture runs along the edges: the ragged
// rim of a dirt trail (with alpha), or the border row of stones. Everything
// is seeded, so a road always gets the same texture for the same settings.

const SIZE = 512;
const STRIP = 128;

type Rgb = [number, number, number];

// ---- tileable noise

const hash = (x: number, y: number, seed: number) => {
    let h = (x * 374761393 + y * 668265263 + seed * 2246822519) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
};

// value noise on a lattice that wraps every `period` cells
const noise = (x: number, y: number, period: number, seed: number) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const fx = x - xi;
    const fy = y - yi;
    const w = (v: number) => ((v % period) + period) % period;
    const a = hash(w(xi), w(yi), seed);
    const b = hash(w(xi + 1), w(yi), seed);
    const c = hash(w(xi), w(yi + 1), seed);
    const d = hash(w(xi + 1), w(yi + 1), seed);
    const u = fx * fx * (3 - 2 * fx);
    const v = fy * fy * (3 - 2 * fy);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
};

// fractal sum over a tile: (x, y) in 0..1, `base` cells across at the coarsest
const fbm = (x: number, y: number, base: number, octaves: number, seed: number) => {
    let sum = 0;
    let amp = 0.5;
    let norm = 0;
    let period = base;
    for (let o = 0; o < octaves; ++o) {
        sum += amp * noise(x * period, y * period, period, seed + o * 31);
        norm += amp;
        amp *= 0.5;
        period *= 2;
    }
    return sum / norm;
};

const smoothstep = (a: number, b: number, x: number) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
};

const mix = (a: Rgb, b: Rgb, t: number, out: number[]) => {
    out[0] = a[0] + (b[0] - a[0]) * t;
    out[1] = a[1] + (b[1] - a[1]) * t;
    out[2] = a[2] + (b[2] - a[2]) * t;
    return out;
};

const scale = (out: number[], k: number) => {
    out[0] *= k;
    out[1] *= k;
    out[2] *= k;
    return out;
};

// ---- the styles: colour (and alpha) at a point of a tile

type Look = { tint: Rgb, colorVariation: number, wear: number, moss: number, seed: number, pattern: PaverPattern };

// stains and dust over everything, more with wear
const applyWear = (x: number, y: number, look: Look, out: number[], dust: Rgb) => {
    if (look.wear <= 0) return;
    const n = fbm(x, y, 3, 4, look.seed + 900);
    const damp = smoothstep(0.55, 0.78, n) * look.wear * 0.3;
    scale(out, 1 - damp);
    const d = fbm(x, y, 5, 3, look.seed + 700);
    mix(out as Rgb, dust, smoothstep(0.5, 0.8, d) * look.wear * 0.35, out);
};

const mossIn = (x: number, y: number, look: Look, out: number[]) => {
    if (look.moss <= 0) return false;
    const n = fbm(x, y, 12, 3, look.seed + 500);
    if (n < 1 - look.moss * 0.9) return false;
    const k = 0.7 + 0.5 * noise(x * 90, y * 90, 90, look.seed + 501);
    out[0] = 0.24 * k;
    out[1] = 0.33 * k;
    out[2] = 0.11 * k;
    return true;
};

const dirt = (x: number, y: number, look: Look, out: number[]) => {
    const light: Rgb = [0.47, 0.37, 0.27];
    const dark: Rgb = [0.3, 0.23, 0.16];
    const n = fbm(x, y, 4, 5, look.seed);
    mix(dark, light, 0.5 + (n - 0.5) * (0.6 + 1.6 * look.colorVariation), out);
    scale(out, 0.9 + 0.2 * noise(x * 160, y * 160, 160, look.seed + 3));
    out[3] = 0.2 + 0.4 * n + 0.08 * noise(x * 90, y * 90, 90, look.seed + 4);
    // pebbles: a few per cell of a 22-cell grid
    const cells = 22;
    const cx = Math.floor(x * cells);
    const cy = Math.floor(y * cells);
    for (let j = -1; j <= 1; ++j) {
        for (let i = -1; i <= 1; ++i) {
            const gx = ((cx + i) % cells + cells) % cells;
            const gy = ((cy + j) % cells + cells) % cells;
            if (hash(gx, gy, look.seed + 11) > 0.45) continue;
            const px = (cx + i + 0.2 + 0.6 * hash(gx, gy, look.seed + 12)) / cells;
            const py = (cy + j + 0.2 + 0.6 * hash(gx, gy, look.seed + 13)) / cells;
            const r = (0.12 + 0.25 * hash(gx, gy, look.seed + 14)) / cells;
            const dx = x - px;
            const dy = y - py;
            const d = Math.hypot(dx, dy) / r;
            if (d < 1) {
                const tone = 0.75 + 0.45 * hash(gx, gy, look.seed + 15) * (0.4 + look.colorVariation);
                const lit = 1 + 0.25 * (-dx - dy) / r * (1 - d);
                out[0] = 0.55 * tone * lit;
                out[1] = 0.5 * tone * lit;
                out[2] = 0.44 * tone * lit;
                out[3] = Math.max(out[3], 0.5 + 0.5 * Math.sqrt(1 - d * d));
                if (d > 0.82) scale(out, 0.7);
            }
        }
    }
    applyWear(x, y, look, out, [0.36, 0.28, 0.2]);
};

const stonePalette: Rgb[] = [[0.52, 0.5, 0.47], [0.44, 0.42, 0.4], [0.58, 0.54, 0.48], [0.4, 0.38, 0.37], [0.5, 0.45, 0.4]];

const cobble = (x: number, y: number, look: Look, out: number[]) => {
    // Voronoi setts, 6 per tile, a little stretched into rows
    const n = 6;
    const px = x * n;
    const py = y * n * 1.15;
    const rows = Math.round(n * 1.15);
    const cx = Math.floor(px);
    const cy = Math.floor(py);
    let d1 = Infinity;
    let d2 = Infinity;
    let id = 0;
    let ox = 0;
    let oy = 0;
    for (let j = -2; j <= 2; ++j) {
        for (let i = -2; i <= 2; ++i) {
            const gx = ((cx + i) % n + n) % n;
            const gy = ((cy + j) % rows + rows) % rows;
            const sx = cx + i + 0.5 + 0.7 * (hash(gx, gy, look.seed + 21) - 0.5);
            const sy = cy + j + 0.5 + 0.55 * (hash(gx, gy, look.seed + 22) - 0.5);
            const d = Math.hypot(px - sx, py - sy);
            if (d < d1) {
                d2 = d1;
                d1 = d;
                id = gy * n + gx;
                ox = px - sx;
                oy = py - sy;
            } else if (d < d2) {
                d2 = d;
            }
        }
    }
    const edge = (d2 - d1) * 0.5;
    const joint = 0.06;
    if (edge < joint) {
        if (!mossIn(x, y, look, out)) {
            const k = 0.8 + 0.4 * noise(x * 200, y * 200, 200, look.seed + 23);
            out[0] = 0.21 * k;
            out[1] = 0.19 * k;
            out[2] = 0.17 * k;
        }
        out[3] = 0.04 + 0.1 * edge / joint;
        return;
    }
    const base = stonePalette[Math.floor(hash(id, 1, look.seed + 24) * stonePalette.length)];
    const v = 1 + (hash(id, 2, look.seed + 25) - 0.5) * 0.5 * look.colorVariation;
    out[0] = base[0] * v;
    out[1] = base[1] * v;
    out[2] = base[2] * v;
    // domed: darker toward the joints, lit from the top left
    const dome = 0.72 + 0.32 * smoothstep(joint, 0.32, edge);
    // rounded tops, some setts sitting higher than others
    out[3] = 0.25 + 0.6 * Math.sqrt(smoothstep(joint, 0.34, edge)) + 0.15 * hash(id, 7, look.seed + 27) + 0.04 * (noise(x * 150, y * 150, 150, look.seed + 28) - 0.5);
    const lit = 1 + 0.12 * (-ox - oy);
    scale(out, dome * lit * (0.92 + 0.16 * noise(x * 220, y * 220, 220, look.seed + 26)));
    applyWear(x, y, look, out, [0.5, 0.45, 0.38]);
};

// a paver pattern: distance to the nearest joint, and which paver
const paverAt = (x: number, y: number, pattern: PaverPattern): { edge: number, id: number } => {
    if (pattern === 'slabs') {
        const L = 0.5;
        const fx = x % L;
        const fy = y % L;
        return { edge: Math.min(fx, L - fx, fy, L - fy), id: Math.floor(x / L) + 7 * Math.floor(y / L) };
    }
    const L = 0.25;
    if (pattern === 'basket') {
        const bx = Math.floor(x / L);
        const by = Math.floor(y / L);
        const fx = x - bx * L;
        const fy = y - by * L;
        if ((bx + by) % 2 === 0) {
            const sub = Math.floor(fy / (L / 2));
            const f = fy - sub * L / 2;
            return { edge: Math.min(fx, L - fx, f, L / 2 - f), id: (bx * 8 + by) * 2 + sub };
        }
        const sub = Math.floor(fx / (L / 2));
        const f = fx - sub * L / 2;
        return { edge: Math.min(f, L / 2 - f, fy, L - fy), id: (bx * 8 + by) * 2 + sub };
    }
    // running bond: rows half a paver high, every other row offset by half
    const row = Math.floor(y / (L / 2));
    const off = (row % 2) * L / 2;
    const xx = (x + off) % 1;
    const col = Math.floor(xx / L);
    const fx = xx - col * L;
    const fy = y - row * L / 2;
    return { edge: Math.min(fx, L - fx, fy, L / 2 - fy), id: row * 5 + col };
};

const pavers = (x: number, y: number, look: Look, out: number[]) => {
    const { edge, id } = paverAt(x, y, look.pattern);
    const joint = 0.005;
    if (edge < joint) {
        if (!mossIn(x, y, look, out)) {
            out[0] = 0.4;
            out[1] = 0.38;
            out[2] = 0.34;
        }
        out[3] = 0.1;
        return;
    }
    const v = 1 + (hash(id, 3, look.seed + 31) - 0.5) * 0.3 * look.colorVariation;
    const warm = (hash(id, 4, look.seed + 32) - 0.5) * 0.04 * look.colorVariation;
    out[0] = (0.55 + warm) * v;
    out[1] = 0.55 * v;
    out[2] = (0.54 - warm) * v;
    out[3] = 0.72 + 0.22 * smoothstep(joint, joint * 3, edge) - 0.06 * hash(id, 6, look.seed + 34);
    // a chamfer at the edges, and the speckle of the aggregate
    scale(out, (0.8 + 0.2 * smoothstep(joint, joint * 3, edge)) * (0.94 + 0.12 * noise(x * 300, y * 300, 300, look.seed + 33)));
    applyWear(x, y, look, out, [0.48, 0.45, 0.4]);
};

const concrete = (x: number, y: number, look: Look, out: number[], joints = true) => {
    const n = fbm(x, y, 3, 5, look.seed + 41);
    const v = 1 + (n - 0.5) * 0.25 * (0.3 + look.colorVariation);
    out[0] = 0.68 * v;
    out[1] = 0.67 * v;
    out[2] = 0.64 * v;
    // broomed: fine streaks across the walk
    scale(out, 0.96 + 0.08 * noise(x * 12, y * 260, 12, look.seed + 42) + 0.04 * noise(x * 300, y * 300, 300, look.seed + 43));
    out[3] = 0.7 + 0.08 * (n - 0.5);
    if (joints) {
        const e = Math.min(y, 1 - y);
        if (e < 0.004) {
            scale(out, 0.45);
            out[3] = 0.1;
        } else if (e < 0.014) {
            scale(out, 0.92);
            out[3] -= 0.12 * (1 - (e - 0.004) / 0.01);
        }
    }
    applyWear(x, y, look, out, [0.5, 0.48, 0.44]);
};

const mainColor: Record<Exclude<RoadStyle, 'custom'>, (x: number, y: number, look: Look, out: number[]) => void> = { dirt, cobble, pavers, concrete };

// ---- textures

type Pixels = { width: number, height: number, data: Uint8ClampedArray };

// colour (and alpha) per pixel; out[3] is the height (0 deep .. 1 high),
// kept in `heights`
const render = (width: number, height: number, fn: (x: number, y: number, out: number[]) => number) => {
    const data = new Uint8ClampedArray(width * height * 4);
    const heights = new Float32Array(width * height);
    const c = [0, 0, 0, 0.5];
    for (let j = 0; j < height; ++j) {
        for (let i = 0; i < width; ++i) {
            c[3] = 0.5;
            const alpha = fn((i + 0.5) / width, (j + 0.5) / height, c);
            heights[j * width + i] = c[3];
            const o = (j * width + i) * 4;
            data[o] = c[0] * 255;
            data[o + 1] = c[1] * 255;
            data[o + 2] = c[2] * 255;
            data[o + 3] = alpha * 255;
        }
    }
    return { width, height, data, heights };
};

const toCanvas = (p: Pixels) => {
    const canvas = document.createElement('canvas');
    canvas.width = p.width;
    canvas.height = p.height;
    canvas.getContext('2d').putImageData(new ImageData(p.data as Uint8ClampedArray<ArrayBuffer>, p.width, p.height), 0, 0);
    return canvas;
};

const toPng = async (p: Pixels): Promise<Uint8Array> => {
    const blob = await new Promise<Blob>((resolve) => {
        toCanvas(p).toBlob(resolve, 'image/png');
    });
    return new Uint8Array(await blob.arrayBuffer());
};

// ---- a picture of the user's own: made seamless, and a height map from it

const loadPicture = async (url: string, size: number) => {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext('2d');
    context.imageSmoothingQuality = 'high';
    context.drawImage(image, 0, 0, size, size);
    return context.getImageData(0, 0, size, size).data;
};

// blend the edges with the picture shifted by half a tile: the edges then
// continue into each other and the tile repeats without seams
const makeSeamless = (rgba: Uint8ClampedArray, size: number) => {
    const out = new Uint8ClampedArray(rgba.length);
    const half = size >> 1;
    for (let y = 0; y < size; ++y) {
        for (let x = 0; x < size; ++x) {
            const fx = Math.abs((x + 0.5) / size - 0.5);
            const fy = Math.abs((y + 0.5) / size - 0.5);
            const m = smoothstep(0.3, 0.5, Math.max(fx, fy));
            const o = (y * size + x) * 4;
            const q = (((y + half) % size) * size + (x + half) % size) * 4;
            for (let c = 0; c < 4; ++c) out[o + c] = rgba[o + c] * (1 - m) + rgba[q + c] * m;
        }
    }
    return out;
};

// a quick hash of a long string (a picture's data url), for the cache key
const textHash = (text: string) => {
    let h = 2166136261;
    for (let i = 0; i < text.length; i += 7) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
    return `${text.length}:${h >>> 0}`;
};

type RoadTextures = {
    main: Uint8Array;
    // the main texture's height map (SIZE x SIZE, 0 deep .. 1 high)
    height: Float32Array;
    heightSize: number;
    // the edge strip: ragged dirt rim (with alpha) or the border row
    strip: Uint8Array | null;
    stripAlpha: boolean;
    // the curb's concrete
    curb: Uint8Array | null;
};

const lookOf = (p: RoadParams): Look => ({ tint: p.tint, colorVariation: p.colorVariation, wear: p.wear, moss: p.moss, seed: p.seed, pattern: p.pattern });

const tinted = (look: Look, fn: (x: number, y: number, out: number[]) => number) => (x: number, y: number, out: number[]) => {
    const a = fn(x, y, out);
    out[0] *= look.tint[0];
    out[1] *= look.tint[1];
    out[2] *= look.tint[2];
    return a;
};

const cache = new Map<string, Promise<RoadTextures>>();

const roadTextures = (p: RoadParams): Promise<RoadTextures> => {
    const look = lookOf(p);
    const hasStrip = p.style === 'dirt' ? p.edge > 0 : (p.style === 'cobble' || p.style === 'pavers') && p.edge > 0;
    const custom = p.style === 'custom' ? [p.customTexture ? textHash(p.customTexture) : '', p.seamless, p.reliefDetail, p.reliefInvert, p.relief] : null;
    const key = JSON.stringify([p.style, look, hasStrip, p.curb > 0, custom]);
    let result = cache.get(key);
    if (!result) {
        result = (async () => {
            let main: Uint8Array;
            let height: Float32Array;
            if (p.style === 'custom') {
                let rgba: Uint8ClampedArray;
                if (p.customTexture) {
                    rgba = await loadPicture(p.customTexture, SIZE);
                    if (p.seamless) rgba = makeSeamless(rgba, SIZE);
                } else {
                    // no picture yet: plain grey
                    rgba = new Uint8ClampedArray(SIZE * SIZE * 4).fill(150);
                }
                height = heightFromPicture(rgba, SIZE, SIZE, p.reliefDetail, p.reliefInvert);
                // a little cavity shading: the deep parts darker, the tops
                // lighter, so it reads as relief even without lights
                const shade = 0.25 + 0.5 * p.relief;
                const data = new Uint8ClampedArray(rgba.length);
                for (let i = 0; i < height.length; ++i) {
                    const k = 1 + shade * (height[i] - 0.5);
                    data[i * 4] = rgba[i * 4] * k * look.tint[0];
                    data[i * 4 + 1] = rgba[i * 4 + 1] * k * look.tint[1];
                    data[i * 4 + 2] = rgba[i * 4 + 2] * k * look.tint[2];
                    data[i * 4 + 3] = 255;
                }
                main = await toPng({ width: SIZE, height: SIZE, data });
            } else {
                const fn = mainColor[p.style];
                const rendered = render(SIZE, SIZE, tinted(look, (x, y, out) => {
                    fn(x, y, look, out);
                    return 1;
                }));
                main = await toPng(rendered);
                // smooth the procedural heights a touch: no stair steps
                height = blurWrap(rendered.heights, SIZE, SIZE, 1);
            }

            let strip: Uint8Array | null = null;
            if (hasStrip && p.style === 'dirt') {
                // u: from the road's edge (0) outwards (1); alpha frays it
                strip = await toPng(render(STRIP, SIZE, tinted(look, (u, v, out) => {
                    dirt(u * 0.25, v, look, out);
                    const reach = 0.25 + 0.6 * fbm(0, v, 6, 4, look.seed + 61) + 0.25 * (noise(u * 40, v * 160, 160, look.seed + 62) - 0.5);
                    scale(out, 1 - 0.2 * u);
                    return u < reach ? 1 : 0;
                })));
            } else if (hasStrip) {
                // a row of long border stones: 4 (cobbles) or 8 (pavers) per
                // tile; the strip is a quarter tile wide (borderWidth)
                const n = p.style === 'cobble' ? 4 : 8;
                const across = n / 4;
                strip = await toPng(render(STRIP, SIZE, tinted(look, (u, v, out) => {
                    const f = (v * n) % 1;
                    const k = Math.floor(v * n);
                    const edge = Math.min(f / n, (1 - f) / n, u * across / n, (1 - u) * across / n);
                    const joint = p.style === 'cobble' ? 0.012 : 0.005;
                    if (edge < joint) {
                        out[0] = 0.25;
                        out[1] = 0.23;
                        out[2] = 0.21;
                        return 1;
                    }
                    const base = p.style === 'cobble' ? 0.42 : 0.3;
                    const t = 1 + (hash(k, 5, look.seed + 71) - 0.5) * 0.3 * look.colorVariation;
                    out[0] = base * t;
                    out[1] = base * t * 0.99;
                    out[2] = base * t * 0.97;
                    scale(out, (0.82 + 0.18 * smoothstep(joint, joint * 4, edge)) * (0.92 + 0.16 * noise(u * 40, v * 300, 300, look.seed + 72)));
                    applyWear(u * 0.1, v, look, out, [0.5, 0.46, 0.4]);
                    return 1;
                })));
            }

            const curb = p.curb > 0 ? await toPng(render(STRIP, SIZE, tinted(look, (u, v, out) => {
                concrete(u * 0.2, v, { ...look, colorVariation: look.colorVariation * 0.5 }, out, false);
                scale(out, 1.06);
                // a joint every half tile
                const e = Math.min((v * 2) % 1, 1 - (v * 2) % 1);
                if (e < 0.006) scale(out, 0.5);
                return 1;
            }))) : null;

            return { main, height, heightSize: SIZE, strip, stripAlpha: p.style === 'dirt', curb };
        })();
        cache.set(key, result);
        result.catch(() => cache.delete(key));
        // keep the cache small
        if (cache.size > 24) cache.delete(cache.keys().next().value);
    }
    return result;
};

// a small swatch of a style, for its button
const previewCache = new Map<string, string>();
const stylePreview = (style: RoadStyle, size = 56): string => {
    const key = `${style}:${size}`;
    let url = previewCache.get(key);
    if (!url) {
        const look: Look = { tint: [1, 1, 1], colorVariation: 0.5, wear: 0.3, moss: style === 'cobble' ? 0.25 : 0, seed: 1, pattern: 'running' };
        // a quarter tile: big enough to read the pattern
        url = toCanvas(render(size, size, (x, y, out) => {
            if (style === 'custom') {
                // a placeholder: an "add a picture" grid
                const line = Math.min(x % 0.25, y % 0.25) < 0.03;
                out[0] = out[1] = out[2] = line ? 0.55 : 0.32;
            } else {
                mainColor[style](x * 0.5, y * 0.5, look, out);
            }
            return 1;
        })).toDataURL();
        previewCache.set(key, url);
    }
    return url;
};

export { roadTextures, stylePreview, RoadTextures };
