import { Button, ColorPicker, Container, Label, VectorInput } from '@playcanvas/pcui';
import { Vec3 } from 'playcanvas';

import { Element, ElementType } from '../element';
import { ShapeGizmoMode, ShapeTransformGizmo } from '../tools/shape-transform-gizmo';
import deleteSvg from '../ui/svg/delete.svg';
import hiddenSvg from '../ui/svg/hidden.svg';
import shownSvg from '../ui/svg/shown.svg';
import type { ToolkitContext, ToolkitModule } from './index';
import { MeshPrimitive, PrimitiveData, PrimitiveKind, PrimitiveState, statesEqual } from './mesh-primitive';
import { AddPrimitiveOp, PrimitiveStateOp, RemovePrimitiveOp } from './primitive-ops';

const TOOL = 'toolkitPrimitive';

const tips = {
    addPlane: 'Add a horizontal plane (floor / ceiling) at the camera focus. It hides the splats behind it with a sharp edge.',
    addWall: 'Add a vertical plane (wall) at the camera focus. It hides the splats behind it with a sharp edge.',
    addBox: 'Add a solid box at the camera focus. Splats inside and behind it are hidden.',
    row: 'Click to select this primitive and show its transform gizmo. Click again to deselect.',
    visible: 'Show or hide this primitive.',
    remove: 'Delete this primitive (undo brings it back).',
    translate: 'Move the selected primitive with the gizmo (shortcut: 1).',
    rotate: 'Rotate the selected primitive with the gizmo (shortcut: 2).',
    scale: 'Resize the selected primitive with the gizmo (shortcut: 3).',
    color: 'Surface colour of the selected primitive.',
    position: 'Position of the primitive centre in world units (X, Y, Z).',
    rotation: 'Rotation in degrees around the X, Y and Z axes.',
    size: 'Size along the primitive\'s own X, Y and Z axes. A plane ignores Y.'
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
    header.append(new Label({ text: '\uE187', class: 'panel-header-icon' }));
    header.append(new Label({ text: 'Mesh primitives', class: 'panel-header-label' }));

    const addRow = new Container({ class: 'toolkit-row' });
    const addPlane = new Button({ text: '+ Plane', class: 'toolkit-button' });
    const addWall = new Button({ text: '+ Wall', class: 'toolkit-button' });
    const addBox = new Button({ text: '+ Box', class: 'toolkit-button' });
    addRow.append(addPlane);
    addRow.append(addWall);
    addRow.append(addBox);

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

    panel.append(header);
    panel.append(addRow);
    panel.append(list);
    panel.append(editor);
    canvasContainer.append(panel);

    tooltips.register(addPlane, tips.addPlane, 'top');
    tooltips.register(addWall, tips.addWall, 'top');
    tooltips.register(addBox, tips.addBox, 'top');
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
        uiUpdating = true;
        position.input.value = state.position;
        rotation.input.value = state.rotation;
        size.input.value = state.scale;
        colorPicker.value = state.color;
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
            visible: true
        });
        selectOnAdd = primitive;
        events.fire('edit.add', new AddPrimitiveOp(scene, primitive));
    };

    addPlane.on('click', () => create('plane', 'Plane', false));
    addWall.on('click', () => create('plane', 'Wall', true));
    addBox.on('click', () => create('box', 'Box', false));

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
