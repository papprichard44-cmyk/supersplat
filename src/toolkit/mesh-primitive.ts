import {
    ADDRESS_CLAMP_TO_EDGE,
    CULLFACE_NONE,
    FILTER_LINEAR,
    FILTER_LINEAR_MIPMAP_LINEAR,
    PIXELFORMAT_RGBA8,
    PRIMITIVE_TRIANGLES,
    SEMANTIC_NORMAL,
    SEMANTIC_POSITION,
    SEMANTIC_TEXCOORD0,
    Asset,
    BoundingBox,
    Entity,
    Mesh,
    MeshInstance,
    ShaderMaterial,
    Texture,
    Vec3
} from 'playcanvas';

import { Element, ElementType } from '../element';
import { Serializer } from '../serializer';
import { AlphaGrid, buildExtrudeGeometry, makeAlphaGrid } from './image-extrude';
import { litChunkWGSL } from './lighting/shading';
import { isShapeKind, shapeGeometry, ShapeKind } from './shapes';

// Opaque, depth-writing mesh drawn in the world layer. The world pass and the
// splat passes share one depth buffer and the splat material depth-tests, so a
// primitive occludes the splats behind it with a hard, pixel-exact edge while
// splats in front of it still blend over it.

// An 'image' is an alpha-cutout picture extruded along its local Y axis (the
// Y scale is its thickness): texels below the cutoff are discarded on the two
// faces, side walls follow the alpha contour, and everything writes depth like
// any other primitive, so the silhouette is a hard edge inside the splats.

//
// A 'model' is an imported GLB mesh. It is drawn with the toolkit's own
// shaders (base colour x texture) instead of the engine's lit materials.
//
// The curved shapes (sphere, cylinder, cone, torus, backdrop) are generated
// meshes, see shapes.ts.
//
// All of them are shaded by the studio lights (lighting/shading.ts) when the
// studio has any; without lights they keep the plain look with a mild
// headlight so their form still reads.

type PrimitiveKind = 'plane' | 'box' | 'image' | 'model' | ShapeKind;

// default surface response of primitives (models use their own materials)
const DEFAULT_ROUGHNESS = 0.55;
const DEFAULT_METALNESS = 0;

type PrimitiveState = {
    position: [number, number, number];
    rotation: [number, number, number];     // euler degrees
    scale: [number, number, number];
    color: [number, number, number];
    visible: boolean;
    alphaCutoff?: number;                   // images only
    // surface response for the studio lights. on a model, leaving them out
    // keeps the model's own materials
    roughness?: number;
    metalness?: number;
};

type PrimitiveData = PrimitiveState & {
    kind: PrimitiveKind;
    name: string;
    image?: string;                         // images only: data url of the picture
    model?: string;                         // models only: data url of the .glb file
};

const vertexShader = /* wgsl */`
attribute vertex_position: vec3f;
attribute vertex_normal: vec3f;
uniform matrix_model: mat4x4f;
uniform matrix_viewProjection: mat4x4f;
uniform matrix_normal: mat3x3f;
varying vWorldPos: vec3f;
varying vNormal: vec3f;

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    let world = uniform.matrix_model * vec4f(input.vertex_position, 1.0);
    output.position = uniform.matrix_viewProjection * world;
    output.vWorldPos = world.xyz;
    output.vNormal = uniform.matrix_normal * input.vertex_normal;
    return output;
}
`;

// flat colour with a mild headlight term so the faces of a box read apart,
// or lit by the studio lights when there are any
const fragmentShader = /* wgsl */`
uniform view_position: vec3f;
uniform primColor: vec3f;
varying vWorldPos: vec3f;
varying vNormal: vec3f;
${litChunkWGSL}

@fragment
fn fragmentMain(input: FragmentInput) -> FragmentOutput {
    var output: FragmentOutput;
    let n = normalize(input.vNormal);
    let v = normalize(uniform.view_position - input.vWorldPos);
    let shade = 0.6 + 0.4 * abs(dot(n, v));
    let color = studioShade(uniform.primColor, n, input.vWorldPos, uniform.view_position, uniform.primColor * shade);
    output.color = vec4f(color, 1.0);
    return output;
}
`;

const imageVertexShader = /* wgsl */`
attribute vertex_position: vec3f;
attribute vertex_normal: vec3f;
attribute vertex_texCoord0: vec2f;
uniform matrix_model: mat4x4f;
uniform matrix_viewProjection: mat4x4f;
uniform matrix_normal: mat3x3f;
varying vUv: vec2f;
varying vWorldPos: vec3f;
varying vNormal: vec3f;
varying vSide: f32;

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    let world = uniform.matrix_model * vec4f(input.vertex_position, 1.0);
    output.position = uniform.matrix_viewProjection * world;
    output.vUv = input.vertex_texCoord0;
    output.vWorldPos = world.xyz;
    output.vNormal = uniform.matrix_normal * input.vertex_normal;
    // 0 on the two picture faces, 1 on the extruded side walls
    output.vSide = 1.0 - abs(input.vertex_normal.y);
    return output;
}
`;

const imageFragmentShader = /* wgsl */`
uniform view_position: vec3f;
uniform primColor: vec3f;
uniform primAlphaCutoff: f32;
var primTex: texture_2d<f32>;
var primTex_sampler: sampler;
varying vUv: vec2f;
varying vWorldPos: vec3f;
varying vNormal: vec3f;
varying vSide: f32;
${litChunkWGSL}

@fragment
fn fragmentMain(input: FragmentInput) -> FragmentOutput {
    var output: FragmentOutput;
    let texel = textureSample(primTex, primTex_sampler, input.vUv);
    // faces are cut out per pixel; walls are solid geometry
    if (input.vSide < 0.5 && texel.a < uniform.primAlphaCutoff) {
        discard;
    }
    let n = normalize(input.vNormal);
    let v = normalize(uniform.view_position - input.vWorldPos);
    let shade = mix(1.0, 0.55 + 0.45 * abs(dot(n, v)), input.vSide);
    let base = texel.rgb * uniform.primColor;
    output.color = vec4f(studioShade(base, n, input.vWorldPos, uniform.view_position, base * shade), 1.0);
    return output;
}
`;

const modelFragmentShader = /* wgsl */`
uniform view_position: vec3f;
uniform primColor: vec3f;
uniform primAlphaCutoff: f32;
uniform primGamma: f32;
var primTex: texture_2d<f32>;
var primTex_sampler: sampler;
varying vUv: vec2f;
varying vWorldPos: vec3f;
varying vNormal: vec3f;
varying vSide: f32;
${litChunkWGSL}

@fragment
fn fragmentMain(input: FragmentInput) -> FragmentOutput {
    var output: FragmentOutput;
    let texel = textureSample(primTex, primTex_sampler, input.vUv);
    if (texel.a < uniform.primAlphaCutoff) {
        discard;
    }
    // sRGB textures sample as linear: bring them back to display space
    let rgb = pow(max(texel.rgb, vec3f(0.0)), vec3f(uniform.primGamma));
    let n = normalize(input.vNormal);
    let v = normalize(uniform.view_position - input.vWorldPos);
    let shade = 0.6 + 0.4 * abs(dot(n, v));
    let base = rgb * uniform.primColor;
    output.color = vec4f(studioShade(base, n, input.vWorldPos, uniform.view_position, base * shade), 1.0);
    return output;
}
`;

const loadImage = (url: string) => {
    return new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error('toolkit: image failed to load'));
        image.src = url;
    });
};

type ModelPart = {
    meshInstance: MeshInstance,
    baseColor: [number, number, number],
    roughness: number,
    metalness: number
};

const makeMaterial = (uniqueName: string, vertexWGSL: string, fragmentWGSL: string, textured: boolean) => {
    const material = new ShaderMaterial({
        uniqueName,
        attributes: {
            vertex_position: SEMANTIC_POSITION,
            vertex_normal: SEMANTIC_NORMAL,
            ...(textured ? { vertex_texCoord0: SEMANTIC_TEXCOORD0 } : {})
        },
        vertexWGSL,
        fragmentWGSL
    });
    material.cull = CULLFACE_NONE;
    material.depthWrite = true;
    material.depthTest = true;
    material.update();
    return material;
};

class MeshPrimitive extends Element {
    kind: PrimitiveKind;
    name: string;
    entity: Entity;
    material: ShaderMaterial;
    image: string | null;
    model: string | null;
    // half size of the primitive in its own space (before the entity's scale)
    localHalf = new Vec3(0.5, 0.5, 0.5);
    private modelRoot: Entity | null = null;
    private modelAsset: Asset | null = null;
    private modelParts: ModelPart[] = [];
    private modelMaterials: ShaderMaterial[] = [];
    texture: Texture | null = null;
    alphaGrid: AlphaGrid | null = null;
    private mesh: Mesh | null = null;
    private builtCutoff = -1;
    alphaCutoff = 0.5;
    color: [number, number, number] = [0.8, 0.8, 0.8];
    // bit per studio light: which lights reach this mesh (set by the studio)
    studioMask = 0xffff;
    // null on a model = the model's own materials
    roughness: number | null = DEFAULT_ROUGHNESS;
    metalness: number | null = DEFAULT_METALNESS;
    private bound = new BoundingBox();
    private localBound = new BoundingBox();

    constructor(data: PrimitiveData) {
        super(ElementType.model);
        this.kind = data.kind;
        this.name = data.name;
        this.entity = new Entity(`toolkitPrimitive:${data.name}`);
        this.image = data.image ?? null;
        this.model = data.model ?? null;
        if (data.kind === 'plane') {
            this.localHalf.set(0.5, 0.002, 0.5);
        }
        if (isShapeKind(data.kind)) {
            const half = shapeGeometry(data.kind).half;
            this.localHalf.set(half[0], half[1], half[2]);
        }
        if (data.kind !== 'model') {
            const generated = data.kind === 'image' || isShapeKind(data.kind);
            this.entity.addComponent('render', { type: generated ? 'asset' : data.kind });
        }
        this.setState(data);
    }

    // load the GLB with the engine's own loader and put it under this.entity,
    // normalised so that its longest side is 1 unit and its centre is the origin
    // (the entity's scale is then the model's real size, like for a box)
    private async addModel() {
        const app = this.scene.app;
        const blob = await (await fetch(this.model)).blob();
        const url = URL.createObjectURL(blob);
        try {
            this.modelAsset = await new Promise<Asset>((resolve, reject) => {
                app.assets.loadFromUrlAndFilename(url, `${this.name}.glb`, 'container', (error: string | null, asset?: Asset) => {
                    if (error || !asset) {
                        reject(new Error(`toolkit: could not load the model (${error})`));
                    } else {
                        resolve(asset);
                    }
                });
            });
        } finally {
            URL.revokeObjectURL(url);
        }

        const root = new Entity(`toolkitModel:${this.name}`);
        root.addChild((this.modelAsset.resource as any).instantiateRenderEntity({ castShadows: false }));

        const flat = makeMaterial('toolkitMeshPrimitive', vertexShader, fragmentShader, false);
        const textured = makeMaterial('toolkitModelTextured', imageVertexShader, modelFragmentShader, true);
        this.modelMaterials = [flat, textured];

        const bound = new BoundingBox();
        const partBound = new BoundingBox();
        let first = true;
        this.modelParts = [];
        (root.findComponents('render') as any[]).forEach((render) => {
            render.layers = [this.scene.worldLayer.id];
            render.meshInstances.forEach((meshInstance: MeshInstance) => {
                const source = meshInstance.material as any;
                const diffuse = source?.diffuse;
                const map: Texture | null = source?.diffuseMap ?? null;
                const useMap = !!map && meshInstance.mesh.vertexBuffer.format.hasUv0;
                meshInstance.material = useMap ? textured : flat;
                if (useMap) {
                    meshInstance.setParameter('primTex', map);
                    meshInstance.setParameter('primGamma', (map as any).srgb ? 1 / 2.2 : 1);
                    meshInstance.setParameter('primAlphaCutoff', source.alphaTest ?? 0);
                }
                this.modelParts.push({
                    meshInstance,
                    baseColor: diffuse ? [diffuse.r, diffuse.g, diffuse.b] : [1, 1, 1],
                    // the glTF loader stores roughness in gloss with glossInvert set
                    roughness: source?.gloss !== undefined ? (source.glossInvert ? source.gloss : 1 - source.gloss) : 1,
                    metalness: source?.useMetalness ? (source.metalness ?? 0) : 0
                });
                partBound.setFromTransformedAabb(meshInstance.mesh.aabb, meshInstance.node.getWorldTransform());
                if (first) {
                    bound.copy(partBound);
                    first = false;
                } else {
                    bound.add(partBound);
                }
            });
        });

        const half = bound.halfExtents;
        const longest = Math.max(half.x, half.y, half.z) * 2 || 1;
        root.setLocalScale(1 / longest, 1 / longest, 1 / longest);
        root.setLocalPosition(-bound.center.x / longest, -bound.center.y / longest, -bound.center.z / longest);
        this.localHalf.set(half.x / longest, half.y / longest, half.z / longest);

        this.modelRoot = root;
        this.entity.addChild(root);
        this.scene.contentRoot.addChild(this.entity);
        this.applyColor();
        this.scene.boundDirty = true;
    }

    // transform from the GLB's own space to world space
    get modelTransform() {
        return this.modelRoot?.getWorldTransform() ?? null;
    }

    async add() {
        if (this.kind === 'model') {
            await this.addModel();
            return;
        }
        const isImage = this.kind === 'image';
        if (isImage) {
            // upload raw, straight-alpha pixels: handing the image element
            // itself to the WebGPU device left the texture empty
            const source = await loadImage(this.image);
            const canvas = document.createElement('canvas');
            canvas.width = source.naturalWidth;
            canvas.height = source.naturalHeight;
            const context = canvas.getContext('2d', { willReadFrequently: true });
            context.drawImage(source, 0, 0);
            const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
            this.alphaGrid = makeAlphaGrid(canvas, canvas.width, canvas.height);
            this.texture = new Texture(this.scene.graphicsDevice, {
                name: `toolkitImage:${this.name}`,
                width: canvas.width,
                height: canvas.height,
                format: PIXELFORMAT_RGBA8,
                mipmaps: true,
                minFilter: FILTER_LINEAR_MIPMAP_LINEAR,
                magFilter: FILTER_LINEAR,
                addressU: ADDRESS_CLAMP_TO_EDGE,
                addressV: ADDRESS_CLAMP_TO_EDGE,
                levels: [new Uint8Array(pixels.buffer)]
            });
        }

        const material = isImage ? new ShaderMaterial({
            uniqueName: 'toolkitImageCutout',
            attributes: {
                vertex_position: SEMANTIC_POSITION,
                vertex_normal: SEMANTIC_NORMAL,
                vertex_texCoord0: SEMANTIC_TEXCOORD0
            },
            vertexWGSL: imageVertexShader,
            fragmentWGSL: imageFragmentShader
        }) : new ShaderMaterial({
            uniqueName: 'toolkitMeshPrimitive',
            attributes: {
                vertex_position: SEMANTIC_POSITION,
                vertex_normal: SEMANTIC_NORMAL
            },
            vertexWGSL: vertexShader,
            fragmentWGSL: fragmentShader
        });
        material.cull = CULLFACE_NONE;
        material.depthWrite = true;
        material.depthTest = true;
        material.update();
        this.material = material;

        if (isImage) {
            this.rebuildMesh();
        } else if (isShapeKind(this.kind)) {
            const geometry = shapeGeometry(this.kind);
            const mesh = new Mesh(this.scene.graphicsDevice);
            mesh.setPositions(geometry.positions);
            mesh.setNormals(geometry.normals);
            mesh.setUvs(0, geometry.uvs);
            mesh.setIndices(geometry.indices);
            mesh.update(PRIMITIVE_TRIANGLES);
            const meshInstance = new MeshInstance(mesh, material);
            meshInstance.castShadow = false;
            this.entity.render.meshInstances = [meshInstance];
            this.mesh = mesh;
        } else {
            this.entity.render.meshInstances[0].material = material;
        }
        this.entity.render.layers = [this.scene.worldLayer.id];
        this.entity.render.castShadows = false;
        this.scene.contentRoot.addChild(this.entity);
        this.applyColor();
        this.scene.boundDirty = true;
    }

    remove() {
        this.scene.contentRoot.removeChild(this.entity);
        this.scene.boundDirty = true;
        this.material?.destroy();
        this.material = null;
        this.texture?.destroy();
        this.texture = null;
        if (this.mesh) {
            this.entity.render.meshInstances = [];
            this.mesh.destroy();
            this.mesh = null;
        }
        if (this.modelRoot) {
            this.modelRoot.destroy();
            this.modelRoot = null;
            this.modelParts = [];
            this.modelMaterials.forEach(material => material.destroy());
            this.modelMaterials = [];
        }
        if (this.modelAsset) {
            this.scene.app.assets.remove(this.modelAsset);
            this.modelAsset.unload();
            this.modelAsset = null;
        }
        this.builtCutoff = -1;
    }

    // packed every frame: any change here triggers a re-render
    serialize(serializer: Serializer) {
        serializer.packa(this.entity.getWorldTransform().data);
        serializer.packa(this.color);
        serializer.pack(this.entity.enabled, this.alphaCutoff, this.roughness ?? -1, this.metalness ?? -1);
    }

    // (re)build the extruded picture mesh for the current alpha cutoff
    private rebuildMesh() {
        if (!this.alphaGrid || !this.material || this.builtCutoff === this.alphaCutoff) {
            return;
        }
        const geometry = buildExtrudeGeometry(this.alphaGrid, this.alphaCutoff);
        const mesh = new Mesh(this.scene.graphicsDevice);
        mesh.setPositions(geometry.positions);
        mesh.setNormals(geometry.normals);
        mesh.setUvs(0, geometry.uvs);
        mesh.setIndices(geometry.indices);
        mesh.update(PRIMITIVE_TRIANGLES);

        const old = this.mesh;
        const meshInstance = new MeshInstance(mesh, this.material);
        meshInstance.castShadow = false;
        this.entity.render.meshInstances = [meshInstance];
        this.entity.render.layers = [this.scene.worldLayer.id];
        old?.destroy();
        this.mesh = mesh;
        this.builtCutoff = this.alphaCutoff;
        this.applyColor();
    }

    get worldBound(): BoundingBox | null {
        if (!this.entity.enabled) {
            return null;
        }
        this.localBound.halfExtents.copy(this.localHalf);
        this.bound.setFromTransformedAabb(this.localBound, this.entity.getWorldTransform());
        return this.bound;
    }

    setStudioMask(mask: number) {
        if (mask === this.studioMask) return;
        this.studioMask = mask;
        this.applyColor();
    }

    private applyColor() {
        if (this.kind === 'model') {
            // the picked colour tints the model's own base colours
            this.modelParts.forEach(({ meshInstance, baseColor, roughness, metalness }) => {
                meshInstance.setParameter('primColor', [baseColor[0] * this.color[0], baseColor[1] * this.color[1], baseColor[2] * this.color[2]]);
                meshInstance.setParameter('primRoughness', this.roughness ?? roughness);
                meshInstance.setParameter('primMetalness', this.metalness ?? metalness);
                meshInstance.setParameter('primStudioMask', this.studioMask);
            });
            return;
        }
        const meshInstance = this.entity.render?.meshInstances[0];
        if (!meshInstance) return;
        meshInstance.setParameter('primColor', this.color);
        meshInstance.setParameter('primRoughness', this.roughness ?? DEFAULT_ROUGHNESS);
        meshInstance.setParameter('primMetalness', this.metalness ?? DEFAULT_METALNESS);
        meshInstance.setParameter('primStudioMask', this.studioMask);
        if (this.texture) {
            meshInstance.setParameter('primTex', this.texture);
            meshInstance.setParameter('primAlphaCutoff', this.alphaCutoff);
        }
    }

    getState(): PrimitiveState {
        const p = this.entity.getLocalPosition();
        const r = this.entity.getLocalEulerAngles();
        const s = this.entity.getLocalScale();
        return {
            position: [p.x, p.y, p.z],
            rotation: [r.x, r.y, r.z],
            scale: [s.x, s.y, s.z],
            color: [this.color[0], this.color[1], this.color[2]],
            visible: this.entity.enabled,
            alphaCutoff: this.alphaCutoff,
            ...(this.roughness !== null ? { roughness: this.roughness } : {}),
            ...(this.metalness !== null ? { metalness: this.metalness } : {})
        };
    }

    setState(state: PrimitiveState) {
        this.entity.setLocalPosition(state.position[0], state.position[1], state.position[2]);
        this.entity.setLocalEulerAngles(state.rotation[0], state.rotation[1], state.rotation[2]);
        this.entity.setLocalScale(state.scale[0], state.scale[1], state.scale[2]);
        this.color = [state.color[0], state.color[1], state.color[2]];
        this.entity.enabled = state.visible;
        this.alphaCutoff = state.alphaCutoff ?? 0.5;
        const ownMaterials = this.kind === 'model';
        this.roughness = state.roughness ?? (ownMaterials ? null : DEFAULT_ROUGHNESS);
        this.metalness = state.metalness ?? (ownMaterials ? null : DEFAULT_METALNESS);
        if (this.kind === 'image' && this.scene) {
            this.rebuildMesh();
        }
        this.applyColor();
        if (this.scene) {
            this.scene.boundDirty = true;
        }
    }

    getData(): PrimitiveData {
        return {
            kind: this.kind,
            name: this.name,
            ...this.getState(),
            ...(this.image ? { image: this.image } : {}),
            ...(this.model ? { model: this.model } : {})
        };
    }
}

const statesEqual = (a: PrimitiveState, b: PrimitiveState) => {
    return JSON.stringify(a) === JSON.stringify(b);
};

export { MeshPrimitive, loadImage, PrimitiveKind, PrimitiveState, PrimitiveData, statesEqual, DEFAULT_ROUGHNESS, DEFAULT_METALNESS };
