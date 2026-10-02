/**
 * Converts a glTF binary (.glb) mesh into gaussian splats.
 *
 * The GLB is parsed directly (no engine asset is created), every triangle is
 * transformed to world space, and the surface is then sampled uniformly by
 * area. Each sample becomes a flat gaussian disc lying in its triangle's plane,
 * coloured by the material's base colour (factor x vertex colour x texture).
 * The result is written as a standard 3DGS PLY so the regular splat loader can
 * load it like any other file.
 */

// glTF component types
const BYTE = 5120;
const UNSIGNED_BYTE = 5121;
const SHORT = 5122;
const UNSIGNED_SHORT = 5123;
const UNSIGNED_INT = 5125;
const FLOAT = 5126;

// glTF sampler wrap modes
const CLAMP_TO_EDGE = 33071;
const MIRRORED_REPEAT = 33648;

const typeSizes: Record<string, number> = {
    SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16
};

// extensions that change how geometry is stored and that this reader can't decode
const unsupportedExtensions = ['KHR_draco_mesh_compression', 'EXT_meshopt_compression', 'KHR_meshopt_compression'];

// largest texture side kept in memory for colour lookups
const MAX_TEXTURE_SIZE = 2048;

// zeroth order spherical harmonic constant
const SH_C0 = 0.28209479177387814;

type Texture = {
    width: number;
    height: number;
    data: Uint8ClampedArray;
    wrapS: number;
    wrapT: number;
    texCoord: number;
    // KHR_texture_transform as a 2x3 matrix (row major), or null for identity
    uvTransform: Float32Array | null;
};

type Material = {
    baseColor: [number, number, number, number];
    texture: Texture | null;
    alphaMode: 'OPAQUE' | 'MASK' | 'BLEND';
    alphaCutoff: number;
};

// one primitive's triangles, with positions already in world space
type Batch = {
    positions: Float32Array;        // xyz per vertex
    uvs: Float32Array | null;       // uv per vertex (the material's texCoord set)
    colors: Float32Array | null;    // linear rgba per vertex
    indices: Uint32Array;           // 3 per triangle
    material: Material;
};

type MeshData = {
    batches: Batch[];
    numTriangles: number;
    surfaceArea: number;
};

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const linearToSrgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

// lookup table from 8-bit sRGB to linear
const srgbTable = new Float32Array(256);
for (let i = 0; i < 256; ++i) srgbTable[i] = srgbToLinear(i / 255);

const decodeDataUri = (uri: string): Uint8Array => {
    const comma = uri.indexOf(',');
    if (!uri.startsWith('data:') || comma < 0 || !uri.slice(0, comma).endsWith(';base64')) {
        throw new Error('GLB references an external resource, only self-contained GLB files are supported');
    }
    const binary = atob(uri.slice(comma + 1));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; ++i) bytes[i] = binary.charCodeAt(i);
    return bytes;
};

// 4x4 column-major matrix helpers
const mat4Identity = () => new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

const mat4Mul = (a: Float64Array, b: Float64Array) => {
    const r = new Float64Array(16);
    for (let c = 0; c < 4; ++c) {
        for (let row = 0; row < 4; ++row) {
            r[c * 4 + row] =
                a[row] * b[c * 4] +
                a[4 + row] * b[c * 4 + 1] +
                a[8 + row] * b[c * 4 + 2] +
                a[12 + row] * b[c * 4 + 3];
        }
    }
    return r;
};

const nodeMatrix = (node: any) => {
    if (node.matrix) return new Float64Array(node.matrix);

    const [tx, ty, tz] = node.translation ?? [0, 0, 0];
    const [qx, qy, qz, qw] = node.rotation ?? [0, 0, 0, 1];
    const [sx, sy, sz] = node.scale ?? [1, 1, 1];

    const xx = qx * qx, yy = qy * qy, zz = qz * qz;
    const xy = qx * qy, xz = qx * qz, yz = qy * qz;
    const wx = qw * qx, wy = qw * qy, wz = qw * qz;

    return new Float64Array([
        (1 - 2 * (yy + zz)) * sx, 2 * (xy + wz) * sx, 2 * (xz - wy) * sx, 0,
        2 * (xy - wz) * sy, (1 - 2 * (xx + zz)) * sy, 2 * (yz + wx) * sy, 0,
        2 * (xz + wy) * sz, 2 * (yz - wx) * sz, (1 - 2 * (xx + yy)) * sz, 0,
        tx, ty, tz, 1
    ]);
};

const triangleArea = (p: Float32Array, a: number, b: number, c: number) => {
    const ax = p[a * 3], ay = p[a * 3 + 1], az = p[a * 3 + 2];
    const e1x = p[b * 3] - ax, e1y = p[b * 3 + 1] - ay, e1z = p[b * 3 + 2] - az;
    const e2x = p[c * 3] - ax, e2y = p[c * 3 + 1] - ay, e2z = p[c * 3 + 2] - az;
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    return 0.5 * Math.sqrt(nx * nx + ny * ny + nz * nz);
};

class GlbReader {
    private json: any;
    private buffers: Uint8Array[];
    private textureCache = new Map<number, Promise<Texture | null>>();
    private materialCache = new Map<number, Promise<Material>>();

    constructor(arrayBuffer: ArrayBuffer) {
        const view = new DataView(arrayBuffer);
        if (arrayBuffer.byteLength < 20 || view.getUint32(0, true) !== 0x46546C67) {
            throw new Error('Not a valid GLB file');
        }
        if (view.getUint32(4, true) !== 2) {
            throw new Error('Only glTF 2.0 GLB files are supported');
        }

        const length = Math.min(view.getUint32(8, true), arrayBuffer.byteLength);
        let binChunk: Uint8Array = null;
        let offset = 12;
        while (offset + 8 <= length) {
            const chunkLength = view.getUint32(offset, true);
            const chunkType = view.getUint32(offset + 4, true);
            const chunk = new Uint8Array(arrayBuffer, offset + 8, Math.min(chunkLength, length - offset - 8));
            if (chunkType === 0x4E4F534A) {            // JSON
                this.json = JSON.parse(new TextDecoder().decode(chunk));
            } else if (chunkType === 0x004E4942) {     // BIN
                binChunk = chunk;
            }
            offset += 8 + chunkLength;
        }

        if (!this.json) {
            throw new Error('GLB file is missing its JSON chunk');
        }

        const required: string[] = this.json.extensionsRequired ?? [];
        const unsupported = required.filter(e => unsupportedExtensions.includes(e));
        if (unsupported.length > 0) {
            throw new Error(`GLB uses compressed geometry (${unsupported.join(', ')}), which is not supported`);
        }

        this.buffers = (this.json.buffers ?? []).map((buffer: any, i: number) => {
            if (buffer.uri === undefined) {
                if (i !== 0 || !binChunk) throw new Error('GLB is missing its binary chunk');
                return binChunk;
            }
            return decodeDataUri(buffer.uri);
        });
    }

    private bufferView(index: number) {
        const bv = this.json.bufferViews[index];
        const buffer = this.buffers[bv.buffer];
        return {
            bytes: new Uint8Array(buffer.buffer, buffer.byteOffset + (bv.byteOffset ?? 0), bv.byteLength),
            byteStride: bv.byteStride as number | undefined
        };
    }

    // read a typed run of `count` elements of `size` components, de-normalizing
    // integer data when `normalized` is set
    private readElements(bytes: Uint8Array, byteOffset: number, byteStride: number | undefined, componentType: number,
        normalized: boolean, size: number, count: number, out: Float32Array) {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const componentSize = componentType === FLOAT || componentType === UNSIGNED_INT ? 4 :
            (componentType === SHORT || componentType === UNSIGNED_SHORT ? 2 : 1);
        const stride = byteStride || componentSize * size;

        for (let i = 0; i < count; ++i) {
            for (let c = 0; c < size; ++c) {
                const o = byteOffset + i * stride + c * componentSize;
                let v: number;
                switch (componentType) {
                    case FLOAT: v = view.getFloat32(o, true); break;
                    case UNSIGNED_INT: v = view.getUint32(o, true); break;
                    case SHORT: v = view.getInt16(o, true); if (normalized) v = Math.max(v / 32767, -1); break;
                    case UNSIGNED_SHORT: v = view.getUint16(o, true); if (normalized) v /= 65535; break;
                    case BYTE: v = view.getInt8(o); if (normalized) v = Math.max(v / 127, -1); break;
                    case UNSIGNED_BYTE: v = view.getUint8(o); if (normalized) v /= 255; break;
                    default: throw new Error(`Unsupported accessor component type ${componentType}`);
                }
                out[i * size + c] = v;
            }
        }
    }

    // read an accessor as floats, `size` components per element
    readAccessor(index: number): { data: Float32Array, size: number, count: number } {
        const accessor = this.json.accessors[index];
        const size = typeSizes[accessor.type];
        const count = accessor.count;
        const normalized = !!accessor.normalized;
        const data = new Float32Array(count * size);

        if (accessor.bufferView !== undefined) {
            const { bytes, byteStride } = this.bufferView(accessor.bufferView);
            this.readElements(bytes, accessor.byteOffset ?? 0, byteStride, accessor.componentType, normalized, size, count, data);
        }

        const sparse = accessor.sparse;
        if (sparse) {
            const indices = new Float32Array(sparse.count);
            const iv = this.bufferView(sparse.indices.bufferView);
            this.readElements(iv.bytes, sparse.indices.byteOffset ?? 0, undefined, sparse.indices.componentType, false, 1, sparse.count, indices);
            const values = new Float32Array(sparse.count * size);
            const vv = this.bufferView(sparse.values.bufferView);
            this.readElements(vv.bytes, sparse.values.byteOffset ?? 0, undefined, accessor.componentType, normalized, size, sparse.count, values);
            for (let i = 0; i < sparse.count; ++i) {
                data.set(values.subarray(i * size, (i + 1) * size), indices[i] * size);
            }
        }

        return { data, size, count };
    }

    private async decodeImage(imageIndex: number): Promise<{ width: number, height: number, data: Uint8ClampedArray } | null> {
        const image = this.json.images?.[imageIndex];
        if (!image) return null;

        let blob: Blob;
        if (image.bufferView !== undefined) {
            const { bytes } = this.bufferView(image.bufferView);
            blob = new Blob([bytes.slice()], { type: image.mimeType ?? 'image/png' });
        } else if (image.uri?.startsWith('data:')) {
            blob = new Blob([decodeDataUri(image.uri).slice()], { type: image.mimeType ?? image.uri.slice(5, image.uri.indexOf(';')) });
        } else {
            return null;
        }

        try {
            const probe = await createImageBitmap(blob);
            const scale = Math.min(1, MAX_TEXTURE_SIZE / Math.max(probe.width, probe.height));
            const width = Math.max(1, Math.round(probe.width * scale));
            const height = Math.max(1, Math.round(probe.height * scale));
            probe.close();

            const bitmap = await createImageBitmap(blob, {
                resizeWidth: width,
                resizeHeight: height,
                resizeQuality: 'medium',
                premultiplyAlpha: 'none',
                colorSpaceConversion: 'none'
            });
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const context = canvas.getContext('2d', { willReadFrequently: true });
            context.drawImage(bitmap, 0, 0);
            bitmap.close();
            return { width, height, data: context.getImageData(0, 0, width, height).data };
        } catch (err) {
            // undecodable (e.g. KTX2) textures fall back to the material's factor
            console.warn(`Failed to decode GLB image ${imageIndex}`, err);
            return null;
        }
    }

    private loadTexture(info: any): Promise<Texture | null> {
        if (!info || info.index === undefined) return Promise.resolve(null);

        const key = info.index;
        if (!this.textureCache.has(key)) {
            this.textureCache.set(key, (async () => {
                const texture = this.json.textures?.[info.index];
                if (!texture) return null;
                const ext = texture.extensions ?? {};
                const source = texture.source ?? ext.EXT_texture_webp?.source ?? ext.EXT_texture_avif?.source;
                if (source === undefined) return null;

                const image = await this.decodeImage(source);
                if (!image) return null;

                const sampler = texture.sampler !== undefined ? this.json.samplers?.[texture.sampler] ?? {} : {};
                return {
                    ...image,
                    wrapS: sampler.wrapS ?? 10497,
                    wrapT: sampler.wrapT ?? 10497,
                    texCoord: 0,
                    uvTransform: null as Float32Array | null
                };
            })());
        }

        return this.textureCache.get(key).then((texture) => {
            if (!texture) return null;

            // texCoord and transform live on the texture info, so may differ per material
            const transform = info.extensions?.KHR_texture_transform;
            let uvTransform: Float32Array = null;
            if (transform) {
                const [ox, oy] = transform.offset ?? [0, 0];
                const [sx, sy] = transform.scale ?? [1, 1];
                const r = transform.rotation ?? 0;
                const c = Math.cos(r), s = Math.sin(r);
                // T * R * S as defined by the extension
                uvTransform = new Float32Array([c * sx, s * sy, ox, -s * sx, c * sy, oy]);
            }
            return {
                ...texture,
                texCoord: transform?.texCoord ?? info.texCoord ?? 0,
                uvTransform
            };
        });
    }

    private loadMaterial(index: number | undefined): Promise<Material> {
        const key = index ?? -1;
        if (!this.materialCache.has(key)) {
            this.materialCache.set(key, (async () => {
                const material = index !== undefined ? this.json.materials?.[index] ?? {} : {};
                const pbr = material.pbrMetallicRoughness ?? {};
                const specGloss = material.extensions?.KHR_materials_pbrSpecularGlossiness;
                const baseColor = specGloss?.diffuseFactor ?? pbr.baseColorFactor ?? [1, 1, 1, 1];
                const textureInfo = specGloss?.diffuseTexture ?? pbr.baseColorTexture;
                return {
                    baseColor: [baseColor[0], baseColor[1], baseColor[2], baseColor[3]],
                    texture: await this.loadTexture(textureInfo),
                    alphaMode: material.alphaMode ?? 'OPAQUE',
                    alphaCutoff: material.alphaCutoff ?? 0.5
                };
            })());
        }
        return this.materialCache.get(key);
    }

    private triangleIndices(primitive: any, numVertices: number): Uint32Array | null {
        const mode = primitive.mode ?? 4;
        let indices: Uint32Array;
        if (primitive.indices !== undefined) {
            indices = Uint32Array.from(this.readAccessor(primitive.indices).data);
        } else {
            indices = new Uint32Array(numVertices);
            for (let i = 0; i < numVertices; ++i) indices[i] = i;
        }

        if (mode === 4) {
            return indices.subarray(0, indices.length - indices.length % 3);
        }

        if (mode === 5 || mode === 6) {
            // triangle strip / fan
            const numTriangles = Math.max(0, indices.length - 2);
            const result = new Uint32Array(numTriangles * 3);
            for (let i = 0; i < numTriangles; ++i) {
                if (mode === 5) {
                    const even = (i % 2) === 0;
                    result[i * 3] = indices[i];
                    result[i * 3 + 1] = even ? indices[i + 1] : indices[i + 2];
                    result[i * 3 + 2] = even ? indices[i + 2] : indices[i + 1];
                } else {
                    result[i * 3] = indices[0];
                    result[i * 3 + 1] = indices[i + 1];
                    result[i * 3 + 2] = indices[i + 2];
                }
            }
            return result;
        }

        // points and lines have no surface to sample
        return null;
    }

    private async readPrimitive(primitive: any, world: Float64Array): Promise<Batch | null> {
        const attributes = primitive.attributes ?? {};
        if (attributes.POSITION === undefined) return null;

        const position = this.readAccessor(attributes.POSITION);
        const indices = this.triangleIndices(primitive, position.count);
        if (!indices || indices.length === 0) return null;

        // transform positions to world space
        const positions = new Float32Array(position.count * 3);
        const p = position.data;
        for (let i = 0; i < position.count; ++i) {
            const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2];
            positions[i * 3] = world[0] * x + world[4] * y + world[8] * z + world[12];
            positions[i * 3 + 1] = world[1] * x + world[5] * y + world[9] * z + world[13];
            positions[i * 3 + 2] = world[2] * x + world[6] * y + world[10] * z + world[14];
        }

        const material = await this.loadMaterial(primitive.material);

        let uvs: Float32Array = null;
        const uvAttribute = material.texture ? attributes[`TEXCOORD_${material.texture.texCoord}`] : undefined;
        if (uvAttribute !== undefined) {
            uvs = this.readAccessor(uvAttribute).data;
        }

        let colors: Float32Array = null;
        if (attributes.COLOR_0 !== undefined) {
            const color = this.readAccessor(attributes.COLOR_0);
            colors = new Float32Array(color.count * 4);
            for (let i = 0; i < color.count; ++i) {
                colors[i * 4] = color.data[i * color.size];
                colors[i * 4 + 1] = color.data[i * color.size + 1];
                colors[i * 4 + 2] = color.data[i * color.size + 2];
                colors[i * 4 + 3] = color.size === 4 ? color.data[i * 4 + 3] : 1;
            }
        }

        return { positions, uvs, colors, indices, material };
    }

    async read(): Promise<MeshData> {
        const json = this.json;
        const nodes: any[] = json.nodes ?? [];
        const batches: Batch[] = [];

        let roots: number[];
        const scene = json.scenes?.[json.scene ?? 0];
        if (scene) {
            roots = scene.nodes ?? [];
        } else {
            // no scene: treat every node that isn't a child as a root
            const children = new Set<number>(nodes.flatMap(n => n.children ?? []));
            roots = nodes.map((_, i) => i).filter(i => !children.has(i));
        }

        const visit = async (nodeIndex: number, parent: Float64Array, depth: number) => {
            const node = nodes[nodeIndex];
            if (!node || depth > 256) return;
            const world = mat4Mul(parent, nodeMatrix(node));
            if (node.mesh !== undefined) {
                for (const primitive of json.meshes[node.mesh].primitives ?? []) {
                    const batch = await this.readPrimitive(primitive, world);
                    if (batch) batches.push(batch);
                }
            }
            for (const child of node.children ?? []) {
                await visit(child, world, depth + 1);
            }
        };

        for (const root of roots) {
            await visit(root, mat4Identity(), 0);
        }

        let numTriangles = 0;
        let surfaceArea = 0;
        for (const batch of batches) {
            const { positions, indices } = batch;
            numTriangles += indices.length / 3;
            for (let t = 0; t < indices.length; t += 3) {
                surfaceArea += triangleArea(positions, indices[t], indices[t + 1], indices[t + 2]);
            }
        }

        return { batches, numTriangles, surfaceArea };
    }
}

const wrap = (v: number, mode: number) => {
    if (mode === CLAMP_TO_EDGE) return Math.min(1, Math.max(0, v));
    const f = v - Math.floor(v);
    if (mode === MIRRORED_REPEAT) return (Math.floor(v) & 1) ? 1 - f : f;
    return f;
};

// nearest-neighbour texture lookup, returning linear rgb and alpha into `out`
const sampleTexture = (texture: Texture, u: number, v: number, out: Float32Array) => {
    if (texture.uvTransform) {
        const m = texture.uvTransform;
        const tu = m[0] * u + m[1] * v + m[2];
        const tv = m[3] * u + m[4] * v + m[5];
        u = tu;
        v = tv;
    }
    const x = Math.min(texture.width - 1, Math.floor(wrap(u, texture.wrapS) * texture.width));
    const y = Math.min(texture.height - 1, Math.floor(wrap(v, texture.wrapT) * texture.height));
    const i = (y * texture.width + x) * 4;
    out[0] = srgbTable[texture.data[i]];
    out[1] = srgbTable[texture.data[i + 1]];
    out[2] = srgbTable[texture.data[i + 2]];
    out[3] = texture.data[i + 3] / 255;
};

/**
 * Parse a GLB file into world-space triangle batches.
 *
 * @param arrayBuffer - The GLB file contents.
 * @returns The parsed mesh data.
 */
const readGlb = (arrayBuffer: ArrayBuffer): Promise<MeshData> => {
    return new GlbReader(arrayBuffer).read();
};

// gaussian properties in the order written to the PLY
const plyProperties = [
    'x', 'y', 'z',
    'f_dc_0', 'f_dc_1', 'f_dc_2',
    'opacity',
    'scale_0', 'scale_1', 'scale_2',
    'rot_0', 'rot_1', 'rot_2', 'rot_3'
];

/**
 * Sample the surface of a mesh into gaussian splats and encode them as a 3DGS
 * PLY file.
 *
 * glTF is Y-up while the editor labels PLY data as rotated 180 degrees about Z,
 * so samples are written with x and y negated to appear upright once loaded.
 *
 * @param mesh - The mesh to sample.
 * @param targetCount - The approximate number of splats to generate.
 * @returns The PLY file and the number of splats it holds.
 */
const meshToSplatPly = (mesh: MeshData, targetCount: number): { blob: Blob, count: number } => {
    const { batches, surfaceArea } = mesh;
    if (!(surfaceArea > 0)) {
        throw new Error('The mesh has no surface to convert');
    }

    const density = targetCount / surfaceArea;
    const spacing = Math.sqrt(surfaceArea / targetCount);
    // in-plane extent: wide enough that neighbouring discs overlap into a
    // closed surface. the normal axis is kept thin so the discs stay flat.
    const logScaleT = Math.log(spacing * 0.85);
    const logScaleN = Math.log(spacing * 0.05);

    // first pass: decide how many samples each triangle receives. the fractional
    // part of each triangle's expected count is carried over to the next one
    // (error diffusion) instead of being rounded at random: neighbouring
    // triangles are usually neighbours in the index buffer, so this keeps the
    // density even where random rounding left thin patches and clumps.
    let carry = 0.5;
    const counts = batches.map(b => new Uint32Array(b.indices.length / 3));
    let total = 0;
    batches.forEach((batch, bi) => {
        const { positions, indices } = batch;
        const batchCounts = counts[bi];
        for (let t = 0; t < batchCounts.length; ++t) {
            const area = triangleArea(positions, indices[t * 3], indices[t * 3 + 1], indices[t * 3 + 2]);
            carry += area * density;
            const n = Math.floor(carry);
            carry -= n;
            batchCounts[t] = n;
            total += n;
        }
    });

    const numProps = plyProperties.length;
    const data = new Float32Array(total * numProps);
    const texel = new Float32Array(4);
    let count = 0;

    batches.forEach((batch, bi) => {
        const { positions: p, uvs, colors, indices, material } = batch;
        const batchCounts = counts[bi];
        const [fr, fg, fb, fa] = material.baseColor;
        const texture = uvs ? material.texture : null;

        for (let t = 0; t < batchCounts.length; ++t) {
            const n = batchCounts[t];
            if (n === 0) continue;

            const ia = indices[t * 3], ib = indices[t * 3 + 1], ic = indices[t * 3 + 2];
            const ax = p[ia * 3], ay = p[ia * 3 + 1], az = p[ia * 3 + 2];
            const e1x = p[ib * 3] - ax, e1y = p[ib * 3 + 1] - ay, e1z = p[ib * 3 + 2] - az;
            const e2x = p[ic * 3] - ax, e2y = p[ic * 3 + 1] - ay, e2z = p[ic * 3 + 2] - az;

            // triangle frame: normal and an in-plane tangent
            let nx = e1y * e2z - e1z * e2y;
            let ny = e1z * e2x - e1x * e2z;
            let nz = e1x * e2y - e1y * e2x;
            const nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
            const tl = Math.sqrt(e1x * e1x + e1y * e1y + e1z * e1z);
            if (!(nl > 0) || !(tl > 0)) continue;
            nx /= nl; ny /= nl; nz /= nl;
            const tx = e1x / tl, ty = e1y / tl, tz = e1z / tl;
            const bx = ny * tz - nz * ty, by = nz * tx - nx * tz, bz = nx * ty - ny * tx;

            // samples follow a low-discrepancy (R2) sequence with a random start
            // per triangle. plain random points clump and leave holes of every
            // size, which showed up as a sieve-like surface that no amount of
            // extra splats could close; this sequence fills the triangle evenly.
            const o1 = Math.random();
            const o2 = Math.random();

            for (let s = 0; s < n; ++s) {
                // evenly spread barycentric sample
                let r1 = (o1 + (s + 1) * 0.7548776662466927) % 1;
                let r2 = (o2 + (s + 1) * 0.5698402909980532) % 1;
                if (r1 + r2 > 1) {
                    r1 = 1 - r1;
                    r2 = 1 - r2;
                }
                const w0 = 1 - r1 - r2;

                // base colour (linear) and alpha
                let r = fr, g = fg, b = fb, a = fa;
                if (colors) {
                    r *= colors[ia * 4] * w0 + colors[ib * 4] * r1 + colors[ic * 4] * r2;
                    g *= colors[ia * 4 + 1] * w0 + colors[ib * 4 + 1] * r1 + colors[ic * 4 + 1] * r2;
                    b *= colors[ia * 4 + 2] * w0 + colors[ib * 4 + 2] * r1 + colors[ic * 4 + 2] * r2;
                    a *= colors[ia * 4 + 3] * w0 + colors[ib * 4 + 3] * r1 + colors[ic * 4 + 3] * r2;
                }
                if (texture) {
                    const u = uvs[ia * 2] * w0 + uvs[ib * 2] * r1 + uvs[ic * 2] * r2;
                    const v = uvs[ia * 2 + 1] * w0 + uvs[ib * 2 + 1] * r1 + uvs[ic * 2 + 1] * r2;
                    sampleTexture(texture, u, v, texel);
                    r *= texel[0];
                    g *= texel[1];
                    b *= texel[2];
                    a *= texel[3];
                }

                if (material.alphaMode === 'OPAQUE') {
                    a = 1;
                } else if (material.alphaMode === 'MASK') {
                    if (a < material.alphaCutoff) continue;
                    a = 1;
                } else if (a < 1 / 255) {
                    continue;
                }

                // random spin about the normal so the discs don't line up in streaks
                const angle = Math.random() * Math.PI * 2;
                const ca = Math.cos(angle), sa = Math.sin(angle);
                // rotation columns in PLY space (x and y negated): tangent, bitangent, normal
                const m00 = -(tx * ca + bx * sa), m10 = -(ty * ca + by * sa), m20 = tz * ca + bz * sa;
                const m01 = -(bx * ca - tx * sa), m11 = -(by * ca - ty * sa), m21 = bz * ca - tz * sa;
                const m02 = -nx, m12 = -ny, m22 = nz;

                // rotation matrix to quaternion
                let qw, qx, qy, qz;
                const trace = m00 + m11 + m22;
                if (trace > 0) {
                    const k = 0.5 / Math.sqrt(trace + 1);
                    qw = 0.25 / k;
                    qx = (m21 - m12) * k;
                    qy = (m02 - m20) * k;
                    qz = (m10 - m01) * k;
                } else if (m00 > m11 && m00 > m22) {
                    const k = 2 * Math.sqrt(1 + m00 - m11 - m22);
                    qw = (m21 - m12) / k;
                    qx = 0.25 * k;
                    qy = (m01 + m10) / k;
                    qz = (m02 + m20) / k;
                } else if (m11 > m22) {
                    const k = 2 * Math.sqrt(1 + m11 - m00 - m22);
                    qw = (m02 - m20) / k;
                    qx = (m01 + m10) / k;
                    qy = 0.25 * k;
                    qz = (m12 + m21) / k;
                } else {
                    const k = 2 * Math.sqrt(1 + m22 - m00 - m11);
                    qw = (m10 - m01) / k;
                    qx = (m02 + m20) / k;
                    qy = (m12 + m21) / k;
                    qz = 0.25 * k;
                }

                const opacity = Math.min(0.999, Math.max(0.001, a));
                const o = count * numProps;
                data[o] = -(ax + e1x * r1 + e2x * r2);
                data[o + 1] = -(ay + e1y * r1 + e2y * r2);
                data[o + 2] = az + e1z * r1 + e2z * r2;
                data[o + 3] = (linearToSrgb(Math.min(1, Math.max(0, r))) - 0.5) / SH_C0;
                data[o + 4] = (linearToSrgb(Math.min(1, Math.max(0, g))) - 0.5) / SH_C0;
                data[o + 5] = (linearToSrgb(Math.min(1, Math.max(0, b))) - 0.5) / SH_C0;
                data[o + 6] = Math.log(opacity / (1 - opacity));
                data[o + 7] = logScaleT;
                data[o + 8] = logScaleT;
                data[o + 9] = logScaleN;
                data[o + 10] = qw;
                data[o + 11] = qx;
                data[o + 12] = qy;
                data[o + 13] = qz;
                count++;
            }
        }
    });

    if (count === 0) {
        throw new Error('The mesh produced no splats (is it fully transparent?)');
    }

    const header = [
        'ply',
        'format binary_little_endian 1.0',
        'comment Generated by SuperSplat from a GLB mesh',
        `element vertex ${count}`,
        ...plyProperties.map(name => `property float ${name}`),
        'end_header',
        ''
    ].join('\n');

    // the editor runs on little-endian platforms, so the float array is written as-is
    const body = data.subarray(0, count * numProps);
    return {
        blob: new Blob([header, body], { type: 'application/ply' }),
        count
    };
};

export { readGlb, meshToSplatPly, type MeshData };
