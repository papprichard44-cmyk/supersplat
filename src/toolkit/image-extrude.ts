import { contours } from 'd3-contour';

// Geometry for an extruded alpha-cutout picture, in the primitive's local
// space: the picture spans x,z in [-0.5, 0.5] (x = u - 0.5, z = v - 0.5, the
// same mapping as the engine's plane) and the thickness spans y in [-0.5, 0.5].
//
// - the two caps are plain quads; the fragment shader cuts them out per pixel,
//   so their silhouette stays as sharp as the picture itself
// - the side walls follow the alpha contour traced with d3-contour (marching
//   squares). Each wall vertex samples the picture slightly inside the edge, so
//   the wall is streaked with the colour of the rim.

const GRID_MAX = 512;

type AlphaGrid = {
    width: number;
    height: number;
    alpha: Float32Array;        // 0..1, row 0 = top of the picture
};

type ExtrudeGeometry = {
    positions: Float32Array;
    normals: Float32Array;
    uvs: Float32Array;
    indices: Uint32Array;
};

// downsample the picture's alpha channel to a grid of at most GRID_MAX cells
const makeAlphaGrid = (source: HTMLImageElement | HTMLCanvasElement, width: number, height: number): AlphaGrid => {
    const scale = Math.min(1, GRID_MAX / Math.max(width, height));
    const w = Math.max(2, Math.round(width * scale));
    const h = Math.max(2, Math.round(height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(source, 0, 0, w, h);
    const pixels = context.getImageData(0, 0, w, h).data;
    const alpha = new Float32Array(w * h);
    for (let i = 0; i < w * h; ++i) {
        alpha[i] = pixels[i * 4 + 3] / 255;
    }
    return { width: w, height: h, alpha };
};

const sampleAlpha = (grid: AlphaGrid, x: number, y: number) => {
    const i = Math.floor(x);
    const j = Math.floor(y);
    if (i < 0 || j < 0 || i >= grid.width || j >= grid.height) {
        return 0;
    }
    return grid.alpha[i + j * grid.width];
};

// One point of a rim (closed loop around an opaque region or a hole):
// x,z = position in the primitive's local space, nx,nz = direction pointing
// out of the opaque region, u,v = where to sample the picture for the rim colour
type RimPoint = { x: number, z: number, nx: number, nz: number, u: number, v: number };

const traceRims = (grid: AlphaGrid, cutoff: number): RimPoint[][] => {
    const { width, height } = grid;
    const threshold = Math.min(0.999, Math.max(0.001, cutoff));
    const [multiPolygon] = contours().size([width, height]).thresholds([threshold])(Array.from(grid.alpha));
    const inset = 1.5;      // grid cells: how far inside the rim the colour is sampled
    const rims: RimPoint[][] = [];

    multiPolygon.coordinates.forEach((polygon) => {
        polygon.forEach((ring) => {
            // d3 closes each ring by repeating the first point
            const n = ring.length - 1;
            if (n < 3) return;
            const rim: RimPoint[] = [];
            for (let i = 0; i < n; ++i) {
                const [x, y] = ring[i];
                const [px, py] = ring[(i + n - 1) % n];
                const [nx, ny] = ring[(i + 1) % n];
                // normal of the rim at this point, from the neighbouring points
                let tx = nx - px;
                let ty = ny - py;
                const length = Math.hypot(tx, ty) || 1;
                tx /= length;
                ty /= length;
                let ox = ty;
                let oy = -tx;
                // make (ox, oy) point out of the opaque region
                if (sampleAlpha(grid, x + ox * inset, y + oy * inset) > sampleAlpha(grid, x - ox * inset, y - oy * inset)) {
                    ox = -ox;
                    oy = -oy;
                }
                rim.push({
                    x: x / width - 0.5,
                    z: y / height - 0.5,
                    nx: ox,
                    nz: oy,
                    u: (x - ox * inset) / width,
                    v: (y - oy * inset) / height
                });
            }
            rims.push(rim);
        });
    });

    return rims;
};

const buildExtrudeGeometry = (grid: AlphaGrid, cutoff: number): ExtrudeGeometry => {
    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];

    // caps: +y and -y quads covering the whole picture
    [0.5, -0.5].forEach((y) => {
        const base = positions.length / 3;
        [[0, 0], [1, 0], [1, 1], [0, 1]].forEach(([u, v]) => {
            positions.push(u - 0.5, y, v - 0.5);
            normals.push(0, Math.sign(y), 0);
            uvs.push(u, v);
        });
        indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    });

    // side walls along the alpha contour (outer rings and holes alike)
    traceRims(grid, cutoff).forEach((rim) => {
        const n = rim.length;
        const base = positions.length / 3;
        rim.forEach((point) => {
            [0.5, -0.5].forEach((side) => {
                positions.push(point.x, side, point.z);
                normals.push(point.nx, 0, point.nz);
                uvs.push(point.u, point.v);
            });
        });
        for (let i = 0; i < n; ++i) {
            const a = base + i * 2;
            const b = base + ((i + 1) % n) * 2;
            indices.push(a, a + 1, b, b, a + 1, b + 1);
        }
    });

    return {
        positions: new Float32Array(positions),
        normals: new Float32Array(normals),
        uvs: new Float32Array(uvs),
        indices: new Uint32Array(indices)
    };
};

export { AlphaGrid, ExtrudeGeometry, RimPoint, makeAlphaGrid, traceRims, buildExtrudeGeometry };
