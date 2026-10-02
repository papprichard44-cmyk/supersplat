import { BooleanInput, Button, ColorPicker, Container, Label, SelectInput, SliderInput } from '@playcanvas/pcui';
import { BoundingBox, Ray, Vec3 } from 'playcanvas';

import { bakeSamples, BakeCancelled, BakeSettings, LightParams, packLight } from './bake';
import { kelvinPresets, kelvinToLinear } from './color';
import { addFarViewBacking, BackingTarget } from './far-backing';
import { FixtureKind, fixtureKinds, fixtures } from './fixtures';
import { AddLightOp, LightStateOp, RemoveLightOp, SplatVisibleOp, StudioSettingsOp } from './light-ops';
import { Preset, presets } from './presets';
import { SampleBuffer, SplatColors, srgbToLinear, unlitColors, writeSplatPly } from './samples';
import { LIGHT_FLOATS, MAX_PREVIEW_LIGHTS, minAlphaForDegree, TONEMAP_FILMIC, TONEMAP_NEUTRAL, TONEMAP_NONE } from './shading';
import { splatLighting } from './splat-lighting';
import { buildShadowGrid, PlyLayout, readPlyLayout, ShadowGrid, splatSamples, writeDc } from './splat-relight';
import { LightState, StudioLight, Vec3Tuple } from './studio-light';
import { AddSplatOp, MultiOp } from '../../edit-ops';
import { Element, ElementType } from '../../element';
import { Splat } from '../../splat';
import { ShapeGizmoMode, ShapeTransformGizmo } from '../../tools/shape-transform-gizmo';
import deleteSvg from '../../ui/svg/delete.svg';
import hiddenSvg from '../../ui/svg/hidden.svg';
import shownSvg from '../../ui/svg/shown.svg';
import lightingSvg from '../icons/lighting.svg';
import type { ToolkitContext, ToolkitModule } from '../index';
import { collapsible } from '../inspector';
import { MemorySink } from '../memory-sink';
import { MeshPrimitive, PrimitiveState } from '../mesh-primitive';
import { headerIcon, registerPanel } from '../panels';
import { PrimitiveStateOp } from '../primitive-ops';
import { cellForDensity, Occluder, primitiveOccluder, samplePrimitive } from '../primitive-to-splat';
import { grassSplatCount } from '../vegetation/grass';


// Studio lighting: place film lights around primitives and models, see them
// lit live in the viewport, and bake the light into the splats when they are
// converted. The lights are hidden (not deleted) after a conversion, so the
// set can be adjusted and baked again.

const TOOL = 'toolkitLight';

// splats per conversion, beyond which the browser runs out of memory
const MAX_SPLATS = 15_000_000;
// above this much memory a conversion asks before it starts
const MEMORY_WARNING = 3 * 1024 * 1024 * 1024;

type StudioSettings = {
    scale: number;                          // subject size the rig was laid out for
    exposure: number;                       // EV
    tonemap: number;                        // TONEMAP_*
    ambient: number;                        // ambient intensity (0 = black surrounding)
    ambientColor: Vec3Tuple;                // sRGB
    ground: number;                         // light bouncing up from the floor, fraction of the ambient
    occlusion: boolean;                     // ambient occlusion in the bake
    degree: number;                         // highlights: SH degree 0..3
    shadows: number;                        // 0 off, 1 hard, 2 soft, 3 very soft
    density: number;                        // splats along the longest side of everything converted
    hideAfter: boolean;                     // hide the converted meshes and the lights afterwards
    backing: boolean;                       // far-view backing inside converted solids (far-backing.ts)
    showBeams: boolean;
    lightSplats: boolean;                   // the lights also reach the splat layers
    noShadow: string[];                     // objects that cast no shadows in the bake
    splatBase: number;                      // share of the splats' own light that is kept
    subject: string;                        // what the lights aim at: 'auto' or a mesh / splat layer key
};

const defaultSettings = (): StudioSettings => ({
    scale: 1,
    exposure: 0,
    tonemap: TONEMAP_FILMIC,
    ambient: 0.05,
    ambientColor: [1, 1, 1],
    ground: 0.5,
    occlusion: true,
    degree: 3,
    shadows: 2,
    density: 400,
    hideAfter: true,
    backing: true,
    showBeams: true,
    lightSplats: false,
    noShadow: [],
    splatBase: 1,
    subject: 'auto'
});

const shadowRays = [0, 1, 16, 36];

const tips = {
    toggle: 'Studio lighting: place film lights around your meshes, then bake the light into the splats.',
    preset: 'Ready-made lighting setups used in film and photography. Applying one replaces the current lights and arranges new ones around the selected mesh (or everything that is visible), relative to your current camera view.',
    apply: 'Replace the current lights with this setup.',
    fixture: (kind: FixtureKind) => `Add a ${fixtures[kind].label.toLowerCase()}: ${fixtures[kind].description}`,
    lightRow: 'Click to select this light and move or turn it with the gizmo (you can also click the lamp in the viewport).',
    visible: 'Switch this light on or off (a hidden light gives no light).',
    remove: 'Delete this light (undo brings it back).',
    move: 'Move the selected light with the gizmo (shortcut: 1).',
    rotate: 'Turn the selected light with the gizmo (shortcut: 2). Turning switches off "Aim at subject".',
    aim: 'Point the light at the centre of the subject and keep it pointed there while you move it.',
    subject: 'What the lights are set up around and aim at: pick a mesh or a splat layer of the scene. Automatic: the selected mesh, else everything visible. Lights that are aiming turn to a newly picked subject.',
    power: 'Brightness in stops: +1 doubles the light, -1 halves it. Like a real lamp, it also gets brighter as you move it closer to the subject.',
    kelvin: 'Colour temperature: low values are warm and orange (candle, tungsten bulb), around 5600 K is neutral daylight, high values are cool and blue (shade, overcast).',
    gel: 'Colour filter in front of the lamp (white = no filter), like a coloured gel on a film light.',
    size: 'Size of the light. Bigger lights give softer shadows and broader highlights; small lights give crisp shadows and pin-point highlights.',
    sunSize: 'Apparent size of the sun in degrees. The real sun is about 0.5; larger values soften the shadow edges like haze.',
    beam: 'How wide the spotlight\'s beam is (half-angle in degrees).',
    softEdge: 'How gradually the beam fades out at its edge: 0 = a sharp circle of light, 1 = a soft falloff.',
    spread: 'How much the light spreads sideways: low = wide and wrapping, high = directed forwards, like a honeycomb grid on a softbox.',
    aspect: 'Height of the light relative to its width.',
    shadows: 'Whether this light casts shadows in the bake.',
    ambient: 'Light coming from all around (sky, walls). At 0 everything the lamps don\'t reach is black.',
    ambientColor: 'Colour of the light from all around.',
    ground: 'How much light bounces back up from the floor into the shadows.',
    occlusion: 'Ambient occlusion: darken creases and the spots where objects meet or stand on the floor. Makes the bake look grounded and real.',
    exposure: 'Overall brightness of the picture, in stops, like the exposure of a camera.',
    autoExposure: 'Set the exposure so the subject gets a normal brightness from the current lights.',
    tonemap: 'How very bright light is rolled off: Filmic gives a soft, cinematic roll-off with rich contrast, Neutral keeps colours true (products), None clips hard.',
    beams: 'Show the beam and aim lines of the lights in the viewport.',
    density: 'Detail of the conversion: how many splats run along the longest side of everything converted. Higher = sharper, but more splats and a larger file.',
    degree: 'How highlights and reflections are stored. Off: lighting is baked as plain colour (smallest file). Higher levels keep highlights moving with the viewing angle like on the real material, but make the file bigger. Very sharp, mirror-like highlights are always softened.',
    shadowQuality: 'Shadow quality of the bake. Soft and very soft trace more rays for smooth shadow edges from big lights, and take longer.',
    hideAfter: 'After converting, hide the meshes and the lights (they are kept, not deleted) so you see only the splats.',
    backing: 'Keep converted objects visible from far away. Splat viewers skip gaussians smaller than about half a pixel, and a converted mesh is made of equally tiny ones, so without this it vanishes all at once as you move away. On: boxes, spheres, cylinders, cones, tori and extruded pictures get hidden layers of larger gaussians inside them that take over from a distance (about a third more splats). Flat planes, backdrops and models have no inside for it.',
    convert: 'Turn every visible primitive and model into one splat layer, with the studio lighting baked in.',
    estimate: 'Approximate size of the result.',
    lightSplats: 'Let the lights reach the splat layers too: they light up live in the viewport, and "Bake & convert" writes the light into a lit copy of each layer (the original is hidden, not deleted). Off: the lights only reach the meshes.',
    splatBase: 'How much of the splats\' own, captured light is kept under the lamps: 1 = all of it (the lamps add light on top), lower values darken the original so the lamps dominate.',
    only: 'Limit this light to the objects ticked below. Off: it reaches everything.',
    casters: 'Which objects cast shadows when baking. A splat layer (e.g. a scanned statue on a mesh podium) shadows the meshes and the other splat layers, never itself: its own captured shadows are already in its colours. Shadows fall on everything the lights reach.',
    targets: 'The objects this light reaches. Splat layers appear here when "Light splats" is on.'
};

const createSvg = (svgString: string) => {
    const decodedStr = decodeURIComponent(svgString.substring('data:image/svg+xml,'.length));
    return new DOMParser().parseFromString(decodedStr, 'image/svg+xml').documentElement;
};

const isPrimitive = (element: Element): element is MeshPrimitive => element instanceof MeshPrimitive;
const isLight = (element: Element): element is StudioLight => element instanceof StudioLight;

const statesEqual = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// approximate surface area of a primitive, for the size estimate
const approxArea = (primitive: MeshPrimitive) => {
    const s = primitive.entity.getWorldTransform().getScale();
    const x = Math.abs(s.x), y = Math.abs(s.y), z = Math.abs(s.z);
    switch (primitive.kind) {
        case 'plane': return x * z;
        case 'box': return 2 * (x * y + y * z + z * x);
        case 'image': return 2 * x * z * 0.6;
        case 'sphere': return Math.PI * ((x + y + z) / 3) ** 2;
        case 'cylinder': return Math.PI * ((x + z) / 2) * y + Math.PI * ((x + z) / 4) ** 2 * 2;
        case 'cone': return Math.PI * ((x + z) / 4) * (((x + z) / 4) + Math.hypot((x + z) / 4, y));
        case 'torus': return 4 * Math.PI * Math.PI * 0.35 * 0.15 * ((x + z) / 2) * ((x + y + z) / 3);
        case 'backdrop': return x * (z * 0.85 + y * 0.85);
        default: {
            const half = primitive.localHalf;
            return 2 * (half.x * half.y * x * y + half.y * half.z * y * z + half.z * half.x * z * x) * 4 * 0.5;
        }
    }
};

// approximate number of splats a primitive converts to at a sample spacing
// bytes a conversion of `count` splats holds at its peak: the samples, the
// colours and the PLY written from them (plus the far-view backing)
const conversionMemoryFor = (count: number, degree: number, backing: boolean) => {
    const rest = [0, 9, 24, 45][degree];
    const perSplat = 24 * 4 + (3 + rest) * 4 + (14 + rest) * 4;
    return count * perSplat * (backing ? 1.3 : 1);
};

const approxSplats = (primitive: MeshPrimitive, cell: number) => {
    const g = primitive.generator;
    if (primitive.kind === 'model' && g?.type === 'grass' && g.params?.direct !== false) {
        return grassSplatCount(g.params);
    }
    return approxArea(primitive) / (cell * cell);
};

let getLights: () => StudioLight[] = () => [];
let getSettings: () => StudioSettings = defaultSettings;
let loadStudio: (data: any) => Promise<void> = async () => {};

const init = (ctx: ToolkitContext) => {
    const { events, scene, toolManager, canvasContainer, tooltips } = ctx;

    let settings = defaultSettings();
    let selected: StudioLight | null = null;
    let counter = 0;

    // the panel's helpers refer to each other, so they are declared up front
    let refreshAll: () => void = () => {};
    let refreshList: () => void = () => {};
    let updateSettingsUI: () => void = () => {};
    let updateEstimate: () => void = () => {};
    let flushPending: () => void = () => {};
    let select: (light: StudioLight | null) => void = () => {};
    let updateEditor: () => void = () => {};
    let refreshTargets: () => void = () => {};
    let refreshCasters: () => void = () => {};

    const primitives = () => scene.getElementsByType(ElementType.model).filter(isPrimitive);
    const visiblePrimitives = () => primitives().filter(p => p.entity.enabled);
    const lights = () => scene.getElementsByType(ElementType.other).filter(isLight);
    const activeLights = () => lights().filter(l => l.state.visible);
    getLights = lights;
    getSettings = () => settings;

    // ---- the subject: what the lights are arranged around

    const subjectBound = (only?: MeshPrimitive[]) => {
        const bound = new BoundingBox();
        let valid = false;
        (only ?? visiblePrimitives()).forEach((p) => {
            const b = p.worldBound;
            if (!b) return;
            if (!valid) {
                bound.copy(b);
                valid = true;
            } else {
                bound.add(b);
            }
        });
        if (!valid) {
            const hasSplat = scene.getElementsByType(ElementType.splat).length > 0;
            if (hasSplat) {
                bound.copy(scene.bound);
            } else {
                bound.center.copy(scene.camera.focalPoint);
                bound.halfExtents.set(0.5, 0.5, 0.5);
            }
        }
        return bound;
    };

    const subjectSize = (bound: BoundingBox) => Math.max(1e-3, bound.halfExtents.length() * 2 * 0.7);

    // the selected primitive (if any) is the subject of a new setup
    let selectedPrimitive: MeshPrimitive | null = null;
    events.on('toolkit.primitive.selected', (primitive: MeshPrimitive | null) => {
        selectedPrimitive = primitive;
    });

    const studioContext = {
        floorY: () => {
            const prims = visiblePrimitives();
            if (prims.length === 0) {
                return subjectBound().getMin().y;
            }
            return subjectBound(prims).getMin().y;
        },
        scale: () => settings.scale,
        showBeams: () => settings.showBeams,
        isSelected: (light: StudioLight) => light === selected
    };

    const invalidateLights = () => {
        lights().forEach(light => light.invalidate());
        scene.forceRender = true;
    };

    // ---- intensity <-> power in stops

    const powerToIntensity = (kind: FixtureKind, power: number) => {
        const base = fixtures[kind].lightType === 4 ? 1 : settings.scale * settings.scale;
        return base * Math.pow(2, power);
    };
    const intensityToPower = (kind: FixtureKind, intensity: number) => {
        const base = fixtures[kind].lightType === 4 ? 1 : settings.scale * settings.scale;
        return Math.log2(Math.max(1e-9, intensity / base));
    };

    // ---- preview uniforms, every frame

    const lightData = new Float32Array(MAX_PREVIEW_LIGHTS * LIGHT_FLOATS);
    const ambientLinear = () => {
        const c = settings.ambientColor;
        const sky: Vec3Tuple = [srgbToLinear(c[0]) * settings.ambient, srgbToLinear(c[1]) * settings.ambient, srgbToLinear(c[2]) * settings.ambient];
        const ground: Vec3Tuple = [sky[0] * settings.ground, sky[1] * settings.ground, sky[2] * settings.ground];
        return { sky, ground };
    };

    // ---- which lights reach which object

    // backdrops (the sky) are never lit, aimed at or shadowed
    const splatLayers = () => (scene.getElementsByType(ElementType.splat) as Splat[]).filter(sp => !sp.background);
    const targetKey = (element: MeshPrimitive | Splat) => (isPrimitive(element) ? `mesh:${element.name}` : `splat:${element.name}`);
    // the subject picked in the panel, if it is still in the scene and shown
    const subjectElement = (): MeshPrimitive | Splat | null => {
        if (!settings.subject || settings.subject === 'auto') return null;
        const all: (MeshPrimitive | Splat)[] = [...primitives(), ...splatLayers()];
        return all.find(e => targetKey(e) === settings.subject && (isPrimitive(e) ? e.entity.enabled : e.visible)) ?? null;
    };
    // what lights are arranged around and aim at
    const chosenSubjectBound = () => {
        const element = subjectElement();
        const b = element?.worldBound;
        if (b) {
            const bound = new BoundingBox();
            bound.copy(b);
            return bound;
        }
        return subjectBound(selectedPrimitive ? [selectedPrimitive] : undefined);
    };

    const reaches = (light: StudioLight, element: MeshPrimitive | Splat) => {
        if (!isPrimitive(element) && !settings.lightSplats) return false;
        return !light.state.only || (light.state.targets ?? []).includes(targetKey(element));
    };
    // bit i set = light i of `list` reaches the element
    const maskFor = (element: MeshPrimitive | Splat, list: StudioLight[]) => {
        let mask = 0;
        list.forEach((light, i) => {
            if (reaches(light, element)) mask |= 1 << i;
        });
        return mask;
    };

    events.on('update', () => {
        const device = scene.graphicsDevice;
        const active = activeLights().slice(0, MAX_PREVIEW_LIGHTS);
        lightData.fill(0);
        active.forEach((light, i) => packLight(light.params(), lightData, i * LIGHT_FLOATS, false));

        // masks of the meshes and splat layers, redrawn when they change
        let changed = false;
        primitives().forEach((p) => {
            const mask = maskFor(p, active);
            if (mask !== p.studioMask) {
                p.setStudioMask(mask);
                changed = true;
            }
        });
        splatLayers().forEach((splat) => {
            const mask = maskFor(splat, active);
            if (mask !== splat.studioMask) {
                splat.studioMask = mask;
                changed = true;
            }
        });
        splatLighting.lights.set(lightData);
        splatLighting.count = active.length;
        splatLighting.base = settings.splatBase;
        splatLighting.exposure = Math.pow(2, settings.exposure);
        if (changed) scene.forceRender = true;
        const { sky, ground } = ambientLinear();
        const scope = device.scope;
        scope.resolve('studioCount').setValue(active.length);
        scope.resolve('studioLights[0]').setValue(lightData);
        scope.resolve('studioSky').setValue(sky);
        scope.resolve('studioGround').setValue(ground);
        scope.resolve('studioExposure').setValue(Math.pow(2, settings.exposure));
        scope.resolve('studioTonemap').setValue(settings.tonemap);
        scope.resolve('studioMinAlpha').setValue(minAlphaForDegree(settings.degree));
    });

    // ---- panel

    const panel = new Container({ id: 'toolkit-lighting-panel', class: 'panel', hidden: true });
    ['pointerdown', 'pointerup', 'pointermove', 'wheel', 'dblclick'].forEach((eventName) => {
        panel.dom.addEventListener(eventName, (event: Event) => event.stopPropagation());
    });

    const header = new Container({ class: 'panel-header' });
    header.append(headerIcon(lightingSvg));
    header.append(new Label({ text: 'Studio lighting', class: 'panel-header-label' }));
    panel.append(header);

    const body = new Container({ class: 'toolkit-lighting-body' });
    panel.append(body);

    const section = (title: string) => {
        const label = new Label({ text: title, class: 'toolkit-section' });
        body.append(label);
        return label;
    };

    const hint = (text = '') => new Label({ text, class: 'toolkit-hint' });

    const row = (labelText?: string, tip?: string) => {
        const r = new Container({ class: 'toolkit-row' });
        if (labelText !== undefined) {
            const label = new Label({ text: labelText, class: 'toolkit-label' });
            r.append(label);
            if (tip) tooltips.register(label, tip, 'left');
        }
        return r;
    };

    // empty-state guidance
    const intro = hint('Add a primitive or a .glb model in the Primitives panel, then pick a setup below or add lights one by one. The meshes show the lighting live; "Bake & convert" turns them into lit splats.');
    intro.class.add('toolkit-intro');
    body.append(intro);

    // setup presets
    section('Lighting setup');
    const presetRow = row();
    const presetSelect = new SelectInput({
        class: 'toolkit-select',
        type: 'string',
        options: presets.map(p => ({ v: p.id, t: p.label })),
        value: presets[0].id
    });
    const applyPreset = new Button({ text: 'Apply', class: 'toolkit-convert' });
    presetRow.append(presetSelect);
    presetRow.append(applyPreset);
    body.append(presetRow);
    const presetHint = hint();
    body.append(presetHint);

    // the subject the setup is arranged around and the lights aim at
    const subjectRow = row('Subject', tips.subject);
    const subjectSelect = new SelectInput({ class: 'toolkit-select', type: 'string', options: [{ v: 'auto', t: 'Automatic' }], value: 'auto' });
    subjectRow.append(subjectSelect);
    tooltips.register(subjectSelect, tips.subject, 'bottom');
    body.append(subjectRow);
    tooltips.register(presetSelect, tips.preset, 'left');
    tooltips.register(applyPreset, tips.apply, 'bottom');

    const updatePresetHint = () => {
        const preset = presets.find(p => p.id === presetSelect.value) ?? presets[0];
        presetHint.text = `${preset.description} Expect: ${preset.expect}`;
    };
    presetSelect.on('change', updatePresetHint);
    updatePresetHint();

    // add lights
    section('Add a light');
    const fixtureGrid = new Container({ class: 'toolkit-fixture-grid' });
    const fixtureButtons = new Map<FixtureKind, Button>();
    fixtureKinds.forEach((kind) => {
        const button = new Button({ text: fixtures[kind].label, class: 'toolkit-fixture' });
        fixtureGrid.append(button);
        fixtureButtons.set(kind, button);
        tooltips.register(button, tips.fixture(kind), 'left');
    });
    body.append(fixtureGrid);

    // light list
    section('Lights');
    const list = new Container({ class: 'toolkit-list' });
    body.append(list);
    const emptyList = hint('No lights yet.');
    body.append(emptyList);
    const allRow = row();
    const showAll = new Button({ text: 'Show all lights', class: 'toolkit-button' });
    const hideAll = new Button({ text: 'Hide all lights', class: 'toolkit-button' });
    allRow.append(showAll);
    allRow.append(hideAll);
    body.append(allRow);
    tooltips.register(showAll, 'Switch every light back on, e.g. to re-light the set after a conversion hid it.', 'bottom');
    tooltips.register(hideAll, 'Switch every light off (they are kept).', 'bottom');

    // selected light editor
    const editor = new Container({ class: 'toolkit-editor', hidden: true });
    body.append(editor);

    const editorTitle = new Label({ text: '', class: 'toolkit-editor-title' });
    editor.append(editorTitle);
    const editorHint = hint();
    editor.append(editorHint);

    const modeRow = row();
    const moveButton = new Button({ class: 'toolkit-mode', icon: 'E111' });
    const rotateButton = new Button({ class: 'toolkit-mode', icon: 'E113' });
    const aimButton = new Button({ text: 'Aim at subject', class: 'toolkit-button' });
    modeRow.append(moveButton);
    modeRow.append(rotateButton);
    modeRow.append(aimButton);
    editor.append(modeRow);
    const aimAtRow = row('Aim at', tips.subject);
    const aimAtSelect = new SelectInput({ class: 'toolkit-select', type: 'string', options: [{ v: 'auto', t: 'Automatic' }], value: 'auto' });
    aimAtRow.append(aimAtSelect);
    tooltips.register(aimAtSelect, tips.subject, 'bottom');
    editor.append(aimAtRow);
    tooltips.register(moveButton, tips.move, 'bottom');
    tooltips.register(rotateButton, tips.rotate, 'bottom');
    tooltips.register(aimButton, tips.aim, 'bottom');

    const sliderRow = (label: string, tip: string, min: number, max: number, precision: number, step?: number) => {
        const r = row(label, tip);
        const slider = new SliderInput({ class: 'toolkit-slider', min, max, precision, step: step ?? Math.pow(10, -precision), value: min });
        r.append(slider);
        tooltips.register(slider, tip, 'bottom');
        return { row: r, slider };
    };

    const power = sliderRow('Power', tips.power, -6, 8, 1, 0.1);
    editor.append(power.row);

    const kelvinRow = row('Colour', tips.kelvin);
    const kelvinSlider = new SliderInput({ class: 'toolkit-slider', min: 1500, max: 10000, precision: 0, step: 100, value: 5600 });
    const kelvinSelect = new SelectInput({
        class: 'toolkit-select-small',
        type: 'number',
        options: [{ v: 0, t: 'Preset' }, ...kelvinPresets.map(k => ({ v: k.kelvin, t: `${k.label} ${k.kelvin} K` }))],
        value: 0
    });
    kelvinRow.append(kelvinSlider);
    kelvinRow.append(kelvinSelect);
    editor.append(kelvinRow);
    tooltips.register(kelvinSlider, tips.kelvin, 'bottom');

    const gelRow = row('Gel', tips.gel);
    const gelPicker = new ColorPicker({ class: 'toolkit-color', value: [1, 1, 1] });
    gelRow.append(gelPicker);
    editor.append(gelRow);
    tooltips.register(gelPicker, tips.gel, 'bottom');

    const size = sliderRow('Size', tips.size, 0.02, 3, 2, 0.01);
    editor.append(size.row);
    const aspect = sliderRow('Height', tips.aspect, 0.2, 6, 2, 0.05);
    editor.append(aspect.row);
    const beam = sliderRow('Beam', tips.beam, 3, 70, 0, 1);
    editor.append(beam.row);
    const softEdge = sliderRow('Edge', tips.softEdge, 0, 1, 2, 0.01);
    editor.append(softEdge.row);
    const spread = sliderRow('Focus', tips.spread, 0.3, 8, 1, 0.1);
    editor.append(spread.row);

    const shadowsRow = row('Shadows', tips.shadows);
    const shadowsToggle = new BooleanInput({ type: 'toggle', value: true });
    shadowsRow.append(shadowsToggle);
    editor.append(shadowsRow);

    const onlyRow = row('Only selected', tips.only);
    const onlyToggle = new BooleanInput({ type: 'toggle', value: false });
    onlyRow.append(onlyToggle);
    editor.append(onlyRow);
    const targetList = new Container({ class: 'toolkit-checklist' });
    editor.append(targetList);
    tooltips.register(targetList, tips.targets, 'left');

    // environment and look
    section('What the lights reach');
    const splatsRow = row('Light splats', tips.lightSplats);
    const splatsToggle = new BooleanInput({ type: 'toggle', value: false });
    splatsRow.append(splatsToggle);
    body.append(splatsRow);
    const splatBase = sliderRow('Keep own', tips.splatBase, 0, 1, 2, 0.01);
    body.append(splatBase.row);
    const castersTitle = hint('Casts shadows (when baking):');
    castersTitle.class.add('toolkit-subtitle');
    body.append(castersTitle);
    tooltips.register(castersTitle, tips.casters, 'left');
    const castersList = new Container({ class: 'toolkit-checklist' });
    body.append(castersList);

    section('Environment & camera');
    const ambient = sliderRow('Ambient', tips.ambient, 0, 1, 2, 0.01);
    const ambientPicker = new ColorPicker({ class: 'toolkit-color-small', value: [1, 1, 1] });
    ambient.row.append(ambientPicker);
    tooltips.register(ambientPicker, tips.ambientColor, 'bottom');
    body.append(ambient.row);
    const ground = sliderRow('Bounce', tips.ground, 0, 1, 2, 0.01);
    body.append(ground.row);

    const exposure = sliderRow('Exposure', tips.exposure, -6, 6, 1, 0.1);
    const autoExposure = new Button({ text: 'Auto', class: 'toolkit-convert' });
    exposure.row.append(autoExposure);
    tooltips.register(autoExposure, tips.autoExposure, 'bottom');
    body.append(exposure.row);

    const tonemapRow = row('Look', tips.tonemap);
    const tonemapSelect = new SelectInput({
        class: 'toolkit-select',
        type: 'number',
        options: [
            { v: TONEMAP_FILMIC, t: 'Filmic (cinematic)' },
            { v: TONEMAP_NEUTRAL, t: 'Neutral (true colours)' },
            { v: TONEMAP_NONE, t: 'None (hard clip)' }
        ],
        value: TONEMAP_FILMIC
    });
    tonemapRow.append(tonemapSelect);
    body.append(tonemapRow);

    const beamsRow = row('Beams', tips.beams);
    const beamsToggle = new BooleanInput({ type: 'toggle', value: true });
    beamsRow.append(beamsToggle);
    body.append(beamsRow);

    // bake
    section('Bake & convert');
    const density = sliderRow('Detail', tips.density, 50, 1500, 0, 10);
    body.append(density.row);

    const degreeRow = row('Highlights', tips.degree);
    const degreeSelect = new SelectInput({
        class: 'toolkit-select',
        type: 'number',
        options: [
            { v: 0, t: 'Off (baked colour only)' },
            { v: 1, t: 'Low' },
            { v: 2, t: 'Medium' },
            { v: 3, t: 'High (best shine)' }
        ],
        value: 3
    });
    degreeRow.append(degreeSelect);
    body.append(degreeRow);

    const shadowRow = row('Shadows', tips.shadowQuality);
    const shadowSelect = new SelectInput({
        class: 'toolkit-select',
        type: 'number',
        options: [
            { v: 0, t: 'Off' },
            { v: 1, t: 'Hard' },
            { v: 2, t: 'Soft' },
            { v: 3, t: 'Very soft (slow)' }
        ],
        value: 2
    });
    shadowRow.append(shadowSelect);
    body.append(shadowRow);

    const aoRow = row('Occlusion', tips.occlusion);
    const aoToggle = new BooleanInput({ type: 'toggle', value: true });
    aoRow.append(aoToggle);
    body.append(aoRow);

    const hideRow = row('Hide after', tips.hideAfter);
    const hideToggle = new BooleanInput({ type: 'toggle', value: true });
    hideRow.append(hideToggle);
    body.append(hideRow);

    const backingRow = row('Far view', tips.backing);
    const backingToggle = new BooleanInput({ type: 'toggle', value: true });
    backingRow.append(backingToggle);
    tooltips.register(backingToggle, tips.backing, 'bottom');
    body.append(backingRow);

    const estimate = hint();
    estimate.class.add('toolkit-estimate');
    body.append(estimate);
    tooltips.register(estimate, tips.estimate, 'left');

    const convertRow = row();
    const convertButton = new Button({ text: 'Bake & convert to splats', class: 'toolkit-bake' });
    convertRow.append(convertButton);
    body.append(convertRow);
    tooltips.register(convertButton, tips.convert, 'left');

    // ---- the selected light goes to the inspector, in groups
    editorTitle.hidden = true;
    const lightGroup = collapsible('Light', 'light.main');
    lightGroup.body.append(editorHint);
    lightGroup.body.append(modeRow);
    lightGroup.body.append(aimAtRow);
    const lookGroup = collapsible('Brightness & colour', 'light.look');
    lookGroup.body.append(power.row);
    lookGroup.body.append(kelvinRow);
    lookGroup.body.append(gelRow);
    const shapeGroup = collapsible('Shape', 'light.shape');
    [size.row, aspect.row, beam.row, softEdge.row, spread.row].forEach(r => shapeGroup.body.append(r));
    const reachGroup = collapsible('Reach & shadows', 'light.reach');
    reachGroup.body.append(shadowsRow);
    reachGroup.body.append(onlyRow);
    reachGroup.body.append(targetList);
    [lightGroup, lookGroup, shapeGroup, reachGroup].forEach(g => editor.append(g.root));
    body.remove(editor);
    editor.hidden = false;

    // conversion settings live with each mesh now (inspector); this panel
    // keeps what is scene-wide: setups, lights, environment, bake quality
    density.row.hidden = true;
    hideRow.hidden = true;
    backingRow.hidden = true;
    convertButton.text = 'Bake & convert all visible meshes';

    // the panel's sections fold
    const sectionOpen: Record<string, boolean> = {
        'Lighting setup': true,
        'Add a light': true,
        'Lights': true,
        'What the lights reach': false,
        'Environment & camera': false,
        'Bake & convert': true
    };
    let group: ReturnType<typeof collapsible> | null = null;
    Array.from(body.dom.children).forEach((child) => {
        const el = child as HTMLElement;
        if (el.classList.contains('toolkit-section')) {
            const title = el.textContent ?? '';
            group = collapsible(title === 'Bake & convert' ? 'Bake quality & convert all' : title, `studio.${title}`, sectionOpen[title] ?? true);
            body.dom.insertBefore(group.root.dom, el);
            el.remove();
        } else if (group) {
            group.body.dom.appendChild(el);
        }
    });

    canvasContainer.append(panel);

    // ---- toolbar toggle, close button and dragging come from the panel manager

    const panelHandle = registerPanel(ctx, {
        id: 'lighting',
        panel,
        header,
        icon: lightingSvg,
        title: 'Studio lighting',
        tooltip: tips.toggle,
        order: 2
    });

    const setPanelVisible = (visible: boolean) => panelHandle.setVisible(visible);

    events.on('toolkit.panel.lighting.visible', (visible: boolean) => {
        if (!visible) return;
        // at its default place the panel shares the space left of the toolbar
        // with the editor's own popups; once dragged away it can stay open
        if (panelHandle.docked) {
            events.fire('appearancePanel.setVisible', false);
            events.fire('settingsPanel.setVisible', false);
            if (events.invoke('overlaysPanel.visible')) events.fire('overlaysPanel.toggleVisible');
        }
        refreshAll();
    });
    ['appearancePanel.visible', 'settingsPanel.visible', 'overlaysPanel.visible'].forEach((name) => {
        events.on(name, (visible: boolean) => {
            if (visible && panelHandle.docked) setPanelVisible(false);
        });
    });
    events.function('toolkit.lightingPanel.visible', () => panelHandle.visible);
    events.on('toolkit.lightingPanel.setVisible', setPanelVisible);

    // ---- settings editing (debounced into one undo step)

    let uiUpdating = false;
    // declared up front: the settings ui keeps the subject lists current
    let refreshSubjects: () => void = () => {};

    const applySettings = (next: StudioSettings) => {
        const beamsChanged = next.showBeams !== settings.showBeams || next.scale !== settings.scale;
        settings = { ...next, ambientColor: [...next.ambientColor] as Vec3Tuple };
        if (beamsChanged) invalidateLights();
        updateSettingsUI();
        updateEstimate();
        scene.forceRender = true;
    };

    let pendingSettings: { old: StudioSettings, timer: number } | null = null;
    const flushSettings = () => {
        if (!pendingSettings) return;
        window.clearTimeout(pendingSettings.timer);
        const old = pendingSettings.old;
        pendingSettings = null;
        if (!statesEqual(old, settings)) {
            events.fire('edit.add', new StudioSettingsOp<StudioSettings>(applySettings, old, { ...settings }), true);
        }
    };
    const editSettings = (change: Partial<StudioSettings>) => {
        if (uiUpdating) return;
        const old = pendingSettings?.old ?? { ...settings };
        if (pendingSettings) window.clearTimeout(pendingSettings.timer);
        applySettings({ ...settings, ...change });
        pendingSettings = { old, timer: window.setTimeout(flushSettings, 400) };
    };

    updateSettingsUI = () => {
        uiUpdating = true;
        ambient.slider.value = settings.ambient;
        ambientPicker.value = settings.ambientColor;
        ground.slider.value = settings.ground;
        exposure.slider.value = settings.exposure;
        tonemapSelect.value = settings.tonemap;
        beamsToggle.value = settings.showBeams;
        density.slider.value = settings.density;
        degreeSelect.value = settings.degree;
        shadowSelect.value = settings.shadows;
        aoToggle.value = settings.occlusion;
        hideToggle.value = settings.hideAfter;
        backingToggle.value = settings.backing;
        splatsToggle.value = settings.lightSplats;
        splatBase.slider.value = settings.splatBase;
        splatBase.row.hidden = !settings.lightSplats;
        uiUpdating = false;
        refreshCasters();
        refreshSubjects();
    };

    ambient.slider.on('change', (value: number) => editSettings({ ambient: value }));
    ambientPicker.on('change', (value: number[]) => editSettings({ ambientColor: [value[0], value[1], value[2]] }));
    ground.slider.on('change', (value: number) => editSettings({ ground: value }));
    exposure.slider.on('change', (value: number) => editSettings({ exposure: value }));
    tonemapSelect.on('change', (value: number) => editSettings({ tonemap: value }));
    beamsToggle.on('change', (value: boolean) => editSettings({ showBeams: value }));
    density.slider.on('change', (value: number) => editSettings({ density: value }));
    degreeSelect.on('change', (value: number) => editSettings({ degree: value }));
    shadowSelect.on('change', (value: number) => editSettings({ shadows: value }));
    aoToggle.on('change', (value: boolean) => editSettings({ occlusion: value }));
    hideToggle.on('change', (value: boolean) => editSettings({ hideAfter: value }));
    backingToggle.on('change', (value: boolean) => editSettings({ backing: value }));
    events.function('toolkit.backing', () => settings.backing);
    events.function('toolkit.setBacking', (value: boolean) => editSettings({ backing: value }));
    splatsToggle.on('change', (value: boolean) => {
        editSettings({ lightSplats: value });
        updateEditor();
    });
    splatBase.slider.on('change', (value: number) => editSettings({ splatBase: value }));

    // irradiance at the subject, facing the camera, from the current lights
    const subjectIrradiance = () => {
        const bound = chosenSubjectBound();
        const c = bound.center;
        const n = new Vec3().sub2(scene.camera.mainCamera.getPosition(), c).normalize();
        let e = 0;
        activeLights().forEach((light) => {
            const p: LightParams = light.params();
            const lum = 0.2126 * p.color[0] + 0.7152 * p.color[1] + 0.0722 * p.color[2];
            if (p.type === 4) {
                e += lum * Math.max(0, -(n.x * p.forward[0] + n.y * p.forward[1] + n.z * p.forward[2]));
                return;
            }
            const d = new Vec3(p.position[0] - c.x, p.position[1] - c.y, p.position[2] - c.z);
            const dist2 = Math.max(1e-6, d.lengthSq());
            d.normalize();
            const cosr = Math.max(0, n.dot(d));
            const cosf = -(d.x * p.forward[0] + d.y * p.forward[1] + d.z * p.forward[2]);
            let emitf = 1;
            if (p.type === 1) {
                const t = Math.min(1, Math.max(0, (cosf - p.cosOuter) / Math.max(1e-6, p.cosInner - p.cosOuter)));
                emitf = t * t * (3 - 2 * t);
            } else if (p.type === 2 || p.type === 3 || p.type === 5) {
                emitf = cosf > 0 ? Math.pow(cosf, p.exponent) : 0;
            }
            e += lum * emitf * cosr / dist2;
        });
        const { sky, ground: g } = ambientLinear();
        e += 0.2126 * (sky[0] + g[0]) * 0.5 + 0.7152 * (sky[1] + g[1]) * 0.5 + 0.0722 * (sky[2] + g[2]) * 0.5;
        return e;
    };

    autoExposure.on('click', () => {
        const e = subjectIrradiance();
        if (e <= 0) return;
        // a mid-grey subject comes out as a mid-tone
        flushSettings();
        const old = { ...settings };
        applySettings({ ...settings, exposure: Math.max(-6, Math.min(6, Math.round(Math.log2(1.1 / e) * 10) / 10)) });
        events.fire('edit.add', new StudioSettingsOp<StudioSettings>(applySettings, old, { ...settings }), true);
    });

    // ---- lights: creation, list, editor

    const nextName = (role: string) => {
        const used = new Set(lights().map(l => l.state.name));
        let name = role;
        let i = 2;
        while (used.has(name)) name = `${role} ${i++}`;
        return name;
    };

    // a fresh light of a kind, placed relative to the subject and the camera
    const makeLightState = (kind: FixtureKind, role: string, bound: BoundingBox, azimuth: number, elevation: number, distance: number, powerStops: number, extra: Partial<LightState> = {}, sizeFactor = 1): LightState => {
        const info = fixtures[kind];
        const center = bound.center;
        const S = settings.scale;
        // horizontal direction from the subject towards the camera, and camera right
        const toCamera = new Vec3().sub2(scene.camera.mainCamera.getPosition(), center);
        toCamera.y = 0;
        if (toCamera.lengthSq() < 1e-8) toCamera.set(0, 0, 1);
        toCamera.normalize();
        const right = new Vec3().cross(toCamera, Vec3.UP).normalize().mulScalar(-1);
        const az = azimuth * Math.PI / 180;
        const el = elevation * Math.PI / 180;
        const dir = new Vec3()
        .add(toCamera.clone().mulScalar(Math.cos(az) * Math.cos(el)))
        .add(right.clone().mulScalar(Math.sin(az) * Math.cos(el)))
        .add(new Vec3(0, Math.sin(el), 0));
        const position = center.clone().add(dir.mulScalar(distance * S));
        const isSun = info.lightType === 4;
        return {
            kind,
            name: nextName(role),
            position: [position.x, position.y, position.z],
            rotation: [0, 0, 0],
            target: [center.x, center.y, center.z],
            intensity: isSun ? Math.pow(2, powerStops) : S * S * Math.pow(2, powerStops),
            kelvin: 5600,
            gel: [1, 1, 1],
            width: isSun ? 0.53 * sizeFactor : info.width * S * sizeFactor,
            aspect: info.aspect,
            beam: info.beam || 25,
            softEdge: info.softEdge,
            spread: info.exponent,
            shadows: true,
            visible: true,
            ...extra
        };
    };

    let selectOnAdd: StudioLight | null = null;

    const addLight = (kind: FixtureKind) => {
        flushPending();
        const bound = chosenSubjectBound();
        if (lights().length === 0) {
            // the first light sets the scale of the rig
            applySettings({ ...settings, scale: subjectSize(bound) });
        }
        // spread new lights around: alternate sides of the camera
        const n = lights().length;
        const azimuth = [40, -45, 150, -150, 90, -90, 0, 180][n % 8];
        const elevation = kind === 'sun' ? 40 : 25;
        const state = makeLightState(kind, fixtures[kind].label, bound, azimuth, elevation, kind === 'sun' ? 3 : 2.2, kind === 'sun' ? 0.5 : 2.2);
        const light = new StudioLight(state, studioContext);
        selectOnAdd = light;
        events.fire('edit.add', new AddLightOp(scene, light));
    };

    fixtureButtons.forEach((button, kind) => button.on('click', () => addLight(kind)));

    // apply a preset: replace all lights in one undo step
    const applySetup = (preset: Preset, selectLight = true) => {
        flushPending();
        flushSettings();
        const bound = chosenSubjectBound();
        const oldSettings = { ...settings };
        const newSettings: StudioSettings = {
            ...settings,
            scale: subjectSize(bound),
            ambient: preset.ambient,
            ground: preset.ground ?? 0.5,
            exposure: preset.exposure ?? 0,
            ambientColor: (() => {
                if (!preset.ambientKelvin) return [1, 1, 1] as Vec3Tuple;
                const k = kelvinToLinear(preset.ambientKelvin);
                const m = Math.max(...k);
                return [k[0] / m, k[1] / m, k[2] / m].map(c => Math.pow(c, 1 / 2.2)) as Vec3Tuple;
            })()
        };
        applySettings(newSettings);
        const created = preset.lights.map((p) => {
            const extra: Partial<LightState> = {};
            if (p.kelvin) extra.kelvin = p.kelvin;
            if (p.beam) extra.beam = p.beam;
            if (p.softEdge !== undefined) extra.softEdge = p.softEdge;
            if (p.aspect) extra.aspect = p.aspect;
            if (p.spread) extra.spread = p.spread;
            if (p.shadows !== undefined) extra.shadows = p.shadows;
            const state = makeLightState(p.kind, `${p.role} – ${fixtures[p.kind].label}`, bound, p.azimuth, p.elevation, p.distance, p.power, extra, p.size ?? 1);
            return new StudioLight(state, studioContext);
        });
        const ops = [
            ...lights().map(light => new RemoveLightOp(scene, light)),
            ...created.map(light => new AddLightOp(scene, light)),
            new StudioSettingsOp<StudioSettings>(applySettings, oldSettings, newSettings)
        ];
        if (selectLight) select(null);
        selectOnAdd = selectLight ? created[0] ?? null : null;
        events.fire('edit.add', new MultiOp(ops));
    };

    applyPreset.on('click', () => {
        const preset = presets.find(p => p.id === presetSelect.value);
        if (preset) applySetup(preset);
    });

    // edits of the selected light apply live and become one undo step once
    // the inputs have been quiet for a moment
    let pending: { light: StudioLight, oldState: LightState, timer: number } | null = null;

    flushPending = () => {
        if (!pending) return;
        const { light, oldState, timer } = pending;
        window.clearTimeout(timer);
        pending = null;
        const newState = light.getState();
        if (light.scene && !statesEqual(oldState, newState)) {
            events.fire('edit.add', new LightStateOp(light, oldState, newState), true);
        }
    };

    const editLight = (light: StudioLight, change: Partial<LightState>) => {
        if (uiUpdating) return;
        if (pending && pending.light !== light) flushPending();
        const oldState = pending?.oldState ?? light.getState();
        if (pending) window.clearTimeout(pending.timer);
        light.setState({ ...light.getState(), ...change });
        pending = { light, oldState, timer: window.setTimeout(flushPending, 350) };
        refreshList();
        updateEstimate();
        scene.forceRender = true;
    };

    refreshList = () => {
        list.clear();
        const all = lights();
        emptyList.hidden = all.length > 0;
        allRow.hidden = all.length === 0;
        showAll.enabled = all.some(l => !l.state.visible);
        hideAll.enabled = all.some(l => l.state.visible);
        intro.hidden = all.length > 0 || primitives().length > 0;
        all.forEach((light) => {
            const r = new Container({ class: 'toolkit-list-row' });
            if (light === selected) r.class.add('selected');

            const swatch = new Label({ class: 'toolkit-swatch' });
            const t = light.tint;
            const m = Math.max(...t) || 1;
            swatch.dom.style.backgroundColor = `rgb(${t.map(c => Math.round(Math.pow(c / m, 1 / 2.2) * 255)).join(',')})`;
            if (!light.state.visible) swatch.dom.style.opacity = '0.3';

            const name = new Label({ text: light.state.name, class: 'toolkit-list-name' });
            const visible = new Container({ class: 'toolkit-list-button' });
            visible.dom.appendChild(createSvg(light.state.visible ? shownSvg : hiddenSvg));
            const remove = new Container({ class: 'toolkit-list-button' });
            remove.dom.appendChild(createSvg(deleteSvg));

            r.on('click', () => select(light === selected ? null : light));
            visible.dom.addEventListener('click', (event) => {
                event.stopPropagation();
                flushPending();
                const old = light.getState();
                events.fire('edit.add', new LightStateOp(light, old, { ...old, visible: !old.visible }));
            });
            remove.dom.addEventListener('click', (event) => {
                event.stopPropagation();
                flushPending();
                events.fire('edit.add', new RemoveLightOp(scene, light));
            });

            tooltips.register(name, tips.lightRow, 'left');
            tooltips.register(visible, tips.visible, 'top');
            tooltips.register(remove, tips.remove, 'top');

            r.append(swatch);
            r.append(name);
            r.append(visible);
            r.append(remove);
            list.append(r);
        });
    };

    updateEditor = () => {
        if (!selected) {
            events.invoke('toolkit.inspector.hide', 'light');
            return;
        }
        const s = selected.state;
        const info = selected.info;
        events.invoke('toolkit.inspector.show', 'light', { title: s.name, kind: info.label, content: editor });
        const isSun = s.kind === 'sun';
        uiUpdating = true;
        editorTitle.text = `${s.name}`;
        editorHint.text = info.description;
        power.slider.value = intensityToPower(s.kind, s.intensity);
        kelvinSlider.value = s.kelvin;
        kelvinSelect.value = 0;
        gelPicker.value = s.gel;
        size.slider.min = isSun ? 0.1 : 0.02;
        size.slider.max = isSun ? 10 : 3;
        size.slider.value = isSun ? s.width : s.width / settings.scale;
        tooltips.register(size.slider, isSun ? tips.sunSize : tips.size, 'bottom');
        aspect.row.hidden = info.lightType !== 2;
        aspect.slider.value = s.aspect;
        beam.row.hidden = info.lightType !== 1;
        beam.slider.value = s.beam;
        softEdge.row.hidden = info.lightType !== 1;
        softEdge.slider.value = s.softEdge;
        spread.row.hidden = !(info.lightType === 2 || info.lightType === 3 || info.lightType === 5);
        spread.slider.value = s.spread;
        shadowsToggle.value = s.shadows;
        onlyToggle.value = !!s.only;
        refreshTargets();
        aimButton.class[s.target ? 'add' : 'remove']('active');
        aimButton.text = s.target ? 'Aiming at subject' : 'Aim at subject';
        uiUpdating = false;
    };

    // the checklist of objects a light is limited to
    refreshTargets = () => {
        targetList.clear();
        targetList.hidden = !selected?.state.only;
        if (!selected || !selected.state.only) return;
        const light = selected;
        const chosen = new Set(light.state.targets ?? []);
        const items: { key: string, name: string, kind: string, shown: boolean }[] = [
            ...primitives().map(p => ({ key: targetKey(p), name: p.name, kind: 'mesh', shown: p.entity.enabled })),
            ...(settings.lightSplats ? splatLayers().map(sp => ({ key: targetKey(sp), name: sp.name, kind: 'splat', shown: sp.visible })) : [])
        ];
        if (items.length === 0) {
            targetList.append(hint('Nothing in the scene yet.'));
            return;
        }
        items.forEach((item) => {
            const r = new Container({ class: 'toolkit-check-row' });
            if (!item.shown) r.class.add('dimmed');
            const box = new BooleanInput({ type: 'checkbox', value: chosen.has(item.key) });
            const name = new Label({ text: item.name, class: 'toolkit-check-name' });
            const kind = new Label({ text: item.kind, class: 'toolkit-check-kind' });
            r.append(box);
            r.append(name);
            r.append(kind);
            const flip = (value: boolean) => {
                const next = new Set(light.state.targets ?? []);
                if (value) next.add(item.key); else next.delete(item.key);
                editLight(light, { targets: [...next] });
            };
            box.on('change', (value: boolean) => {
                if (!uiUpdating) flip(value);
            });
            name.dom.addEventListener('click', () => {
                box.value = !box.value;
            });
            targetList.append(r);
        });
        // ticked objects that are no longer in the scene (e.g. renamed)
        const known = new Set(items.map(i => i.key));
        const stale = (light.state.targets ?? []).filter(k => !known.has(k) && !(k.startsWith('splat:') && !settings.lightSplats));
        if (stale.length) {
            targetList.append(hint(`Also ticked, but not in the scene: ${stale.map(k => k.slice(k.indexOf(':') + 1)).join(', ')}`));
        }
    };

    // objects casting shadows in the bake
    refreshCasters = () => {
        castersList.clear();
        const items = [
            ...primitives().map(p => ({ key: targetKey(p), name: p.name, kind: 'mesh', shown: p.entity.enabled })),
            ...splatLayers().map(sp => ({ key: targetKey(sp), name: sp.name, kind: 'splat', shown: sp.visible }))
        ];
        if (items.length === 0) {
            castersList.append(hint('Nothing in the scene yet.'));
            return;
        }
        const off = new Set(settings.noShadow);
        items.forEach((item) => {
            const r = new Container({ class: 'toolkit-check-row' });
            if (!item.shown) r.class.add('dimmed');
            const box = new BooleanInput({ type: 'checkbox', value: !off.has(item.key) });
            const name = new Label({ text: item.name, class: 'toolkit-check-name' });
            const kind = new Label({ text: item.kind, class: 'toolkit-check-kind' });
            r.append(box);
            r.append(name);
            r.append(kind);
            box.on('change', (value: boolean) => {
                if (uiUpdating) return;
                const next = new Set(settings.noShadow);
                if (value) next.delete(item.key); else next.add(item.key);
                editSettings({ noShadow: [...next] });
            });
            name.dom.addEventListener('click', () => {
                box.value = !box.value;
            });
            castersList.append(r);
        });
    };

    onlyToggle.on('change', (value: boolean) => {
        if (uiUpdating || !selected) return;
        // starting a selection: begin with the subject (the selected mesh, or everything visible)
        const targets = selected.state.targets?.length ? selected.state.targets :
            (selectedPrimitive ? [targetKey(selectedPrimitive)] : visiblePrimitives().map(targetKey));
        editLight(selected, { only: value, targets });
        refreshTargets();
    });

    power.slider.on('change', (value: number) => selected && editLight(selected, { intensity: powerToIntensity(selected.state.kind, value) }));
    kelvinSlider.on('change', (value: number) => selected && editLight(selected, { kelvin: value }));
    kelvinSelect.on('change', (value: number) => {
        if (uiUpdating || !selected || !value) return;
        editLight(selected, { kelvin: value });
        updateEditor();
    });
    gelPicker.on('change', (value: number[]) => selected && editLight(selected, { gel: [value[0], value[1], value[2]] }));
    size.slider.on('change', (value: number) => selected && editLight(selected, { width: selected.state.kind === 'sun' ? value : value * settings.scale }));
    aspect.slider.on('change', (value: number) => selected && editLight(selected, { aspect: value }));
    beam.slider.on('change', (value: number) => selected && editLight(selected, { beam: value }));
    softEdge.slider.on('change', (value: number) => selected && editLight(selected, { softEdge: value }));
    spread.slider.on('change', (value: number) => selected && editLight(selected, { spread: value }));
    shadowsToggle.on('change', (value: boolean) => selected && editLight(selected, { shadows: value }));

    // ---- subject choice

    const subjectOptions = () => [
        { v: 'auto', t: 'Automatic (selected mesh, else everything)' },
        ...visiblePrimitives().map(p => ({ v: targetKey(p), t: `Mesh: ${p.name}` })),
        ...splatLayers().filter(sp => sp.visible).map(sp => ({ v: targetKey(sp), t: `Splat: ${sp.name}` }))
    ];
    refreshSubjects = () => {
        const options = subjectOptions();
        // a picked subject that is hidden or gone stays listed, so the choice is kept
        if (settings.subject !== 'auto' && !options.some(o => o.v === settings.subject)) {
            options.push({ v: settings.subject, t: `${settings.subject.replace(/^(mesh|splat):/, '')} (not shown)` });
        }
        const wasUpdating = uiUpdating;
        uiUpdating = true;
        [subjectSelect, aimAtSelect].forEach((select) => {
            select.options = options;
            select.value = settings.subject ?? 'auto';
        });
        uiUpdating = wasUpdating;
    };
    const pickSubject = (value: string) => {
        if (uiUpdating || value === settings.subject) return;
        flushPending();
        editSettings({ subject: value });
        flushSettings();
        refreshSubjects();
        // lights that are aiming turn to the new subject
        const c = chosenSubjectBound().center;
        const ops = lights().filter(l => l.state.target).map((light) => {
            const old = light.getState();
            return new LightStateOp(light, old, { ...old, target: [c.x, c.y, c.z] as Vec3Tuple });
        });
        if (ops.length) events.fire('edit.add', new MultiOp(ops));
    };
    subjectSelect.on('change', pickSubject);
    aimAtSelect.on('change', pickSubject);
    ['scene.elementAdded', 'scene.elementRemoved', 'splat.name', 'splat.visibility', 'toolkit.primitive.changed'].forEach((name) => {
        events.on(name, () => refreshSubjects());
    });
    events.on('toolkit.lightingPanel.setVisible', () => refreshSubjects());
    events.function('toolkit.studio.subjects', () => subjectOptions());

    events.function('toolkit.studio.setSubject', (value: string) => pickSubject(value));

    aimButton.on('click', () => {
        if (!selected) return;
        flushPending();
        const old = selected.getState();
        const c = chosenSubjectBound().center;
        const next = { ...old, target: old.target ? null : [c.x, c.y, c.z] as Vec3Tuple };
        events.fire('edit.add', new LightStateOp(selected, old, next));
    });

    const setAllVisible = (visible: boolean) => {
        flushPending();
        const ops = lights().filter(l => l.state.visible !== visible).map((light) => {
            const old = light.getState();
            return new LightStateOp(light, old, { ...old, visible });
        });
        if (ops.length) events.fire('edit.add', new MultiOp(ops));
    };
    showAll.on('click', () => setAllVisible(true));
    hideAll.on('click', () => setAllVisible(false));

    // ---- gizmo + tool

    let dragStart: LightState | null = null;

    const updateModeButtons = (mode: ShapeGizmoMode) => {
        moveButton.class[mode === 'translate' ? 'add' : 'remove']('active');
        rotateButton.class[mode === 'rotate' ? 'add' : 'remove']('active');
    };

    const gizmo = new ShapeTransformGizmo(events, scene, {
        rotate: true,
        uniformScale: true,
        lowerBoundScale: new Vec3(0.001, 0.001, 0.001),
        onTransformStart: () => {
            flushPending();
            dragStart = selected?.getState() ?? null;
            // turning the lamp by hand ends the automatic aiming
            if (selected && gizmo.mode === 'rotate' && selected.state.target) {
                selected.state.target = null;
            }
        },
        onTransform: () => {
            if (!selected) return;
            selected.syncFromEntity();
            scene.forceRender = true;
        },
        onTransformEnd: () => {
            if (selected && dragStart) {
                selected.syncFromEntity();
                const newState = selected.getState();
                if (!statesEqual(dragStart, newState)) {
                    events.fire('edit.add', new LightStateOp(selected, dragStart, newState), true);
                }
                updateEditor();
            }
            dragStart = null;
        },
        onModeChanged: updateModeButtons
    });
    updateModeButtons(gizmo.mode);

    select = (light: StudioLight | null) => {
        flushPending();
        const previous = selected;
        selected = light;
        if (!light) {
            if (toolManager.active === TOOL) {
                toolManager.activate(null);
                return;
            }
        } else if (toolManager.active !== TOOL) {
            toolManager.activate(TOOL);
        } else {
            gizmo.detach();
            gizmo.attach(light.entity);
        }
        previous?.invalidate();
        light?.invalidate();
        if (light) events.invoke('toolkit.inspector.reveal');
        refreshList();
        updateEditor();
        scene.forceRender = true;
    };

    // scripted access (and tests)
    events.function('toolkit.selectLight', (index: number) => select(lights()[index] ?? null));

    toolManager.register(TOOL, {
        activate: () => {
            if (selected) {
                if (gizmo.mode === 'scale' || gizmo.mode === 'none') gizmo.setMode('translate');
                gizmo.attach(selected.entity);
            }
        },
        deactivate: () => {
            flushPending();
            gizmo.detach();
            const previous = selected;
            selected = null;
            previous?.invalidate();
            refreshList();
            updateEditor();
            scene.forceRender = true;
        },
        setTransformMode: (mode) => {
            // lights move and turn; their size is a slider
            if (mode !== 'scale') gizmo.setMode(mode);
            return true;
        },
        getFocus: () => {
            if (!selected) return null;
            return { position: selected.entity.getPosition().clone(), radius: settings.scale * 0.5 };
        }
    });

    moveButton.on('click', () => gizmo.setMode('translate'));
    rotateButton.on('click', () => gizmo.setMode('rotate'));

    // ---- viewport picking: a click on a lamp selects it

    const pickRay = new Ray();
    const pickTools: (string | null)[] = [null, TOOL, 'toolkitPrimitive', 'move', 'rotate', 'scale'];
    let down: { x: number, y: number } | null = null;

    const pickLight = (x: number, y: number) => {
        scene.camera.getRay(x, y, pickRay);
        let best: StudioLight | null = null;
        let bestDistance = Infinity;
        lights().forEach((light) => {
            const d = light.pick(pickRay.origin, pickRay.direction);
            if (d >= 0 && d < bestDistance) {
                bestDistance = d;
                best = light;
            }
        });
        return { light: best as StudioLight | null, distance: bestDistance };
    };

    events.function('toolkit.lightPickDistance', (x: number, y: number) => pickLight(x, y).distance);

    scene.canvas.addEventListener('pointerdown', (event: PointerEvent) => {
        down = event.button === 0 ? { x: event.clientX, y: event.clientY } : null;
    }, true);

    scene.canvas.addEventListener('pointerup', (event: PointerEvent) => {
        const start = down;
        down = null;
        if (!start || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4) return;
        if (!pickTools.includes(toolManager.active)) return;
        const hit = pickLight(event.offsetX, event.offsetY);
        if (!hit.light) return;
        const primitiveDistance: number = events.invoke('toolkit.primitivePickDistance', event.offsetX, event.offsetY) ?? Infinity;
        if (hit.distance <= primitiveDistance && hit.light !== selected) {
            select(hit.light);
        }
    }, true);

    // ---- conversion

    // the bake gives masks of up to 24 lights (they ride in a float)
    const MAX_BAKE_LIGHTS = 24;
    const bakeLights = () => activeLights().slice(0, MAX_BAKE_LIGHTS);

    // splat layers the lights will relight when baking
    const splatTargets = (lit: StudioLight[]) => (settings.lightSplats && lit.length ?
        splatLayers().filter(sp => sp.visible && sp.numSplats > 0 && maskFor(sp, lit) !== 0) : []);

    const estimateFor = (prims: MeshPrimitive[]) => {
        if (prims.length === 0) return null;
        const count = prims.reduce((sum, p) => sum + approxSplats(p, cellForDensity(p, p.detail)), 0) * (settings.backing ? 1.2 : 1);
        const lit = prims.some(p => bakeLights().some(l => reaches(l, p)));
        const floats = 14 + (lit ? [0, 3, 8, 15][settings.degree] * 3 : 0);
        return { count, bytes: count * floats * 4, lit };
    };

    const formatCount = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} M` : `${Math.round(n / 1000)} k`);

    updateEstimate = () => {
        const prims = visiblePrimitives();
        const relit = splatTargets(bakeLights());
        const e = estimateFor(prims);
        if (!e && relit.length === 0) {
            estimate.text = settings.lightSplats ?
                'Nothing to bake: add or show a mesh, or let a light reach a visible splat layer.' :
                'Nothing to convert: add or show a primitive or model first.';
            convertButton.enabled = false;
            return;
        }
        convertButton.enabled = true;
        const n = activeLights().length;
        const lightsText = n ? `${n} light${n === 1 ? '' : 's'}` : 'no lights (unlit colours)';
        const parts: string[] = [];
        if (e) {
            parts.push(`${prims.length} mesh${prims.length === 1 ? '' : 'es'} → about ${formatCount(e.count)} splats, ${Math.max(1, Math.round(e.bytes / 1048576))} MB as PLY`);
        }
        if (relit.length) {
            parts.push(`${relit.length} splat layer${relit.length === 1 ? '' : 's'} relit (${formatCount(relit.reduce((sum, sp) => sum + sp.numSplats, 0))} splats)`);
        }
        estimate.text = `${lightsText}: ${parts.join('; ')}.`;
        if (e && e.count > MAX_SPLATS) {
            estimate.text += ' Too many: lower the detail.';
        }
    };

    const reportError = async (error: unknown, header: string) => {
        if (error instanceof BakeCancelled) return;
        await events.invoke('showPopup', {
            type: 'error',
            header,
            message: (error as Error).message ?? String(error)
        });
    };

    // load a PLY as a new layer and return it
    const importLayer = async (filename: string, data: BlobPart) => {
        let created: Splat | null = null;
        const onAdded = (element: Element) => {
            if (element.type === ElementType.splat) created = element as Splat;
        };
        const handle = events.on('scene.elementAdded', onAdded);
        try {
            await events.invoke('import', [{ filename, contents: new File([data], filename) }]);
        } finally {
            handle.off();
        }
        return created as Splat | null;
    };

    // where a converted primitive can hide its far-view backing (far-backing.ts)
    const backingTargetOf = (p: MeshPrimitive, start: number, end: number, cell: number): BackingTarget | null => {
        if (end - start < 16) return null;
        const transform = p.entity.getWorldTransform();
        const scale = transform.getScale();
        const longest = Math.max(scale.x, scale.y, scale.z);
        if (p.kind === 'image') {
            const up = transform.transformVector(new Vec3(0, 1, 0), new Vec3());
            const thickness = up.length();
            up.normalize();
            return { start, end, cell, shape: 'slab', depth: thickness / 2, front: [up.x, up.y, up.z], longest };
        }
        if (p.kind === 'box' || p.kind === 'sphere' || p.kind === 'cylinder' || p.kind === 'cone' || p.kind === 'torus') {
            const half = p.geometry.half;
            const thinnest = Math.min(half[0] * scale.x, half[1] * scale.y, half[2] * scale.z);
            return { start, end, cell, shape: 'solid', depth: thinnest * 0.5, longest };
        }
        // planes, backdrops and models have no inside to hide it in
        return null;
    };

    const conversionMemory = (count: number, lit: boolean) => conversionMemoryFor(count, lit ? settings.degree : 0, settings.backing);

    // Convert primitives into one splat layer and, when the lights reach
    // splat layers, relight those into lit copies. `cell` is the spacing
    // between splats; by default it follows the panel's detail setting.
    const convertPrimitives = async (prims: MeshPrimitive[], options: { cell?: number, name?: string, hideLights?: boolean, relightSplats?: boolean, backing?: boolean, splats?: Splat[] } = {}) => {
        const targets = prims.filter(p => p.entity.enabled);
        const lit = bakeLights();
        const relit = options.relightSplats ? splatTargets(lit).filter(sp => !options.splats || options.splats.includes(sp)) : [];
        if (targets.length === 0 && relit.length === 0) return 0;
        flushPending();
        flushSettings();

        const bound = subjectBound(targets.length ? targets : undefined);
        const longest = Math.max(bound.halfExtents.x, bound.halfExtents.y, bound.halfExtents.z) * 2;
        // every object at its own detail (splats along its longest side)
        const cellOf = (p: MeshPrimitive) => options.cell ?? cellForDensity(p, p.detail);
        const cell = targets.length ? Math.min(...targets.map(cellOf)) : longest / 300;
        const estimated = targets.reduce((sum, p) => sum + approxSplats(p, cellOf(p)), 0);
        if (estimated > MAX_SPLATS) {
            await events.invoke('showPopup', {
                type: 'error',
                header: 'Too many splats',
                message: `This would create about ${formatCount(estimated)} splats, more than the ${formatCount(MAX_SPLATS)} a conversion can make. Lower the detail and try again.`
            });
            return 0;
        }
        // big conversions: say what memory they need before starting
        const memory = conversionMemory(estimated, lit.length > 0);
        if (memory > MEMORY_WARNING) {
            const answer = await events.invoke('showPopup', {
                type: 'yesno',
                header: 'Large conversion',
                message: `About ${formatCount(estimated)} splats: this needs roughly ${(memory / 1024 ** 3).toFixed(1)} GB of memory while it runs, and the browser tab may run out. ${lit.length && settings.degree > 1 ? 'Lower "Highlights" in the lighting panel to need much less. ' : ''}Convert anyway?`
            });
            if (answer?.action !== 'yes') return 0;
        }

        const control = { cancelled: false };
        const cancelHandle = events.on('progressCancel', () => {
            control.cancelled = true;
        });
        const startProgress = (header: string) => {
            events.fire('progressStart', header, true);
        };
        startProgress(lit.length ? 'Baking studio lighting' : 'Converting to splats');
        events.fire('progressUpdate', { text: 'Preparing', progress: 0 });
        await new Promise((resolve) => {
            setTimeout(resolve, 30);
        });

        const { sky, ground: g } = ambientLinear();
        const casts = (element: MeshPrimitive | Splat) => !settings.noShadow.includes(targetKey(element));
        const casters = lit.length ? visiblePrimitives().filter(casts) : [];
        const sceneSize = Math.max(longest, subjectSize(subjectBound(casters.length ? casters : undefined)));
        const bakeSettings: BakeSettings = {
            degree: settings.degree,
            shadowSamples: shadowRays[settings.shadows] ?? 0,
            aoSamples: settings.occlusion ? 12 : 0,
            exposure: Math.pow(2, settings.exposure),
            tonemap: settings.tonemap,
            sky,
            ground: g,
            sceneSize,
            cell,
            grids: []
        };
        const ops: any[] = [];
        let count = 0;

        try {
            // everything visible casts shadows, also what is not converted
            const meshes = new Map();
            const occluders: Occluder[] = [];
            const occluderIds = new Map<MeshPrimitive, number>();
            for (const p of casters) {
                const occluder = await primitiveOccluder(p, meshes);
                if (occluder) {
                    occluderIds.set(p, occluders.length);
                    occluders.push(occluder);
                }
            }

            // splat layers casting shadows: density grids, built from the
            // layers as they are now (before anything new is added)
            const exports = new Map<Splat, { buffer: ArrayBuffer, layout: PlyLayout }>();
            const exportLayer = async (splat: Splat) => {
                let entry = exports.get(splat);
                if (!entry) {
                    const sink = new MemorySink();
                    const written = await events.invoke('scene.write', 'ply', {
                        filename: 'studio.ply',
                        splatIdx: (events.invoke('scene.splats') as Splat[]).indexOf(splat),
                        serializeSettings: {}
                    }, sink);
                    if (!written) return null;
                    const buffer = await sink.blob().arrayBuffer();
                    entry = { buffer, layout: readPlyLayout(buffer) };
                    exports.set(splat, entry);
                }
                return entry;
            };
            const shadowsUsed = (bakeSettings.shadowSamples > 0 && lit.some(l => l.state.shadows)) || bakeSettings.aoSamples > 0;
            const splatCasters = lit.length && shadowsUsed ?
                splatLayers().filter(sp => sp.visible && sp.numSplats > 0 && casts(sp)) : [];
            const grids: ShadowGrid[] = [];
            const gridIndex = new Map<Splat, number>();
            for (const splat of splatCasters) {
                if (control.cancelled) throw new BakeCancelled();
                startProgress('Baking studio lighting');
                events.fire('progressUpdate', { text: `Shadows of ${splat.name}`, progress: 2 });
                const entry = await exportLayer(splat);
                const grid = entry && buildShadowGrid(entry.buffer, entry.layout);
                if (grid) {
                    gridIndex.set(splat, grids.length);
                    grids.push(grid);
                }
            }
            bakeSettings.grids = grids;

            // ---- meshes -> one new splat layer
            if (targets.length) {
                const samples = new SampleBuffer();
                samples.reserveTotal(Math.ceil(estimated * 1.1) + 1024);
                const backingTargets: BackingTarget[] = [];
                for (let i = 0; i < targets.length; ++i) {
                    if (control.cancelled) throw new BakeCancelled();
                    const p = targets[i];
                    const start = samples.count;
                    await samplePrimitive(p, cellOf(p), samples, meshes);
                    const backing = (options.backing ?? settings.backing) ? backingTargetOf(p, start, samples.count, cellOf(p)) : null;
                    if (backing) backingTargets.push(backing);
                    const id = occluderIds.get(p);
                    if (id !== undefined && occluders[id].convex) samples.setOccluder(start, id);
                    samples.setLightMask(start, maskFor(p, lit));
                    events.fire('progressUpdate', { text: `Sampling surfaces (${formatCount(samples.count)} splats)`, progress: 10 * (i + 1) / targets.length });
                    if (samples.count > MAX_SPLATS) {
                        throw new Error(`More than ${formatCount(MAX_SPLATS)} splats. Lower the detail and try again.`);
                    }
                }
                if (samples.count === 0) {
                    throw new Error('Nothing to convert: the meshes produced no splats.');
                }

                let colors: SplatColors;
                if (lit.length) {
                    colors = await bakeSamples(samples, occluders, lit.map(l => l.params()), bakeSettings, (fraction) => {
                        events.fire('progressUpdate', { text: `Lighting ${formatCount(samples.count)} splats`, progress: 10 + (relit.length ? 45 : 85) * fraction });
                    }, control);
                } else {
                    colors = unlitColors(samples);
                }

                // mip levels of larger gaussians inside the objects, so they
                // don't vanish where renderers cull the tiny surface gaussians
                if (backingTargets.length) {
                    colors = addFarViewBacking(samples, colors, backingTargets).colors;
                }

                events.fire('progressUpdate', { text: 'Loading splats', progress: relit.length ? 55 : 97 });
                const baseName = options.name ?? (targets.length === 1 ? targets[0].name : `Lit scene ${++counter}`);
                const created = await importLayer(`${baseName.replace(/[^\w\- ]+/g, '_')}.ply`, writeSplatPly(samples, colors));
                if (created) {
                    created.noSizeCull = true;
                    created.studioMask = 0;
                    // part of the same undo step as hiding the meshes
                    ops.push(new AddSplatOp(scene, created));
                }
                count += samples.count;

                // hide (never delete) what was converted
                targets.forEach((p) => {
                    const old = p.getState();
                    ops.push(new PrimitiveStateOp(p, old, { ...old, visible: false } as PrimitiveState));
                });
            }

            // ---- splat layers -> lit copies
            const camera = scene.camera.mainCamera.getPosition();
            for (let k = 0; k < relit.length; ++k) {
                if (control.cancelled) throw new BakeCancelled();
                const splat = relit[k];
                const progress0 = targets.length ? 55 : 0;
                const span = (100 - progress0) / relit.length;
                startProgress('Baking studio lighting');
                events.fire('progressUpdate', { text: `Reading ${splat.name}`, progress: progress0 + span * k });

                const entry = await exportLayer(splat);
                if (!entry) continue;
                const { buffer, layout } = entry;
                const samples = splatSamples(buffer, layout, maskFor(splat, lit), camera, gridIndex.get(splat) ?? -1);
                const colors = await bakeSamples(samples, occluders, lit.map(l => l.params()), {
                    ...bakeSettings,
                    degree: 0,
                    aoSamples: 0,
                    splatBase: settings.splatBase
                }, (fraction) => {
                    events.fire('progressUpdate', { text: `Lighting ${splat.name} (${formatCount(samples.count)} splats)`, progress: progress0 + span * (k + fraction * 0.9) });
                }, control);
                const name = `${splat.name.replace(/\.(compressed\.)?ply$/i, '').replace(/[^\w\- ]+/g, '_')} lit.ply`;
                const created = await importLayer(name, writeDc(buffer, layout, colors.dc));
                if (created) {
                    created.studioMask = 0;
                    ops.push(new AddSplatOp(scene, created));
                }
                count += layout.count;
                ops.push(new SplatVisibleOp(splat, false));
            }
        } catch (error) {
            cancelHandle.off();
            events.fire('progressEnd');
            if (ops.length) events.fire('edit.add', new MultiOp(ops));
            await reportError(error, 'Baking failed');
            return 0;
        }
        cancelHandle.off();
        events.fire('progressEnd');

        // and the lights, if asked
        const hideLights = options.hideLights ?? settings.hideAfter;
        if (hideLights && lit.length) {
            activeLights().forEach((light) => {
                const old = light.getState();
                ops.push(new LightStateOp(light, old, { ...old, visible: false }));
            });
            select(null);
        }
        if (ops.length) events.fire('edit.add', new MultiOp(ops));
        scene.forceRender = true;
        return count;
    };

    events.function('toolkit.convertPrimitives', convertPrimitives);

    // ---- quick lighting of one mesh, for the inspector

    // (a mesh or a splat layer)
    events.function('toolkit.studio.meshLighting', (p: MeshPrimitive | Splat) => ({
        lights: lights().map((light, index) => ({ index, name: light.state.name, visible: light.state.visible, reaches: reaches(light, p) })),
        casts: !settings.noShadow.includes(targetKey(p)),
        subject: settings.subject === targetKey(p),
        presets: presets.map(preset => ({ v: preset.id, t: preset.label })),
        lightSplats: settings.lightSplats
    }));
    events.function('toolkit.studio.setLightSplats', (value: boolean) => {
        editSettings({ lightSplats: value });
        flushSettings();
        updateEditor();
    });
    // bake the lights into a lit copy of one splat layer
    events.function('toolkit.studio.relightSplat', (splat: Splat) => convertPrimitives([], { relightSplats: true, splats: [splat] }));
    // let one light reach the mesh, or not (switching the light to chosen objects)
    events.function('toolkit.studio.setReach', (p: MeshPrimitive | Splat, index: number, value: boolean) => {
        const light = lights()[index];
        if (!light) return;
        const key = targetKey(p);
        const old = light.getState();
        let next: LightState;
        if (value) {
            if (!old.only) return;
            next = { ...old, targets: [...new Set([...(old.targets ?? []), key])] };
        } else {
            const all = old.only ? (old.targets ?? []) :
                [...visiblePrimitives(), ...(settings.lightSplats ? splatLayers().filter(sp => sp.visible) : [])].map(targetKey);
            next = { ...old, only: true, targets: all.filter(k => k !== key) };
        }
        flushPending();
        events.fire('edit.add', new LightStateOp(light, old, next));
    });
    events.function('toolkit.studio.setCasts', (p: MeshPrimitive | Splat, value: boolean) => {
        const key = targetKey(p);
        const next = new Set(settings.noShadow);
        if (value) next.delete(key); else next.add(key);
        editSettings({ noShadow: [...next] });
        flushSettings();
    });
    // light the mesh with a setup: it becomes the subject, the setup is applied around it
    events.function('toolkit.studio.lightWith', (p: MeshPrimitive | Splat, presetId: string) => {
        const preset = presets.find(pr => pr.id === presetId);
        if (!preset) return;
        if (settings.subject !== targetKey(p)) {
            editSettings({ subject: targetKey(p) });
            flushSettings();
        }
        // the mesh stays selected: its inspector shows the result
        applySetup(preset, false);
    });
    events.function('toolkit.studio.aimHere', (p: MeshPrimitive | Splat) => pickSubject(targetKey(p)));
    events.function('toolkit.studio.openPanel', () => setPanelVisible(true));
    events.function('toolkit.studio.hideAfter', () => settings.hideAfter);
    events.function('toolkit.studio.setHideAfter', (value: boolean) => {
        editSettings({ hideAfter: value });
        flushSettings();
    });
    // what converting one mesh makes: splats, whether lights are baked in, memory
    events.function('toolkit.studio.estimatePrimitive', (p: MeshPrimitive, detail?: number) => {
        const count = approxSplats(p, cellForDensity(p, detail ?? p.detail)) * (settings.backing ? 1.2 : 1);
        const lit = bakeLights().some(l => reaches(l, p));
        return { count, lit, memory: conversionMemory(count, lit), max: MAX_SPLATS };
    });
    events.function('toolkit.studio.active', () => activeLights().length > 0);

    convertButton.on('click', async () => {
        if (!convertButton.enabled) return;
        convertButton.enabled = false;
        try {
            await convertPrimitives(visiblePrimitives(), { relightSplats: true });
        } finally {
            updateEstimate();
        }
    });

    // ---- keep things in sync

    refreshAll = () => {
        refreshList();
        updateEditor();
        updateSettingsUI();
        updateEstimate();
    };

    events.on('scene.elementAdded', (element: Element) => {
        if (isLight(element)) {
            refreshList();
            if (element === selectOnAdd) {
                selectOnAdd = null;
                select(element);
            }
            updateEstimate();
        } else if (isPrimitive(element)) {
            invalidateLights();
            refreshAll();
        } else if (element.type === ElementType.splat) {
            updateEditor();
            updateEstimate();
            refreshCasters();
        }
    });

    events.on('scene.elementRemoved', (element: Element) => {
        if (isLight(element)) {
            if (element === selected) select(null);
            refreshList();
            updateEstimate();
        } else if (isPrimitive(element)) {
            if (element === selectedPrimitive) selectedPrimitive = null;
            invalidateLights();
            refreshAll();
        } else if (element.type === ElementType.splat) {
            updateEditor();
            updateEstimate();
            refreshCasters();
        }
    });

    events.on('toolkit.light.changed', (light: StudioLight) => {
        refreshList();
        if (light === selected) updateEditor();
        updateEstimate();
        scene.forceRender = true;
    });

    events.on('toolkit.primitive.changed', () => {
        invalidateLights();
        updateEstimate();
        refreshCasters();
    });

    // new document / document load
    events.on('scene.clear', () => {
        select(null);
        lights().forEach(light => scene.remove(light));
        settings = defaultSettings();
        counter = 0;
        refreshAll();
    });

    loadStudio = async (data: any) => {
        if (!data) return;
        settings = { ...defaultSettings(), ...(data.settings ?? {}) };
        for (const state of (data.lights ?? []) as LightState[]) {
            await scene.add(new StudioLight(state, studioContext));
        }
        refreshAll();
        scene.forceRender = true;
    };

    refreshAll();
};

const studioModule: ToolkitModule = {
    id: 'studioLighting',
    init,
    serialize: () => ({
        settings: getSettings(),
        lights: getLights().map(light => light.getState())
    }),
    deserialize: data => loadStudio(data)
};

export { studioModule, StudioSettings };
