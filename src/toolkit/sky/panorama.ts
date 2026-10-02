// Panoramas for the sky: an equirectangular picture (jpg / png / webp) or a
// Radiance HDR (.hdr), held as float RGB in display space (0..1, an HDR keeps
// its exposure separately until it is tone mapped). The sky samples it with a
// pre-filter, so every splat gets the average of the pixels it covers instead
// of one random pixel (no shimmer, no aliasing).

type Panorama = {
    name: string;
    width: number;
    height: number;
    data: Float32Array;     // rgb per pixel, row 0 = the top (zenith)
    hdr: boolean;           // linear radiance, tone mapped at sampling
};

const MAX_WIDTH = 8192;

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const linearToSrgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

// ACES filmic curve (Narkowicz fit): keeps highlights from clipping hard
const aces = (x: number) => Math.min(1, Math.max(0, (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14)));

// ---- loading

const readRgbe = (buffer: ArrayBuffer): { width: number, height: number, data: Float32Array } => {
    const bytes = new Uint8Array(buffer);
    let pos = 0;
    const line = () => {
        let s = '';
        while (pos < bytes.length && bytes[pos] !== 0x0a) s += String.fromCharCode(bytes[pos++]);
        pos++;
        return s;
    };
    const magic = line();
    if (!magic.startsWith('#?')) throw new Error('not a Radiance HDR file');
    // header lines until the empty one
    for (let l = line(); l.length > 0; l = line()) {
        if (l.startsWith('FORMAT') && !l.includes('32-bit_rle_rgbe')) throw new Error('only RGBE .hdr files are supported');
    }
    const size = line().match(/-Y (\d+) \+X (\d+)/);
    if (!size) throw new Error('unsupported .hdr orientation');
    const height = parseInt(size[1], 10);
    const width = parseInt(size[2], 10);

    const data = new Float32Array(width * height * 3);
    const scan = new Uint8Array(width * 4);
    for (let y = 0; y < height; ++y) {
        if (width >= 8 && width < 32768 && bytes[pos] === 2 && bytes[pos + 1] === 2 && (bytes[pos + 2] & 0x80) === 0) {
            // run length encoded, one channel after the other
            pos += 4;
            for (let c = 0; c < 4; ++c) {
                let x = 0;
                while (x < width) {
                    let count = bytes[pos++];
                    if (count > 128) {
                        count -= 128;
                        const value = bytes[pos++];
                        for (let k = 0; k < count; ++k) scan[(x++) * 4 + c] = value;
                    } else {
                        for (let k = 0; k < count; ++k) scan[(x++) * 4 + c] = bytes[pos++];
                    }
                }
            }
        } else {
            // flat scanline
            scan.set(bytes.subarray(pos, pos + width * 4));
            pos += width * 4;
        }
        for (let x = 0; x < width; ++x) {
            const e = scan[x * 4 + 3];
            const f = e ? Math.pow(2, e - 136) : 0;
            const o = (y * width + x) * 3;
            data[o] = scan[x * 4] * f;
            data[o + 1] = scan[x * 4 + 1] * f;
            data[o + 2] = scan[x * 4 + 2] * f;
        }
    }
    return { width, height, data };
};

const loadPanorama = async (file: File): Promise<Panorama> => {
    if (/\.hdr$/i.test(file.name)) {
        const { width, height, data } = readRgbe(await file.arrayBuffer());
        return { name: file.name, width, height, data, hdr: true };
    }
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_WIDTH / bitmap.width);
    const width = Math.max(2, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    const pixels = context.getImageData(0, 0, width, height).data;
    const data = new Float32Array(width * height * 3);
    for (let i = 0, j = 0; i < data.length; i += 3, j += 4) {
        data[i] = pixels[j] / 255;
        data[i + 1] = pixels[j + 1] / 255;
        data[i + 2] = pixels[j + 2] / 255;
    }
    return { name: file.name, width, height, data, hdr: false };
};

// ---- sampling

type PanoramaSampler = (dx: number, dy: number, dz: number, out: number[]) => void;

// box-filter down to about `targetWidth` (the splats' own resolution), then
// sample bilinearly. Filtering happens in linear light, so averages are right.
const createSampler = (pano: Panorama, targetWidth: number, yawDegrees: number, exposure: number): PanoramaSampler => {
    const factor = Math.max(1, Math.floor(pano.width / Math.max(16, targetWidth)));
    const w = Math.max(2, Math.floor(pano.width / factor));
    const h = Math.max(1, Math.floor(pano.height / factor));
    const lin = new Float32Array(w * h * 3);
    const toLinear = pano.hdr ? (v: number) => v : srgbToLinear;
    for (let y = 0; y < h; ++y) {
        for (let x = 0; x < w; ++x) {
            let r = 0, g = 0, b = 0;
            for (let sy = 0; sy < factor; ++sy) {
                const row = (y * factor + sy) * pano.width;
                for (let sx = 0; sx < factor; ++sx) {
                    const o = (row + x * factor + sx) * 3;
                    r += toLinear(pano.data[o]);
                    g += toLinear(pano.data[o + 1]);
                    b += toLinear(pano.data[o + 2]);
                }
            }
            const n = factor * factor;
            const o = (y * w + x) * 3;
            lin[o] = r / n;
            lin[o + 1] = g / n;
            lin[o + 2] = b / n;
        }
    }

    const gain = Math.pow(2, exposure);
    const toDisplay = pano.hdr ?
        (v: number) => linearToSrgb(aces(v * gain)) :
        (v: number) => linearToSrgb(Math.min(1, v * gain));
    const yaw = yawDegrees / 360;

    return (dx, dy, dz, out) => {
        // u: azimuth, 0.5 looks down -Z; v: 0 at the zenith
        const azimuth = Math.atan2(dx, -dz);
        const elevation = Math.asin(Math.max(-1, Math.min(1, dy)));
        let u = (0.5 + azimuth / (2 * Math.PI) + yaw) * w - 0.5;
        const v = Math.min(h - 1, Math.max(0, (0.5 - elevation / Math.PI) * h - 0.5));
        u = ((u % w) + w) % w;
        const x0 = Math.floor(u);
        const y0 = Math.floor(v);
        const x1 = (x0 + 1) % w;
        const y1 = Math.min(h - 1, y0 + 1);
        const fx = u - x0;
        const fy = v - y0;
        for (let c = 0; c < 3; ++c) {
            const a = lin[(y0 * w + x0) * 3 + c] * (1 - fx) + lin[(y0 * w + x1) * 3 + c] * fx;
            const b = lin[(y1 * w + x0) * 3 + c] * (1 - fx) + lin[(y1 * w + x1) * 3 + c] * fx;
            out[c] = toDisplay(a * (1 - fy) + b * fy);
        }
    };
};

export { loadPanorama, createSampler, Panorama, PanoramaSampler, srgbToLinear, linearToSrgb };
