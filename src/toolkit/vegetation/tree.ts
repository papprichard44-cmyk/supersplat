import { dataUrlBytes, GlbMesh, GlbTexture, writeGlb } from './glb-writer';
import { srgbToLinear } from '../lighting/samples';

// Procedural trees with EZ-Tree (github.com/dgreenheck/ez-tree, MIT; bark
// and leaf textures CC0 from Poly Haven / TextureCan). The library and three.js
// are only loaded when the first tree is generated. The generated branches
// and leaves are written to a .glb with their textures, which the editor
// then uses like any imported model.

type Rgb = [number, number, number];

type TreeParams = {
    preset: string;
    seed: number;
    levels: number;             // branch recursion levels 0..3
    branching: number;          // multiplier on child branches per level
    gnarliness: number;         // multiplier on the twisting of branches
    leafCount: number;          // multiplier on leaves per branch tip
    leafSize: number;           // multiplier on leaf size
    leafType: string;           // '' = the preset's
    barkType: string;           // '' = the preset's
    leafTint: Rgb;              // sRGB
    barkTint: Rgb;
};

const treePresets = [
    'Oak Small', 'Oak Medium', 'Oak Large',
    'Ash Small', 'Ash Medium', 'Ash Large',
    'Aspen Small', 'Aspen Medium', 'Aspen Large',
    'Pine Small', 'Pine Medium', 'Pine Large',
    'Bush 1', 'Bush 2', 'Bush 3'
];

const leafTypes = ['Oak', 'Ash', 'Aspen', 'Pine'];
const barkTypes = ['Oak', 'Birch', 'Pine', 'Willow'];

const defaultTree = (): TreeParams => ({
    preset: 'Oak Medium',
    seed: 1,
    levels: 3,
    branching: 1,
    gnarliness: 1,
    leafCount: 1,
    leafSize: 1,
    leafType: '',
    barkType: '',
    leafTint: [1, 1, 1],
    barkTint: [1, 1, 1]
});

let library: Promise<any> | null = null;
const loadLibrary = () => {
    library = library ?? import('@dgreenheck/ez-tree');
    return library;
};

const toHex = (c: Rgb) => (Math.round(c[0] * 255) << 16) | (Math.round(c[1] * 255) << 8) | Math.round(c[2] * 255);
const fromHex = (hex: number): Rgb => [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];

// textures load asynchronously from the library's embedded data
const textureBytes = async (texture: any): Promise<GlbTexture | null> => {
    if (!texture) return null;
    for (let i = 0; i < 400; ++i) {
        const image = texture.image;
        if (image && (image.complete === undefined || image.complete) && image.width) break;
        await new Promise((resolve) => {
            setTimeout(resolve, 25);
        });
    }
    const src: string | undefined = texture.image?.src;
    if (!src) return null;
    if (src.startsWith('data:')) return dataUrlBytes(src);
    const response = await fetch(src);
    return { mimeType: response.headers.get('content-type') ?? 'image/png', bytes: new Uint8Array(await response.arrayBuffer()) };
};

const attribute = (geometry: any, name: string): Float32Array | null => {
    const a = geometry.getAttribute(name);
    return a ? new Float32Array(a.array) : null;
};

// the preset's own leaf / bark settings, for the panel's defaults
const presetInfo = async (preset: string) => {
    const ez = await loadLibrary();
    const tree = new ez.Tree();
    tree.loadPreset(preset);
    return {
        levels: tree.options.branch.levels as number,
        leafTint: fromHex(tree.options.leaves.tint),
        barkTint: fromHex(tree.options.bark.tint)
    };
};

const treeGlb = async (p: TreeParams): Promise<{ glb: ArrayBuffer, triangles: number }> => {
    const ez = await loadLibrary();
    const tree = new ez.Tree();
    tree.loadPreset(p.preset);
    const o = tree.options;
    o.seed = p.seed;
    o.branch.levels = Math.max(0, Math.min(3, Math.round(p.levels)));
    Object.keys(o.branch.children).forEach((k) => {
        o.branch.children[k] = Math.max(0, Math.round(o.branch.children[k] * p.branching));
    });
    Object.keys(o.branch.gnarliness).forEach((k) => {
        o.branch.gnarliness[k] *= p.gnarliness;
    });
    o.leaves.count = Math.max(0, Math.round(o.leaves.count * p.leafCount));
    o.leaves.size *= p.leafSize;
    if (p.leafType) o.leaves.type = ez.LeafType[p.leafType] ?? o.leaves.type;
    if (p.barkType) o.bark.type = ez.BarkType[p.barkType] ?? o.bark.type;
    o.leaves.tint = toHex(p.leafTint);
    o.bark.tint = toHex(p.barkTint);
    tree.generate();

    const meshes: GlbMesh[] = [];
    let triangles = 0;

    const branches = tree.branchesMesh;
    if (branches?.geometry?.getAttribute('position')) {
        const g = branches.geometry;
        const material = branches.material;
        const map = material.map;
        // the bark texture repeats: bake the repeat into the uvs
        const uvs = attribute(g, 'uv');
        if (uvs && map?.repeat) {
            for (let i = 0; i < uvs.length; i += 2) {
                uvs[i] *= map.repeat.x;
                uvs[i + 1] *= map.repeat.y;
            }
        }
        const tint = fromHex(o.bark.tint);
        meshes.push({
            name: 'branches',
            positions: attribute(g, 'position'),
            normals: attribute(g, 'normal'),
            uvs,
            indices: g.index.array,
            material: {
                name: 'bark',
                baseColor: [srgbToLinear(tint[0]), srgbToLinear(tint[1]), srgbToLinear(tint[2]), 1],
                texture: map ? await textureBytes(map) : null,
                roughness: 0.9
            }
        });
        triangles += g.index.count / 3;
    }

    const leaves = tree.leavesMesh;
    if (leaves?.geometry?.getAttribute('position') && o.leaves.count > 0) {
        const g = leaves.geometry;
        const material = leaves.material;
        const tint = fromHex(o.leaves.tint);
        const leafTexture = material.map ? await textureBytes(material.map) : null;
        meshes.push({
            name: 'leaves',
            positions: attribute(g, 'position'),
            normals: attribute(g, 'normal'),
            uvs: attribute(g, 'uv'),
            indices: g.index.array,
            material: {
                name: 'leaves',
                baseColor: [srgbToLinear(tint[0]), srgbToLinear(tint[1]), srgbToLinear(tint[2]), 1],
                texture: leafTexture ? { ...leafTexture, repeat: false } : null,
                alphaMode: 'MASK',
                alphaCutoff: o.leaves.alphaTest ?? 0.5,
                doubleSided: true,
                roughness: 0.7
            }
        });
        triangles += g.index.count / 3;
    }

    tree.traverse?.((child: any) => {
        child.geometry?.dispose?.();
    });

    return { glb: writeGlb(meshes), triangles };
};

export { TreeParams, defaultTree, treeGlb, presetInfo, treePresets, leafTypes, barkTypes };
