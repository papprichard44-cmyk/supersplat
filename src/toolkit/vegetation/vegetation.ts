import { BooleanInput, Button, ColorPicker, Container, Label, SelectInput, SliderInput } from '@playcanvas/pcui';
import { BoundingBox } from 'playcanvas';

import { bladeCount, defaultGrass, flowerPalettes, GrassParams, grassGlb, MAX_BLADES } from './grass';
import { barkTypes, defaultTree, leafTypes, presetInfo, TreeParams, treeGlb, treePresets } from './tree';
import { ElementType } from '../../element';
import vegetationSvg from '../icons/vegetation.svg';
import type { ToolkitContext, ToolkitModule } from '../index';
import { MeshPrimitive } from '../mesh-primitive';
import { headerIcon, registerPanel } from '../panels';


// Vegetation: procedural trees (EZ-Tree) and grass. Both are generated as
// .glb models and placed in the scene like an imported model: move, size,
// light and convert them like any mesh. Grass can also go straight to splats:
// its conversion lays gaussians along the blades.

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
    width: 'Size of the grass patch along X, in scene units.',
    depth: 'Size of the grass patch along Z, in scene units.',
    density: 'Blades per square unit. Denser grass looks lusher but makes more splats.',
    bladeHeight: 'Height of the blades.',
    heightVariance: 'How much the blade heights vary: 0 = mown lawn, 1 = wild meadow.',
    bladeWidth: 'Width of a blade at its root.',
    bend: 'How far the blades curve over.',
    wind: 'Direction the blades lean, in degrees.',
    windStrength: 'How uniformly the blades lean with the wind: 0 = every way, 1 = all the same way.',
    clumping: 'Blades gathering in tufts instead of growing evenly.',
    rootColor: 'Colour of the blades near the ground.',
    tipColor: 'Colour of the blade tips.',
    dryness: 'Share of dry, straw coloured blades.',
    flowers: 'Flowers per square unit, scattered in the grass.',
    palette: 'Colours of the flowers.',
    direct: 'Convert this grass as gaussians laid along each blade (looks better, far fewer splats). Off: the grass mesh is sampled like any model.',
    addGrass: 'Generate a grass patch and put it on the ground at the camera focus.',
    addGrassSplats: 'Generate the grass and convert it to splats right away (with the studio lighting if there are lights).',
    updateGrass: 'Regenerate the selected grass patch with these settings, keeping its place.',
    downloadGrass: 'Save the grass as a .glb file.'
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
    let grass: GrassParams = { ...defaultGrass(2), direct: true };
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

    const section = (title: string) => body.append(new Label({ text: title, class: 'toolkit-section' }));
    const hint = (text = '') => new Label({ text, class: 'toolkit-hint' });
    const row = (labelText: string, tip: string) => {
        const r = new Container({ class: 'toolkit-row' });
        const label = new Label({ text: labelText, class: 'toolkit-label' });
        r.append(label);
        tooltips.register(label, tip, 'left');
        body.append(r);
        return r;
    };
    const slider = (labelText: string, tip: string, min: number, max: number, precision: number, step?: number) => {
        const r = row(labelText, tip);
        const s = new SliderInput({ class: 'toolkit-slider', min, max, precision, step: step ?? Math.pow(10, -precision), value: min });
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
        body.append(r);
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

    body.append(hint('Trees by EZ-Tree (Daniel Greenheck, MIT). Generated plants are models: move, light and convert them like any mesh.'));

    // tree
    section('Tree');
    const preset = select('Kind', tips.preset, treePresets.map(p => ({ v: p, t: p })));
    const treeSeed = seedRow(tips.seed);
    const height = slider('Height', tips.treeHeight, 0.05, 50, 2, 0.01);
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
    body.append(treeStatus);

    // grass
    section('Grass');
    const grassSeed = seedRow(tips.seed);
    const width = slider('Width', tips.width, 0.05, 50, 2, 0.01);
    const depth = slider('Depth', tips.depth, 0.05, 50, 2, 0.01);
    const density = slider('Density', tips.density, 1, 20000, 0, 1);
    const bladeHeight = slider('Blade height', tips.bladeHeight, 0.002, 2, 3, 0.001);
    const heightVariance = slider('Variance', tips.heightVariance, 0, 1, 2, 0.01);
    const bladeWidth = slider('Blade width', tips.bladeWidth, 0.0005, 0.2, 4, 0.0005);
    const bend = slider('Bend', tips.bend, 0, 1, 2, 0.01);
    const wind = slider('Wind', tips.wind, 0, 360, 0, 1);
    const windStrength = slider('Lean', tips.windStrength, 0, 1, 2, 0.01);
    const clumping = slider('Tufts', tips.clumping, 0, 1, 2, 0.01);
    const rootColor = color('Root colour', tips.rootColor);
    const tipColor = color('Tip colour', tips.tipColor);
    const dryness = slider('Dry blades', tips.dryness, 0, 1, 2, 0.01);
    const flowers = slider('Flowers', tips.flowers, 0, 2000, 0, 1);
    const palette = select('Flower colours', tips.palette, Object.keys(flowerPalettes).map(k => ({ v: k, t: k[0].toUpperCase() + k.slice(1) })));
    const directRow = row('As blades', tips.direct);
    const direct = new BooleanInput({ type: 'toggle', value: true });
    directRow.append(direct);
    const grassCount = hint();
    body.append(grassCount);
    const [addGrass, addGrassSplats] = buttons([['Add grass', tips.addGrass], ['Add as splats', tips.addGrassSplats]]);
    const [updateGrass, downloadGrass] = buttons([['Update selected', tips.updateGrass], ['Download .glb', tips.downloadGrass]]);

    canvasContainer.append(panel);

    registerPanel(ctx, {
        id: 'vegetation',
        panel,
        header,
        icon: vegetationSvg,
        title: 'Vegetation',
        tooltip: tips.toggle,
        order: 2.5
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
        width.value = grass.width;
        depth.value = grass.depth;
        density.value = grass.density;
        bladeHeight.value = grass.height;
        heightVariance.value = grass.heightVariance;
        bladeWidth.value = grass.bladeWidth;
        bend.value = grass.bend;
        wind.value = grass.windAngle;
        windStrength.value = grass.windStrength;
        clumping.value = grass.clumping;
        rootColor.value = grass.rootColor;
        tipColor.value = grass.tipColor;
        dryness.value = grass.dryness;
        flowers.value = grass.flowers;
        palette.value = grass.flowerPalette;
        direct.value = grass.direct !== false;
        uiUpdating = false;
        updateGrassCount();
        updateButtons();
    };

    updateGrassCount = () => {
        const n = bladeCount(grass);
        const wanted = Math.round(grass.density * grass.width * grass.depth);
        grassCount.text = `${n.toLocaleString()} blades${wanted > MAX_BLADES ? ` (limited from ${wanted.toLocaleString()}: lower the density or the size)` : ''}, about ${(n * 4).toLocaleString()} splats as blades.`;
    };

    const onTree = (change: Partial<TreeParams>) => {
        if (!uiUpdating) tree = { ...tree, ...change };
    };
    const onGrass = (change: Partial<GrassParams>) => {
        if (uiUpdating) return;
        grass = { ...grass, ...change };
        updateGrassCount();
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
    });
    width.on('change', (v: number) => onGrass({ width: v }));
    depth.on('change', (v: number) => onGrass({ depth: v }));
    density.on('change', (v: number) => onGrass({ density: v }));
    bladeHeight.on('change', (v: number) => onGrass({ height: v }));
    heightVariance.on('change', (v: number) => onGrass({ heightVariance: v }));
    bladeWidth.on('change', (v: number) => onGrass({ bladeWidth: v }));
    bend.on('change', (v: number) => onGrass({ bend: v }));
    wind.on('change', (v: number) => onGrass({ windAngle: v }));
    windStrength.on('change', (v: number) => onGrass({ windStrength: v }));
    clumping.on('change', (v: number) => onGrass({ clumping: v }));
    rootColor.on('change', (v: number[]) => onGrass({ rootColor: rgb(v) }));
    tipColor.on('change', (v: number[]) => onGrass({ tipColor: rgb(v) }));
    dryness.on('change', (v: number) => onGrass({ dryness: v }));
    flowers.on('change', (v: number) => onGrass({ flowers: v }));
    palette.on('change', (v: string) => onGrass({ flowerPalette: v }));
    direct.on('change', (v: boolean) => onGrass({ direct: v }));

    // ---- generation

    const selectedGenerated = (type: 'tree' | 'grass') => {
        const p = events.invoke('toolkit.selectedPrimitive') as MeshPrimitive | null;
        return p && p.generator?.type === type ? p : null;
    };

    updateButtons = () => {
        updateTree.enabled = !!selectedGenerated('tree');
        updateGrass.enabled = !!selectedGenerated('grass');
    };

    // show a generated plant's settings when it is selected
    events.on('toolkit.primitive.selected', (p: MeshPrimitive | null) => {
        if (p?.generator?.type === 'tree') {
            tree = { ...defaultTree(), ...p.generator.params };
            updateUI();
        } else if (p?.generator?.type === 'grass') {
            grass = { ...grass, ...p.generator.params };
            updateUI();
        }
        updateButtons();
    });

    const busy = async <T>(text: string, work: () => Promise<T>) => {
        events.fire('startSpinner');
        [addTree, updateTree, downloadTree, addGrass, addGrassSplats, updateGrass, downloadGrass].forEach((b) => {
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
            [addTree, downloadTree, addGrass, addGrassSplats, downloadGrass].forEach((b) => {
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

    const addGrassModel = async (replace?: MeshPrimitive | null) => {
        const { glb } = await grassGlb(grass);
        return await events.invoke('toolkit.addGeneratedModel', glb, {
            name: 'Grass',
            generator: { type: 'grass', params: { ...grass } },
            longest: Math.max(grass.width, grass.depth),
            replace
        }) as MeshPrimitive;
    };

    addGrass.on('click', () => busy('Grass', () => addGrassModel()));
    addGrassSplats.on('click', () => busy('Grass', async () => {
        const primitive = await addGrassModel();
        // convert just this patch: as blades unless switched off
        await events.invoke('toolkit.convertPrimitives', [primitive], { hideLights: false });
    }));
    updateGrass.on('click', () => busy('Grass', async () => {
        const target = selectedGenerated('grass');
        if (target) await addGrassModel(target);
    }));
    downloadGrass.on('click', () => busy('Grass', async () => {
        download((await grassGlb(grass)).glb, `grass_${grass.seed}.glb`);
    }));

    // sizes follow the scene when the panel opens on a new scene
    let sizedFor = -1;
    events.on('toolkit.panel.vegetation.visible', (visible: boolean) => {
        if (!visible) return;
        const size = sceneSize();
        if (Math.abs(size - sizedFor) > 1e-6 && primitives().every(p => !p.generator)) {
            sizedFor = size;
            treeHeight = size * 0.9;
            grass = { ...defaultGrass(size), seed: grass.seed, direct: grass.direct };
        }
        updateUI();
    });

    updateUI();
};

const vegetationModule: ToolkitModule = {
    id: 'vegetation',
    init
};


export { vegetationModule };
