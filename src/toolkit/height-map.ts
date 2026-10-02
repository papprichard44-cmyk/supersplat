// Height maps from pictures, the way material tools make them ("bitmap to
// material"): the fine detail of the brightness against its blurred
// surroundings, normalised - dark joints low, bright stone tops high - so a
// flat picture can be given relief. Used by the road maker's custom texture
// and by pictures painted on primitives.

type HeightMap = { width: number, height: number, data: Float32Array };

const smoothstep = (a: number, b: number, x: number) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
};

// box blur that wraps around the picture (two passes per direction, near gaussian)
const blurWrap = (src: Float32Array, width: number, height: number, radius: number) => {
    const r = Math.max(1, Math.round(radius));
    let a = Float32Array.from(src);
    let b = new Float32Array(src.length);
    const norm = 1 / (2 * r + 1);
    for (let pass = 0; pass < 4; ++pass) {
        const horizontal = pass % 2 === 0;
        const n = horizontal ? width : height;
        const lines = horizontal ? height : width;
        for (let line = 0; line < lines; ++line) {
            const at = (i: number) => {
                const w = ((i % n) + n) % n;
                return horizontal ? line * width + w : w * width + line;
            };
            let sum = 0;
            for (let i = -r; i <= r; ++i) sum += a[at(i)];
            for (let i = 0; i < n; ++i) {
                b[at(i)] = sum * norm;
                sum += a[at(i + r + 1)] - a[at(i - r)];
            }
        }
        [a, b] = [b, a];
    }
    return a;
};

// `detail` 0 picks up fine grain, 1 whole stones; `invert` for pictures
// whose joints are lighter than the stones
const heightFromPicture = (rgba: ArrayLike<number>, width: number, height: number, detail: number, invert: boolean): Float32Array => {
    const n = width * height;
    const lum = new Float32Array(n);
    for (let i = 0; i < n; ++i) {
        lum[i] = (0.2126 * rgba[i * 4] + 0.7152 * rgba[i * 4 + 1] + 0.0722 * rgba[i * 4 + 2]) / 255;
    }
    const size = Math.max(width, height);
    const fine = blurWrap(lum, width, height, 1 + detail * 3 * size / 512);
    const coarse = blurWrap(lum, width, height, (4 + detail * 512 * 0.12) * size / 512);
    let mean = 0;
    for (let i = 0; i < n; ++i) mean += fine[i] - coarse[i];
    mean /= n;
    let variance = 0;
    for (let i = 0; i < n; ++i) variance += (fine[i] - coarse[i] - mean) ** 2;
    const std = Math.sqrt(variance / n) || 1;
    const h = new Float32Array(n);
    for (let i = 0; i < n; ++i) {
        const v = Math.min(1, Math.max(0, 0.5 + (fine[i] - coarse[i] - mean) / (4 * std)));
        h[i] = invert ? 1 - v : v;
    }
    return h;
};

// a picture's height map, at most `maxSize` pixels across (box-filtered down),
// cached per picture and settings
const cache = new WeakMap<object, Map<string, HeightMap>>();

const heightMapOf = (pixels: { width: number, height: number, data: ArrayLike<number> }, detail: number, invert: boolean, maxSize = 1024): HeightMap => {
    let perPicture = cache.get(pixels);
    if (!perPicture) cache.set(pixels, perPicture = new Map());
    const key = `${detail.toFixed(3)}:${invert}:${maxSize}`;
    const known = perPicture.get(key);
    if (known) return known;
    // shrink by a whole factor first: the height map needn't be finer
    const factor = Math.max(1, Math.ceil(Math.max(pixels.width, pixels.height) / maxSize));
    const width = Math.max(1, Math.floor(pixels.width / factor));
    const height = Math.max(1, Math.floor(pixels.height / factor));
    let rgba: ArrayLike<number> = pixels.data;
    if (factor > 1) {
        const small = new Float32Array(width * height * 4);
        for (let y = 0; y < height; ++y) {
            for (let x = 0; x < width; ++x) {
                for (let c = 0; c < 4; ++c) {
                    let sum = 0;
                    for (let dy = 0; dy < factor; ++dy) {
                        for (let dx = 0; dx < factor; ++dx) {
                            sum += pixels.data[((y * factor + dy) * pixels.width + x * factor + dx) * 4 + c];
                        }
                    }
                    small[(y * width + x) * 4 + c] = sum / (factor * factor);
                }
            }
        }
        rgba = small;
    }
    const map = { width, height, data: heightFromPicture(rgba, width, height, detail, invert) };
    perPicture.set(key, map);
    return map;
};

// bilinear height at texture coordinates already in 0..1 (wrapping repeat)
const sampleHeight = (map: HeightMap, u: number, v: number) => {
    const x = u * map.width - 0.5;
    const y = v * map.height - 0.5;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const w = map.width;
    const h = map.height;
    const ix = (i: number) => ((i % w) + w) % w;
    const iy = (i: number) => ((i % h) + h) % h;
    const d = map.data;
    return (d[iy(y0) * w + ix(x0)] * (1 - fx) + d[iy(y0) * w + ix(x0 + 1)] * fx) * (1 - fy) +
        (d[iy(y0 + 1) * w + ix(x0)] * (1 - fx) + d[iy(y0 + 1) * w + ix(x0 + 1)] * fx) * fy;
};

export { blurWrap, heightFromPicture, heightMapOf, sampleHeight, smoothstep, HeightMap };
