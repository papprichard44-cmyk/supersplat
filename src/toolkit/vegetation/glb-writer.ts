// A small glTF 2.0 binary (.glb) writer for generated meshes: positions,
// normals, uvs and indices, one material per mesh with an optional embedded
// base colour texture (PNG / JPEG bytes as they are, no re-encoding).

type GlbTexture = {
    mimeType: string;
    bytes: Uint8Array;
    repeat?: boolean;               // REPEAT wrapping (default), else CLAMP_TO_EDGE
};

type GlbMaterial = {
    name: string;
    baseColor: [number, number, number, number];   // linear
    texture?: GlbTexture | null;
    alphaMode?: 'OPAQUE' | 'MASK' | 'BLEND';
    alphaCutoff?: number;
    doubleSided?: boolean;
    roughness?: number;
    metalness?: number;
};

type GlbMesh = {
    name: string;
    positions: Float32Array;
    normals?: Float32Array | null;
    uvs?: Float32Array | null;
    indices: Uint16Array | Uint32Array;
    material: GlbMaterial;
};

const align4 = (n: number) => (n + 3) & ~3;

const writeGlb = (meshes: GlbMesh[]): ArrayBuffer => {
    const chunks: Uint8Array[] = [];
    let binLength = 0;
    const bufferViews: any[] = [];
    const accessors: any[] = [];
    const images: any[] = [];
    const textures: any[] = [];
    const samplers: any[] = [];
    const materials: any[] = [];
    const gltfMeshes: any[] = [];
    const nodes: any[] = [];

    // append bytes to the binary chunk, 4-byte aligned
    const addView = (bytes: Uint8Array, target?: number) => {
        const offset = binLength;
        chunks.push(bytes);
        binLength += bytes.byteLength;
        const pad = align4(binLength) - binLength;
        if (pad) {
            chunks.push(new Uint8Array(pad));
            binLength += pad;
        }
        bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.byteLength, ...(target ? { target } : {}) });
        return bufferViews.length - 1;
    };

    const addAccessor = (data: Float32Array, size: number, withBounds: boolean) => {
        const view = addView(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), 34962);
        const count = data.length / size;
        const accessor: any = { bufferView: view, componentType: 5126, count, type: ['SCALAR', 'VEC2', 'VEC3', 'VEC4'][size - 1] };
        if (withBounds) {
            const min = new Array(size).fill(Infinity);
            const max = new Array(size).fill(-Infinity);
            for (let i = 0; i < count; ++i) {
                for (let c = 0; c < size; ++c) {
                    const v = data[i * size + c];
                    if (v < min[c]) min[c] = v;
                    if (v > max[c]) max[c] = v;
                }
            }
            accessor.min = min;
            accessor.max = max;
        }
        accessors.push(accessor);
        return accessors.length - 1;
    };

    const textureCache = new Map<Uint8Array, number>();

    meshes.forEach((mesh, index) => {
        const m = mesh.material;
        const material: any = {
            name: m.name,
            pbrMetallicRoughness: {
                baseColorFactor: m.baseColor,
                metallicFactor: m.metalness ?? 0,
                roughnessFactor: m.roughness ?? 1
            },
            doubleSided: !!m.doubleSided
        };
        if (m.alphaMode && m.alphaMode !== 'OPAQUE') {
            material.alphaMode = m.alphaMode;
            if (m.alphaMode === 'MASK') material.alphaCutoff = m.alphaCutoff ?? 0.5;
        }
        if (m.texture) {
            let texture = textureCache.get(m.texture.bytes);
            if (texture === undefined) {
                const view = addView(m.texture.bytes);
                images.push({ bufferView: view, mimeType: m.texture.mimeType });
                const wrap = m.texture.repeat === false ? 33071 : 10497;
                samplers.push({ magFilter: 9729, minFilter: 9987, wrapS: wrap, wrapT: wrap });
                textures.push({ source: images.length - 1, sampler: samplers.length - 1 });
                texture = textures.length - 1;
                textureCache.set(m.texture.bytes, texture);
            }
            material.pbrMetallicRoughness.baseColorTexture = { index: texture };
        }
        materials.push(material);

        const attributes: any = { POSITION: addAccessor(mesh.positions, 3, true) };
        if (mesh.normals) attributes.NORMAL = addAccessor(mesh.normals, 3, false);
        if (mesh.uvs) attributes.TEXCOORD_0 = addAccessor(mesh.uvs, 2, false);

        const wide = mesh.indices instanceof Uint32Array;
        const indexView = addView(new Uint8Array(mesh.indices.buffer, mesh.indices.byteOffset, mesh.indices.byteLength), 34963);
        accessors.push({ bufferView: indexView, componentType: wide ? 5125 : 5123, count: mesh.indices.length, type: 'SCALAR' });
        const indices = accessors.length - 1;

        gltfMeshes.push({ name: mesh.name, primitives: [{ attributes, indices, material: index, mode: 4 }] });
        nodes.push({ name: mesh.name, mesh: gltfMeshes.length - 1 });
    });

    const json: any = {
        asset: { version: '2.0', generator: 'SuperSplat toolkit' },
        scene: 0,
        scenes: [{ nodes: nodes.map((_, i) => i) }],
        nodes,
        meshes: gltfMeshes,
        materials,
        accessors,
        bufferViews,
        buffers: [{ byteLength: binLength }]
    };
    if (images.length) {
        json.images = images;
        json.textures = textures;
        json.samplers = samplers;
    }

    let jsonBytes = new TextEncoder().encode(JSON.stringify(json));
    const jsonPadded = align4(jsonBytes.byteLength);
    if (jsonPadded !== jsonBytes.byteLength) {
        const padded = new Uint8Array(jsonPadded).fill(0x20);
        padded.set(jsonBytes);
        jsonBytes = padded;
    }

    const total = 12 + 8 + jsonBytes.byteLength + 8 + binLength;
    const out = new Uint8Array(total);
    const view = new DataView(out.buffer);
    view.setUint32(0, 0x46546C67, true);
    view.setUint32(4, 2, true);
    view.setUint32(8, total, true);
    view.setUint32(12, jsonBytes.byteLength, true);
    view.setUint32(16, 0x4E4F534A, true);
    out.set(jsonBytes, 20);
    let offset = 20 + jsonBytes.byteLength;
    view.setUint32(offset, binLength, true);
    view.setUint32(offset + 4, 0x004E4942, true);
    offset += 8;
    chunks.forEach((chunk) => {
        out.set(chunk, offset);
        offset += chunk.byteLength;
    });
    return out.buffer;
};

// bytes of a base64 data url
const dataUrlBytes = (url: string): GlbTexture => {
    const comma = url.indexOf(',');
    const header = url.slice(5, comma);
    const mimeType = header.split(';')[0] || 'image/png';
    const binary = atob(url.slice(comma + 1));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; ++i) bytes[i] = binary.charCodeAt(i);
    return { mimeType, bytes };
};

export { writeGlb, dataUrlBytes, GlbMesh, GlbMaterial, GlbTexture };
