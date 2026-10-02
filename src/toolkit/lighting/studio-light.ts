import {
    CULLFACE_NONE,
    PRIMITIVE_LINES,
    PRIMITIVE_TRIANGLES,
    SEMANTIC_COLOR,
    SEMANTIC_NORMAL,
    SEMANTIC_POSITION,
    Entity,
    Mesh,
    MeshInstance,
    ShaderMaterial,
    Vec3
} from 'playcanvas';

import { LightParams } from './bake';
import { kelvinToLinear } from './color';
import { FixtureKind, Geometry, fixtureModel, fixtures, legModel, standModel } from './fixtures';
import { srgbToLinear, linearToSrgb } from './samples';
import { LT_RECT, LT_SPOT, LT_SUN } from './shading';
import { Element, ElementType } from '../../element';
import { Serializer } from '../../serializer';
import { vertexShader as lineVertexShader, fragmentShader as lineFragmentShader } from '../../shaders/debug-shader';

// A light of the virtual studio: the fixture model on its stand, the beam
// drawn as lines, and the light parameters the preview and the bake use.
// Lights are scene elements so they get undo, visibility and project saving
// like everything else, but they have no bound: they never take part in
// framing, and nothing of them is ever exported.

type Vec3Tuple = [number, number, number];

type LightState = {
    kind: FixtureKind;
    name: string;
    position: Vec3Tuple;
    rotation: Vec3Tuple;            // euler degrees
    target: Vec3Tuple | null;       // when set, the light keeps aiming at it
    intensity: number;              // linear, see Studio.powerToIntensity
    kelvin: number;
    gel: Vec3Tuple;                 // colour filter, sRGB (white = none)
    width: number;                  // emitter width / diameter, world units (sun: disk diameter in degrees)
    aspect: number;                 // rect lights: height / width
    beam: number;                   // spot: beam half-angle, degrees
    softEdge: number;               // spot: 0 = hard beam edge .. 1 = soft
    spread: number;                 // area lights: emission falloff exponent (1 = diffuser)
    shadows: boolean;
    visible: boolean;
};

// what the light needs to know about the studio around it
type StudioContext = {
    floorY: () => number;           // where the stand's feet go
    scale: () => number;            // subject size, for stands, the sun's size and beam lengths
    showBeams: () => boolean;
    isSelected: (light: StudioLight) => boolean;
};

const bodyVertexWGSL = /* wgsl */`
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

// housing: dark metal lit by a headlight, tinted when selected
const bodyFragmentWGSL = /* wgsl */`
uniform view_position: vec3f;
uniform fixtureColor: vec3f;
varying vWorldPos: vec3f;
varying vNormal: vec3f;

@fragment
fn fragmentMain(input: FragmentInput) -> FragmentOutput {
    var output: FragmentOutput;
    let n = normalize(input.vNormal);
    let v = normalize(uniform.view_position - input.vWorldPos);
    let d = abs(dot(n, v));
    let shade = 0.35 + 0.65 * d + 0.25 * pow(d, 24.0);
    output.color = vec4f(uniform.fixtureColor * shade, 1.0);
    return output;
}
`;

// emitting surface: the light's colour, unlit
const emitterFragmentWGSL = /* wgsl */`
uniform fixtureEmit: vec3f;
varying vWorldPos: vec3f;
varying vNormal: vec3f;

@fragment
fn fragmentMain(input: FragmentInput) -> FragmentOutput {
    var output: FragmentOutput;
    output.color = vec4f(uniform.fixtureEmit, 1.0);
    return output;
}
`;

const meshFromGeometry = (device: any, geometry: Geometry) => {
    const mesh = new Mesh(device);
    mesh.setPositions(geometry.positions);
    mesh.setNormals(geometry.normals);
    mesh.setIndices(geometry.indices);
    mesh.update(PRIMITIVE_TRIANGLES);
    return mesh;
};

const makeMaterial = (name: string, fragmentWGSL: string) => {
    const material = new ShaderMaterial({
        uniqueName: name,
        attributes: {
            vertex_position: SEMANTIC_POSITION,
            vertex_normal: SEMANTIC_NORMAL
        },
        vertexWGSL: bodyVertexWGSL,
        fragmentWGSL
    });
    material.cull = CULLFACE_NONE;
    material.depthWrite = true;
    material.depthTest = true;
    material.update();
    return material;
};

const v = new Vec3();
const w = new Vec3();

class StudioLight extends Element {
    state: LightState;
    studio: StudioContext;

    // head: positioned and rotated; the model under it is scaled by the width
    entity: Entity;
    private model: Entity;
    private stand: Entity;
    private lines: Entity;

    private meshes: Mesh[] = [];
    private materials: ShaderMaterial[] = [];
    private bodyInstance: MeshInstance | null = null;
    private emitterInstance: MeshInstance | null = null;
    private standInstances: MeshInstance[] = [];
    private lineMesh: Mesh | null = null;
    private lineInstance: MeshInstance | null = null;
    private builtModel = '';
    private dirty = true;

    // half size of the fixture model, in model units
    half = new Vec3(0.5, 0.5, 0.5);

    constructor(state: LightState, studio: StudioContext) {
        super(ElementType.other);
        this.studio = studio;
        this.entity = new Entity(`studioLight:${state.name}`);
        this.model = new Entity('fixture');
        this.entity.addChild(this.model);
        this.stand = new Entity('stand');
        this.lines = new Entity('beam');
        this.state = { ...state };
        this.applyTransform();
    }

    get info() {
        return fixtures[this.state.kind];
    }

    get name() {
        return this.state.name;
    }

    add() {
        const scene = this.scene;
        const device = scene.graphicsDevice;
        this.materials = [
            makeMaterial('studioFixtureBody', bodyFragmentWGSL),
            makeMaterial('studioFixtureEmitter', emitterFragmentWGSL)
        ];

        const lineMaterial = new ShaderMaterial({
            uniqueName: 'studioBeamLines',
            attributes: {
                vertex_position: SEMANTIC_POSITION,
                vertex_color: SEMANTIC_COLOR
            },
            vertexWGSL: lineVertexShader,
            fragmentWGSL: lineFragmentShader
        });
        lineMaterial.depthWrite = true;
        lineMaterial.depthTest = true;
        lineMaterial.update();
        this.materials.push(lineMaterial);

        this.lineMesh = new Mesh(device);
        this.lineMesh.primitive[0] = { baseVertex: 0, type: PRIMITIVE_LINES, base: 0, count: 0 };
        this.lineInstance = new MeshInstance(this.lineMesh, lineMaterial, null);
        this.lineInstance.cull = false;
        this.lines.addComponent('render', { meshInstances: [this.lineInstance], layers: [scene.worldLayer.id] });

        // stand: pole + legs
        const pole = meshFromGeometry(device, standModel);
        const legs = meshFromGeometry(device, legModel);
        this.meshes.push(pole, legs);
        this.standInstances = [new MeshInstance(pole, this.materials[0]), new MeshInstance(legs, this.materials[0])];
        const poleEntity = new Entity('pole');
        poleEntity.addComponent('render', { meshInstances: [this.standInstances[0]], layers: [scene.worldLayer.id] });
        const legsEntity = new Entity('legs');
        legsEntity.addComponent('render', { meshInstances: [this.standInstances[1]], layers: [scene.worldLayer.id] });
        this.stand.addChild(poleEntity);
        this.stand.addChild(legsEntity);

        this.builtModel = '';
        this.rebuildModel();

        scene.contentRoot.addChild(this.entity);
        scene.contentRoot.addChild(this.stand);
        scene.contentRoot.addChild(this.lines);
        this.dirty = true;
        this.update();
    }

    remove() {
        const scene = this.scene;
        scene.contentRoot.removeChild(this.entity);
        scene.contentRoot.removeChild(this.stand);
        scene.contentRoot.removeChild(this.lines);
        if (this.model.render) {
            this.model.render.meshInstances.forEach(mi => mi.mesh.destroy());
            this.model.removeComponent('render');
        }
        this.stand.children.slice().forEach(child => child.destroy());
        this.lines.removeComponent('render');
        this.meshes.forEach(mesh => mesh.destroy());
        this.meshes = [];
        this.lineMesh?.destroy();
        this.lineMesh = null;
        this.materials.forEach(material => material.destroy());
        this.materials = [];
        this.bodyInstance = null;
        this.emitterInstance = null;
        this.builtModel = '';
    }

    private rebuildModel() {
        const key = `${this.state.kind}:${this.state.aspect.toFixed(3)}`;
        if (key === this.builtModel || !this.scene) return;
        const device = this.scene.graphicsDevice;
        const model = fixtureModel(this.state.kind, this.state.aspect);
        if (this.model.render) {
            this.model.render.meshInstances.forEach(mi => mi.mesh.destroy());
            this.model.removeComponent('render');
        }
        const body = meshFromGeometry(device, model.body);
        const emitter = meshFromGeometry(device, model.emitter);
        this.bodyInstance = new MeshInstance(body, this.materials[0]);
        this.emitterInstance = new MeshInstance(emitter, this.materials[1]);
        this.model.addComponent('render', {
            meshInstances: [this.bodyInstance, this.emitterInstance],
            layers: [this.scene.worldLayer.id]
        });
        this.half.set(model.half[0], model.half[1], model.half[2]);
        this.builtModel = key;
    }

    // position / rotation / aim from the state
    private applyTransform() {
        const s = this.state;
        this.entity.setLocalPosition(s.position[0], s.position[1], s.position[2]);
        if (s.target) {
            v.set(s.target[0], s.target[1], s.target[2]);
            if (v.distance(this.entity.getLocalPosition()) > 1e-6) {
                // keep the fixture upright while aiming (pick a different up when
                // aiming straight down or up)
                w.sub2(v, this.entity.getLocalPosition()).normalize();
                const up = Math.abs(w.y) > 0.98 ? Vec3.FORWARD : Vec3.UP;
                this.entity.lookAt(v, up);
                const r = this.entity.getLocalEulerAngles();
                s.rotation = [r.x, r.y, r.z];
            }
        } else {
            this.entity.setLocalEulerAngles(s.rotation[0], s.rotation[1], s.rotation[2]);
        }
    }

    // world size of one model unit
    private get modelScale() {
        return this.state.kind === 'sun' ? this.studio.scale() * 0.05 : Math.max(1e-4, this.state.width);
    }

    getState(): LightState {
        return {
            ...this.state,
            position: [...this.state.position] as Vec3Tuple,
            rotation: [...this.state.rotation] as Vec3Tuple,
            target: this.state.target ? [...this.state.target] as Vec3Tuple : null,
            gel: [...this.state.gel] as Vec3Tuple
        };
    }

    setState(state: LightState) {
        this.state = { ...state, target: state.target ? [...state.target] as Vec3Tuple : null };
        this.applyTransform();
        this.entity.name = `studioLight:${state.name}`;
        this.dirty = true;
        this.update();
    }

    // read the head's transform back into the state (after a gizmo drag)
    syncFromEntity() {
        const p = this.entity.getLocalPosition();
        const r = this.entity.getLocalEulerAngles();
        this.state.position = [p.x, p.y, p.z];
        this.state.rotation = [r.x, r.y, r.z];
        if (this.state.target) {
            this.applyTransform();
        }
        this.dirty = true;
        this.update();
    }

    get forward() {
        return this.entity.forward;
    }

    // the linear colour of the light with a luminance of 1 (temperature x gel)
    get tint(): Vec3Tuple {
        const k = kelvinToLinear(this.state.kelvin);
        const g = this.state.gel;
        return [k[0] * srgbToLinear(g[0]), k[1] * srgbToLinear(g[1]), k[2] * srgbToLinear(g[2])];
    }

    params(): LightParams {
        const s = this.state;
        const info = this.info;
        const f = this.entity.forward;
        const u = this.entity.up;
        const tint = this.tint;
        const beam = Math.min(89, Math.max(1, s.beam)) * Math.PI / 180;
        return {
            type: info.lightType,
            position: [s.position[0], s.position[1], s.position[2]],
            forward: [f.x, f.y, f.z],
            up: [u.x, u.y, u.z],
            width: info.lightType === LT_SUN ? 0 : s.width,
            height: info.lightType === LT_RECT ? s.width * s.aspect : s.width,
            color: [tint[0] * s.intensity, tint[1] * s.intensity, tint[2] * s.intensity],
            castShadows: s.shadows,
            cosOuter: Math.cos(beam),
            cosInner: Math.cos(beam * (1 - 0.95 * Math.min(1, Math.max(0, s.softEdge)))),
            exponent: s.spread,
            // a sun's width is the apparent diameter of its disk in degrees
            sunAngle: info.lightType === LT_SUN ? Math.max(0.05, s.width) * 0.5 * Math.PI / 180 : 0,
            ringInner: info.ringInner
        };
    }

    // mark for a refresh of everything that depends on the studio (floor, scale, selection)
    invalidate() {
        this.dirty = true;
    }

    // refresh the model, stand and beam lines
    update() {
        if (!this.scene || !this.dirty) return;
        this.dirty = false;
        const s = this.state;
        const visible = s.visible;
        this.entity.enabled = visible;
        this.stand.enabled = visible && s.kind !== 'sun';
        this.lines.enabled = visible && this.studio.showBeams();
        if (!visible) return;

        this.rebuildModel();
        const scale = this.modelScale;
        this.model.setLocalScale(scale, scale, scale);

        // colours: housing (orange when selected) and the emitter
        const selected = this.studio.isSelected(this);
        const bodyColor = selected ? [0.95, 0.55, 0.15] : [0.16, 0.16, 0.17];
        this.bodyInstance?.setParameter('fixtureColor', bodyColor);
        this.standInstances.forEach(mi => mi.setParameter('fixtureColor', selected ? [0.55, 0.35, 0.15] : [0.12, 0.12, 0.13]));
        const t = this.tint;
        const peak = Math.max(t[0], t[1], t[2]) || 1;
        this.emitterInstance?.setParameter('fixtureEmit', [linearToSrgb(t[0] / peak), linearToSrgb(t[1] / peak), linearToSrgb(t[2] / peak)]);

        this.updateStand(scale);
        this.updateLines(scale, selected);
    }

    private updateStand(scale: number) {
        if (this.state.kind === 'sun') return;
        const head = this.entity.getPosition();
        const floor = this.studio.floorY();
        // the stand meets the head below its yoke / bottom
        const top = head.y - this.half.y * scale * 0.9;
        const height = top - floor;
        const subject = this.studio.scale();
        if (height <= subject * 0.05) {
            // hanging or standing on the floor: no stand
            this.stand.enabled = false;
            return;
        }
        this.stand.enabled = true;
        const radius = subject * 0.008;
        const [pole, legs] = this.stand.children as Entity[];
        pole.setLocalPosition(head.x, floor, head.z);
        pole.setLocalScale(radius * 2, height, radius * 2);
        const legLength = Math.min(height * 0.6, subject * 0.35);
        legs.setLocalPosition(head.x, floor, head.z);
        legs.setLocalScale(legLength, legLength, legLength);
    }

    private updateLines(scale: number, selected: boolean) {
        if (!this.lineMesh || !this.studio.showBeams()) return;
        const s = this.state;
        const t = this.tint;
        const peak = Math.max(t[0], t[1], t[2]) || 1;
        const alpha = selected ? 1 : 0.55;
        const color = [linearToSrgb(t[0] / peak) * alpha, linearToSrgb(t[1] / peak) * alpha, linearToSrgb(t[2] / peak) * alpha, 1];
        const positions: number[] = [];
        const colors: number[] = [];
        const line = (a: Vec3, b: Vec3) => {
            positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
            colors.push(...color, ...color);
        };

        const origin = this.entity.getPosition().clone();
        const f = this.entity.forward.clone();
        const right = this.entity.right.clone();
        const up = this.entity.up.clone();
        const subject = this.studio.scale();
        // beam length: to the aim point, or a couple of subject sizes
        let length = subject * 2;
        if (s.target) {
            length = Math.max(subject * 0.2, origin.distance(new Vec3(s.target[0], s.target[1], s.target[2])));
        }

        const info = this.info;
        if (info.lightType === LT_SPOT) {
            // the beam cone, with its edge where the light falls off
            const radius = Math.tan(Math.min(89, s.beam) * Math.PI / 180) * length;
            const center = origin.clone().add(f.clone().mulScalar(length));
            const n = 24;
            let prev: Vec3 | null = null;
            for (let i = 0; i <= n; ++i) {
                const a = i / n * Math.PI * 2;
                const p = center.clone().add(right.clone().mulScalar(Math.cos(a) * radius)).add(up.clone().mulScalar(Math.sin(a) * radius));
                if (prev) line(prev, p);
                if (i % 6 === 0) line(origin, p);
                prev = p;
            }
        } else if (info.lightType === LT_SUN) {
            // parallel rays through the scene in the sun's direction
            const center = origin.clone();
            for (let i = 0; i < 5; ++i) {
                const ox = (i % 3 - 1) * subject * 0.3;
                const oy = (Math.floor(i / 3) - 0.5) * subject * 0.3;
                const a = center.clone().add(right.clone().mulScalar(ox)).add(up.clone().mulScalar(oy));
                const b = a.clone().add(f.clone().mulScalar(subject * 1.5));
                line(a, b);
                // arrow head
                line(b, b.clone().sub(f.clone().mulScalar(subject * 0.12)).add(right.clone().mulScalar(subject * 0.06)));
                line(b, b.clone().sub(f.clone().mulScalar(subject * 0.12)).sub(right.clone().mulScalar(subject * 0.06)));
            }
        } else {
            // area and point lights: the aim line and a ring where it lands
            const end = origin.clone().add(f.clone().mulScalar(length));
            line(origin, end);
            const radius = Math.max(scale * 0.5, subject * 0.08);
            const n = 24;
            let prev: Vec3 | null = null;
            for (let i = 0; i <= n; ++i) {
                const a = i / n * Math.PI * 2;
                const p = end.clone().add(right.clone().mulScalar(Math.cos(a) * radius)).add(up.clone().mulScalar(Math.sin(a) * radius));
                if (prev) line(prev, p);
                prev = p;
            }
        }

        this.lineMesh.setPositions(positions);
        this.lineMesh.setColors(colors);
        this.lineMesh.update(PRIMITIVE_LINES);
    }

    // packed every frame: any change re-renders the viewport
    serialize(serializer: Serializer) {
        const s = this.state;
        serializer.packa(s.position);
        serializer.packa(s.rotation);
        serializer.packa(s.gel);
        serializer.pack(s.intensity, s.kelvin, s.width, s.aspect, s.beam, s.softEdge, s.spread, s.shadows, s.visible, this.studio.isSelected(this), this.studio.showBeams());
    }

    onPreRender() {
        this.update();
    }

    // ray test against the fixture's box, returns the distance or -1
    pick(origin: Vec3, direction: Vec3) {
        if (!this.state.visible) return -1;
        const m = this.entity.getWorldTransform();
        const inv = m.clone().invert();
        const scale = this.modelScale;
        const o = inv.transformPoint(origin, new Vec3());
        const d = inv.transformVector(direction, new Vec3());
        // a minimum pick size so tiny bulbs stay clickable
        const minHalf = this.studio.scale() * 0.04;
        const hx = Math.max(this.half.x * scale, minHalf), hy = Math.max(this.half.y * scale, minHalf), hz = Math.max(this.half.z * scale, minHalf);
        // fixture models extend behind the emitter (+Z)
        const cz = this.state.kind === 'bulb' || this.state.kind === 'sun' ? 0 : hz;
        let tn = -Infinity, tf = Infinity;
        const axes: [number, number, number, number][] = [[o.x, d.x, -hx, hx], [o.y, d.y, -hy, hy], [o.z, d.z, cz - hz, cz + hz]];
        for (const [oo, dd, lo, hi] of axes) {
            if (Math.abs(dd) < 1e-12) {
                if (oo < lo || oo > hi) return -1;
                continue;
            }
            const t1 = (lo - oo) / dd, t2 = (hi - oo) / dd;
            tn = Math.max(tn, Math.min(t1, t2));
            tf = Math.min(tf, Math.max(t1, t2));
        }
        if (tf < Math.max(tn, 0)) return -1;
        // distance in world units
        const hit = o.add(d.mulScalar(Math.max(tn, 0)));
        return m.transformPoint(hit, new Vec3()).distance(origin);
    }
}

export { StudioLight, LightState, StudioContext, Vec3Tuple };
