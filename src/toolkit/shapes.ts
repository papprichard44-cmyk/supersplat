import { ConeGeometry, CylinderGeometry, SphereGeometry, TorusGeometry } from 'playcanvas';

// Curved primitives. Each fits the unit box (-0.5..0.5) so the entity scale is
// its size, like the plane and box. The same triangles are drawn in the
// viewport, sampled into splats and used as shadow casters.

type ShapeKind = 'sphere' | 'cylinder' | 'cone' | 'torus' | 'backdrop';

type ShapeGeometry = {
    positions: Float32Array;
    normals: Float32Array;
    uvs: Float32Array;
    indices: Uint32Array;
    half: [number, number, number];
    // a thin sheet seen from both sides, rather than a closed solid
    twoSided: boolean;
    // a convex solid can't shadow itself, so its own triangles are skipped by
    // its shadow rays (no self-shadowing artefacts on its surface)
    convex: boolean;
};

const shapeKinds: ShapeKind[] = ['sphere', 'cylinder', 'cone', 'torus', 'backdrop'];

const cache = new Map<ShapeKind, ShapeGeometry>();

const fromGeometry = (geometry: { positions?: ArrayLike<number>, normals?: ArrayLike<number>, uvs?: ArrayLike<number>, indices?: ArrayLike<number> }) => ({
    positions: Float32Array.from(geometry.positions),
    normals: Float32Array.from(geometry.normals),
    uvs: Float32Array.from(geometry.uvs ?? new Array((geometry.positions.length / 3) * 2).fill(0)),
    indices: Uint32Array.from(geometry.indices)
});

// photo backdrop / cyclorama: a floor that sweeps up into a wall with a
// smooth curve, so the background has no visible corner. Floor towards +z,
// wall at the back (-z), facing the inside of the sweep.
const buildBackdrop = () => {
    const radius = 0.35;
    const curveSteps = 24;
    // profile in (z, y) with its inward normal, from the front edge to the top
    const profile: { z: number, y: number, nz: number, ny: number }[] = [];
    profile.push({ z: 0.5, y: -0.5, nz: 0, ny: 1 });
    const cz = -0.5 + radius;
    const cy = -0.5 + radius;
    for (let i = 0; i <= curveSteps; ++i) {
        const a = -Math.PI / 2 - (i / curveSteps) * (Math.PI / 2);
        const z = cz + Math.cos(a) * radius;
        const y = cy + Math.sin(a) * radius;
        profile.push({ z, y, nz: -Math.cos(a), ny: -Math.sin(a) });
    }
    profile.push({ z: -0.5, y: 0.5, nz: 1, ny: 0 });

    const columns = 2;
    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    let length = 0;
    const along = profile.map((p, i) => {
        if (i > 0) length += Math.hypot(p.z - profile[i - 1].z, p.y - profile[i - 1].y);
        return length;
    });
    profile.forEach((p, i) => {
        for (let c = 0; c < columns; ++c) {
            const x = c / (columns - 1) - 0.5;
            positions.push(x, p.y, p.z);
            normals.push(0, p.ny, p.nz);
            uvs.push(c / (columns - 1), along[i] / length);
        }
    });
    for (let i = 0; i < profile.length - 1; ++i) {
        for (let c = 0; c < columns - 1; ++c) {
            const a = i * columns + c;
            const b = a + columns;
            indices.push(a, b, a + 1, a + 1, b, b + 1);
        }
    }
    return {
        positions: new Float32Array(positions),
        normals: new Float32Array(normals),
        uvs: new Float32Array(uvs),
        indices: new Uint32Array(indices)
    };
};

const shapeGeometry = (kind: ShapeKind): ShapeGeometry => {
    let result = cache.get(kind);
    if (result) return result;

    switch (kind) {
        case 'sphere':
            result = {
                ...fromGeometry(new SphereGeometry({ radius: 0.5, latitudeBands: 48, longitudeBands: 64 })),
                half: [0.5, 0.5, 0.5],
                twoSided: false,
                convex: true
            };
            break;
        case 'cylinder':
            result = {
                ...fromGeometry(new CylinderGeometry({ radius: 0.5, height: 1, heightSegments: 1, capSegments: 64 })),
                half: [0.5, 0.5, 0.5],
                twoSided: false,
                convex: true
            };
            break;
        case 'cone':
            result = {
                ...fromGeometry(new ConeGeometry({ baseRadius: 0.5, peakRadius: 0, height: 1, heightSegments: 4, capSegments: 64 })),
                half: [0.5, 0.5, 0.5],
                twoSided: false,
                convex: true
            };
            break;
        case 'torus':
            result = {
                ...fromGeometry(new TorusGeometry({ tubeRadius: 0.15, ringRadius: 0.35, segments: 72, sides: 32 })),
                half: [0.5, 0.15, 0.5],
                twoSided: false,
                convex: false
            };
            break;
        case 'backdrop':
        default:
            result = {
                ...buildBackdrop(),
                half: [0.5, 0.5, 0.5],
                twoSided: true,
                convex: false
            };
            break;
    }

    cache.set(kind, result);
    return result;
};

const isShapeKind = (kind: string): kind is ShapeKind => (shapeKinds as string[]).includes(kind);

// ---- planes and boxes
//
// Built from faces: origin + s * u + t * v for s, t in 0..1, with uv = (s, t).
// Seen from outside, u runs to the right and v downwards on every face, so a
// picture mapped on them is upright and never mirrored. The splat conversion
// samples the very same faces, so pictures and gradients line up exactly.

type Face = { origin: [number, number, number], u: [number, number, number], v: [number, number, number] };

const planeFaces: Face[] = [
    { origin: [-0.5, 0, -0.5], u: [1, 0, 0], v: [0, 0, 1] }
];

const boxFaces: Face[] = [
    { origin: [-0.5, 0.5, 0.5], u: [1, 0, 0], v: [0, -1, 0] },      // +z
    { origin: [0.5, 0.5, -0.5], u: [-1, 0, 0], v: [0, -1, 0] },     // -z
    { origin: [0.5, 0.5, 0.5], u: [0, 0, -1], v: [0, -1, 0] },      // +x
    { origin: [-0.5, 0.5, -0.5], u: [0, 0, 1], v: [0, -1, 0] },     // -x
    { origin: [-0.5, 0.5, -0.5], u: [1, 0, 0], v: [0, 0, 1] },      // +y
    { origin: [-0.5, -0.5, 0.5], u: [1, 0, 0], v: [0, 0, -1] }      // -y
];

const flatCache = new Map<string, ShapeGeometry>();

const flatGeometry = (kind: 'plane' | 'box'): ShapeGeometry => {
    let result = flatCache.get(kind);
    if (result) return result;
    const faces = kind === 'plane' ? planeFaces : boxFaces;
    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    faces.forEach(({ origin: o, u, v }) => {
        // outward normal: u x v points inwards (see above)
        const n = [-(u[1] * v[2] - u[2] * v[1]), -(u[2] * v[0] - u[0] * v[2]), -(u[0] * v[1] - u[1] * v[0])];
        const base = positions.length / 3;
        [[0, 0], [1, 0], [1, 1], [0, 1]].forEach(([s, t]) => {
            positions.push(o[0] + u[0] * s + v[0] * t, o[1] + u[1] * s + v[1] * t, o[2] + u[2] * s + v[2] * t);
            normals.push(kind === 'plane' ? 0 : n[0], kind === 'plane' ? 1 : n[1], kind === 'plane' ? 0 : n[2]);
            uvs.push(s, t);
        });
        indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    });
    result = {
        positions: new Float32Array(positions),
        normals: new Float32Array(normals),
        uvs: new Float32Array(uvs),
        indices: new Uint32Array(indices),
        half: kind === 'plane' ? [0.5, 0.002, 0.5] : [0.5, 0.5, 0.5],
        twoSided: kind === 'plane',
        convex: true
    };
    flatCache.set(kind, result);
    return result;
};

export { ShapeKind, ShapeGeometry, Face, shapeKinds, shapeGeometry, isShapeKind, planeFaces, boxFaces, flatGeometry };
