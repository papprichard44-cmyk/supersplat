import { Button, ColorPicker, Container, Label, SelectInput, SliderInput, VectorInput } from '@playcanvas/pcui';
import { OrientedBox, Ray, Vec3 } from 'playcanvas';

import { Element, ElementType } from '../element';
import primitivesSvg from './icons/primitives.svg';
import { DEFAULT_METALNESS, DEFAULT_ROUGHNESS, MeshPrimitive, PrimitiveData, PrimitiveKind, PrimitiveState, statesEqual } from './mesh-primitive';
import { headerIcon, registerPanel } from './panels';
import { AddPrimitiveOp, PrimitiveStateOp, RemovePrimitiveOp } from './primitive-ops';
import { cellForDensity } from './primitive-to-splat';
import { ShapeKind } from './shapes';
import { readGlb } from '../mesh-to-splat';
import { ShapeGizmoMode, ShapeTransformGizmo } from '../tools/shape-transform-gizmo';
import deleteSvg from '../ui/svg/delete.svg';
import hiddenSvg from '../ui/svg/hidden.svg';
import shownSvg from '../ui/svg/shown.svg';

import type { ToolkitContext, ToolkitModule } from './index';

const TOOL = 'toolkitPrimitive';

const tips = {
    addPlane: 'Add a horizontal plane (floor / ceiling) at the camera focus. It hides the splats behind it with a sharp edge.',
    addWall: 'Add a vertical plane (wall) at the camera focus. It hides the splats behind it with a sharp edge.',
    addBox: 'Add a solid box at the camera focus. Splats inside and behind it are hidden.',
    addImage: 'Add a picture (PNG / WebP with transparency) as a flat cutout in space. Transparent pixels are cut away, the rest hides the splats behind it with a sharp edge. Its Y size is its thickness.',
    addModel: 'Add a 3D model (.glb) as a mesh. Place and size it like any primitive, then turn it into splats with "To splat". You can also drop a .glb onto the viewport.',
    cutoff: 'Alpha cutoff: pixels of the picture more transparent than this are cut away. Raise it to trim soft, semi-transparent fringes.',
    density: 'How many splats are generated along the longest side when converting. Higher = sharper picture and edges, but more splats and a bigger file.',
    convert: 'Turn the selected primitive into a real gaussian splat layer (it then exports to PLY / SOG / SPZ and can be edited like any splat). With studio lights in the scene, their light is baked in. The primitive itself is hidden, not deleted.',
    addShape: (label: string) => `Add a ${label.toLowerCase()} at the camera focus. Curved shapes show light and highlights best; light them in the Studio lighting panel.`,
    addBackdrop: 'Add a photo backdrop (cyclorama): a floor that sweeps up into a wall without a corner, as used in photo studios. Put your subject on it.',
    surface: 'How the surface reacts to the studio lights: matte, satin or glossy, or metallic. Glossy and metal surfaces show highlights and reflections.',
    shine: 'Glossiness: 0 = completely matte, 1 = mirror-smooth. Higher values give smaller, brighter highlights.',
    metal: 'Metalness: 0 = paint, plastic, wood, stone; 1 = bare metal, which reflects in its own colour.',
    row: 'Click to select this primitive and show its transform gizmo (you can also click it in the viewport). Click again to deselect.',
    visible: 'Show or hide this primitive.',
    remove: 'Delete this primitive (undo brings it back).',
    translate: 'Move the selected primitive with the gizmo (shortcut: 1).',
    rotate: 'Rotate the selected primitive with the gizmo (shortcut: 2).',
    scale: 'Resize the selected primitive with the gizmo (shortcut: 3). On a picture, drag the Y handle to extrude it.',
    color: 'Surface colour of the selected primitive. On a picture it tints the image (white = unchanged).',
    position: 'Position of the primitive centre in world units (X, Y, Z).',
    rotation: 'Rotation in degrees around the X, Y and Z axes.',
    size: 'Size along the primitive\'s own X, Y and Z axes. A plane ignores Y. On a picture Y is the thickness: raise it to extrude the cutout into a solid. On a model the three values scale its longest side.'
};

const createSvg = (svgString: string) => {
    const decodedStr = decodeURIComponent(svgString.substring('data:image/svg+xml,'.length));
    return new DOMParser().parseFromString(decodedStr, 'image/svg+xml').documentElement;
};

const isPrimitive = (element: Element): element is MeshPrimitive => element instanceof MeshPrimitive;

let getPrimitives: () => MeshPrimitive[] = () => [];
let loadPrimitives: (data: PrimitiveData[]) => Promise<void> = async () => {};

const init = (ctx: ToolkitContext) => {
    const { events, scene, toolManager, canvasContainer, tooltips } = ctx;

    const primitives = () => scene.getElementsByType(ElementType.model).filter(isPrimitive);
    getPrimitives = primitives;

    let selected: MeshPrimitive | null = null;
    let counter = 0;

    // ---- ui

    const panel = new Container({ id: 'toolkit-primitives-panel', class: 'panel' });
    ['pointerdown', 'pointerup', 'pointermove', 'wheel', 'dblclick'].forEach((eventName) => {
        panel.dom.addEventListener(eventName, (event: Event) => event.stopPropagation());
    });

    const header = new Container({ class: 'panel-header' });
    header.append(headerIcon(primitivesSvg));
    header.append(new Label({ text: 'Primitives & images', class: 'panel-header-label' }));

    const addRow = new Container({ class: 'toolkit-row' });
    const addPlane = new Button({ text: '+ Plane', class: 'toolkit-button' });
    const addWall = new Button({ text: '+ Wall', class: 'toolkit-button' });
    const addBox = new Button({ text: '+ Box', class: 'toolkit-button' });
    addRow.append(addPlane);
    addRow.append(addWall);
    const addImage = new Button({ text: '+ Image', class: 'toolkit-button' });
    addRow.append(addBox);
    addRow.append(addImage);

    const addModel = new Button({ text: '+ GLB', class: 'toolkit-button' });
    addRow.append(addModel);

    const shapeRow = new Container({ class: 'toolkit-row' });
    const shapeButtons: [ShapeKind, string, Button][] = ([
        ['sphere', 'Sphere'], ['cylinder', 'Cylinder'], ['cone', 'Cone'], ['torus', 'Torus'], ['backdrop', 'Backdrop']
    ] as [ShapeKind, string][]).map(([kind, label]) => {
        const button = new Button({ text: `+ ${label}`, class: 'toolkit-button' });
        shapeRow.append(button);
        return [kind, label, button];
    });

    const modelInput = document.createElement('input');
    modelInput.type = 'file';
    modelInput.accept = '.glb,model/gltf-binary';
    modelInput.style.display = 'none';
    panel.dom.appendChild(modelInput);

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/png,image/webp,image/jpeg';
    fileInput.style.display = 'none';
    panel.dom.appendChild(fileInput);

    const list = new Container({ class: 'toolkit-list' });

    const editor = new Container({ class: 'toolkit-editor', hidden: true });

    const modeRow = new Container({ class: 'toolkit-row' });
    const translateButton = new Button({ class: 'toolkit-mode', icon: 'E111' });
    const rotateButton = new Button({ class: 'toolkit-mode', icon: 'E113' });
    const scaleButton = new Button({ class: 'toolkit-mode', icon: 'E112' });
    const colorLabel = new Label({ text: 'Color', class: 'toolkit-label' });
    const colorPicker = new ColorPicker({ class: 'toolkit-color', value: [0.8, 0.8, 0.8] });
    modeRow.append(translateButton);
    modeRow.append(rotateButton);
    modeRow.append(scaleButton);
    modeRow.append(colorLabel);
    modeRow.append(colorPicker);

    const vectorRow = (text: string, precision: number, min?: number) => {
        const row = new Container({ class: 'toolkit-row' });
        const label = new Label({ text, class: 'toolkit-label' });
        const input = new VectorInput({
            class: 'toolkit-vector',
            precision,
            dimensions: 3,
            placeholder: ['X', 'Y', 'Z'],
            value: [0, 0, 0],
            min
        });
        row.append(label);
        row.append(input);
        editor.append(row);
        return { label, input };
    };

    editor.append(modeRow);
    const position = vectorRow('Position', 3);
    const rotation = vectorRow('Rotation', 2);
    const size = vectorRow('Size', 3, 0.001);

    const cutoffRow = new Container({ class: 'toolkit-row', hidden: true });
    const cutoffLabel = new Label({ text: 'Cutoff', class: 'toolkit-label' });
    const cutoff = new SliderInput({ class: 'toolkit-slider', min: 0.01, max: 1, precision: 2, value: 0.5 });
    cutoffRow.append(cutoffLabel);
    cutoffRow.append(cutoff);
    editor.append(cutoffRow);

    // surface response to the studio lights
    const surfacePresets: Record<string, [number, number] | null> = {
        model: null,
        matte: [0.9, 0],
        satin: [0.55, 0],
        glossy: [0.25, 0],
        lacquer: [0.08, 0],
        metal: [0.35, 1],
        chrome: [0.06, 1]
    };
    const surfaceRow = new Container({ class: 'toolkit-row' });
    const surfaceLabel = new Label({ text: 'Surface', class: 'toolkit-label' });
    const surfaceSelect = new SelectInput({
        class: 'toolkit-select',
        type: 'string',
        options: [
            { v: 'model', t: 'From the model' },
            { v: 'matte', t: 'Matte' },
            { v: 'satin', t: 'Satin' },
            { v: 'glossy', t: 'Glossy' },
            { v: 'lacquer', t: 'Lacquer (very glossy)' },
            { v: 'metal', t: 'Brushed metal' },
            { v: 'chrome', t: 'Chrome' },
            { v: 'custom', t: 'Custom' }
        ],
        value: 'satin'
    });
    surfaceRow.append(surfaceLabel);
    surfaceRow.append(surfaceSelect);
    editor.append(surfaceRow);

    const shineRow = new Container({ class: 'toolkit-row' });
    const shineLabel = new Label({ text: 'Shine', class: 'toolkit-label' });
    const shine = new SliderInput({ class: 'toolkit-slider', min: 0, max: 1, precision: 2, step: 0.01, value: 1 - DEFAULT_ROUGHNESS });
    shineRow.append(shineLabel);
    shineRow.append(shine);
    editor.append(shineRow);

    const metalRow = new Container({ class: 'toolkit-row' });
    const metalLabel = new Label({ text: 'Metal', class: 'toolkit-label' });
    const metal = new SliderInput({ class: 'toolkit-slider', min: 0, max: 1, precision: 2, step: 0.01, value: DEFAULT_METALNESS });
    metalRow.append(metalLabel);
    metalRow.append(metal);
    editor.append(metalRow);

    const convertRow = new Container({ class: 'toolkit-row' });
    const densityLabel = new Label({ text: 'Density', class: 'toolkit-label' });
    const density = new SliderInput({ class: 'toolkit-slider', min: 16, max: 1024, precision: 0, step: 1, value: 200 });
    const convert = new Button({ text: 'To splat', class: 'toolkit-convert' });
    convertRow.append(densityLabel);
    convertRow.append(density);
    convertRow.append(convert);
    editor.append(convertRow);

    panel.append(header);
    panel.append(addRow);
    panel.append(shapeRow);
    panel.append(list);
    panel.append(editor);
    canvasContainer.append(panel);

    registerPanel(ctx, {
        id: 'primitives',
        panel,
        header,
        icon: primitivesSvg,
        title: 'Primitives & models',
        tooltip: 'Primitives & models: planes, walls, boxes, spheres and other shapes, pictures and .glb models, and turning them into splats.',
        order: 1
    });

    tooltips.register(addPlane, tips.addPlane, 'top');
    tooltips.register(addWall, tips.addWall, 'top');
    tooltips.register(addBox, tips.addBox, 'top');
    tooltips.register(addImage, tips.addImage, 'top');
    tooltips.register(addModel, tips.addModel, 'top');
    shapeButtons.forEach(([kind, label, button]) => tooltips.register(button, kind === 'backdrop' ? tips.addBackdrop : tips.addShape(label), 'top'));
    tooltips.register(surfaceLabel, tips.surface, 'right');
    tooltips.register(surfaceSelect, tips.surface, 'bottom');
    tooltips.register(shineLabel, tips.shine, 'right');
    tooltips.register(shine, tips.shine, 'bottom');
    tooltips.register(metalLabel, tips.metal, 'right');
    tooltips.register(metal, tips.metal, 'bottom');
    tooltips.register(cutoffLabel, tips.cutoff, 'right');
    tooltips.register(cutoff, tips.cutoff, 'bottom');
    tooltips.register(densityLabel, tips.density, 'right');
    tooltips.register(density, tips.density, 'bottom');
    tooltips.register(convert, tips.convert, 'bottom');
    tooltips.register(translateButton, tips.translate, 'bottom');
    tooltips.register(rotateButton, tips.rotate, 'bottom');
    tooltips.register(scaleButton, tips.scale, 'bottom');
    tooltips.register(colorPicker, tips.color, 'bottom');
    tooltips.register(colorLabel, tips.color, 'bottom');
    tooltips.register(position.label, tips.position, 'right');
    tooltips.register(rotation.label, tips.rotation, 'right');
    tooltips.register(size.label, tips.size, 'right');

    // ---- gizmo + tool

    let dragStart: PrimitiveState | null = null;

    const updateModeButtons = (mode: ShapeGizmoMode) => {
        translateButton.class[mode === 'translate' ? 'add' : 'remove']('active');
        rotateButton.class[mode === 'rotate' ? 'add' : 'remove']('active');
        scaleButton.class[mode === 'scale' ? 'add' : 'remove']('active');
    };

    let uiUpdating = false;
    const updateEditor = () => {
        editor.hidden = !selected;
        if (!selected) return;
        const state = selected.getState();
        // dragging a number field moves it one step per 100px, so the step has
        // to follow the size of the scene (a fixed step of 1 is useless on a
        // 0.2 unit scan and too fine on a 200 unit one)
        const hasSplat = scene.getElementsByType(ElementType.splat).length > 0;
        const dragStep = Math.max(0.001, (hasSplat ? scene.bound.halfExtents.length() : 1) * 0.5);
        position.input.step = dragStep;
        size.input.step = dragStep;
        rotation.input.step = 45;
        uiUpdating = true;
        position.input.value = state.position;
        rotation.input.value = state.rotation;
        size.input.value = state.scale;
        colorPicker.value = state.color;
        cutoffRow.hidden = selected.kind !== 'image';
        cutoff.value = state.alphaCutoff ?? 0.5;
        const isModel = selected.kind === 'model';
        const fromModel = isModel && state.roughness === undefined;
        const r = state.roughness ?? DEFAULT_ROUGHNESS;
        const m = state.metalness ?? DEFAULT_METALNESS;
        const match = Object.entries(surfacePresets).find(([, v]) => v && Math.abs(v[0] - r) < 1e-3 && Math.abs(v[1] - m) < 1e-3);
        surfaceSelect.options = surfaceSelect.options.filter(o => o.v !== 'model').concat(isModel ? [{ v: 'model', t: 'From the model' }] : []);
        surfaceSelect.value = fromModel ? 'model' : (match ? match[0] : 'custom');
        shineRow.hidden = fromModel;
        metalRow.hidden = fromModel;
        shine.value = 1 - r;
        metal.value = m;
        uiUpdating = false;
    };

    const gizmo = new ShapeTransformGizmo(events, scene, {
        rotate: true,
        uniformScale: false,
        lowerBoundScale: new Vec3(0.001, 0.001, 0.001),
        onTransformStart: () => {
            dragStart = selected?.getState() ?? null;
        },
        onTransform: () => {
            scene.boundDirty = true;
            updateEditor();
        },
        onTransformEnd: () => {
            if (selected && dragStart) {
                const newState = selected.getState();
                if (!statesEqual(dragStart, newState)) {
                    events.fire('edit.add', new PrimitiveStateOp(selected, dragStart, newState));
                }
            }
            dragStart = null;
        },
        onModeChanged: updateModeButtons
    });
    updateModeButtons(gizmo.mode);

    // edits from the inputs apply live and are committed to history as one
    // operation once the input has been quiet for a moment (a colour drag would
    // otherwise flood the undo stack)
    let pending: { primitive: MeshPrimitive, oldState: PrimitiveState, timer: number } | null = null;

    const flushPending = () => {
        if (!pending) return;
        const { primitive, oldState, timer } = pending;
        window.clearTimeout(timer);
        pending = null;
        const newState = primitive.getState();
        if (primitive.scene && !statesEqual(oldState, newState)) {
            events.fire('edit.add', new PrimitiveStateOp(primitive, oldState, newState));
        }
    };

    const edit = (primitive: MeshPrimitive, change: Partial<PrimitiveState>) => {
        if (pending && pending.primitive !== primitive) {
            flushPending();
        }
        const oldState = pending?.oldState ?? primitive.getState();
        if (pending) {
            window.clearTimeout(pending.timer);
        }
        primitive.setState({ ...primitive.getState(), ...change });
        pending = { primitive, oldState, timer: window.setTimeout(flushPending, 350) };
    };

    let select: (primitive: MeshPrimitive | null) => void = () => {};

    const refreshList = () => {
        list.clear();
        primitives().forEach((primitive) => {
            const row = new Container({ class: 'toolkit-list-row' });
            if (primitive === selected) {
                row.class.add('selected');
            }

            const name = new Label({ text: primitive.name, class: 'toolkit-list-name' });

            const visible = new Container({ class: 'toolkit-list-button' });
            visible.dom.appendChild(createSvg(primitive.entity.enabled ? shownSvg : hiddenSvg));

            const remove = new Container({ class: 'toolkit-list-button' });
            remove.dom.appendChild(createSvg(deleteSvg));

            row.on('click', () => select(primitive === selected ? null : primitive));

            visible.dom.addEventListener('click', (event) => {
                event.stopPropagation();
                flushPending();
                const oldState = primitive.getState();
                events.fire('edit.add', new PrimitiveStateOp(primitive, oldState, { ...oldState, visible: !oldState.visible }));
            });

            remove.dom.addEventListener('click', (event) => {
                event.stopPropagation();
                flushPending();
                events.fire('edit.add', new RemovePrimitiveOp(scene, primitive));
            });

            tooltips.register(name, tips.row, 'right');
            tooltips.register(visible, tips.visible, 'top');
            tooltips.register(remove, tips.remove, 'top');

            row.append(name);
            row.append(visible);
            row.append(remove);
            list.append(row);
        });
    };

    select = (primitive: MeshPrimitive | null) => {
        flushPending();
        selected = primitive;
        if (!primitive) {
            if (toolManager.active === TOOL) {
                toolManager.activate(null);     // runs deactivate below
                return;
            }
        } else if (toolManager.active !== TOOL) {
            toolManager.activate(TOOL);         // runs activate below
        } else {
            gizmo.detach();
            gizmo.attach(primitive.entity);
        }
        refreshList();
        updateEditor();
        events.fire('toolkit.primitive.selected', selected);
        scene.forceRender = true;
    };

    toolManager.register(TOOL, {
        activate: () => {
            if (selected) {
                gizmo.attach(selected.entity);
            }
        },
        deactivate: () => {
            flushPending();
            gizmo.detach();
            selected = null;
            refreshList();
            updateEditor();
            events.fire('toolkit.primitive.selected', null);
            scene.forceRender = true;
        },
        setTransformMode: (mode) => {
            gizmo.setMode(mode);
            return true;
        },
        getFocus: () => {
            const bound = selected?.worldBound;
            return bound ? { position: bound.center.clone(), radius: bound.halfExtents.length() } : null;
        }
    });

    translateButton.on('click', () => gizmo.setMode('translate'));
    rotateButton.on('click', () => gizmo.setMode('rotate'));
    scaleButton.on('click', () => gizmo.setMode('scale'));

    position.input.on('change', (value: number[]) => {
        if (!uiUpdating && selected) edit(selected, { position: [value[0], value[1], value[2]] });
    });
    rotation.input.on('change', (value: number[]) => {
        if (!uiUpdating && selected) edit(selected, { rotation: [value[0], value[1], value[2]] });
    });
    size.input.on('change', (value: number[]) => {
        if (!uiUpdating && selected) edit(selected, { scale: [value[0], value[1], value[2]] });
    });
    colorPicker.on('change', (value: number[]) => {
        if (!uiUpdating && selected) edit(selected, { color: [value[0], value[1], value[2]] });
    });

    cutoff.on('change', (value: number) => {
        if (!uiUpdating && selected) edit(selected, { alphaCutoff: value });
    });

    surfaceSelect.on('change', (value: string) => {
        if (uiUpdating || !selected) return;
        if (value === 'model') {
            const state = selected.getState();
            delete state.roughness;
            delete state.metalness;
            flushPending();
            events.fire('edit.add', new PrimitiveStateOp(selected, selected.getState(), state));
            return;
        }
        const preset = surfacePresets[value];
        if (preset) {
            edit(selected, { roughness: preset[0], metalness: preset[1] });
            updateEditor();
        }
    });
    shine.on('change', (value: number) => {
        if (!uiUpdating && selected) edit(selected, { roughness: 1 - value, metalness: selected.metalness ?? 0 });
    });
    metal.on('change', (value: number) => {
        if (!uiUpdating && selected) edit(selected, { metalness: value, roughness: selected.roughness ?? DEFAULT_ROUGHNESS });
    });

    // ---- conversion to a gaussian splat layer

    // the conversion itself (sampling, studio lighting, import, hiding the
    // primitive) lives in the studio lighting module
    const convertToSplat = async (primitive: MeshPrimitive, splatsAlongLongestSide: number) => {
        flushPending();
        // the lights stay on while other meshes still need them
        const othersVisible = primitives().some(p => p !== primitive && p.entity.enabled);
        return await events.invoke('toolkit.convertPrimitives', [primitive], {
            cell: cellForDensity(primitive, splatsAlongLongestSide),
            hideLights: othersVisible ? false : undefined
        }) as number;
    };

    events.function('toolkit.primitiveToSplat', convertToSplat);

    convert.on('click', async () => {
        if (!selected || !convert.enabled) return;
        convert.enabled = false;
        try {
            await convertToSplat(selected, density.value);
        } finally {
            convert.enabled = true;
        }
    });

    // ---- creation

    let selectOnAdd: MeshPrimitive | null = null;

    const create = (kind: PrimitiveKind, label: string, vertical: boolean) => {
        flushPending();
        const hasSplat = scene.getElementsByType(ElementType.splat).length > 0;
        const extent = hasSplat ? scene.bound.halfExtents.length() : 1;
        const s = Math.max(0.01, extent * 0.5);
        const focus = scene.camera.focalPoint;
        const primitive = new MeshPrimitive({
            kind,
            name: `${label} ${++counter}`,
            position: [focus.x, focus.y, focus.z],
            rotation: [vertical ? 90 : 0, 0, 0],
            scale: [s, kind === 'box' ? s : 1, s],
            color: [0.8, 0.8, 0.8],
            visible: true,
            alphaCutoff: 0.5
        });
        selectOnAdd = primitive;
        events.fire('edit.add', new AddPrimitiveOp(scene, primitive));
    };

    // curved shapes stand on the floor of the scene at the camera focus
    const createShape = (kind: ShapeKind, label: string) => {
        flushPending();
        const hasSplat = scene.getElementsByType(ElementType.splat).length > 0;
        const extent = hasSplat ? scene.bound.halfExtents.length() : 1;
        const s = Math.max(0.01, extent * 0.5);
        const focus = scene.camera.focalPoint;
        const scale: [number, number, number] = kind === 'backdrop' ? [s * 4, s * 2.5, s * 3] : [s, s, s];
        const primitive = new MeshPrimitive({
            kind,
            name: `${label} ${++counter}`,
            position: [focus.x, focus.y, focus.z],
            rotation: [0, 0, 0],
            scale,
            color: kind === 'backdrop' ? [0.85, 0.85, 0.85] : [0.8, 0.8, 0.8],
            visible: true,
            alphaCutoff: 0.5,
            roughness: kind === 'backdrop' ? 0.95 : DEFAULT_ROUGHNESS,
            metalness: 0
        });
        selectOnAdd = primitive;
        events.fire('edit.add', new AddPrimitiveOp(scene, primitive));
    };

    shapeButtons.forEach(([kind, label, button]) => button.on('click', () => createShape(kind, label)));

    addPlane.on('click', () => create('plane', 'Plane', false));
    addWall.on('click', () => create('plane', 'Wall', true));
    addBox.on('click', () => create('box', 'Box', false));

    // a picture stands upright at the camera focus, keeping its aspect ratio
    const createImage = async (dataUrl: string, label = 'Image') => {
        flushPending();
        const image = new Image();
        image.src = dataUrl;
        await image.decode();
        const aspect = image.naturalWidth / Math.max(1, image.naturalHeight);
        const hasSplat = scene.getElementsByType(ElementType.splat).length > 0;
        const height = Math.max(0.01, (hasSplat ? scene.bound.halfExtents.length() : 1) * 0.5);
        const focus = scene.camera.focalPoint;
        const primitive = new MeshPrimitive({
            kind: 'image',
            name: `${label} ${++counter}`,
            image: dataUrl,
            position: [focus.x, focus.y, focus.z],
            rotation: [90, 0, 0],
            scale: [height * aspect, height * 0.05, height],
            color: [1, 1, 1],
            visible: true,
            alphaCutoff: 0.5
        });
        selectOnAdd = primitive;
        events.fire('edit.add', new AddPrimitiveOp(scene, primitive));
    };

    events.function('toolkit.addImage', createImage);

    addImage.on('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
        const file = fileInput.files?.[0];
        fileInput.value = '';
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => createImage(reader.result as string, file.name.replace(/\.[^.]+$/, ''));
        reader.readAsDataURL(file);
    });

    // a .glb becomes a mesh primitive: upright at the camera focus, its longest
    // side half the size of the scene. reading it here first rejects files the
    // converter cannot handle (e.g. Draco-compressed) before anything is added
    const createModel = async (file: { filename: string, contents?: Blob, url?: string }) => {
        flushPending();
        const displayName = file.filename.split('/').pop();
        try {
            const blob: Blob = file.contents ?? await (await fetch(file.url)).blob();
            const mesh = await readGlb(await blob.arrayBuffer());
            if (mesh.numTriangles === 0) {
                throw new Error('The file contains no triangle meshes');
            }
            const dataUrl = await new Promise<string>((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result as string);
                reader.onerror = () => reject(new Error('The file could not be read'));
                reader.readAsDataURL(blob);
            });
            const hasSplat = scene.getElementsByType(ElementType.splat).length > 0;
            const size = Math.max(0.01, (hasSplat ? scene.bound.halfExtents.length() : 1) * 0.5);
            const focus = scene.camera.focalPoint;
            const primitive = new MeshPrimitive({
                kind: 'model',
                name: `${displayName.replace(/\.glb$/i, '')} ${++counter}`,
                model: dataUrl,
                position: [focus.x, focus.y, focus.z],
                rotation: [0, 0, 0],
                scale: [size, size, size],
                color: [1, 1, 1],
                visible: true,
                alphaCutoff: 0.5
            });
            selectOnAdd = primitive;
            events.fire('edit.add', new AddPrimitiveOp(scene, primitive));
        } catch (error) {
            await events.invoke('showPopup', {
                type: 'error',
                header: 'GLB import',
                message: `${(error as Error).message ?? error} while loading '${displayName}'`
            });
        }
    };

    events.function('toolkit.addModel', createModel);

    addModel.on('click', () => modelInput.click());
    modelInput.addEventListener('change', () => {
        const file = modelInput.files?.[0];
        modelInput.value = '';
        if (file) {
            createModel({ filename: file.name, contents: file });
        }
    });

    // ---- viewport picking: a click (not a drag) on a primitive selects it

    const pickRay = new Ray();
    const pickPoint = new Vec3();
    const pickTools: (string | null)[] = [null, TOOL, 'move', 'rotate', 'scale'];
    let down: { x: number, y: number } | null = null;

    let pickDistance = Infinity;
    const pick = (x: number, y: number) => {
        pickDistance = Infinity;
        scene.camera.getRay(x, y, pickRay);
        let best: MeshPrimitive | null = null;
        let bestDistance = Infinity;
        primitives().forEach((primitive) => {
            if (!primitive.entity.enabled) return;
            const pickBox = new OrientedBox(primitive.entity.getWorldTransform(), primitive.localHalf);
            if (pickBox.intersectsRay(pickRay, pickPoint)) {
                const distance = pickPoint.distance(pickRay.origin);
                if (distance < bestDistance) {
                    bestDistance = distance;
                    best = primitive;
                }
            }
        });
        pickDistance = bestDistance;
        return best as MeshPrimitive | null;
    };

    events.function('toolkit.primitivePickDistance', (x: number, y: number) => {
        pick(x, y);
        return pickDistance;
    });

    scene.canvas.addEventListener('pointerdown', (event: PointerEvent) => {
        down = event.button === 0 ? { x: event.clientX, y: event.clientY } : null;
    }, true);

    scene.canvas.addEventListener('pointerup', (event: PointerEvent) => {
        const start = down;
        down = null;
        if (!start || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4) return;
        if (!pickTools.includes(toolManager.active)) return;
        const hit = pick(event.offsetX, event.offsetY);
        // a studio light in front of the primitive takes the click
        const lightDistance: number = events.invoke('toolkit.lightPickDistance', event.offsetX, event.offsetY) ?? Infinity;
        if (hit && hit !== selected && pickDistance < lightDistance) {
            select(hit);
        }
    }, true);

    // ---- scene events

    events.on('scene.elementAdded', (element: Element) => {
        if (isPrimitive(element)) {
            refreshList();
            if (element === selectOnAdd) {
                selectOnAdd = null;
                select(element);
            }
        }
    });

    events.on('scene.elementRemoved', (element: Element) => {
        if (isPrimitive(element)) {
            if (element === selected) {
                select(null);
            }
            refreshList();
        }
    });

    events.on('toolkit.primitive.changed', (primitive: MeshPrimitive) => {
        refreshList();
        if (primitive === selected) {
            updateEditor();
        }
        scene.forceRender = true;
    });

    // new document / document load: primitives go with the rest of the scene
    events.on('scene.clear', () => {
        select(null);
        primitives().forEach(primitive => scene.remove(primitive));
        counter = 0;
    });

    loadPrimitives = async (data: PrimitiveData[]) => {
        for (const item of data) {
            await scene.add(new MeshPrimitive(item));
            counter++;
        }
    };
};

const meshPrimitivesModule: ToolkitModule = {
    id: 'meshPrimitives',
    init,
    serialize: () => getPrimitives().map(primitive => primitive.getData()),
    deserialize: data => loadPrimitives(Array.isArray(data) ? data as PrimitiveData[] : [])
};

export { meshPrimitivesModule };
