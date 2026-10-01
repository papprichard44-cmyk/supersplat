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

// Opaque, depth-writing mesh drawn in the world layer. The world pass and the
// splat passes share one depth buffer and the splat material depth-tests, so a
// primitive occludes the splats behind it with a hard, pixel-exact edge while
// splats in front of it still blend over it.

// An 'image' is an alpha-cutout picture extruded along its local Y axis (the
// Y scale is its thickness): texels below the cutoff are discarded on the two
// faces, side walls follow the alpha contour, and everything writes depth like
// any other primitive, so the silhouette is a hard edge inside the splats.

type PrimitiveKind = 'plane' | 'box' | 'image';

type PrimitiveState = {
    position: [number, number, number];
    rotation: [number, number, number];     // euler degrees
    scale: [number, number, number];
    color: [number, number, number];
    visible: boolean;
    alphaCutoff?: number;                   // images only
};

type PrimitiveData = PrimitiveState & {
    kind: PrimitiveKind;
    name: string;
    image?: string;                         // images only: data url of the picture
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

// flat colour with a mild headlight term so the faces of a box read apart
const fragmentShader = /* wgsl */`
uniform view_position: vec3f;
uniform primColor: vec3f;
varying vWorldPos: vec3f;
varying vNormal: vec3f;

@fragment
fn fragmentMain(input: FragmentInput) -> FragmentOutput {
    var output: FragmentOutput;
    let n = normalize(input.vNormal);
    let v = normalize(uniform.view_position - input.vWorldPos);
    let shade = 0.6 + 0.4 * abs(dot(n, v));
    output.color = vec4f(uniform.primColor * shade, 1.0);
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
    output.color = vec4f(texel.rgb * uniform.primColor * shade, 1.0);
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

const unitBox = new BoundingBox(new Vec3(0, 0, 0), new Vec3(0.5, 0.5, 0.5));
const unitPlane = new BoundingBox(new Vec3(0, 0, 0), new Vec3(0.5, 0.001, 0.5));

class MeshPrimitive extends Element {
    kind: PrimitiveKind;
    name: string;
    entity: Entity;
    material: ShaderMaterial;
    image: string | null;
    texture: Texture | null = null;
    private alphaGrid: AlphaGrid | null = null;
    private mesh: Mesh | null = null;
    private builtCutoff = -1;
    alphaCutoff = 0.5;
    color: [number, number, number] = [0.8, 0.8, 0.8];
    private bound = new BoundingBox();

    constructor(data: PrimitiveData) {
        super(ElementType.model);
        this.kind = data.kind;
        this.name = data.name;
        this.entity = new Entity(`toolkitPrimitive:${data.name}`);
        this.image = data.image ?? null;
        this.entity.addComponent('render', { type: data.kind === 'image' ? 'asset' : data.kind });
        this.setState(data);
    }

    async add() {
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
        this.builtCutoff = -1;
    }

    // packed every frame: any change here triggers a re-render
    serialize(serializer: Serializer) {
        serializer.packa(this.entity.getWorldTransform().data);
        serializer.packa(this.color);
        serializer.pack(this.entity.enabled, this.alphaCutoff);
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
        this.bound.setFromTransformedAabb(this.kind === 'plane' ? unitPlane : unitBox, this.entity.getWorldTransform());
        return this.bound;
    }

    private applyColor() {
        const meshInstance = this.entity.render?.meshInstances[0];
        if (!meshInstance) return;
        meshInstance.setParameter('primColor', this.color);
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
            alphaCutoff: this.alphaCutoff
        };
    }

    setState(state: PrimitiveState) {
        this.entity.setLocalPosition(state.position[0], state.position[1], state.position[2]);
        this.entity.setLocalEulerAngles(state.rotation[0], state.rotation[1], state.rotation[2]);
        this.entity.setLocalScale(state.scale[0], state.scale[1], state.scale[2]);
        this.color = [state.color[0], state.color[1], state.color[2]];
        this.entity.enabled = state.visible;
        this.alphaCutoff = state.alphaCutoff ?? 0.5;
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
            ...(this.image ? { image: this.image } : {})
        };
    }
}

const statesEqual = (a: PrimitiveState, b: PrimitiveState) => {
    return JSON.stringify(a) === JSON.stringify(b);
};

export { MeshPrimitive, PrimitiveKind, PrimitiveState, PrimitiveData, statesEqual };
