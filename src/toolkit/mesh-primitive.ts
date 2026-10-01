import {
    CULLFACE_NONE,
    SEMANTIC_NORMAL,
    SEMANTIC_POSITION,
    BoundingBox,
    Entity,
    ShaderMaterial,
    Vec3
} from 'playcanvas';

import { Element, ElementType } from '../element';
import { Serializer } from '../serializer';

// Opaque, depth-writing mesh drawn in the world layer. The world pass and the
// splat passes share one depth buffer and the splat material depth-tests, so a
// primitive occludes the splats behind it with a hard, pixel-exact edge while
// splats in front of it still blend over it.

type PrimitiveKind = 'plane' | 'box';

type PrimitiveState = {
    position: [number, number, number];
    rotation: [number, number, number];     // euler degrees
    scale: [number, number, number];
    color: [number, number, number];
    visible: boolean;
};

type PrimitiveData = PrimitiveState & {
    kind: PrimitiveKind;
    name: string;
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

const unitBox = new BoundingBox(new Vec3(0, 0, 0), new Vec3(0.5, 0.5, 0.5));
const unitPlane = new BoundingBox(new Vec3(0, 0, 0), new Vec3(0.5, 0.001, 0.5));

class MeshPrimitive extends Element {
    kind: PrimitiveKind;
    name: string;
    entity: Entity;
    material: ShaderMaterial;
    color: [number, number, number] = [0.8, 0.8, 0.8];
    private bound = new BoundingBox();

    constructor(data: PrimitiveData) {
        super(ElementType.model);
        this.kind = data.kind;
        this.name = data.name;
        this.entity = new Entity(`toolkitPrimitive:${data.name}`);
        this.entity.addComponent('render', { type: data.kind });
        this.setState(data);
    }

    add() {
        const material = new ShaderMaterial({
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

        this.entity.render.meshInstances[0].material = material;
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
    }

    // packed every frame: any change here triggers a re-render
    serialize(serializer: Serializer) {
        serializer.packa(this.entity.getWorldTransform().data);
        serializer.packa(this.color);
        serializer.pack(this.entity.enabled);
    }

    get worldBound(): BoundingBox | null {
        if (!this.entity.enabled) {
            return null;
        }
        this.bound.setFromTransformedAabb(this.kind === 'box' ? unitBox : unitPlane, this.entity.getWorldTransform());
        return this.bound;
    }

    private applyColor() {
        this.entity.render?.meshInstances[0]?.setParameter('primColor', this.color);
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
            visible: this.entity.enabled
        };
    }

    setState(state: PrimitiveState) {
        this.entity.setLocalPosition(state.position[0], state.position[1], state.position[2]);
        this.entity.setLocalEulerAngles(state.rotation[0], state.rotation[1], state.rotation[2]);
        this.entity.setLocalScale(state.scale[0], state.scale[1], state.scale[2]);
        this.color = [state.color[0], state.color[1], state.color[2]];
        this.entity.enabled = state.visible;
        this.applyColor();
        if (this.scene) {
            this.scene.boundDirty = true;
        }
    }

    getData(): PrimitiveData {
        return { kind: this.kind, name: this.name, ...this.getState() };
    }
}

const statesEqual = (a: PrimitiveState, b: PrimitiveState) => {
    return JSON.stringify(a) === JSON.stringify(b);
};

export { MeshPrimitive, PrimitiveKind, PrimitiveState, PrimitiveData, statesEqual };
