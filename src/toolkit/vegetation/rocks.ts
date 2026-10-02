import { GlbMesh, GlbTexture, writeGlb } from './glb-writer';
import { srgbToLinear } from '../lighting/samples';

// Procedural rocks with SeedRock (github.com/reed-soul/SeedRock, MIT): its
// species presets and form generators (boulder, columnar, slate, crystal),
// without the erosion passes. One generation makes one rock or a whole group,
// each rock with its own seed, size, turn and tilt, written to a .glb with the
// species' stone texture mapped from three sides (triplanar, baked into uvs).
// The generator and its three.js dependency load with the first rock.

type RockParams = {
    species: string;
    seed: number;
    count: number;              // rocks in the group
    size: number;               // longest side of an average rock, scene units
    sizeVariation: number;      // 0..1: how much the rocks differ in size
    spread: number;             // group radius, in average rock sizes
    turn: number;               // 0..1: random turn about the vertical (1 = any)
    tilt: number;               // degrees: random lean of each rock
    flatten: number;            // 0..1: squash the rocks flatter
    roughness: number;          // 0..1: surface relief (noise amplitude)
    detail: number;             // mesh subdivisions 2..5
    sink: number;               // 0..0.5: share of each rock's height below the ground
    tintVariation: number;      // 0..1: colour difference between rocks
    tint: [number, number, number];  // sRGB, multiplied over the stone
};

const defaultRocks = (size = 0.5): RockParams => ({
    species: 'granite',
    seed: 1,
    count: 1,
    size,
    sizeVariation: 0.4,
    spread: 2,
    turn: 1,
    tilt: 15,
    flatten: 0,
    roughness: 1,
    detail: 4,
    sink: 0.15,
    tintVariation: 0.15,
    tint: [1, 1, 1]
});

const speciesNames: { key: string, name: string }[] = [
    { key: 'granite', name: 'Granite' },
    { key: 'sandstone', name: 'Sandstone' },
    { key: 'basalt', name: 'Basalt (columns)' },
    { key: 'limestone', name: 'Limestone' },
    { key: 'volcanic', name: 'Volcanic' },
    { key: 'glacial', name: 'Glacial boulder' },
    { key: 'riverCobble', name: 'River cobble' },
    { key: 'karst', name: 'Karst' },
    { key: 'schist', name: 'Schist' },
    { key: 'slate', name: 'Slate (slabs)' },
    { key: 'marble', name: 'Marble' },
    { key: 'obsidian', name: 'Obsidian' },
    { key: 'crystal', name: 'Crystal cluster' },
    { key: 'ore', name: 'Ore cluster' },
    { key: 'ice', name: 'Ice' }
];

const textureFile: Record<string, string> = {
    riverCobble: 'river_cobble'
};

let library: Promise<any> | null = null;
const loadLibrary = () => {
    library = library ?? Promise.all([
        import('./seedrock/species/index'),
        import('./seedrock/species/controls'),
        import('./seedrock/structure/graph'),
        import('./seedrock/core/noise'),
        import('./seedrock/core/rng')
    ]).then(([species, controls, graph, noise, rng]) => ({ species, controls, graph, noise, rng }));
    return library;
};

const textures = new Map<string, Promise<GlbTexture | null>>();
const loadTexture = (species: string) => {
    if (!textures.has(species)) {
        const name = textureFile[species] ?? species;
        textures.set(species, fetch(`static/rocks/${name}.jpg`)
        .then(r => (r.ok ? r.arrayBuffer() : null))
        .then(b => (b ? { mimeType: 'image/jpeg', bytes: new Uint8Array(b) } : null))
        .catch((): null => null));
    }
    return textures.get(species);
};

// small seeded generator for the placement of the rocks
const random = (seed: number) => {
    let a = (seed * 2654435761) >>> 0 || 1;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
};

// one rock's geometry from the species preset, without erosion
const rockGeometry = (lib: any, params: RockParams, seed: number) => {
    const preset = lib.species.SPECIES[params.species] ?? lib.species.SPECIES.granite;
    const base = lib.controls.controlsFromSpecies(preset);
    const merged = lib.controls.mergeControls(base, {
        seed,
        shape: {
            detail: Math.max(1, Math.min(5, Math.round(params.detail))),
            squash: (preset.shape.squash ?? 1) * (1 - 0.6 * params.flatten),
            amplitude: preset.noise.amplitude * params.roughness
        }
    });
    const shaped = lib.controls.applySpeciesControls(preset, merged);
    const rng = new lib.rng.Rng(`${shaped.id}:${seed}`);
    const noise = lib.noise.makeNoise3D(rng.int(1, 1_000_000));
    const graph = lib.graph.buildStructureGraph(shaped, rng, noise);
    const geometry = lib.graph.meshStructureGraph(graph, { detail: shaped.shape.detail ?? 4, style: 'pbr' });
    geometry.computeVertexNormals();
    return { geometry, preset: shaped };
};

// re-index a mesh so every triangle takes its uvs from the side it faces most
// (x, y or z): the stone texture then lies on the rock from three sides
const triplanar = (positions: Float32Array, normals: Float32Array, indices: ArrayLike<number>, scale: number) => {
    const map = new Map<number, number>();
    const outPos: number[] = [];
    const outNrm: number[] = [];
    const outUv: number[] = [];
    const outIdx: number[] = [];
    for (let t = 0; t < indices.length; t += 3) {
        const a = indices[t], b = indices[t + 1], c = indices[t + 2];
        // face normal
        const ux = positions[b * 3] - positions[a * 3], uy = positions[b * 3 + 1] - positions[a * 3 + 1], uz = positions[b * 3 + 2] - positions[a * 3 + 2];
        const vx = positions[c * 3] - positions[a * 3], vy = positions[c * 3 + 1] - positions[a * 3 + 1], vz = positions[c * 3 + 2] - positions[a * 3 + 2];
        const nx = Math.abs(uy * vz - uz * vy), ny = Math.abs(uz * vx - ux * vz), nz = Math.abs(ux * vy - uy * vx);
        const axis = nx >= ny && nx >= nz ? 0 : (ny >= nz ? 1 : 2);
        [a, b, c].forEach((v) => {
            const key = v * 3 + axis;
            let index = map.get(key);
            if (index === undefined) {
                index = outPos.length / 3;
                map.set(key, index);
                const x = positions[v * 3], y = positions[v * 3 + 1], z = positions[v * 3 + 2];
                outPos.push(x, y, z);
                outNrm.push(normals[v * 3], normals[v * 3 + 1], normals[v * 3 + 2]);
                if (axis === 0) outUv.push(z * scale, -y * scale);
                else if (axis === 1) outUv.push(x * scale, z * scale);
                else outUv.push(x * scale, -y * scale);
            }
            outIdx.push(index);
        });
    }
    return {
        positions: new Float32Array(outPos),
        normals: new Float32Array(outNrm),
        uvs: new Float32Array(outUv),
        indices: outPos.length / 3 > 65535 ? new Uint32Array(outIdx) : new Uint16Array(outIdx)
    };
};

/**
 * Generate a rock or a group of rocks as a .glb, in scene units, standing on
 * y = 0 (sunk a little into it) around the origin.
 */
const rocksGlb = async (params: RockParams) => {
    const lib = await loadLibrary();
    const texture = await loadTexture(params.species);
    const rand = random(params.seed);
    const count = Math.max(1, Math.round(params.count));
    const meshes: GlbMesh[] = [];
    const placed: { x: number, z: number, r: number }[] = [];
    let triangles = 0;
    // room for a rock of radius r at (x, z) without piling into the others
    const free = (x: number, z: number, r: number) => placed.every(o => Math.hypot(o.x - x, o.z - z) > (o.r + r) * 0.8);

    for (let i = 0; i < count; ++i) {
        const { geometry, preset } = rockGeometry(lib, params, params.seed * 1000 + i);
        const position = geometry.getAttribute('position');
        const normal = geometry.getAttribute('normal');
        const index = geometry.index;
        const src = new Float32Array(position.array);
        const nrm = new Float32Array(normal.array);
        const idx = index ? index.array : Uint32Array.from({ length: src.length / 3 }, (_, k) => k);

        // normalise to a longest side of 1 around its centre
        const min = [Infinity, Infinity, Infinity];
        const max = [-Infinity, -Infinity, -Infinity];
        for (let v = 0; v < src.length; v += 3) {
            for (let k = 0; k < 3; ++k) {
                min[k] = Math.min(min[k], src[v + k]);
                max[k] = Math.max(max[k], src[v + k]);
            }
        }
        const longest = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]) || 1;
        const centre = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
        for (let v = 0; v < src.length; v += 3) {
            for (let k = 0; k < 3; ++k) src[v + k] = (src[v + k] - centre[k]) / longest;
        }
        // uvs in the rock's own frame: the texture keeps its scale on every rock
        const mesh = triplanar(src, nrm, idx, (preset.textures?.triplanarScale ?? 0.45) * 2.2);

        // this rock's size, turn and lean
        const k = params.size * Math.max(0.15, 1 + (rand() * 2 - 1) * params.sizeVariation);
        const yaw = (rand() * 2 - 1) * Math.PI * params.turn;
        const tiltAngle = (rand() * 2 - 1) * params.tilt * Math.PI / 180;
        const tiltDir = rand() * Math.PI * 2;
        // rotation: lean about a horizontal axis, then turn about y
        const ax = Math.cos(tiltDir), az = Math.sin(tiltDir);
        const cs = Math.cos(tiltAngle), sn = Math.sin(tiltAngle);
        const cy = Math.cos(yaw), sy = Math.sin(yaw);
        const rotate = (x: number, y: number, z: number): [number, number, number] => {
            // Rodrigues about (ax, 0, az)
            const dot = x * ax + z * az;
            const cx = -az * y;                 // (axis x v).x = 0*z - az*y
            const cyy = az * x - ax * z;        // (axis x v).y
            const cz = ax * y;                  // (axis x v).z
            let rx = x * cs + cx * sn + ax * dot * (1 - cs);
            const ry = y * cs + cyy * sn;
            let rz = z * cs + cz * sn + az * dot * (1 - cs);
            const tx = rx * cy + rz * sy;
            rz = -rx * sy + rz * cy;
            rx = tx;
            return [rx, ry, rz];
        };

        // where it lies: spread around the centre without piling into the others
        let px = 0, pz = 0;
        if (count > 1) {
            const radius = params.spread * params.size;
            for (let attempt = 0; attempt < 30; ++attempt) {
                const a = rand() * Math.PI * 2;
                const r = Math.sqrt(rand()) * radius;
                px = Math.cos(a) * r;
                pz = Math.sin(a) * r;
                if (free(px, pz, k * 0.5)) break;
            }
        }
        placed.push({ x: px, z: pz, r: k * 0.5 });

        let lowest = Infinity;
        let top = -Infinity;
        for (let v = 0; v < mesh.positions.length; v += 3) {
            const [x, y, z] = rotate(mesh.positions[v] * k, mesh.positions[v + 1] * k, mesh.positions[v + 2] * k);
            mesh.positions[v] = x + px;
            mesh.positions[v + 1] = y;
            mesh.positions[v + 2] = z + pz;
            lowest = Math.min(lowest, y);
            top = Math.max(top, y);
            const n = rotate(mesh.normals[v], mesh.normals[v + 1], mesh.normals[v + 2]);
            mesh.normals[v] = n[0];
            mesh.normals[v + 1] = n[1];
            mesh.normals[v + 2] = n[2];
        }
        // stand on the ground, sunk by part of its height
        const drop = lowest + (top - lowest) * params.sink;
        for (let v = 1; v < mesh.positions.length; v += 3) mesh.positions[v] -= drop;

        const shade = 1 + (rand() * 2 - 1) * params.tintVariation * 0.5;
        const hue = (rand() * 2 - 1) * params.tintVariation * 0.08;
        const base = texture ? [1, 1, 1] : [((preset.color >> 16) & 255) / 255, ((preset.color >> 8) & 255) / 255, (preset.color & 255) / 255];
        const c = [
            base[0] * params.tint[0] * shade * (1 + hue),
            base[1] * params.tint[1] * shade,
            base[2] * params.tint[2] * shade * (1 - hue)
        ].map(v => srgbToLinear(Math.max(0, Math.min(1, v))));

        meshes.push({
            name: `rock_${i}`,
            ...mesh,
            material: {
                name: `${params.species}_${i}`,
                baseColor: [c[0], c[1], c[2], 1],
                texture,
                roughness: preset.roughness ?? 0.9,
                metalness: preset.metalness ?? 0
            }
        });
        triangles += mesh.indices.length / 3;
        geometry.dispose();
    }

    return { glb: writeGlb(meshes), triangles };
};

export { RockParams, defaultRocks, rocksGlb, speciesNames };
