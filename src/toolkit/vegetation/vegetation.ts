import { BooleanInput, Button, ColorPicker, Container, Label, SelectInput, SliderInput } from '@playcanvas/pcui';
import { BoundingBox, Vec3 } from 'playcanvas';

import { bladeCount, bladesPerArea, defaultGrass, flowerPalettes, GrassParams, grassGlb, MAX_BLADES, perAreaToFill } from './grass';
import { defaultRocks, RockParams, rocksGlb, speciesNames } from './rocks';
import { barkTypes, defaultTree, leafTypes, presetInfo, TreeParams, treeGlb, treePresets } from './tree';
import { ElementType } from '../../element';
import vegetationSvg from '../icons/vegetation.svg';
import type { ToolkitContext, ToolkitModule } from '../index';
import { collapsible } from '../inspector';
import { LogSlider } from '../log-slider';
import { MeshPrimitive } from '../mesh-primitive';
import { MeshRaycaster } from '../mesh-raycast';
import { headerIcon, registerPanel } from '../panels';
import { createSurfaceProbe } from '../surface-probe';


// Vegetation: procedural trees (EZ-Tree), grass and rocks (SeedRock). All are
// generated as .glb models and placed in the scene like an imported model:
// move, size, light and convert them like any mesh. Grass can also go straight
// to splats: its conversion lays gaussians along the blades.
//
// Placement: besides "Add" (at the camera focus), the place brush puts the
// current kind where you click on a surface (splats or meshes), or several
// along a drag, each with its own shape, size and turn; one stroke is one
// undo step.

const TOOL = 'toolkitPlant';
const MAX_PER_STROKE = 40;

const tips = {
    toggle: 'Vegetation: generate trees, bushes and grass, as models you can light and turn into splats.',
    preset: 'Kind of tree to start from. Every option below adjusts it.',
    seed: 'The tree\'s / field\'s random number: the same number always grows the same shape. Roll the dice for a new one.',
    dice: 'A new random shape.',
    treeHeight: 'Height of a new tree, in scene units.',
    levels: 'How many times branches split into smaller branches (0 = a bare trunk).',
    branching: 'More or fewer branches at every level.',
    gnarliness: 'How crooked and twisted the branches grow.',
    leafCount: 'More or fewer leaves.',
    leafSize: 'Bigger or smaller leaves.',
    leafType: 'Leaf shape and colour texture.',
    barkType: 'Bark texture of the trunk and branches.',
    leafTint: 'Tint over the leaf texture (white = as is), e.g. orange for autumn.',
    barkTint: 'Tint over the bark texture.',
    addTree: 'Generate the tree and put it on the ground at the camera focus.',
    updateTree: 'Regenerate the selected tree with these settings, keeping its place and height.',
    downloadTree: 'Save the tree as a .glb file.',
    brushRadius: 'Radius of the grass brush: a click grows a round patch this big, a drag grows grass along the stroke this wide.',
    grassSize: 'Size of the blades (their height). With the same density, small blades fill a stroke with many blades, big ones with just a few.',
    fullness: 'How close the blades stand, relative to their size: low = a few scattered blades, high = a dense lawn.',
    thickness: 'Blade width, relative to its height: thin grass or broad blades.',
    live: 'Changes apply right away to the grass being edited: the selected patch, or the one you just brushed (each settled change is one undo step).',
    toSplats: 'Turn the grass being edited into splats (with the studio lighting if there are lights).',
    addPatch: 'Grow a round patch (brush radius) at the camera focus.',
    heightVariance: 'How much the blade heights vary: 0 = mown lawn, 1 = wild meadow.',
    bladeWidth: 'Width of a blade at its root.',
    bend: 'How far the blades curve over.',
    wind: 'Direction the blades lean, in degrees.',
    windStrength: 'How uniformly the blades lean with the wind: 0 = every way, 1 = all the same way.',
    clumping: 'Blades gathering in tufts instead of growing evenly.',
    rootColor: 'Colour of the blades near the ground.',
    tipColor: 'Colour of the blade tips.',
    dryness: 'Share of dry, straw coloured blades.',
    flowers: 'Share of flowers among the blades.',
    palette: 'Colours of the flowers.',
    direct: 'Convert this grass as gaussians laid along each blade (looks better, far fewer splats). Off: the grass mesh is sampled like any model.',
    addGrass: 'Generate a grass patch and put it on the ground at the camera focus.',
    addGrassSplats: 'Generate the grass and convert it to splats right away (with the studio lighting if there are lights).',
    updateGrass: 'Regenerate the selected grass patch with these settings, keeping its place.',
    downloadGrass: 'Save the grass as a .glb file.',
    tabs: 'What to generate and place: trees, grass or rocks.',
    place: 'Place by clicking: click on a surface (splats or meshes) to put the current kind there, or drag to place several along the stroke. Press again (or Esc) to stop.',
    spacing: 'Distance between the things placed along a drag, in scene units.',
    scaleVariation: 'Random size difference between placed things (0 = all the same).',
    varyShape: 'Every placed thing gets a new random shape (seed). Off: copies of the current one.',
    randomTurn: 'Every placed thing is turned randomly about the vertical.',
    rockKind: 'Kind of stone (SeedRock species). Basalt grows columns, slate stacks slabs, crystal and ore grow shard clusters, the rest are boulders.',
    rockCount: 'How many rocks in one group: 1 for a single stone, more for a pile or a scatter.',
    rockSize: 'Longest side of an average rock, in scene units.',
    rockSizeVariation: 'How much the rocks of a group differ in size.',
    spread: 'Radius of the group, in rock sizes: small = a tight pile, large = scattered stones.',
    turn: 'Random turn of each rock about the vertical: 0 = all the same way, 1 = any way.',
    tilt: 'Random lean of each rock, in degrees.',
    flatten: 'Squash the rocks flatter (pebbles, flagstones).',
    relief: 'How rugged the surface is: lower = smoother, rounder stones.',
    detail: 'Mesh detail: more = finer shape, more triangles.',
    sink: 'How deep each rock sits in the ground, as a share of its height.',
    tintVariation: 'Colour difference between the rocks of a group.',
    rockTint: 'Tint over the stone texture (white = as is).',
    addRocks: 'Generate the rock(s) and put them on the ground at the camera focus.',
    updateRocks: 'Regenerate the selected rock group with these settings, keeping its place.',
    downloadRocks: 'Save the rock(s) as a .glb file.'
};

const init = (ctx: ToolkitContext) => {
    const { events, scene, canvasContainer, tooltips } = ctx;

    const primitives = () => scene.getElementsByType(ElementType.model).filter((e): e is MeshPrimitive => e instanceof MeshPrimitive);

    // a sensible size for new plants: the visible meshes, the splats, or 2 units
    const sceneSize = () => {
        const visible = primitives().filter(p => p.entity.enabled && !p.generator && p.worldBound);
        if (visible.length) {
            const b = new BoundingBox();
            b.copy(visible[0].worldBound);
            visible.slice(1).forEach(p => b.add(p.worldBound));
            return Math.max(0.1, Math.max(b.halfExtents.x, b.halfExtents.z) * 2);
        }
        if (scene.getElementsByType(ElementType.splat).length) {
            return Math.max(0.1, scene.bound.halfExtents.length());
        }
        return 2;
    };

    let tree: TreeParams = defaultTree();
    let treeHeight = 2;
    let rocks: RockParams = defaultRocks();
    // placement brush settings
    let placeSpacing = 1;
    let placeScaleVariation = 0.2;
    let grass: GrassParams = { ...defaultGrass(2), direct: true };
    let brushRadius = 0.3;
    let uiUpdating = false;
    // declared up front: the ui helpers refer to each other
    let updateGrassCount: () => void = () => {};
    let updateButtons: () => void = () => {};

    // ---- panel

    const panel = new Container({ id: 'toolkit-vegetation-panel', class: 'panel' });
    ['pointerdown', 'pointerup', 'pointermove', 'wheel', 'dblclick'].forEach((eventName) => {
        panel.dom.addEventListener(eventName, (event: Event) => event.stopPropagation());
    });
    const header = new Container({ class: 'panel-header' });
    header.append(headerIcon(vegetationSvg));
    header.append(new Label({ text: 'Vegetation', class: 'panel-header-label' }));
    panel.append(header);
    const body = new Container({ class: 'toolkit-lighting-body' });
    panel.append(body);

    // the helpers below add to `target`: the panel body or a tab's page
    let target: Container = body;
    const section = (title: string) => target.append(new Label({ text: title, class: 'toolkit-section' }));
    const hint = (text = '') => new Label({ text, class: 'toolkit-hint' });
    const row = (labelText: string, tip: string) => {
        const r = new Container({ class: 'toolkit-row' });
        const label = new Label({ text: labelText, class: 'toolkit-label' });
        r.append(label);
        tooltips.register(label, tip, 'left');
        target.append(r);
        return r;
    };
    const slider = (labelText: string, tip: string, min: number, max: number, precision: number, step?: number) => {
        const r = row(labelText, tip);
        const s = new SliderInput({ class: 'toolkit-slider', min, max, precision, step: step ?? Math.pow(10, -precision), value: min });
        r.append(s);
        tooltips.register(s, tip, 'bottom');
        return s;
    };
    // sizes and distances: a logarithmic track, its range set from the scene
    const logSlider = (labelText: string, tip: string, min: number, max: number) => {
        const r = row(labelText, tip);
        const s = new LogSlider(min, max, min);
        r.append(s);
        tooltips.register(s, tip, 'bottom');
        return s;
    };
    const select = (labelText: string, tip: string, options: { v: string, t: string }[]) => {
        const r = row(labelText, tip);
        const s = new SelectInput({ class: 'toolkit-select', type: 'string', options, value: options[0].v });
        r.append(s);
        return s;
    };
    const color = (labelText: string, tip: string) => {
        const r = row(labelText, tip);
        const c = new ColorPicker({ class: 'toolkit-color', value: [1, 1, 1] });
        r.append(c);
        tooltips.register(c, tip, 'bottom');
        return c;
    };
    const buttons = (items: [string, string][]) => {
        const r = new Container({ class: 'toolkit-row' });
        const result = items.map(([text, tip]) => {
            const b = new Button({ text, class: 'toolkit-button' });
            r.append(b);
            tooltips.register(b, tip, 'bottom');
            return b;
        });
        target.append(r);
        return result;
    };
    const seedRow = (tip: string) => {
        const r = row('Seed', tip);
        const s = new SliderInput({ class: 'toolkit-slider', min: 1, max: 9999, precision: 0, step: 1, value: 1 });
        const dice = new Button({ text: '🎲', class: 'toolkit-convert' });
        r.append(s);
        r.append(dice);
        tooltips.register(dice, tips.dice, 'bottom');
        return { s, dice };
    };

    // tabs: one kind at a time
    type Kind = 'tree' | 'grass' | 'rocks';
    let kind: Kind = 'tree';
    const tabRow = new Container({ class: ['toolkit-row', 'toolkit-tabs'] });
    const tabButtons = new Map<Kind, Button>();
    ([['tree', 'Trees'], ['grass', 'Grass'], ['rocks', 'Rocks']] as [Kind, string][]).forEach(([k, text]) => {
        const b = new Button({ text, class: 'toolkit-button' });
        tabRow.append(b);
        tooltips.register(b, tips.tabs, 'bottom');
        tabButtons.set(k, b);
    });
    body.append(tabRow);

    // placement brush, for whichever kind is shown
    section('Place');
    const [placeButton] = buttons([['Place by clicking', tips.place]]);
    const grassBrush = new Container();
    body.append(grassBrush);
    target = grassBrush;
    const brush = logSlider('Brush radius', tips.brushRadius, 0.01, 2);
    const placeOptions = new Container();
    body.append(placeOptions);
    target = placeOptions;
    const spacing = logSlider('Spacing', tips.spacing, 0.01, 4);
    const scaleVariation = slider('Size var.', tips.scaleVariation, 0, 0.8, 2, 0.01);
    const varyRow = row('New shapes', tips.varyShape);
    const varyShape = new BooleanInput({ type: 'toggle', value: true });
    varyRow.append(varyShape);
    tooltips.register(varyShape, tips.varyShape, 'bottom');
    const turnRow = row('Random turn', tips.randomTurn);
    const randomTurn = new BooleanInput({ type: 'toggle', value: true });
    turnRow.append(randomTurn);
    tooltips.register(randomTurn, tips.randomTurn, 'bottom');
    target = body;
    const placeStatus = hint('Click on the scene to put one, drag to place several.');
    body.append(placeStatus);

    const treePage = new Container({ class: 'toolkit-veg-page' });
    const grassPage = new Container({ class: 'toolkit-veg-page' });
    const rockPage = new Container({ class: 'toolkit-veg-page' });
    body.append(treePage);
    body.append(grassPage);
    body.append(rockPage);

    // tree
    target = treePage;
    target.append(hint('Trees by EZ-Tree (Daniel Greenheck, MIT). Generated plants are models: move, light and convert them like any mesh.'));
    section('Tree');
    const preset = select('Kind', tips.preset, treePresets.map(p => ({ v: p, t: p })));
    const treeSeed = seedRow(tips.seed);
    const height = logSlider('Height', tips.treeHeight, 0.05, 10);
    const levels = slider('Branches', tips.levels, 0, 3, 0, 1);
    const branching = slider('Branching', tips.branching, 0.3, 2, 2, 0.01);
    const gnarliness = slider('Crooked', tips.gnarliness, 0, 3, 2, 0.01);
    const leafCount = slider('Leaves', tips.leafCount, 0, 3, 2, 0.01);
    const leafSize = slider('Leaf size', tips.leafSize, 0.3, 3, 2, 0.01);
    const leafType = select('Leaf type', tips.leafType, [{ v: '', t: 'From the kind' }, ...leafTypes.map(t => ({ v: t, t }))]);
    const barkType = select('Bark', tips.barkType, [{ v: '', t: 'From the kind' }, ...barkTypes.map(t => ({ v: t, t }))]);
    const leafTint = color('Leaf tint', tips.leafTint);
    const barkTint = color('Bark tint', tips.barkTint);
    const [addTree, updateTree, downloadTree] = buttons([['Add tree', tips.addTree], ['Update selected', tips.updateTree], ['Download .glb', tips.downloadTree]]);
    const treeStatus = hint();
    treePage.append(treeStatus);

    // grass: the main controls, then folding groups for the rest
    target = grassPage;
    section('Grass');
    const grassSize = logSlider('Size', tips.grassSize, 0.004, 0.5);
    const fullness = slider('Density', tips.fullness, 0, 1, 2, 0.01);
    const heightVariance = slider('Variance', tips.heightVariance, 0, 1, 2, 0.01);
    const bend = slider('Bend', tips.bend, 0, 1, 2, 0.01);
    const thickness = logSlider('Thickness', tips.thickness, 0.008, 0.25);
    const clumping = slider('Tufts', tips.clumping, 0, 1, 2, 0.01);
    const grassSeed = seedRow(tips.seed);
    const grassGroup = (title: string, id: string, open: boolean) => {
        const g = collapsible(title, `vegetation.grass.${id}`, open);
        grassPage.append(g.root);
        target = g.body;
        return g;
    };
    grassGroup('Colour', 'colour', true);
    const rootColor = color('Root colour', tips.rootColor);
    const tipColor = color('Tip colour', tips.tipColor);
    const dryness = slider('Dry blades', tips.dryness, 0, 1, 2, 0.01);
    const windGroup = grassGroup('Wind', 'wind', false);
    const wind = slider('Direction', tips.wind, 0, 360, 0, 1);
    const windStrength = slider('Lean', tips.windStrength, 0, 1, 2, 0.01);
    const flowerGroup = grassGroup('Flowers', 'flowers', false);
    const flowers = slider('Amount', tips.flowers, 0, 1, 2, 0.01);
    const palette = select('Colours', tips.palette, Object.keys(flowerPalettes).map(k => ({ v: k, t: k[0].toUpperCase() + k.slice(1) })));
    target = grassPage;
    const grassCount = hint();
    grassPage.append(grassCount);
    const liveRow = row('Live edit', tips.live);
    const liveGrass = new BooleanInput({ type: 'toggle', class: 'toolkit-toggle', value: true });
    liveRow.append(liveGrass);
    tooltips.register(liveGrass, tips.live, 'bottom');
    const liveStatus = hint();
    grassPage.append(liveStatus);
    const [addGrass, addGrassSplats, downloadGrass] = buttons([['Add patch', tips.addPatch], ['To splats', tips.toSplats], ['Download .glb', tips.downloadGrass]]);

    // rocks
    target = rockPage;
    target.append(hint('Rocks by SeedRock (reed-soul, MIT). One rock or a whole group per placement.'));
    section('Rocks');
    const rockKind = select('Kind', tips.rockKind, speciesNames.map(n => ({ v: n.key, t: n.name })));
    const rockSeed = seedRow(tips.seed);
    const rockCount = slider('Count', tips.rockCount, 1, 50, 0, 1);
    const rockSize = logSlider('Size', tips.rockSize, 0.005, 2);
    const rockSizeVariation = slider('Size var.', tips.rockSizeVariation, 0, 1, 2, 0.01);
    const spread = slider('Spread', tips.spread, 0.5, 8, 2, 0.01);
    const turn = slider('Turn', tips.turn, 0, 1, 2, 0.01);
    const tilt = slider('Tilt', tips.tilt, 0, 90, 0, 1);
    const flatten = slider('Flatten', tips.flatten, 0, 1, 2, 0.01);
    const relief = slider('Relief', tips.relief, 0, 2, 2, 0.01);
    const detail = slider('Detail', tips.detail, 2, 5, 0, 1);
    const sink = slider('Sink', tips.sink, 0, 0.5, 2, 0.01);
    const tintVariation = slider('Colour var.', tips.tintVariation, 0, 1, 2, 0.01);
    const rockTint = color('Tint', tips.rockTint);
    const [addRocks, updateRocks, downloadRocks] = buttons([['Add rocks', tips.addRocks], ['Update selected', tips.updateRocks], ['Download .glb', tips.downloadRocks]]);
    const rockStatus = hint();
    rockPage.append(rockStatus);
    target = body;

    canvasContainer.append(panel);

    registerPanel(ctx, {
        id: 'vegetation',
        panel,
        header,
        icon: vegetationSvg,
        title: 'Vegetation',
        tooltip: tips.toggle,
        order: 2.5,
        // placing needs the panel's settings
        onHide: () => {
            if (ctx.toolManager.active === TOOL) ctx.toolManager.activate(null);
        }
    });

    // ---- ui <-> params

    const updateUI = () => {
        uiUpdating = true;
        preset.value = tree.preset;
        treeSeed.s.value = tree.seed;
        height.value = treeHeight;
        levels.value = tree.levels;
        branching.value = tree.branching;
        gnarliness.value = tree.gnarliness;
        leafCount.value = tree.leafCount;
        leafSize.value = tree.leafSize;
        leafType.value = tree.leafType;
        barkType.value = tree.barkType;
        leafTint.value = tree.leafTint;
        barkTint.value = tree.barkTint;

        grassSeed.s.value = grass.seed;
        grassSize.value = grass.height;
        fullness.value = grass.fill ?? 0.68;
        heightVariance.value = grass.heightVariance;
        thickness.value = grass.thickness ?? 0.035;
        bend.value = grass.bend;
        wind.value = grass.windAngle;
        windStrength.value = grass.windStrength;
        clumping.value = grass.clumping;
        rootColor.value = grass.rootColor;
        tipColor.value = grass.tipColor;
        dryness.value = grass.dryness;
        flowers.value = grass.flowerAmount ?? 0;
        palette.value = grass.flowerPalette;
        brush.value = brushRadius;
        windGroup.extra.dom.textContent = `${Math.round(grass.windAngle)}°`;
        flowerGroup.extra.dom.textContent = (grass.flowerAmount ?? 0) > 0 ? `${Math.round((grass.flowerAmount ?? 0) * 100)}%` : 'none';

        rockKind.value = rocks.species;
        rockSeed.s.value = rocks.seed;
        rockCount.value = rocks.count;
        rockSize.value = rocks.size;
        rockSizeVariation.value = rocks.sizeVariation;
        spread.value = rocks.spread;
        turn.value = rocks.turn;
        tilt.value = rocks.tilt;
        flatten.value = rocks.flatten;
        relief.value = rocks.roughness;
        detail.value = rocks.detail;
        sink.value = rocks.sink;
        tintVariation.value = rocks.tintVariation;
        rockTint.value = rocks.tint;

        spacing.value = placeSpacing;
        scaleVariation.value = placeScaleVariation;
        tabButtons.forEach((b, k) => b.class[k === kind ? 'add' : 'remove']('active'));
        treePage.hidden = kind !== 'tree';
        grassBrush.hidden = kind !== 'grass';
        placeOptions.hidden = kind === 'grass';
        grassPage.hidden = kind !== 'grass';
        rockPage.hidden = kind !== 'rocks';
        uiUpdating = false;
        updateGrassCount();
        updateButtons();
    };

    updateGrassCount = () => {
        // per brush dab (a round patch of the brush radius)
        const perArea = bladesPerArea(grass);
        const dab = Math.round(perArea * Math.PI * brushRadius * brushRadius);
        grassCount.text = `≈ ${dab.toLocaleString()} blades per click (${Math.round(perArea).toLocaleString()} per square unit), about 4 splats per blade.${dab > MAX_BLADES ? ` A patch holds at most ${MAX_BLADES.toLocaleString()} blades: bigger blades or a lower density for this brush.` : ''}`;
    };

    const onTree = (change: Partial<TreeParams>) => {
        if (!uiUpdating) tree = { ...tree, ...change };
    };
    let grassChanged: () => void = () => {};
    const onGrass = (change: Partial<GrassParams>) => {
        if (uiUpdating) return;
        grass = { ...grass, ...change };
        updateGrassCount();
        grassChanged();
    };
    const rgb = (v: number[]) => [v[0], v[1], v[2]] as [number, number, number];

    preset.on('change', async (value: string) => {
        if (uiUpdating) return;
        tree = { ...tree, preset: value, leafType: '', barkType: '' };
        // take over the kind's own branch levels and tints
        try {
            const info = await presetInfo(value);
            tree = { ...tree, levels: info.levels, leafTint: info.leafTint, barkTint: info.barkTint };
        } catch (error) {
            console.warn(error);
        }
        updateUI();
    });
    treeSeed.s.on('change', (v: number) => onTree({ seed: Math.round(v) }));
    treeSeed.dice.on('click', () => {
        tree = { ...tree, seed: 1 + Math.floor(Math.random() * 9998) };
        updateUI();
    });
    height.on('change', (v: number) => {
        if (!uiUpdating) treeHeight = v;
    });
    levels.on('change', (v: number) => onTree({ levels: v }));
    branching.on('change', (v: number) => onTree({ branching: v }));
    gnarliness.on('change', (v: number) => onTree({ gnarliness: v }));
    leafCount.on('change', (v: number) => onTree({ leafCount: v }));
    leafSize.on('change', (v: number) => onTree({ leafSize: v }));
    leafType.on('change', (v: string) => onTree({ leafType: v }));
    barkType.on('change', (v: string) => onTree({ barkType: v }));
    leafTint.on('change', (v: number[]) => onTree({ leafTint: rgb(v) }));
    barkTint.on('change', (v: number[]) => onTree({ barkTint: rgb(v) }));

    grassSeed.s.on('change', (v: number) => onGrass({ seed: Math.round(v) }));
    grassSeed.dice.on('click', () => {
        grass = { ...grass, seed: 1 + Math.floor(Math.random() * 9998) };
        updateUI();
        grassChanged();
    });
    grassSize.on('change', (v: number) => onGrass({ height: v, bladeWidth: v * (grass.thickness ?? 0.035) }));
    fullness.on('change', (v: number) => onGrass({ fill: v }));
    heightVariance.on('change', (v: number) => onGrass({ heightVariance: v }));
    thickness.on('change', (v: number) => onGrass({ thickness: v, bladeWidth: grass.height * v }));
    bend.on('change', (v: number) => onGrass({ bend: v }));
    wind.on('change', (v: number) => {
        onGrass({ windAngle: v });
        windGroup.extra.dom.textContent = `${Math.round(v)}°`;
    });
    windStrength.on('change', (v: number) => onGrass({ windStrength: v }));
    clumping.on('change', (v: number) => onGrass({ clumping: v }));
    rootColor.on('change', (v: number[]) => onGrass({ rootColor: rgb(v) }));
    tipColor.on('change', (v: number[]) => onGrass({ tipColor: rgb(v) }));
    dryness.on('change', (v: number) => onGrass({ dryness: v }));
    flowers.on('change', (v: number) => {
        onGrass({ flowerAmount: v });
        flowerGroup.extra.dom.textContent = v > 0 ? `${Math.round(v * 100)}%` : 'none';
    });
    palette.on('change', (v: string) => onGrass({ flowerPalette: v }));
    brush.on('change', (v: number) => {
        if (uiUpdating) return;
        brushRadius = v;
        updateGrassCount();
        // the cursor ring follows on the next frame
        scene.forceRender = true;
        grassChanged();
    });

    // ---- generation

    const selectedGenerated = (type: 'tree' | 'grass' | 'rocks') => {
        const p = events.invoke('toolkit.selectedPrimitive') as MeshPrimitive | null;
        return p && p.generator?.type === type ? p : null;
    };

    updateButtons = () => {
        updateTree.enabled = !!selectedGenerated('tree');
        updateRocks.enabled = !!selectedGenerated('rocks');
    };

    // show a generated plant's settings when it is selected
    events.on('toolkit.primitive.selected', (p: MeshPrimitive | null) => {
        if (p?.generator?.type === 'tree') {
            tree = { ...defaultTree(), ...p.generator.params };
            updateUI();
        } else if (p?.generator?.type === 'grass') {
            grass = normalizeGrass({ ...grass, ...p.generator.params });
            if (p.generator.params.area) brushRadius = p.generator.params.area.radius;
            updateUI();
            updateLiveStatus();
        } else if (p?.generator?.type === 'rocks') {
            rocks = { ...defaultRocks(), ...p.generator.params };
            updateUI();
        }
        updateButtons();
    });

    const busy = async <T>(text: string, work: () => Promise<T>) => {
        events.fire('startSpinner');
        [addTree, updateTree, downloadTree, addGrass, addGrassSplats, downloadGrass, addRocks, updateRocks, downloadRocks].forEach((b) => {
            b.enabled = false;
        });
        await new Promise((resolve) => {
            setTimeout(resolve, 30);
        });
        try {
            return await work();
        } catch (error) {
            await events.invoke('showPopup', { type: 'error', header: text, message: (error as Error).message ?? String(error) });
            return null;
        } finally {
            events.fire('stopSpinner');
            [addTree, downloadTree, addGrass, addGrassSplats, downloadGrass, addRocks, downloadRocks].forEach((b) => {
                b.enabled = true;
            });
            updateButtons();
        }
    };

    const download = (glb: ArrayBuffer, filename: string) => {
        const url = URL.createObjectURL(new Blob([glb], { type: 'model/gltf-binary' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    };

    const makeTree = async () => {
        const start = performance.now();
        const result = await treeGlb(tree);
        treeStatus.text = `${Math.round(result.triangles).toLocaleString()} triangles, generated in ${((performance.now() - start) / 1000).toFixed(1)} s.`;
        return result.glb;
    };

    addTree.on('click', () => busy('Tree', async () => {
        const glb = await makeTree();
        await events.invoke('toolkit.addGeneratedModel', glb, {
            name: tree.preset,
            generator: { type: 'tree', params: { ...tree } },
            height: treeHeight
        });
    }));
    updateTree.on('click', () => busy('Tree', async () => {
        const target = selectedGenerated('tree');
        if (!target) return;
        const glb = await makeTree();
        await events.invoke('toolkit.addGeneratedModel', glb, {
            name: tree.preset,
            generator: { type: 'tree', params: { ...tree } },
            replace: target
        });
    }));
    downloadTree.on('click', () => busy('Tree', async () => {
        download(await makeTree(), `${tree.preset.replace(/\s+/g, '_').toLowerCase()}_${tree.seed}.glb`);
    }));

    // ---- grass: brushed patches, edited live

    // grass made before brushing: its absolute amounts as the relative ones
    function normalizeGrass(p: GrassParams): GrassParams {
        const out = { ...p };
        if (out.fill === undefined) out.fill = perAreaToFill(bladesPerArea(p), p.height);
        if (out.thickness === undefined) out.thickness = p.bladeWidth / Math.max(1e-9, p.height);
        if (out.flowerAmount === undefined) out.flowerAmount = Math.min(1, p.flowers * p.width * p.depth / Math.max(1, bladeCount(p)) / 0.15);
        return out;
    }

    // a stroke is one patch; patches of a stroke are found again by its id
    // (an undo brings back the earlier version of it, with the same id)
    let lastStroke = '';
    const grassPatches = () => primitives().filter(p => p.generator?.type === 'grass');
    const liveTarget = (): MeshPrimitive | null => {
        const selectedGrass = selectedGenerated('grass');
        if (selectedGrass) return selectedGrass;
        return lastStroke ? grassPatches().find(p => p.generator.params.stroke === lastStroke) ?? null : null;
    };
    function updateLiveStatus() {
        const t = liveTarget();
        liveStatus.text = t ? `Editing ${t.name}${liveGrass.value ? ': changes apply as you go.' : '.'}` : 'Brush some grass (Place by clicking), or select a patch, to edit it here.';
        addGrassSplats.enabled = !!t;
    }

    // the params a patch is regenerated with: the panel's, its own area
    const paramsFor = (patch: MeshPrimitive): GrassParams => {
        const own = patch.generator.params as GrassParams;
        const area = own.area ? { ...own.area, radius: brushRadius } : undefined;
        return { ...grass, area, width: own.width, depth: own.depth, stroke: (own as any).stroke } as GrassParams;
    };

    let regenerating = false;
    let regenerateAgain = false;
    let liveTimer = 0;
    const regenerate = async () => {
        const patch = liveTarget();
        if (!patch) return;
        if (regenerating) {
            regenerateAgain = true;
            return;
        }
        regenerating = true;
        liveStatus.text = `Updating ${patch.name}…`;
        try {
            const params = paramsFor(patch);
            const { glb } = await grassGlb(params);
            const options = { name: 'Grass', generator: { type: 'grass', params }, unitScale: 1, replace: patch };
            const wasSelected = events.invoke('toolkit.selectedPrimitive') === patch;
            if (wasSelected) {
                await events.invoke('toolkit.addGeneratedModel', glb, options);
            } else {
                await events.invoke('toolkit.addGeneratedModels', [{ glb, options }]);
            }
        } catch (error) {
            await events.invoke('showPopup', { type: 'error', header: 'Grass', message: (error as Error).message ?? String(error) });
        } finally {
            regenerating = false;
            updateLiveStatus();
            if (regenerateAgain) {
                regenerateAgain = false;
                regenerate();
            }
        }
    };
    grassChanged = () => {
        if (!liveGrass.value || !liveTarget()) return;
        window.clearTimeout(liveTimer);
        liveTimer = window.setTimeout(regenerate, 350);
    };
    liveGrass.on('change', updateLiveStatus);

    // a new patch: the stroke's points (world) relative to the first one
    const addGrassPatch = async (points: Vec3[]) => {
        const origin = points[0];
        // keep the stroke light: points a third of the radius apart at most
        const kept: number[] = [];
        let last: Vec3 | null = null;
        points.forEach((p, i) => {
            if (!last || p.distance(last) >= brushRadius * 0.33 || i === points.length - 1) {
                if (kept.length < 3 * 600) kept.push(p.x - origin.x, p.y - origin.y, p.z - origin.z);
                last = p;
            }
        });
        const stroke = `s${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
        const params = { ...grass, area: { points: kept, radius: brushRadius }, stroke } as GrassParams;
        const { glb, blades } = await grassGlb(params);
        await events.invoke('toolkit.addGeneratedModels', [{
            glb,
            options: { name: 'Grass', generator: { type: 'grass', params }, unitScale: 1, anchor: [origin.x, origin.y, origin.z], yaw: 0 }
        }]);
        lastStroke = stroke;
        updateLiveStatus();
        return blades;
    };

    addGrass.on('click', () => busy('Grass', async () => {
        const focus = scene.camera.focalPoint;
        const floor = primitives().filter(p => p.entity.enabled && p.worldBound && !p.generator);
        const y = floor.length ? Math.min(...floor.map(p => p.worldBound.getMin().y)) : focus.y;
        await addGrassPatch([new Vec3(focus.x, y, focus.z)]);
    }));
    addGrassSplats.on('click', () => busy('Grass', async () => {
        const patch = liveTarget();
        if (patch) await events.invoke('toolkit.convertPrimitives', [patch], { hideLights: false });
    }));
    downloadGrass.on('click', () => busy('Grass', async () => {
        const patch = liveTarget();
        download((await grassGlb(patch ? paramsFor(patch) : { ...grass, area: { points: [0, 0, 0], radius: brushRadius } })).glb, `grass_${grass.seed}.glb`);
    }));

    // ---- rocks

    const onRocks = (change: Partial<RockParams>) => {
        if (!uiUpdating) rocks = { ...rocks, ...change };
    };
    rockKind.on('change', (v: string) => onRocks({ species: v }));
    rockSeed.s.on('change', (v: number) => onRocks({ seed: Math.round(v) }));
    rockSeed.dice.on('click', () => {
        rocks = { ...rocks, seed: 1 + Math.floor(Math.random() * 9998) };
        updateUI();
    });
    rockCount.on('change', (v: number) => onRocks({ count: Math.round(v) }));
    rockSize.on('change', (v: number) => onRocks({ size: v }));
    rockSizeVariation.on('change', (v: number) => onRocks({ sizeVariation: v }));
    spread.on('change', (v: number) => onRocks({ spread: v }));
    turn.on('change', (v: number) => onRocks({ turn: v }));
    tilt.on('change', (v: number) => onRocks({ tilt: v }));
    flatten.on('change', (v: number) => onRocks({ flatten: v }));
    relief.on('change', (v: number) => onRocks({ roughness: v }));
    detail.on('change', (v: number) => onRocks({ detail: Math.round(v) }));
    sink.on('change', (v: number) => onRocks({ sink: v }));
    tintVariation.on('change', (v: number) => onRocks({ tintVariation: v }));
    rockTint.on('change', (v: number[]) => onRocks({ tint: rgb(v) }));

    const makeRocks = async (params: RockParams) => {
        const start = performance.now();
        const result = await rocksGlb(params);
        rockStatus.text = `${params.count} ${params.count === 1 ? 'rock' : 'rocks'}, ${Math.round(result.triangles).toLocaleString()} triangles, generated in ${((performance.now() - start) / 1000).toFixed(1)} s.`;
        return result.glb;
    };
    const rockName = () => speciesNames.find(n => n.key === rocks.species)?.name.replace(/\s*\(.*\)$/, '') ?? 'Rock';

    addRocks.on('click', () => busy('Rocks', async () => {
        const focus = scene.camera.focalPoint;
        // stand on the floor under the focus: the lowest visible mesh, else the focus
        const floor = primitives().filter(p => p.entity.enabled && p.worldBound);
        const y = floor.length ? Math.min(...floor.map(p => p.worldBound.getMin().y)) : focus.y;
        await events.invoke('toolkit.addGeneratedModels', [{
            glb: await makeRocks(rocks),
            options: { name: rockName(), generator: { type: 'rocks', params: { ...rocks } }, unitScale: 1, anchor: [focus.x, y, focus.z], yaw: 0 }
        }]);
    }));
    updateRocks.on('click', () => busy('Rocks', async () => {
        const target = selectedGenerated('rocks');
        if (!target) return;
        await events.invoke('toolkit.addGeneratedModel', await makeRocks(rocks), {
            name: rockName(),
            generator: { type: 'rocks', params: { ...rocks } },
            replace: target
        });
    }));
    downloadRocks.on('click', () => busy('Rocks', async () => {
        download(await makeRocks(rocks), `${rocks.species}_${rocks.seed}.glb`);
    }));

    // ---- placement brush

    // footprint of one placed thing, for the spacing and the cursor ring
    const footprint = () => {
        if (kind === 'tree') return treeHeight * 0.35;
        if (kind === 'grass') return brushRadius;
        return rocks.count > 1 ? rocks.size * (rocks.spread + 0.5) : rocks.size * 0.5;
    };
    const defaultSpacing = () => Math.max(0.01, footprint() * 2);

    // ---- tabs

    tabButtons.forEach((b, k) => b.on('click', () => {
        kind = k;
        placeSpacing = defaultSpacing();
        updateUI();
    }));


    spacing.on('change', (v: number) => {
        if (!uiUpdating) placeSpacing = v;
    });
    scaleVariation.on('change', (v: number) => {
        if (!uiUpdating) placeScaleVariation = v;
    });

    const parent = ctx.toolsContainer.dom;
    // trees and grass are not something to place things onto
    const raycaster = new MeshRaycaster(scene, events, p => !p.generator || p.generator.type === 'rocks');
    const { probe, resample } = createSurfaceProbe(scene, raycaster);

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.classList.add('tool-svg', 'hidden');
    svg.id = 'toolkit-plant-svg';
    const ring = document.createElementNS(svg.namespaceURI, 'polygon') as SVGPolygonElement;
    const strokeLine = document.createElementNS(svg.namespaceURI, 'polyline') as SVGPolylineElement;
    const dot = document.createElementNS(svg.namespaceURI, 'circle') as SVGCircleElement;
    dot.setAttribute('r', '4');
    svg.appendChild(ring);
    svg.appendChild(strokeLine);
    svg.appendChild(dot);
    parent.appendChild(svg);

    let placing = false;
    let ringAt: Vec3 | null = null;

    const drawRing = () => {
        if (!ringAt) {
            ring.setAttribute('points', '');
            return;
        }
        const width = scene.canvas.clientWidth;
        const height = scene.canvas.clientHeight;
        const radius = footprint();
        const screen = new Vec3();
        const world = new Vec3();
        const camera = scene.camera.mainCamera;
        const pts: string[] = [];
        for (let i = 0; i < 40; ++i) {
            const a = i / 40 * Math.PI * 2;
            world.set(ringAt.x + Math.cos(a) * radius, ringAt.y, ringAt.z + Math.sin(a) * radius);
            if (world.clone().sub(camera.getPosition()).dot(camera.forward) <= 0) {
                ring.setAttribute('points', '');
                return;
            }
            scene.camera.worldToScreen(world, screen);
            pts.push(`${(screen.x * width).toFixed(1)},${(screen.y * height).toFixed(1)}`);
        }
        ring.setAttribute('points', pts.join(' '));
    };
    events.on('postrender', () => {
        if (ringAt && ctx.toolManager.active === TOOL) drawRing();
    });

    let hoverAt: { x: number, y: number } | null = null;
    let hovering = false;
    const hover = async () => {
        if (hovering || placing || !hoverAt) return;
        hovering = true;
        const at = hoverAt;
        try {
            const [hit] = await probe([at], false);
            ringAt = hit ? hit.position.clone() : null;
            drawRing();
        } finally {
            hovering = false;
        }
        if (hoverAt !== at) setTimeout(hover, 60);
    };

    const glbCache = new Map<string, Promise<ArrayBuffer>>();
    const cached = (key: string, make: () => Promise<ArrayBuffer>) => {
        if (!glbCache.has(key)) glbCache.set(key, make());
        const result = glbCache.get(key);
        result.catch(() => glbCache.delete(key));
        return result;
    };

    // put the current kind at each point, one undo step
    const placeAt = async (points: Vec3[]) => {
        const items = [];
        for (let i = 0; i < points.length; ++i) {
            const p = points[i];
            const seedOffset = varyShape.value ? Math.floor(Math.random() * 9000) + 1 : 0;
            const factor = Math.max(0.1, 1 + (Math.random() * 2 - 1) * placeScaleVariation);
            const yaw = randomTurn.value ? Math.random() * 360 : 0;
            const anchor: [number, number, number] = [p.x, p.y, p.z];
            placeStatus.text = `Generating ${i + 1} / ${points.length}…`;
            if (kind === 'tree') {
                const params = { ...tree, seed: (tree.seed + seedOffset) % 9999 || 1 };
                const glb = await cached(`tree:${JSON.stringify(params)}`, async () => (await treeGlb(params)).glb);
                items.push({ glb, options: { name: tree.preset, generator: { type: 'tree', params }, height: treeHeight * factor, anchor, yaw } });
            } else {
                const params = { ...rocks, seed: (rocks.seed + seedOffset) % 9999 || 1 };
                const glb = await cached(`rocks:${JSON.stringify(params)}`, () => rocksGlb(params).then(r => r.glb));
                items.push({ glb, options: { name: rockName(), generator: { type: 'rocks', params }, unitScale: factor, anchor, yaw } });
            }
        }
        if (!items.length) return 0;
        placeStatus.text = 'Adding…';
        await events.invoke('toolkit.addGeneratedModels', items);
        return items.length;
    };

    const placeStroke = async (stroke: { x: number, y: number }[]) => {
        if (placing || !stroke.length) return 0;
        placing = true;
        events.fire('startSpinner');
        try {
            const samples = resample(stroke);
            const hits = await probe(samples, false);
            if (kind === 'grass') {
                const along = hits.filter(h => !!h).map(h => h.position.clone());
                if (!along.length) {
                    placeStatus.text = 'Nothing under the cursor to grow grass on.';
                    return 0;
                }
                placeStatus.text = 'Growing grass…';
                const blades = await addGrassPatch(along);
                placeStatus.text = `Grew ${blades.toLocaleString()} blades. Change the settings to edit them live; Ctrl+Z takes the stroke back.`;
                return 1;
            }
            // points along the stroke, `spacing` apart on the surface
            const points: Vec3[] = [];
            let last: Vec3 | null = null;
            hits.forEach((hit) => {
                if (!hit || points.length >= MAX_PER_STROKE) return;
                if (!last || hit.position.distance(last) >= placeSpacing) {
                    points.push(hit.position.clone());
                    last = hit.position;
                }
            });
            if (!points.length) {
                placeStatus.text = 'Nothing under the cursor to place onto.';
                return 0;
            }
            const n = await placeAt(points);
            const what = kind === 'tree' ? 'tree' : (rocks.count > 1 ? 'rock group' : 'rock');
            placeStatus.text = `Placed ${n} ${what}${n === 1 ? '' : 's'}. Ctrl+Z takes the stroke back.`;
            return n;
        } catch (error) {
            placeStatus.text = '';
            await events.invoke('showPopup', { type: 'error', header: 'Place', message: (error as Error).message ?? String(error) });
            return 0;
        } finally {
            events.fire('stopSpinner');
            placing = false;
        }
    };

    let dragId: number | undefined;
    let stroke: { x: number, y: number }[] = [];
    const drawStroke = () => strokeLine.setAttribute('points', stroke.map(p => `${p.x},${p.y}`).join(' '));

    const pointerdown = (e: PointerEvent) => {
        if (dragId !== undefined || e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        if (placing) return;
        dragId = e.pointerId;
        parent.setPointerCapture(dragId);
        stroke = [{ x: e.offsetX, y: e.offsetY }];
        drawStroke();
    };
    const pointermove = (e: PointerEvent) => {
        dot.setAttribute('cx', `${e.offsetX}`);
        dot.setAttribute('cy', `${e.offsetY}`);
        hoverAt = { x: e.offsetX, y: e.offsetY };
        hover();
        if (dragId === undefined) return;
        e.preventDefault();
        e.stopPropagation();
        const lastPoint = stroke[stroke.length - 1];
        if (Math.hypot(e.offsetX - lastPoint.x, e.offsetY - lastPoint.y) >= 3) {
            stroke.push({ x: e.offsetX, y: e.offsetY });
            drawStroke();
        }
    };
    const endDrag = () => {
        if (dragId !== undefined && parent.hasPointerCapture(dragId)) parent.releasePointerCapture(dragId);
        dragId = undefined;
        strokeLine.setAttribute('points', '');
    };
    const pointerup = (e: PointerEvent) => {
        if (e.pointerId !== dragId) return;
        e.preventDefault();
        e.stopPropagation();
        const finished = stroke;
        endDrag();
        placeStroke(finished);
    };
    const pointercancel = (e: PointerEvent) => {
        if (e.pointerId === dragId) endDrag();
    };
    const pointerleave = () => {
        hoverAt = null;
        ringAt = null;
        drawRing();
    };

    ctx.toolManager.register(TOOL, {
        activate: () => {
            svg.classList.remove('hidden');
            parent.style.display = 'block';
            parent.addEventListener('pointerdown', pointerdown);
            parent.addEventListener('pointermove', pointermove);
            parent.addEventListener('pointerup', pointerup);
            parent.addEventListener('pointercancel', pointercancel);
            parent.addEventListener('pointerleave', pointerleave);
        },
        deactivate: () => {
            endDrag();
            ringAt = null;
            drawRing();
            svg.classList.add('hidden');
            parent.style.display = 'none';
            parent.removeEventListener('pointerdown', pointerdown);
            parent.removeEventListener('pointermove', pointermove);
            parent.removeEventListener('pointerup', pointerup);
            parent.removeEventListener('pointercancel', pointercancel);
            parent.removeEventListener('pointerleave', pointerleave);
        }
    });
    events.on('tool.activated', (name: string | null) => {
        placeButton.class[name === TOOL ? 'add' : 'remove']('active');
        placeButton.text = name === TOOL ? 'Placing - click or drag on the scene' : 'Place by clicking';
    });
    placeButton.on('click', () => {
        if (ctx.toolManager.active === TOOL) ctx.toolManager.activate(null);
        else events.fire(`tool.${TOOL}`);
    });

    events.function('toolkit.vegetation.kind', (k: Kind) => {
        kind = k;
        placeSpacing = defaultSpacing();
        updateUI();
    });
    events.function('toolkit.vegetation.place', placeStroke);
    events.function('toolkit.vegetation.rocks', (change: Partial<RockParams>) => {
        rocks = { ...rocks, ...change };
        updateUI();
    });
    events.function('toolkit.vegetation.placement', (change: { spacing?: number, scaleVariation?: number }) => {
        if (change.spacing !== undefined) placeSpacing = change.spacing;
        if (change.scaleVariation !== undefined) placeScaleVariation = change.scaleVariation;
        updateUI();
    });

    // sizes follow the scene when the panel opens on a new scene
    let sizedFor = -1;
    // slider tracks span what makes sense for a scene of this size
    const applyRanges = (size: number) => {
        brush.setRange(size * 0.004, size * 1.5);
        spacing.setRange(size * 0.005, size * 2);
        height.setRange(size * 0.02, size * 4);
        grassSize.setRange(size * 0.002, size * 0.25);
        rockSize.setRange(size * 0.002, size);
    };
    events.on('toolkit.panel.vegetation.visible', (visible: boolean) => {
        if (!visible) return;
        const size = sceneSize();
        if (Math.abs(size - sizedFor) > 1e-6 && primitives().every(p => !p.generator)) {
            sizedFor = size;
            treeHeight = size * 0.9;
            grass = { ...defaultGrass(size), seed: grass.seed, direct: grass.direct };
            brushRadius = Math.max(0.001, size * 0.08);

            rocks = { ...rocks, size: Math.max(0.01, size * 0.12) };
            placeSpacing = defaultSpacing();
        }
        applyRanges(size);
        updateUI();
    });

    updateUI();
};

const vegetationModule: ToolkitModule = {
    id: 'vegetation',
    init
};


export { vegetationModule };
