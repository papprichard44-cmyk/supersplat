import { BooleanInput, Button, ColorPicker, Container, Label, NumericInput, SelectInput, SliderInput } from '@playcanvas/pcui';

import { AddSplatOp, MultiOp } from '../../edit-ops';
import { Element, ElementType } from '../../element';
import type { Scene } from '../../scene';
import type { Splat } from '../../splat';
import skySvg from '../icons/sky.svg';
import { collapsible } from '../inspector';
import { headerIcon, registerPanel } from '../panels';
import { loadPanorama, Panorama } from './panorama';
import { defaultParams, estimateSplats, generateSky, presets, QUALITY_SPLATS, renderPreview, RGB, SkyParams, SkyQuality, SkySource } from './sky-gen';
import type { ToolkitContext, ToolkitModule } from '../index';

// The Sky panel: makes a sky dome of splats around the scene, from a
// procedural sky (presets, sun, clouds, stars, distant mountains), a panorama
// picture or HDR, or one colour. The dome is a splat layer marked as a
// backdrop: it stays out of the scene bound (framing), the studio lights leave
// it alone, and it never vanishes at a distance. It is created and updated as
// one undo step, and its settings are kept in the project, so it can be
// changed later.

const tips = {
    toggle: 'Sky: a parametric sky dome of splats around the scene',
    preview: 'What the dome will show, unrolled (left to right: all around you; top: straight up).',
    source: 'Where the sky comes from: generated, a panorama picture, or one colour.',
    preset: 'A starting point. Every setting below can be changed after.',
    zenith: 'Colour straight up.',
    horizon: 'Colour at the horizon.',
    ground: 'Colour below the horizon (under the ground of most scenes).',
    curve: 'How fast the zenith colour takes over above the horizon. Low: a thin band of horizon colour.',
    haze: 'A bright, hazy band along the horizon.',
    sun: 'A sun (or a moon): a crisp disc with a glow around it.',
    sunAzimuth: 'Which way the sun is (degrees around; 0 = -Z, 90 = +X).',
    sunElevation: 'How high the sun is above the horizon (degrees).',
    sunSize: 'The disc\'s size in degrees (the real sun is about 0.5).',
    sunGlow: 'Glow around the sun and the light it throws into the sky and onto the clouds.',
    sunColor: 'Colour of the sun and its glow.',
    clouds: 'How much of the sky is cloudy.',
    cloudSoftness: 'Soft, wispy edges (high) or crisp cloud outlines (low).',
    cloudScale: 'Size of the clouds.',
    cloudShadow: 'Darker, shaded undersides: gives the clouds volume.',
    cloudColor: 'Colour of the clouds.',
    seed: 'Another random variation of the same settings.',
    dice: 'A random seed',
    cloud3d: 'Clouds as a real layer at a height, in front of the sky: they move against it as the camera moves (more splats). Off: painted on the dome (cheapest).',
    cloudHeight: 'Height of the cloud layer, as a part of the sky\'s radius.',
    cloudThickness: 'How thick the clouds are, as a part of their height.',
    stars: 'Stars, in front of the sky and hidden by clouds. Best with a dark sky.',
    starBrightness: 'Brightness of the stars.',
    mountains: 'Rings of distant mountains in front of the sky, each further away and hazier: real depth when the camera moves.',
    mountainHeight: 'Height of the highest peaks, in degrees above the horizon.',
    mountainRoughness: 'Gentle hills (low) or jagged peaks (high).',
    mountainColor: 'Colour of the mountains (far ranges fade into the horizon).',
    mountainHaze: 'How much the far ranges fade into the horizon colour.',
    panorama: 'Load an equirectangular panorama (2:1): .jpg, .png, .webp, or .hdr.',
    yaw: 'Turn the panorama around.',
    exposure: 'Brighter or darker (EV). HDR panoramas are tone mapped.',
    groundProjection: 'Lay the lower half of the panorama flat on the ground around the camera instead of on the dome: the ground then stays put as you move.',
    eyeHeight: 'Height of the panorama\'s camera above its ground (scene units).',
    color: 'The colour of the whole sky.',
    quality: 'Splats in the dome. Light is enough for most skies; more only sharpens fine detail (clouds, panoramas).',
    upperOnly: 'Leave out the lower half of the dome, which the ground hides anyway: about half the splats.',
    radius: 'Distance of the sky from the centre. Automatic: well beyond the scene.',
    horizon_y: 'Height of the horizon (the dome\'s centre). Automatic: the centre of the scene.',
    live: 'Update the sky in the scene while you change the settings.',
    create: 'Add the sky to the scene as a splat layer (one undo step).',
    update: 'Rebuild the sky with these settings (one undo step).',
    remove: 'Take the sky out of the scene (Ctrl+Z brings it back).'
};

const qualityNames: Record<SkyQuality, string> = {
    light: 'Light',
    balanced: 'Balanced',
    high: 'High',
    ultra: 'Ultra'
};

const formatCount = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} M` : n >= 1e3 ? `${Math.round(n / 1000)}k` : String(n));

// removing a sky layer, undoable (the counterpart of AddSplatOp)
class RemoveSplatOp {
    name = 'toolkitRemoveSplat';

    constructor(private scene: Scene, private splat: Splat) {}

    do() {
        this.scene.remove(this.splat);
    }

    async undo() {
        await this.scene.add(this.splat);
    }

    destroy() {
        // dropped from the history while removed: nothing can bring it back
        if (!this.splat.scene) this.splat.destroy();
    }
}

const clone = (p: SkyParams): SkyParams => JSON.parse(JSON.stringify(p));

// skies of the scene and their settings
const skies = new Map<Splat, SkyParams>();
let sceneRef: Scene | null = null;

const markSky = (splat: Splat, params: SkyParams) => {
    splat.background = true;
    splat.noSizeCull = true;
    splat.studioMask = 0;
    skies.set(splat, params);
    if (sceneRef) {
        sceneRef.boundDirty = true;
        sceneRef.forceRender = true;
    }
};

const init = (ctx: ToolkitContext) => {
    const { events, scene, tooltips, canvasContainer } = ctx;
    sceneRef = scene;

    let params = defaultParams();
    let panorama: Panorama | null = null;
    let uiUpdating = false;

    // ---- panel
    const panel = new Container({ id: 'toolkit-sky-panel', class: 'panel' });
    ['pointerdown', 'pointerup', 'pointermove', 'wheel', 'dblclick'].forEach((eventName) => {
        panel.dom.addEventListener(eventName, (event: Event) => event.stopPropagation());
    });
    const header = new Container({ class: 'panel-header' });
    header.append(headerIcon(skySvg));
    header.append(new Label({ text: 'Sky', class: 'panel-header-label' }));
    panel.append(header);
    const body = new Container({ class: 'toolkit-lighting-body' });
    panel.append(body);

    // preview
    const previewBox = new Container({ class: 'toolkit-sky-preview' });
    const previewCanvas = document.createElement('canvas');
    previewCanvas.width = 256;
    previewCanvas.height = 128;
    previewBox.dom.appendChild(previewCanvas);
    tooltips.register(previewBox, tips.preview, 'left');
    body.append(previewBox);

    // ---- control helpers (each one writes into `params` and refreshes)
    const changed: (() => void)[] = [];
    let target: Container = body;
    const row = (text: string, tip: string) => {
        const r = new Container({ class: 'toolkit-row' });
        const label = new Label({ text, class: 'toolkit-label' });
        r.append(label);
        tooltips.register(label, tip, 'left');
        target.append(r);
        return r;
    };
    type Key<T> = { [K in keyof SkyParams]: SkyParams[K] extends T ? K : never }[keyof SkyParams];
    const slider = (text: string, tip: string, key: Key<number>, min: number, max: number, precision: number) => {
        const r = row(text, tip);
        const s = new SliderInput({ class: 'toolkit-slider', min, max, precision, step: Math.pow(10, -precision), value: params[key] as number });
        r.append(s);
        tooltips.register(s, tip, 'bottom');
        s.on('change', (v: number) => {
            if (uiUpdating) return;
            (params[key] as number) = v;
            onChange();
        });
        changed.push(() => {
            s.value = params[key] as number;
        });
        return { row: r, input: s };
    };
    const toggle = (text: string, tip: string, key: Key<boolean>) => {
        const r = row(text, tip);
        const t = new BooleanInput({ type: 'toggle', class: 'toolkit-toggle', value: params[key] as boolean });
        r.append(t);
        tooltips.register(t, tip, 'bottom');
        t.on('change', (v: boolean) => {
            if (uiUpdating) return;
            (params[key] as boolean) = v;
            onChange();
        });
        changed.push(() => {
            t.value = params[key] as boolean;
        });
        return { row: r, input: t };
    };
    const color = (text: string, tip: string, key: Key<RGB>) => {
        const r = row(text, tip);
        const c = new ColorPicker({ class: 'toolkit-color', value: params[key] as RGB });
        r.append(c);
        tooltips.register(c, tip, 'bottom');
        c.on('change', (v: number[]) => {
            if (uiUpdating) return;
            (params[key] as RGB) = [v[0], v[1], v[2]];
            onChange();
        });
        changed.push(() => {
            c.value = params[key] as RGB;
        });
        return { row: r, input: c };
    };
    const seed = (key: 'cloudSeed' | 'mountainSeed') => {
        const { row: r, input } = slider('Seed', tips.seed, key, 1, 999, 0);
        const dice = new Button({ text: '🎲', class: 'toolkit-convert' });
        r.append(dice);
        tooltips.register(dice, tips.dice, 'bottom');
        dice.on('click', () => {
            input.value = 1 + Math.floor(Math.random() * 999);
        });
    };
    const group = (title: string, id: string, open: boolean) => {
        const g = collapsible(title, `sky.${id}`, open);
        target.append(g.root);
        target = g.body;
        return g;
    };

    // ---- source tabs
    const tabRow = new Container({ class: ['toolkit-row', 'toolkit-tabs'] });
    const tabs = new Map<SkySource, Button>();
    ([['procedural', 'Generated'], ['panorama', 'Panorama'], ['solid', 'Colour']] as [SkySource, string][]).forEach(([source, text]) => {
        const b = new Button({ text, class: 'toolkit-button' });
        tabRow.append(b);
        tooltips.register(b, tips.source, 'bottom');
        tabs.set(source, b);
        b.on('click', () => {
            params.source = source;
            onChange();
        });
    });
    body.append(tabRow);

    // ---- generated
    const proceduralPage = new Container({ class: 'toolkit-veg-page' });
    body.append(proceduralPage);
    target = proceduralPage;

    const presetRow = row('Preset', tips.preset);
    const presetSelect = new SelectInput({
        class: 'toolkit-select',
        type: 'string',
        options: [{ v: 'custom', t: 'Custom' }, ...presets.map(p => ({ v: p.id, t: p.name }))],
        value: 'clear'
    });
    presetRow.append(presetSelect);
    presetSelect.on('change', (id: string) => {
        if (uiUpdating) return;
        const preset = presets.find(p => p.id === id);
        if (!preset) return;
        params = { ...params, ...clone({ ...params, ...preset.params }) };
        onChange(true);
    });

    const colours = group('Colours', 'colours', true);
    color('Zenith', tips.zenith, 'zenith');
    color('Horizon', tips.horizon, 'horizon');
    color('Ground', tips.ground, 'ground');
    slider('Gradient', tips.curve, 'curve', 0.1, 3, 2);
    slider('Haze', tips.haze, 'haze', 0, 1, 2);
    target = proceduralPage;

    const sunGroup = group('Sun', 'sun', true);
    const sunToggle = new BooleanInput({ type: 'toggle', class: 'toolkit-toggle', value: params.sun });
    sunGroup.extra.append(sunToggle);
    tooltips.register(sunToggle, tips.sun, 'bottom');
    sunToggle.on('change', (v: boolean) => {
        if (uiUpdating) return;
        params.sun = v;
        onChange();
    });
    changed.push(() => {
        sunToggle.value = params.sun;
    });
    slider('Direction', tips.sunAzimuth, 'sunAzimuth', 0, 360, 0);
    slider('Height', tips.sunElevation, 'sunElevation', -5, 90, 1);
    slider('Size', tips.sunSize, 'sunSize', 0.2, 10, 1);
    slider('Glow', tips.sunGlow, 'sunGlow', 0, 2, 2);
    color('Colour', tips.sunColor, 'sunColor');
    target = proceduralPage;

    const cloudGroup = group('Clouds', 'clouds', true);
    slider('Amount', tips.clouds, 'clouds', 0, 1, 2);
    slider('Softness', tips.cloudSoftness, 'cloudSoftness', 0, 1, 2);
    slider('Size', tips.cloudScale, 'cloudScale', 0.2, 4, 2);
    slider('Shading', tips.cloudShadow, 'cloudShadow', 0, 1, 2);
    color('Colour', tips.cloudColor, 'cloudColor');
    seed('cloudSeed');
    const cloud3d = toggle('3D layer', tips.cloud3d, 'cloud3d');
    const cloudHeight = slider('Height', tips.cloudHeight, 'cloudHeight', 0.03, 0.6, 2);
    const cloudThickness = slider('Thickness', tips.cloudThickness, 'cloudThickness', 0, 0.6, 2);
    target = proceduralPage;

    const starGroup = group('Stars', 'stars', false);
    slider('Amount', tips.stars, 'stars', 0, 1, 2);
    slider('Brightness', tips.starBrightness, 'starBrightness', 0.2, 2, 2);
    target = proceduralPage;

    const mountainGroup = group('Mountains', 'mountains', false);
    slider('Ranges', tips.mountains, 'mountains', 0, 3, 0);
    slider('Height', tips.mountainHeight, 'mountainHeight', 1, 25, 1);
    slider('Roughness', tips.mountainRoughness, 'mountainRoughness', 0, 1, 2);
    color('Colour', tips.mountainColor, 'mountainColor');
    slider('Haze', tips.mountainHaze, 'mountainHaze', 0, 1, 2);
    seed('mountainSeed');
    target = body;

    // ---- panorama
    const panoramaPage = new Container({ class: 'toolkit-veg-page' });
    body.append(panoramaPage);
    target = panoramaPage;
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.jpg,.jpeg,.png,.webp,.hdr,image/*';
    fileInput.style.display = 'none';
    panel.dom.appendChild(fileInput);
    const loadRow = new Container({ class: 'toolkit-row' });
    const loadButton = new Button({ text: 'Load panorama…', class: 'toolkit-button' });
    loadRow.append(loadButton);
    tooltips.register(loadButton, tips.panorama, 'bottom');
    panoramaPage.append(loadRow);
    const panoramaInfo = new Label({ text: 'No panorama yet: an equirectangular (2:1) .jpg, .png, .webp or .hdr.', class: 'toolkit-hint' });
    panoramaPage.append(panoramaInfo);
    slider('Turn', tips.yaw, 'yaw', -180, 180, 0);
    slider('Exposure', tips.exposure, 'exposure', -4, 4, 2);
    const projection = toggle('Flat ground', tips.groundProjection, 'groundProjection');
    const eyeHeight = slider('Eye height', tips.eyeHeight, 'eyeHeight', 0.05, 50, 2);
    target = body;

    // ---- one colour
    const solidPage = new Container({ class: 'toolkit-veg-page' });
    body.append(solidPage);
    target = solidPage;
    color('Colour', tips.color, 'color');
    target = body;

    // ---- output
    const outputGroup = group('Output', 'output', true);
    const qualityRow = row('Quality', tips.quality);
    const qualitySelect = new SelectInput({
        class: 'toolkit-select',
        type: 'string',
        options: (Object.keys(QUALITY_SPLATS) as SkyQuality[]).map(q => ({ v: q, t: `${qualityNames[q]} (${formatCount(QUALITY_SPLATS[q])})` })),
        value: params.quality
    });
    qualityRow.append(qualitySelect);
    tooltips.register(qualitySelect, tips.quality, 'bottom');
    qualitySelect.on('change', (v: SkyQuality) => {
        if (uiUpdating) return;
        params.quality = v;
        onChange();
    });
    changed.push(() => {
        qualitySelect.value = params.quality;
    });
    toggle('Upper half', tips.upperOnly, 'upperOnly');

    // automatic or set: radius and horizon height
    const autoNumber = (text: string, tip: string, get: () => number | null, set: (v: number | null) => void, auto: () => number, min: number) => {
        const r = row(text, tip);
        const check = new BooleanInput({ type: 'checkbox', value: get() === null || get() === 0 });
        const input = new NumericInput({ class: 'toolkit-numeric', precision: 2, min, value: auto() });
        const label = new Label({ text: 'auto', class: 'toolkit-check-kind' });
        r.append(input);
        r.append(check);
        r.append(label);
        tooltips.register(input, tip, 'bottom');
        tooltips.register(check, 'Automatic', 'bottom');
        const refresh = () => {
            const value = get();
            const isAuto = value === null || value === 0;
            check.value = isAuto;
            input.enabled = !isAuto;
            input.value = isAuto ? auto() : value;
        };
        check.on('change', (v: boolean) => {
            if (uiUpdating) return;
            set(v ? null : auto());
            onChange();
        });
        input.on('change', (v: number) => {
            if (uiUpdating || check.value) return;
            set(v);
            onChange();
        });
        changed.push(refresh);
        return refresh;
    };

    const sceneBound = () => scene.bound;
    const autoRadius = () => {
        const b = sceneBound();
        const r = b ? b.halfExtents.length() : 1;
        return Math.round(Math.max(30, r * 25));
    };
    const autoHorizon = () => {
        const b = sceneBound();
        return b ? Math.round(b.center.y * 100) / 100 : 0;
    };
    const refreshRadius = autoNumber('Radius', tips.radius, () => params.radius || null, (v) => {
        params.radius = v ?? 0;
    }, autoRadius, 1);
    const refreshHorizon = autoNumber('Horizon at', tips.horizon_y, () => params.horizonY, (v) => {
        params.horizonY = v;
    }, autoHorizon, -1e6);
    target = body;

    const status = new Label({ text: '', class: 'toolkit-hint' });
    body.append(status);

    const liveRow = new Container({ class: 'toolkit-row' });
    const liveLabel = new Label({ text: 'Live update', class: 'toolkit-label' });
    const live = new BooleanInput({ type: 'toggle', class: 'toolkit-toggle', value: true });
    liveRow.append(liveLabel);
    liveRow.append(live);
    tooltips.register(liveLabel, tips.live, 'left');
    tooltips.register(live, tips.live, 'bottom');
    body.append(liveRow);

    const actionRow = new Container({ class: 'toolkit-row' });
    const createButton = new Button({ text: 'Create sky', class: 'toolkit-bake' });
    const removeButton = new Button({ text: 'Remove', class: 'toolkit-button' });
    actionRow.append(createButton);
    actionRow.append(removeButton);
    tooltips.register(removeButton, tips.remove, 'bottom');
    body.append(actionRow);

    // ---- state

    const skyLayers = () => (scene.getElementsByType(ElementType.splat) as Splat[]).filter(s => skies.has(s));
    // the sky being edited: the selected one, else the newest
    let editing: Splat | null = null;
    const currentSky = () => (editing && editing.scene ? editing : skyLayers().pop() ?? null);
    tooltips.register(createButton, () => (currentSky() ? tips.update : tips.create), 'bottom');

    const placement = () => {
        const b = sceneBound();
        const cx = b ? b.center.x : 0;
        const cz = b ? b.center.z : 0;
        const radius = params.radius > 0 ? params.radius : autoRadius();
        const y = params.horizonY ?? autoHorizon();
        return { center: [cx, y, cz] as [number, number, number], radius };
    };

    // ---- refresh the panel

    let previewQueued = false;
    const drawPreview = () => {
        previewQueued = false;
        const context = previewCanvas.getContext('2d');
        const image = context.createImageData(previewCanvas.width, previewCanvas.height);
        renderPreview(params, panorama, previewCanvas.width, previewCanvas.height, image.data);
        context.putImageData(image, 0, 0);
        // the horizon
        context.strokeStyle = 'rgba(255, 255, 255, 0.25)';
        context.setLineDash([3, 3]);
        context.beginPath();
        context.moveTo(0, previewCanvas.height / 2 + 0.5);
        context.lineTo(previewCanvas.width, previewCanvas.height / 2 + 0.5);
        context.stroke();
    };

    const updateUi = () => {
        uiUpdating = true;
        changed.forEach(fn => fn());
        tabs.forEach((b, source) => b.class[source === params.source ? 'add' : 'remove']('active'));
        proceduralPage.hidden = params.source !== 'procedural';
        panoramaPage.hidden = params.source !== 'panorama';
        solidPage.hidden = params.source !== 'solid';
        cloudHeight.row.hidden = cloudThickness.row.hidden = !params.cloud3d;
        eyeHeight.row.hidden = !params.groundProjection;
        projection.row.hidden = false;
        cloud3d.row.hidden = false;
        uiUpdating = false;

        colours.extra.dom.textContent = '';
        cloudGroup.extra.dom.textContent = params.clouds > 0 ? `${Math.round(params.clouds * 100)}%` : 'none';
        starGroup.extra.dom.textContent = params.stars > 0 ? `${Math.round(params.stars * 100)}%` : 'none';
        mountainGroup.extra.dom.textContent = params.mountains > 0 ? `${Math.round(params.mountains)} range${params.mountains > 1.5 ? 's' : ''}` : 'none';
        outputGroup.extra.dom.textContent = qualityNames[params.quality];

        const sky = currentSky();
        const n = estimateSplats(params);
        const sizeMb = n * 56 / 1048576;
        const where = placement();
        status.text = `≈ ${formatCount(n)} splats · ${sizeMb.toFixed(1)} MB · radius ${where.radius}${params.source === 'panorama' && !panorama ? ' · load a panorama first' : ''}`;
        createButton.text = sky ? 'Update sky' : 'Create sky';
        removeButton.enabled = !!sky;
        createButton.enabled = !(params.source === 'panorama' && !panorama);

        if (!previewQueued) {
            previewQueued = true;
            requestAnimationFrame(drawPreview);
        }
    };

    // ---- build

    // load a PLY as a new layer and return it
    const importLayer = async (filename: string, data: Blob) => {
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

    let building = false;
    let again = false;
    const build = async () => {
        if (building) {
            again = true;
            return;
        }
        if (params.source === 'panorama' && !panorama) return;
        building = true;
        createButton.enabled = false;
        try {
            const old = currentSky();
            const settings = clone(params);
            const { ply, stats } = generateSky(settings, placement(), panorama);
            const created = await importLayer('Sky.ply', ply);
            if (!created) return;
            markSky(created, settings);
            editing = created;
            events.fire('toolkit.sky.changed', created);
            const ops = [];
            if (old) ops.push(new RemoveSplatOp(scene, old));
            ops.push(new AddSplatOp(scene, created));
            events.fire('edit.add', ops.length === 1 ? ops[0] : new MultiOp(ops));
            status.text = `${formatCount(stats.total)} splats · ${(stats.total * 56 / 1048576).toFixed(1)} MB`;
        } catch (error) {
            await events.invoke('showPopup', {
                type: 'error',
                header: 'Sky',
                message: (error as Error).message ?? String(error)
            });
        } finally {
            building = false;
            updateUi();
            if (again) {
                again = false;
                build();
            }
        }
    };

    // live: rebuild a little after the last change
    let liveTimer = 0;
    function onChange(fromPreset = false) {
        if (!fromPreset && !uiUpdating) {
            uiUpdating = true;
            presetSelect.value = 'custom';
            uiUpdating = false;
        }
        updateUi();
        if (live.value && currentSky()) {
            window.clearTimeout(liveTimer);
            liveTimer = window.setTimeout(build, 500);
        }
    }

    createButton.on('click', () => {
        window.clearTimeout(liveTimer);
        build();
    });
    removeButton.on('click', () => {
        const sky = currentSky();
        if (sky) events.fire('edit.add', new RemoveSplatOp(scene, sky));
    });

    loadButton.on('click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
        const file = fileInput.files?.[0];
        fileInput.value = '';
        if (!file) return;
        try {
            panorama = await loadPanorama(file);
            panoramaInfo.text = `${panorama.name}: ${panorama.width} × ${panorama.height}${panorama.hdr ? ' HDR' : ''}${Math.abs(panorama.width / panorama.height - 2) > 0.05 ? ' (not 2:1: it will be stretched)' : ''}`;
            onChange();
        } catch (error) {
            await events.invoke('showPopup', {
                type: 'error',
                header: 'Panorama',
                message: (error as Error).message ?? String(error)
            });
        }
    });

    // picking a sky layer brings its settings back
    events.on('selection.changed', (splat: Splat | null) => {
        const stored = splat && skies.get(splat);
        if (!stored) return;
        editing = splat;
        params = clone(stored);
        uiUpdating = true;
        presetSelect.value = 'custom';
        uiUpdating = false;
        updateUi();
    });
    events.on('scene.elementAdded', updateUi);
    events.on('scene.elementRemoved', (element: Element) => {
        if (element === editing) editing = null;
        updateUi();
    });
    events.on('scene.clear', () => {
        skies.clear();
        editing = null;
    });

    canvasContainer.append(panel);
    registerPanel(ctx, {
        id: 'sky',
        panel,
        header,
        icon: skySvg,
        title: 'Sky',
        tooltip: tips.toggle,
        order: 2.7
    });

    // keep the radius / horizon read-outs current as the scene changes
    events.on('scene.boundChanged', () => {
        if (params.radius === 0) refreshRadius();
        if (params.horizonY === null) refreshHorizon();
    });

    updateUi();
};

const skyModule: ToolkitModule = {
    id: 'sky',
    init,
    serialize: () => {
        const layers = sceneRef ? (sceneRef.getElementsByType(ElementType.splat) as Splat[]).filter(s => skies.has(s)) : [];
        return layers.map(s => ({ name: s.name, params: skies.get(s) }));
    },
    deserialize: (data) => {
        if (!Array.isArray(data) || !sceneRef) return;
        const splats = sceneRef.getElementsByType(ElementType.splat) as Splat[];
        (data as { name: string, params: SkyParams }[]).forEach((entry) => {
            const splat = splats.find(s => s.name === entry?.name && !skies.has(s));
            if (splat) markSky(splat, { ...defaultParams(), ...entry.params });
        });
    }
};

export { skyModule };
