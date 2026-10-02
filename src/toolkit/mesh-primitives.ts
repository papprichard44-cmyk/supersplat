import { BooleanInput, Button, ColorPicker, Container, Label, SelectInput, SliderInput, VectorInput } from '@playcanvas/pcui';
import { OrientedBox, Quat, Ray, Vec3 } from 'playcanvas';

import { MultiOp } from '../edit-ops';
import { Element, ElementType } from '../element';
import primitivesSvg from './icons/primitives.svg';
import { collapsible } from './inspector';
import { DEFAULT_METALNESS, DEFAULT_ROUGHNESS, MeshPrimitive, PrimitiveData, PrimitiveGenerator, PrimitiveKind, PrimitiveState, statesEqual } from './mesh-primitive';
import { headerIcon, registerPanel } from './panels';
import { AddPrimitiveOp, PrimitiveStateOp, RemovePrimitiveOp } from './primitive-ops';
import { cellForDensity } from './primitive-to-splat';
import { ShapeKind } from './shapes';
import { defaultGradient, defaultTexture, gradientCss, PaintGradient, PaintTexture, PaintWrap } from './surface-paint';
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
    lock: 'Lock: X, Y and Z sizes change together, keeping the proportions (also on the scale gizmo). Unlocked: each size on its own.',
    detail: 'Detail of the splats: how many along the object\'s longest side. Higher = sharper, but more splats and a bigger file. Saved with the object.',
    hideAfter: 'Hide the mesh (and the lights, once nothing else needs them) after converting, so you see the splats. Nothing is deleted.',
    convertLit: 'Turn this mesh into splats with the studio lights that reach it baked in (shading, highlights, shadows). The mesh is kept, hidden.',
    convertPlain: 'Turn this mesh into splats with its own colours (no studio lights reach it). The mesh is kept, hidden.',
    lightWith: 'Light this object with a ready-made setup: the lights are placed around it and aimed at it.',
    reach: 'Which studio lights reach this object. Untick a light to keep it off this object (the light then lights only the objects ticked for it).',
    casts: 'Whether this object casts shadows onto others when the lighting is baked.',
    aimHere: 'Make this object the subject: every light that is set to aim turns to it.',
    farView: 'Keep the converted object visible from far away. Splat viewers (the editor, published and exported scenes alike) skip gaussians smaller than about half a pixel, and a converted mesh is made of equally tiny ones, so it would vanish all at once as you move away. On: solids and extruded pictures get hidden layers of larger gaussians inside that take over from a distance (about a third more splats).',
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
    color: 'Surface colour of the selected primitive (with a gradient: its start colour). On a picture or model it tints it (white = unchanged).',
    opacity: 'Opacity of the colour: 1 = solid, 0 = invisible. See-through parts let the light through and become see-through splats.',
    gradient: 'Blend the colour into a second colour across the surface. Each end has its own opacity, so a colour can fade out into nothing.',
    gradientEnd: 'End colour of the gradient and its opacity. With opacity 0 its colour does not matter: the start colour simply fades out.',
    gradientType: 'Linear: a straight blend in one direction. Radial: from the centre outwards.',
    gradientSpace: 'Along the surface: follows the surface layout (on a box, every face on its own; on a backdrop, from its front edge up the wall). In object space: across the whole object, angle 0 = bottom to top.',
    angle: 'Direction of the blend in degrees.',
    from: 'Where the blend starts: before this point the surface has the start colour.',
    to: 'Where the blend ends: after this point the surface has the end colour. Set it below "From" to reverse the gradient.',
    balance: 'Where between From and To the colours meet half way: lower values let the end colour take over sooner, higher values later.',
    smooth: 'Ease the blend in and out instead of a straight line: softer, more natural transitions.',
    swap: 'Swap the two ends of the gradient.',
    picture: 'Put a picture (PNG / JPEG / WebP) from your computer on the surface. It is multiplied with the colour (white = the picture as it is) and its transparency is kept.',
    tiling: 'How many times the picture repeats across the surface, horizontally and vertically.',
    offset: 'Shift the picture across the surface, in picture widths and heights.',
    turn: 'Turn the picture on the surface, in degrees.',
    wrap: 'Beyond its edges the picture repeats, repeats mirrored, stretches its edge pixels, or (decal) is laid once over the colour - with its transparent parts showing the colour underneath.',
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
    header.append(new Label({ text: 'Meshes', class: 'panel-header-label' }));

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
        return { row, label, input };
    };

    editor.append(modeRow);
    const position = vectorRow('Position', 3);
    const rotation = vectorRow('Rotation', 2);
    const size = vectorRow('Size', 3, 0.001);

    // size lock: all three sizes change together, keeping the proportions
    const lockIcon = (locked: boolean) => `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none">
<rect x="3.5" y="7" width="9" height="6.5" rx="1.2" stroke="currentColor" stroke-width="1.3"/>
<path d="${locked ? 'M5.5 7 V5 a2.5 2.5 0 0 1 5 0 V7' : 'M5.5 7 V5 a2.5 2.5 0 0 1 4.9 -0.7'}" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
</svg>`;
    const lockButton = new Button({ class: ['toolkit-mode', 'toolkit-lock'] });
    size.row.append(lockButton);
    let scaleLocked = true;
    try {
        scaleLocked = localStorage.getItem('supersplat.toolkit.scaleLock') !== 'false';
    } catch {
        // storage unavailable
    }
    const showLock = () => {
        lockButton.dom.innerHTML = lockIcon(scaleLocked);
        lockButton.class[scaleLocked ? 'add' : 'remove']('active');
    };
    showLock();

    // ---- paint: opacity, gradient, picture (planes, boxes and shapes)
    const paintBox = new Container({ class: 'toolkit-paint' });
    editor.append(paintBox);
    const paintRow = (text: string, tip: string) => {
        const row = new Container({ class: 'toolkit-row' });
        const label = new Label({ text, class: 'toolkit-label' });
        row.append(label);
        tooltips.register(label, tip, 'right');
        return row;
    };
    const paintSlider = (row: Container, tip: string, args: { min: number, max: number, precision: number, value: number, step?: number }) => {
        const slider = new SliderInput({ class: 'toolkit-slider', ...args });
        row.append(slider);
        tooltips.register(slider, tip, 'bottom');
        return slider;
    };

    const opacityRow = paintRow('Opacity', tips.opacity);
    const opacity = paintSlider(opacityRow, tips.opacity, { min: 0, max: 1, precision: 2, step: 0.01, value: 1 });
    paintBox.append(opacityRow);

    const gradientRow = paintRow('Gradient', tips.gradient);
    const gradientToggle = new BooleanInput({ type: 'toggle', class: 'toolkit-toggle', value: false });
    const gradientPreview = new Container({ class: 'toolkit-gradient-preview' });
    const swapButton = new Button({ text: '⇄', class: 'toolkit-convert' });
    gradientRow.append(gradientToggle);
    gradientRow.append(gradientPreview);
    gradientRow.append(swapButton);
    tooltips.register(gradientToggle, tips.gradient, 'bottom');
    tooltips.register(gradientPreview, tips.gradient, 'bottom');
    tooltips.register(swapButton, tips.swap, 'bottom');
    paintBox.append(gradientRow);

    const gradientBox = new Container({ class: 'toolkit-paint-sub', hidden: true });
    paintBox.append(gradientBox);
    const endRow = paintRow('End', tips.gradientEnd);
    const endColor = new ColorPicker({ class: 'toolkit-color-small', value: [1, 1, 1] });
    endRow.append(endColor);
    tooltips.register(endColor, tips.gradientEnd, 'bottom');
    const endOpacity = paintSlider(endRow, tips.gradientEnd, { min: 0, max: 1, precision: 2, step: 0.01, value: 0 });
    gradientBox.append(endRow);

    const typeRow = paintRow('Type', tips.gradientType);
    const gradientType = new SelectInput({
        class: 'toolkit-select-small',
        type: 'string',
        options: [{ v: 'linear', t: 'Linear' }, { v: 'radial', t: 'Radial' }],
        value: 'linear'
    });
    const gradientSpace = new SelectInput({
        class: 'toolkit-select',
        type: 'string',
        options: [{ v: 'surface', t: 'Along the surface' }, { v: 'object', t: 'In object space' }],
        value: 'surface'
    });
    typeRow.append(gradientType);
    typeRow.append(gradientSpace);
    tooltips.register(gradientType, tips.gradientType, 'bottom');
    tooltips.register(gradientSpace, tips.gradientSpace, 'bottom');
    gradientBox.append(typeRow);

    const angleRow = paintRow('Angle', tips.angle);
    const angle = paintSlider(angleRow, tips.angle, { min: 0, max: 360, precision: 0, step: 1, value: 90 });
    gradientBox.append(angleRow);
    const fromRow = paintRow('From', tips.from);
    const from = paintSlider(fromRow, tips.from, { min: 0, max: 1, precision: 2, step: 0.01, value: 0 });
    gradientBox.append(fromRow);
    const toRow = paintRow('To', tips.to);
    const to = paintSlider(toRow, tips.to, { min: 0, max: 1, precision: 2, step: 0.01, value: 1 });
    gradientBox.append(toRow);
    const balanceRow = paintRow('Balance', tips.balance);
    const balance = paintSlider(balanceRow, tips.balance, { min: 0.05, max: 0.95, precision: 2, step: 0.01, value: 0.5 });
    gradientBox.append(balanceRow);
    const smoothRow = paintRow('Smooth', tips.smooth);
    const smoothToggle = new BooleanInput({ type: 'toggle', class: 'toolkit-toggle', value: false });
    smoothRow.append(smoothToggle);
    tooltips.register(smoothToggle, tips.smooth, 'bottom');
    gradientBox.append(smoothRow);

    const pictureRow = paintRow('Picture', tips.picture);
    const pictureName = new Label({ text: 'None', class: ['toolkit-check-name', 'toolkit-picture-name'] });
    const pictureLoad = new Button({ text: 'Load…', class: 'toolkit-convert' });
    const pictureRemove = new Button({ text: '✕', class: 'toolkit-convert', hidden: true });
    pictureRow.append(pictureName);
    pictureRow.append(pictureLoad);
    pictureRow.append(pictureRemove);
    tooltips.register(pictureLoad, tips.picture, 'bottom');
    tooltips.register(pictureRemove, 'Take the picture off the surface', 'bottom');
    paintBox.append(pictureRow);

    const pictureBox = new Container({ class: 'toolkit-paint-sub', hidden: true });
    paintBox.append(pictureBox);
    const vector2 = (text: string, tip: string, precision: number, step: number) => {
        const row = paintRow(text, tip);
        const input = new VectorInput({ class: 'toolkit-vector', dimensions: 2, precision, step, placeholder: ['U', 'V'], value: [0, 0] });
        row.append(input);
        tooltips.register(input, tip, 'bottom');
        pictureBox.append(row);
        return input;
    };
    const tiling = vector2('Tiling', tips.tiling, 2, 0.5);
    const offset = vector2('Offset', tips.offset, 3, 0.1);
    const turnRow = paintRow('Turn', tips.turn);
    const turn = paintSlider(turnRow, tips.turn, { min: -180, max: 180, precision: 0, step: 1, value: 0 });
    pictureBox.append(turnRow);
    const wrapRow = paintRow('Edges', tips.wrap);
    const wrap = new SelectInput({
        class: 'toolkit-select',
        type: 'string',
        options: [
            { v: 'repeat', t: 'Repeat' },
            { v: 'mirror', t: 'Repeat mirrored' },
            { v: 'clamp', t: 'Stretch the edge' },
            { v: 'decal', t: 'Once, over the colour (decal)' }
        ],
        value: 'repeat'
    });
    wrapRow.append(wrap);
    tooltips.register(wrap, tips.wrap, 'bottom');
    pictureBox.append(wrapRow);

    const pictureInput = document.createElement('input');
    pictureInput.type = 'file';
    pictureInput.accept = 'image/png,image/webp,image/jpeg';
    pictureInput.style.display = 'none';
    panel.dom.appendChild(pictureInput);

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
    const density = new SliderInput({ class: 'toolkit-slider', min: 16, max: 2000, precision: 0, step: 1, value: 300 });
    const convert = new Button({ text: 'To splat', class: 'toolkit-convert' });
    convertRow.append(densityLabel);
    convertRow.append(density);
    convertRow.append(convert);
    editor.append(convertRow);

    // far view: renderers skip gaussians below about half a pixel, so a
    // converted object made of equally tiny ones vanishes at one distance
    const farRow = new Container({ class: 'toolkit-row' });
    const farLabel = new Label({ text: 'Far view', class: 'toolkit-label' });
    const farToggle = new BooleanInput({ type: 'toggle', class: 'toolkit-toggle', value: true });
    farRow.append(farLabel);
    farRow.append(farToggle);
    editor.append(farRow);
    const farHint = new Label({ text: '', class: 'toolkit-hint' });
    editor.append(farHint);
    tooltips.register(farLabel, tips.farView, 'right');
    tooltips.register(farToggle, tips.farView, 'bottom');

    // ---- the inspector content: the selected mesh's settings in groups
    editor.hidden = false;
    const transformGroup = collapsible('Transform', 'mesh.transform');
    transformGroup.body.append(modeRow);
    transformGroup.body.append(position.row);
    transformGroup.body.append(rotation.row);
    transformGroup.body.append(size.row);

    const lookGroup = collapsible('Look', 'mesh.look');
    const colorRow = new Container({ class: 'toolkit-row' });
    colorRow.append(colorLabel);
    colorRow.append(colorPicker);
    lookGroup.body.append(colorRow);
    lookGroup.body.append(paintBox);
    lookGroup.body.append(cutoffRow);
    const lookSwatch = new Container({ class: 'toolkit-swatch-small' });
    lookGroup.extra.append(lookSwatch);

    const surfaceGroup = collapsible('Surface', 'mesh.surface');
    surfaceGroup.body.append(surfaceRow);
    surfaceGroup.body.append(shineRow);
    surfaceGroup.body.append(metalRow);
    const surfaceSummary = new Label({ text: '', class: 'toolkit-group-summary' });
    surfaceGroup.extra.append(surfaceSummary);

    const lightGroup = collapsible('Lighting', 'mesh.lighting');
    const lightBox = new Container();
    lightGroup.body.append(lightBox);
    const lightSummary = new Label({ text: '', class: 'toolkit-group-summary' });
    lightGroup.extra.append(lightSummary);

    const splatGroup = collapsible('Splats', 'mesh.splats');
    const detailRow = new Container({ class: 'toolkit-row' });
    densityLabel.text = 'Detail';
    detailRow.append(densityLabel);
    detailRow.append(density);
    splatGroup.body.append(detailRow);
    const splatEstimate = new Label({ text: '', class: ['toolkit-hint', 'toolkit-estimate'] });
    splatGroup.body.append(splatEstimate);
    splatGroup.body.append(farRow);
    splatGroup.body.append(farHint);
    const hideRow = new Container({ class: 'toolkit-row' });
    const hideLabel = new Label({ text: 'Hide after', class: 'toolkit-label' });
    const hideToggle = new BooleanInput({ type: 'toggle', class: 'toolkit-toggle', value: true });
    hideRow.append(hideLabel);
    hideRow.append(hideToggle);
    splatGroup.body.append(hideRow);
    const convertBigRow = new Container({ class: 'toolkit-row' });
    convert.class.remove('toolkit-convert');
    convert.class.add('toolkit-bake');
    convertBigRow.append(convert);
    splatGroup.body.append(convertBigRow);
    const splatSummary = new Label({ text: '', class: 'toolkit-group-summary' });
    splatGroup.extra.append(splatSummary);
    convertRow.destroy();

    [transformGroup, lookGroup, surfaceGroup, lightGroup, splatGroup].forEach(g => editor.append(g.root));

    tooltips.register(lockButton, tips.lock, 'bottom');
    tooltips.register(densityLabel, tips.detail, 'right');
    tooltips.register(hideLabel, tips.hideAfter, 'right');
    tooltips.register(hideToggle, tips.hideAfter, 'bottom');

    panel.append(header);
    panel.append(addRow);
    panel.append(shapeRow);
    panel.append(list);
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

    // what the far view does for the selected primitive at this density
    const updateFarHint = () => {
        if (!selected) return;
        const backed = ['box', 'sphere', 'cylinder', 'cone', 'torus', 'image'].includes(selected.kind);
        const on = events.invoke('toolkit.backing') ?? true;
        // the surface gaussians are ~0.7 cells wide; they drop out at ~0.6 px
        const vanish = Math.round(density.value * 0.85);
        if (backed && on) {
            farHint.text = `Stays visible from far: larger hidden gaussians take over once the surface ones get too small (below ~${vanish} px on screen).`;
        } else if (backed) {
            farHint.text = `Vanishes once it is smaller than ~${vanish} px on screen. Turn Far view on, or lower Density.`;
        } else {
            farHint.text = `Flat sheets and models vanish once smaller than ~${vanish} px on screen. A lower Density keeps them visible from further; publishing with LODs also helps.`;
        }
    };

    const formatCount = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} M` : `${Math.max(1, Math.round(n / 1000))} k`);

    // what converting the selected mesh makes, and the button to do it
    const updateSplatInfo = () => {
        if (!selected) return;
        const info = events.invoke('toolkit.studio.estimatePrimitive', selected, density.value) as { count: number, lit: boolean, memory: number, max: number } | null;
        if (!info) return;
        const parts = [`About ${formatCount(info.count)} splats`];
        parts.push(info.lit ? 'the studio lights that reach it are baked in' : 'its own colours (no studio light reaches it)');
        if (info.memory > 3 * 1024 ** 3) parts.push(`needs ~${(info.memory / 1024 ** 3).toFixed(1)} GB of memory`);
        splatEstimate.text = `${parts.join(', ')}.`;
        splatSummary.text = `≈ ${formatCount(info.count)}`;
        const tooMany = info.count > info.max;
        convert.enabled = !tooMany;
        if (tooMany) splatEstimate.text += ` More than ${formatCount(info.max)}: lower the Detail.`;
        convert.text = info.lit ? 'Bake lighting & convert to splats' : 'Convert to splats';
        tooltips.register(convert, info.lit ? tips.convertLit : tips.convertPlain, 'bottom');
        hideToggle.value = events.invoke('toolkit.studio.hideAfter') ?? true;
    };

    // the selected mesh's lighting at a glance, with quick actions
    let lightPreset = '';
    const refreshLighting = () => {
        if (!selected) return;
        const info = events.invoke('toolkit.studio.meshLighting', selected) as {
            lights: { index: number, name: string, visible: boolean, reaches: boolean }[],
            casts: boolean,
            subject: boolean,
            presets: { v: string, t: string }[]
        } | null;
        lightBox.clear();
        if (!info) return;
        const target = selected;
        const on = info.lights.filter(l => l.visible && l.reaches).length;
        lightSummary.text = info.lights.length ? `${on} of ${info.lights.length} lights` : 'no lights';

        lightBox.append(new Label({
            text: info.lights.length ?
                `Lit by ${on} of ${info.lights.length} light${info.lights.length === 1 ? '' : 's'}${info.subject ? '. The lights aim at it.' : '.'}` :
                'No studio lights yet. Light it with a setup:',
            class: 'toolkit-hint'
        }));

        // a setup around this object
        const setupRow = new Container({ class: 'toolkit-row' });
        const setupSelect = new SelectInput({ class: 'toolkit-select', type: 'string', options: info.presets, value: lightPreset || info.presets[0]?.v });
        const setupButton = new Button({ text: info.lights.length ? 'Relight' : 'Light it', class: 'toolkit-convert' });
        setupRow.append(setupSelect);
        setupRow.append(setupButton);
        lightBox.append(setupRow);
        tooltips.register(setupSelect, tips.lightWith, 'bottom');
        tooltips.register(setupButton, tips.lightWith, 'bottom');
        setupSelect.on('change', (v: string) => {
            lightPreset = v;
        });
        setupButton.on('click', () => {
            lightPreset = setupSelect.value;
            events.invoke('toolkit.studio.lightWith', target, setupSelect.value);
        });

        if (info.lights.length) {
            const checklist = new Container({ class: 'toolkit-checklist' });
            tooltips.register(checklist, tips.reach, 'left');
            info.lights.forEach((light) => {
                const r = new Container({ class: 'toolkit-check-row' });
                if (!light.visible) r.class.add('dimmed');
                const box = new BooleanInput({ type: 'checkbox', value: light.reaches });
                const name = new Label({ text: light.name, class: 'toolkit-check-name' });
                const state = new Label({ text: light.visible ? '' : 'off', class: 'toolkit-check-kind' });
                r.append(box);
                r.append(name);
                r.append(state);
                box.on('change', (value: boolean) => events.invoke('toolkit.studio.setReach', target, light.index, value));
                name.dom.addEventListener('click', () => {
                    box.value = !box.value;
                });
                checklist.append(r);
            });
            lightBox.append(checklist);

            const castsRow = new Container({ class: 'toolkit-row' });
            const castsLabel = new Label({ text: 'Shadows', class: 'toolkit-label' });
            const castsToggle = new BooleanInput({ type: 'toggle', class: 'toolkit-toggle', value: info.casts });
            castsRow.append(castsLabel);
            castsRow.append(castsToggle);
            lightBox.append(castsRow);
            tooltips.register(castsLabel, tips.casts, 'right');
            tooltips.register(castsToggle, tips.casts, 'bottom');
            castsToggle.on('change', (value: boolean) => events.invoke('toolkit.studio.setCasts', target, value));
        }

        const actionRow = new Container({ class: 'toolkit-row' });
        if (info.lights.length) {
            const aimHere = new Button({ text: info.subject ? 'Lights aim here' : 'Aim lights here', class: 'toolkit-button' });
            aimHere.enabled = !info.subject;
            aimHere.on('click', () => events.invoke('toolkit.studio.aimHere', target));
            tooltips.register(aimHere, tips.aimHere, 'bottom');
            actionRow.append(aimHere);
        }
        const openLighting = new Button({ text: 'Lighting panel…', class: 'toolkit-button' });
        openLighting.on('click', () => events.invoke('toolkit.studio.openPanel'));
        tooltips.register(openLighting, 'Open the studio lighting panel: add single lights, the environment and the bake quality.', 'bottom');
        actionRow.append(openLighting);
        lightBox.append(actionRow);
    };

    // what the inspector calls the selected mesh
    const kindLabel = (p: MeshPrimitive) => {
        if (p.generator) return { tree: 'Tree', grass: 'Grass', rocks: 'Rocks' }[p.generator.type] ?? 'Model';
        if (p.kind === 'plane') return p.getState().rotation[0] !== 0 ? 'Wall' : 'Plane';
        return p.kind[0].toUpperCase() + p.kind.slice(1);
    };

    let uiUpdating = false;
    const updateEditor = () => {
        if (!selected) {
            events.invoke('toolkit.inspector.hide', 'mesh');
            return;
        }
        events.invoke('toolkit.inspector.show', 'mesh', { title: selected.name, kind: kindLabel(selected), content: editor });
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

        paintBox.hidden = !selected.paintable;
        const g = state.gradient ?? null;
        const pic = state.texture ?? null;
        opacity.value = state.opacity ?? 1;
        gradientToggle.value = !!g;
        gradientBox.hidden = !g;
        swapButton.hidden = !g;
        const shown = g ?? defaultGradient();
        endColor.value = shown.color;
        endOpacity.value = shown.opacity;
        gradientType.value = shown.type;
        gradientSpace.value = shown.space;
        angleRow.hidden = shown.type === 'radial';
        angle.value = shown.angle;
        from.value = shown.start;
        to.value = shown.end;
        balance.value = shown.balance;
        smoothToggle.value = shown.smooth;
        const css = gradientCss({ color: state.color, opacity: state.opacity ?? 1, gradient: g, texture: null });
        const layer = g ? css : `linear-gradient(${css}, ${css})`;
        gradientPreview.dom.style.background = `${layer}, repeating-conic-gradient(#7a7a7a 0% 25%, #b4b4b4 0% 50%) 50% / 10px 10px`;
        pictureName.text = pic ? pic.name : 'None';
        pictureRemove.hidden = !pic;
        pictureBox.hidden = !pic;
        if (pic) {
            tiling.value = pic.tiling;
            offset.value = pic.offset;
            turn.value = pic.rotation;
            wrap.value = pic.wrap;
        }
        farToggle.value = events.invoke('toolkit.backing') ?? true;
        updateFarHint();
        density.value = state.detail ?? 300;
        updateSplatInfo();
        refreshLighting();
        // title bar summaries, for when a group is folded
        const c = state.color;
        lookSwatch.dom.style.background = `rgb(${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(c[2] * 255)})`;
        surfaceSummary.text = surfaceSelect.options.find(o => o.v === surfaceSelect.value)?.t ?? '';
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
    gizmo.setUniformScale(scaleLocked);

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
        if (primitive) events.invoke('toolkit.inspector.reveal');
        events.fire('toolkit.primitive.selected', selected);
        scene.forceRender = true;
    };

    // lights and settings change through the history: keep the groups current
    events.on('edit.apply', () => {
        if (!selected) return;
        updateSplatInfo();
        refreshLighting();
    });

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
        if (uiUpdating || !selected) return;
        let next: [number, number, number] = [value[0], value[1], value[2]];
        if (scaleLocked) {
            // the size that was changed sets the factor for all three
            const old = selected.getState().scale;
            let axis = 0;
            let most = -1;
            for (let i = 0; i < 3; ++i) {
                const change = Math.abs(value[i] - old[i]) / Math.max(Math.abs(old[i]), 1e-9);
                if (change > most) {
                    most = change;
                    axis = i;
                }
            }
            const factor = Math.abs(old[axis]) > 1e-9 ? value[axis] / old[axis] : 1;
            next = old.map(v => Math.max(0.001, v * factor)) as [number, number, number];
            uiUpdating = true;
            size.input.value = next;
            uiUpdating = false;
        }
        edit(selected, { scale: next });
    });
    colorPicker.on('change', (value: number[]) => {
        if (uiUpdating || !selected) return;
        edit(selected, { color: [value[0], value[1], value[2]] });
        updateEditor();
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

    // ---- paint

    const editGradient = (change: Partial<PaintGradient>) => {
        if (uiUpdating || !selected) return;
        const current = selected.gradient ?? defaultGradient();
        edit(selected, { gradient: { ...current, ...change } });
        updateEditor();
    };
    const editTexture = (change: Partial<PaintTexture>) => {
        if (uiUpdating || !selected || !selected.paintTexture) return;
        edit(selected, { texture: { ...selected.paintTexture, ...change } });
        updateEditor();
    };

    opacity.on('change', (value: number) => {
        if (uiUpdating || !selected) return;
        edit(selected, { opacity: value });
        updateEditor();
    });
    gradientToggle.on('change', (value: boolean) => {
        if (uiUpdating || !selected) return;
        // the first gradient fades the colour out: same colour, no opacity
        const gradient = value ? { ...defaultGradient(), color: [...selected.color] as [number, number, number] } : null;
        edit(selected, { gradient });
        updateEditor();
    });
    swapButton.on('click', () => {
        if (!selected?.gradient) return;
        const g = selected.gradient;
        edit(selected, {
            color: [...g.color] as [number, number, number],
            opacity: g.opacity,
            gradient: { ...g, color: [...selected.color] as [number, number, number], opacity: selected.opacity }
        });
        updateEditor();
    });
    endColor.on('change', (value: number[]) => editGradient({ color: [value[0], value[1], value[2]] }));
    endOpacity.on('change', (value: number) => editGradient({ opacity: value }));
    gradientType.on('change', (value: string) => editGradient({ type: value as PaintGradient['type'] }));
    gradientSpace.on('change', (value: string) => editGradient({ space: value as PaintGradient['space'] }));
    angle.on('change', (value: number) => editGradient({ angle: value }));
    from.on('change', (value: number) => editGradient({ start: value }));
    to.on('change', (value: number) => editGradient({ end: value }));
    balance.on('change', (value: number) => editGradient({ balance: value }));
    smoothToggle.on('change', (value: boolean) => editGradient({ smooth: value }));

    pictureLoad.on('click', () => pictureInput.click());
    pictureInput.addEventListener('change', () => {
        const file = pictureInput.files?.[0];
        pictureInput.value = '';
        const target = selected;
        if (!file || !target) return;
        const reader = new FileReader();
        reader.onload = () => {
            if (!target.scene) return;
            const name = file.name.replace(/\.[^.]+$/, '');
            const previous = target.paintTexture;
            // a new picture keeps the placement of the one it replaces
            const texture = previous ? { ...previous, image: reader.result as string, name } : defaultTexture(reader.result as string, name);
            flushPending();
            events.fire('edit.add', new PrimitiveStateOp(target, target.getState(), { ...target.getState(), texture }));
            if (target === selected) updateEditor();
        };
        reader.readAsDataURL(file);
    });
    pictureRemove.on('click', () => {
        if (!selected) return;
        flushPending();
        events.fire('edit.add', new PrimitiveStateOp(selected, selected.getState(), { ...selected.getState(), texture: null }));
        updateEditor();
    });
    tiling.on('change', (value: number[]) => editTexture({ tiling: [value[0], value[1]] }));
    offset.on('change', (value: number[]) => editTexture({ offset: [value[0], value[1]] }));
    turn.on('change', (value: number) => editTexture({ rotation: value }));
    wrap.on('change', (value: string) => editTexture({ wrap: value as PaintWrap }));

    // scripted access (and tests)
    events.function('toolkit.primitivePaint', (primitive: MeshPrimitive, change: Partial<PrimitiveState>) => {
        flushPending();
        events.fire('edit.add', new PrimitiveStateOp(primitive, primitive.getState(), { ...primitive.getState(), ...change }));
        if (primitive === selected) updateEditor();
    });

    // ---- conversion to a gaussian splat layer

    // the conversion itself (sampling, studio lighting, import, hiding the
    // primitive) lives in the studio lighting module
    const convertToSplat = async (primitive: MeshPrimitive, splatsAlongLongestSide?: number) => {
        flushPending();
        // the lights stay on while other meshes still need them
        const othersVisible = primitives().some(p => p !== primitive && p.entity.enabled);
        return await events.invoke('toolkit.convertPrimitives', [primitive], {
            // by default: the object's own detail
            cell: splatsAlongLongestSide ? cellForDensity(primitive, splatsAlongLongestSide) : undefined,
            hideLights: othersVisible ? false : undefined
        }) as number;
    };

    events.function('toolkit.primitiveToSplat', convertToSplat);

    density.on('change', (value: number) => {
        if (uiUpdating || !selected) return;
        edit(selected, { detail: Math.round(value) });
        updateFarHint();
        updateSplatInfo();
    });
    hideToggle.on('change', (value: boolean) => {
        if (!uiUpdating) events.invoke('toolkit.studio.setHideAfter', value);
    });
    lockButton.on('click', () => {
        scaleLocked = !scaleLocked;
        try {
            localStorage.setItem('supersplat.toolkit.scaleLock', String(scaleLocked));
        } catch {
            // storage unavailable
        }
        showLock();
        gizmo.setUniformScale(scaleLocked);
    });
    farToggle.on('change', (value: boolean) => {
        if (uiUpdating) return;
        events.invoke('toolkit.setBacking', value);
        updateFarHint();
    });

    convert.on('click', async () => {
        if (!selected || !convert.enabled) return;
        convert.enabled = false;
        try {
            await convertToSplat(selected);
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

    // a model made by a generator (vegetation panel). By default it stands on
    // the ground at the camera focus, sized to `height` (its top above the
    // ground) or `longest` (its longest side); `unitScale` keeps the .glb's own
    // units (times the factor). With `anchor` the .glb's origin goes exactly
    // there (a point picked on a surface), turned by `yaw` degrees. `replace`
    // takes the place of an existing model.
    type GeneratedOptions = {
        name: string,
        generator: PrimitiveGenerator,
        height?: number,
        longest?: number,
        unitScale?: number,
        anchor?: [number, number, number],
        yaw?: number,
        replace?: MeshPrimitive | null
    };

    const prepareGeneratedModel = async (glb: ArrayBuffer, options: GeneratedOptions) => {
        const blob = new Blob([glb], { type: 'model/gltf-binary' });
        const dataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.onerror = () => reject(new Error('The model could not be read'));
            reader.readAsDataURL(blob);
        });
        const old = options.replace && options.replace.scene ? options.replace : null;
        const focus = scene.camera.focalPoint;
        const oldState = old?.getState();
        const primitive = new MeshPrimitive({
            kind: 'model',
            name: old ? old.name : `${options.name} ${++counter}`,
            model: dataUrl,
            generator: options.generator,
            position: oldState ? oldState.position : [focus.x, focus.y, focus.z],
            rotation: oldState ? oldState.rotation : [0, options.yaw ?? 0, 0],
            scale: [1, 1, 1],
            color: oldState ? oldState.color : [1, 1, 1],
            visible: true,
            alphaCutoff: 0.5
        });

        // size and place it once its geometry is known
        const added = new Promise<void>((resolve) => {
            const handle = events.on('scene.elementAdded', (element: Element) => {
                if (element !== primitive) return;
                handle.off();
                const half = primitive.localHalf;
                let scale = 1;
                if (old) {
                    // keep the replaced model's height
                    scale = old.localHalf.y * old.getState().scale[1] / Math.max(half.y, 1e-6);
                } else if (options.unitScale) {
                    scale = primitive.modelUnits * options.unitScale;
                } else if (options.height) {
                    scale = options.height / Math.max(2 * half.y, 1e-6);
                } else if (options.longest) {
                    scale = options.longest;
                }
                const state = primitive.getState();
                if (options.anchor && !old) {
                    // the .glb's origin onto the anchor
                    const offset = new Quat().setFromEulerAngles(0, options.yaw ?? 0, 0)
                    .transformVector(primitive.modelOrigin.clone().mulScalar(scale), new Vec3());
                    const [ax, ay, az] = options.anchor;
                    primitive.setState({
                        ...state,
                        position: [ax - offset.x, ay - offset.y, az - offset.z],
                        rotation: [0, options.yaw ?? 0, 0],
                        scale: [scale, scale, scale]
                    });
                } else {
                    let y = state.position[1];
                    if (!old) {
                        // on the floor: the lowest visible primitive, else the focus
                        const others = primitives().filter(p => p !== primitive && p.entity.enabled && p.worldBound);
                        const ground = others.length ? Math.min(...others.map(p => p.worldBound.getMin().y)) : focus.y;
                        y = ground + half.y * scale;
                    }
                    primitive.setState({ ...state, position: [state.position[0], y, state.position[2]], scale: [scale, scale, scale] });
                }
                resolve();
            });
        });

        const op = old ? new MultiOp([new RemovePrimitiveOp(scene, old), new AddPrimitiveOp(scene, primitive)]) : new AddPrimitiveOp(scene, primitive);
        return { primitive, op, added };
    };

    const addGeneratedModel = async (glb: ArrayBuffer, options: GeneratedOptions) => {
        flushPending();
        const { primitive, op, added } = await prepareGeneratedModel(glb, options);
        selectOnAdd = primitive;
        events.fire('edit.add', op);
        await added;
        return primitive;
    };

    // several models in one undo step (a placement stroke)
    events.function('toolkit.addGeneratedModels', async (items: { glb: ArrayBuffer, options: GeneratedOptions }[]) => {
        flushPending();
        const prepared = [];
        for (const item of items) {
            prepared.push(await prepareGeneratedModel(item.glb, item.options));
        }
        if (!prepared.length) return [];
        events.fire('edit.add', prepared.length === 1 ? prepared[0].op : new MultiOp(prepared.map(p => p.op)));
        await Promise.all(prepared.map(p => p.added));
        return prepared.map(p => p.primitive);
    });

    events.function('toolkit.addGeneratedModel', addGeneratedModel);
    events.function('toolkit.selectedPrimitive', () => selected);

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
