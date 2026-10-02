import { BoxGeometry, ConeGeometry, CylinderGeometry, Mat4, Quat, SphereGeometry, TorusGeometry, Vec3 } from 'playcanvas';

import { LT_DISK, LT_POINT, LT_RECT, LT_RING, LT_SPOT, LT_SUN } from './shading';

// The studio's light fixtures: what each kind of lamp does, and a small
// procedural model of it so the scene reads like a real film set. The models
// are a few hundred triangles each, in the fixture's own space:
//  - the light leaves the front face towards -Z (the entity's forward)
//  - one unit is the emitter's width (lens, softbox front, panel, ...)
// They are split in two parts: the housing (drawn as dark metal) and the
// emitting surface (drawn in the light's colour).

type FixtureKind = 'fresnel' | 'softbox' | 'stripbox' | 'panel' | 'umbrella' | 'ring' | 'bulb' | 'sun';

type FixtureInfo = {
    label: string;
    // one-liner for people who have never been on a set
    description: string;
    lightType: number;
    // emitter width relative to the subject size, and height / width (rect lights)
    width: number;
    aspect: number;
    // how tightly an area light points forwards (1 = plain diffuser)
    exponent: number;
    // spot beam half-angle (degrees) and edge softness (0 hard .. 1 soft)
    beam: number;
    softEdge: number;
    ringInner: number;
};

const fixtureKinds: FixtureKind[] = ['softbox', 'fresnel', 'stripbox', 'panel', 'umbrella', 'ring', 'bulb', 'sun'];

const fixtures: Record<FixtureKind, FixtureInfo> = {
    softbox: {
        label: 'Softbox',
        description: 'Big, soft light with gentle shadow edges. The classic key light for faces and products.',
        lightType: LT_RECT,
        width: 0.9,
        aspect: 1,
        exponent: 1,
        beam: 0,
        softEdge: 0,
        ringInner: 0
    },
    fresnel: {
        label: 'Fresnel spot',
        description: 'Hard, focused beam with crisp shadows. Narrow it to pick out a spot; great for drama and rim light.',
        lightType: LT_SPOT,
        width: 0.12,
        aspect: 1,
        exponent: 1,
        beam: 22,
        softEdge: 0.35,
        ringInner: 0
    },
    stripbox: {
        label: 'Strip box',
        description: 'Tall, narrow softbox. Draws long, clean highlight lines along the edges of glossy objects.',
        lightType: LT_RECT,
        width: 0.3,
        aspect: 4,
        exponent: 1.5,
        beam: 0,
        softEdge: 0,
        ringInner: 0
    },
    panel: {
        label: 'LED panel',
        description: 'Compact, medium-soft light. A handy fill or background light.',
        lightType: LT_RECT,
        width: 0.4,
        aspect: 0.7,
        exponent: 2,
        beam: 0,
        softEdge: 0,
        ringInner: 0
    },
    umbrella: {
        label: 'Umbrella',
        description: 'Very broad light that wraps around the subject. Soft, forgiving, lights a wide area.',
        lightType: LT_DISK,
        width: 1.2,
        aspect: 1,
        exponent: 0.6,
        beam: 0,
        softEdge: 0,
        ringInner: 0
    },
    ring: {
        label: 'Ring light',
        description: 'Even, almost shadowless light from the camera\'s direction, with a round highlight in reflections.',
        lightType: LT_RING,
        width: 0.5,
        aspect: 1,
        exponent: 1,
        beam: 0,
        softEdge: 0,
        ringInner: 0.72
    },
    bulb: {
        label: 'Bulb',
        description: 'A bare bulb shining in every direction, like a practical lamp standing in the scene.',
        lightType: LT_POINT,
        width: 0.05,
        aspect: 1,
        exponent: 1,
        beam: 0,
        softEdge: 0,
        ringInner: 0
    },
    sun: {
        label: 'Sun',
        description: 'Parallel daylight from far away with sharp shadows. Only its direction matters, not its position.',
        lightType: LT_SUN,
        width: 0.05,
        aspect: 1,
        exponent: 1,
        beam: 0,
        softEdge: 0,
        ringInner: 0
    }
};

// ---- geometry

type Geometry = { positions: number[], normals: number[], indices: number[] };

class GeometryBuilder {
    positions: number[] = [];
    normals: number[] = [];
    indices: number[] = [];

    add(source: { positions?: ArrayLike<number>, normals?: ArrayLike<number>, indices?: ArrayLike<number> }, transform: Mat4) {
        const base = this.positions.length / 3;
        const normalMatrix = new Mat4().copy(transform).invert().transpose();
        const v = new Vec3();
        for (let i = 0; i < source.positions.length; i += 3) {
            transform.transformPoint(v.set(source.positions[i], source.positions[i + 1], source.positions[i + 2]), v);
            this.positions.push(v.x, v.y, v.z);
            normalMatrix.transformVector(v.set(source.normals[i], source.normals[i + 1], source.normals[i + 2]), v).normalize();
            this.normals.push(v.x, v.y, v.z);
        }
        for (let i = 0; i < source.indices.length; ++i) {
            this.indices.push(source.indices[i] + base);
        }
        return this;
    }

    get geometry(): Geometry {
        return { positions: this.positions, normals: this.normals, indices: this.indices };
    }
}

const trs = (px: number, py: number, pz: number, ex = 0, ey = 0, ez = 0, sx = 1, sy = 1, sz = 1) => {
    return new Mat4().setTRS(new Vec3(px, py, pz), new Quat().setFromEulerAngles(ex, ey, ez), new Vec3(sx, sy, sz));
};

const box = new BoxGeometry({ halfExtents: new Vec3(0.5, 0.5, 0.5) });
const cylinder = new CylinderGeometry({ radius: 0.5, height: 1, capSegments: 24 });
const tube = new CylinderGeometry({ radius: 0.5, height: 1, capSegments: 24 });
const sphere = new SphereGeometry({ radius: 0.5, latitudeBands: 12, longitudeBands: 18 });
const cone = new ConeGeometry({ baseRadius: 0.5, peakRadius: 0.08, height: 1, capSegments: 24 });

// a flat quad facing -Z, for emitting fronts
const quad = { positions: [-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], normals: [0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1], indices: [0, 2, 1, 0, 3, 2] };

// a disc facing -Z
const disc = (() => {
    const positions = [0, 0, 0];
    const normals = [0, 0, -1];
    const indices: number[] = [];
    const n = 32;
    for (let i = 0; i <= n; ++i) {
        const a = i / n * Math.PI * 2;
        positions.push(Math.cos(a) * 0.5, Math.sin(a) * 0.5, 0);
        normals.push(0, 0, -1);
        if (i > 0) indices.push(0, i + 1, i);
    }
    return { positions, normals, indices };
})();

// a truncated pyramid (softbox body): front w x h at z=0, back b x b at z=depth
const frustum = (w: number, h: number, b: number, depth: number) => {
    const f = [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]];
    const k = [[-b / 2, -b / 2], [b / 2, -b / 2], [b / 2, b / 2], [-b / 2, b / 2]];
    const positions: number[] = [];
    const normals: number[] = [];
    const indices: number[] = [];
    for (let i = 0; i < 4; ++i) {
        const j = (i + 1) % 4;
        const a = new Vec3(f[i][0], f[i][1], 0);
        const bb = new Vec3(f[j][0], f[j][1], 0);
        const c = new Vec3(k[j][0], k[j][1], depth);
        const d = new Vec3(k[i][0], k[i][1], depth);
        const n = new Vec3().cross(new Vec3().sub2(bb, a), new Vec3().sub2(d, a)).normalize().mulScalar(-1);
        const base = positions.length / 3;
        [a, bb, c, d].forEach((p) => {
            positions.push(p.x, p.y, p.z);
            normals.push(n.x, n.y, n.z);
        });
        indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    // back cap
    const base = positions.length / 3;
    k.forEach((p) => {
        positions.push(p[0], p[1], depth);
        normals.push(0, 0, 1);
    });
    indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
    return { positions, normals, indices };
};

// an open cone shell (umbrella canopy) opening towards -Z, apex at z = depth
const canopy = (radius: number, depth: number) => {
    const positions: number[] = [];
    const normals: number[] = [];
    const indices: number[] = [];
    const n = 16;
    for (let i = 0; i <= n; ++i) {
        const a = i / n * Math.PI * 2;
        const x = Math.cos(a), y = Math.sin(a);
        // rim and apex rows; normal faces the inside (towards -Z)
        const nv = new Vec3(-x * depth, -y * depth, -radius).normalize();
        positions.push(x * radius, y * radius, 0, 0, 0, depth);
        normals.push(nv.x, nv.y, nv.z, 0, 0, -1);
        if (i > 0) {
            const b = (i - 1) * 2;
            indices.push(b, b + 2, b + 1, b + 1, b + 2, b + 3);
        }
    }
    return { positions, normals, indices };
};

type FixtureModel = { body: Geometry, emitter: Geometry, half: [number, number, number] };

const modelCache = new Map<string, FixtureModel>();

// the model of a fixture; `aspect` only matters for rect lights
const fixtureModel = (kind: FixtureKind, aspect: number): FixtureModel => {
    const key = `${kind}:${aspect.toFixed(3)}`;
    const cached = modelCache.get(key);
    if (cached) return cached;

    const body = new GeometryBuilder();
    const emitter = new GeometryBuilder();
    let half: [number, number, number] = [0.5, 0.5, 0.5];

    switch (kind) {
        case 'fresnel': {
            // housing behind the lens, cooling fins, barn doors and a yoke
            body.add(cylinder, trs(0, 0, 0.75, 90, 0, 0, 1.25, 1.4, 1.25));
            body.add(cylinder, trs(0, 0, 1.55, 90, 0, 0, 1.0, 0.25, 1.0));
            body.add(box, trs(0, 0.72, 0.8, 0, 0, 0, 0.5, 0.18, 0.9));
            [[0, 0.62, 0, 0], [0, -0.62, 0, 180], [0.62, 0, 0, -90], [-0.62, 0, 0, 90]].forEach(([x, y, , rz]) => {
                body.add(box, trs(x, y, -0.25, 0, 0, 0, 1, 1, 1).mul(trs(0, 0, 0, -35, 0, rz)).mul(trs(0, 0.25, -0.05, 0, 0, 0, 1.1, 0.5, 0.03)));
            });
            body.add(box, trs(0.82, 0, 0.75, 0, 0, 0, 0.08, 0.22, 0.22));
            body.add(box, trs(-0.82, 0, 0.75, 0, 0, 0, 0.08, 0.22, 0.22));
            body.add(box, trs(0, -0.95, 0.75, 0, 0, 0, 1.72, 0.08, 0.22));
            body.add(box, trs(0.82, -0.47, 0.75, 0, 0, 0, 0.08, 0.95, 0.12));
            body.add(box, trs(-0.82, -0.47, 0.75, 0, 0, 0, 0.08, 0.95, 0.12));
            emitter.add(disc, trs(0, 0, -0.01, 0, 0, 0, 1, 1, 1));
            half = [0.9, 1.0, 1.0];
            break;
        }
        case 'softbox':
        case 'stripbox': {
            const h = aspect;
            body.add(frustum(1, h, 0.22, 0.55), trs(0, 0, 0));
            body.add(cylinder, trs(0, 0, 0.62, 90, 0, 0, 0.3, 0.16, 0.3));
            body.add(box, trs(0, 0, 0.76, 0, 0, 0, 0.18, 0.18, 0.14));
            emitter.add(quad, trs(0, 0, -0.005, 0, 0, 0, 0.96, h * 0.96, 1));
            half = [0.5, h * 0.5, 0.45];
            break;
        }
        case 'panel': {
            const h = aspect;
            body.add(box, trs(0, 0, 0.05, 0, 0, 0, 1.06, h + 0.06, 0.1));
            body.add(box, trs(0.58, 0, 0.05, 0, 0, 0, 0.06, h * 0.6, 0.12));
            body.add(box, trs(-0.58, 0, 0.05, 0, 0, 0, 0.06, h * 0.6, 0.12));
            emitter.add(quad, trs(0, 0, -0.005, 0, 0, 0, 1, h, 1));
            half = [0.6, h * 0.5 + 0.03, 0.1];
            break;
        }
        case 'umbrella': {
            // reflective umbrella: the canopy faces the subject, the lamp head
            // sits in front of it pointing back into it, the shaft runs through
            const depth = 0.3;
            body.add(canopy(0.5, depth), trs(0, 0, 0, 0, 0, 0, 1.02, 1.02, 1.0).mul(trs(0, 0, 0.005)));
            body.add(cylinder, trs(0, 0, 0.05, 90, 0, 0, 0.012, 0.95, 0.012));
            body.add(cylinder, trs(0, 0, 0.42, 90, 0, 0, 0.12, 0.2, 0.12));
            emitter.add(canopy(0.5, depth), trs(0, 0, 0));
            half = [0.5, 0.5, 0.5];
            break;
        }
        case 'ring': {
            body.add(new TorusGeometry({ tubeRadius: 0.06, ringRadius: 0.42, segments: 40, sides: 10 }), trs(0, 0, 0.04, 90, 0, 0));
            body.add(box, trs(0, -0.55, 0.05, 0, 0, 0, 0.1, 0.2, 0.08));
            emitter.add(new TorusGeometry({ tubeRadius: 0.065, ringRadius: 0.42, segments: 40, sides: 10 }), trs(0, 0, 0, 90, 0, 0, 1, 0.6, 1));
            half = [0.5, 0.65, 0.1];
            break;
        }
        case 'bulb': {
            emitter.add(sphere, trs(0, 0, 0));
            body.add(cylinder, trs(0, 0.55, 0, 0, 0, 0, 0.35, 0.3, 0.35));
            body.add(cylinder, trs(0, 1.4, 0, 0, 0, 0, 0.06, 1.6, 0.06));
            half = [0.5, 1.2, 0.5];
            break;
        }
        case 'sun':
        default: {
            // a stylised sun with rays, the beam lines show its direction
            emitter.add(sphere, trs(0, 0, 0, 0, 0, 0, 3, 3, 3));
            for (let i = 0; i < 8; ++i) {
                body.add(cone, trs(0, 0, 0, 0, 0, i * 45).mul(trs(0, 2.6, 0, 0, 0, 0, 0.5, 1.2, 0.5)));
            }
            half = [3.2, 3.2, 1.5];
            break;
        }
    }

    const result = { body: body.geometry, emitter: emitter.geometry, half };
    modelCache.set(key, result);
    return result;
};

// stand: a unit pole (radius 0.5, y 0..1) scaled to the height, and three legs
const standModel = (() => {
    const g = new GeometryBuilder();
    // unit pole along +Y from 0 to 1; the legs are added per height below
    g.add(tube, trs(0, 0.5, 0, 0, 0, 0, 1, 1, 1));
    return g.geometry;
})();

const legModel = (() => {
    const g = new GeometryBuilder();
    for (let i = 0; i < 3; ++i) {
        // feet on y = 0, meeting the pole at y ~ 0.54
        g.add(tube, trs(0, 0, 0, 0, i * 120, 0).mul(trs(0.5, 0.27, 0, 0, 0, 62)).mul(trs(0, 0, 0, 0, 0, 0, 0.04, 1.15, 0.04)));
    }
    return g.geometry;
})();


export { FixtureKind, FixtureInfo, FixtureModel, Geometry, fixtures, fixtureKinds, fixtureModel, standModel, legModel };
