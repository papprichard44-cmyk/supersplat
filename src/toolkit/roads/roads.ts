import { BooleanInput, Button, ColorPicker, Container, Label, SelectInput, SliderInput } from '@playcanvas/pcui';
import { Mat4, Vec3 } from 'playcanvas';

import { buildRoad, centerline, Centerline, Point } from './road-mesh';
import { defaultRoad, PaverPattern, RoadParams, RoadStyle, styles } from './road-params';
import { stylePreview } from './road-textures';
import { ElementType } from '../../element';
import roadSvg from '../icons/road.svg';
import type { ToolkitContext, ToolkitModule } from '../index';
import { collapsible } from '../inspector';
import { LogSlider } from '../log-slider';
import { MeshPrimitive } from '../mesh-primitive';
import { MeshRaycaster } from '../mesh-raycast';
import { headerIcon, registerPanel } from '../panels';
import { createSurfaceProbe } from '../surface-probe';

// Road Maker: roads drawn with a pen tool. Click on the scene to put down the
// path's points, drag a point to move it, click on the road's line to insert
// one, Alt+click a point to remove it. A road is a mesh (a generated model):
// lit by the studio lights like any mesh, editable - path, style, width - as
// long as it is a mesh, and turned into splats when it is ready.
//
// Styles: dirt trail, old cobblestone, modern pavers, concrete sidewalk.

const TOOL = 'toolkitRoad';
const HANDLE_PX = 9;
const LINE_PX = 7;
// at most this many ground probes per rebuild
const MAX_PROBES = 1600;

const tips = {
    toggle: 'Road Maker: draw roads and paths with a pen tool',
    style: 'The kind of road. Changing it restyles the road being edited.',
    draw: 'Draw: click on the scene to add points, drag a point to move it, click the road\'s line to insert a point, Alt+click a point to remove it. Enter, Esc or this button again to finish.',
    newRoad: 'Start a new road: the next click puts down its first point.',
    width: 'Width of the road.',
    follow: 'Lay the road on the ground under it (splats or meshes in view). Off: a smooth line through the points\' heights.',
    lift: 'How far the road floats above the ground, so the ground doesn\'t show through it.',
    rim: 'Width of the frayed edge where the trail blends into the ground, as a share of the road\'s width.',
    border: 'A row of border stones along both edges.',
    curb: 'A raised curb on both sides.',
    curbHeight: 'Height of the curb.',
    pattern: 'Laying pattern of the pavers.',
    tint: 'Tint over the style\'s colours (white = as is).',
    colorVariation: 'How much the stones (or the ground) differ in colour.',
    wear: 'Stains, dust and damp patches.',
    moss: 'Moss and weeds in the joints.',
    seed: 'Another random variation of the same road.',
    dice: 'A random seed',
    toSplats: 'Turn the road into splats (with the studio lighting if there are lights). The mesh is kept, hidden.',
    download: 'Save the road as a .glb file.'
};

const patternTexts: Record<PaverPattern, string> = { running: 'Running bond', basket: 'Basket weave', slabs: 'Large slabs' };

const clone = (p: RoadParams): RoadParams => JSON.parse(JSON.stringify(p));
const newId = () => `r${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

const init = (ctx: ToolkitContext) => {
    const { events, scene, canvasContainer, tooltips, toolManager } = ctx;

    const primitives = () => scene.getElementsByType(ElementType.model).filter((e): e is MeshPrimitive => e instanceof MeshPrimitive);
    const roads = () => primitives().filter(p => p.generator?.type === 'road');

    let params: RoadParams = defaultRoad(0.3);
    let curbHeight = 0.02;
    // the road being edited (found by id, so undo / redo keep it), and the
    // first point of a new road before it has a second
    let editingId = '';
    let draftOrigin: Vec3 | null = null;
    let uiUpdating = false;

    const selectedRoad = () => {
        const p = events.invoke('toolkit.selectedPrimitive') as MeshPrimitive | null;
        return p?.generator?.type === 'road' ? p : null;
    };
    const current = (): MeshPrimitive | null => selectedRoad() ?? (editingId ? roads().find(r => r.generator.params.id === editingId) ?? null : null);

    // ---- road space <-> world

    const inverse = new Mat4();
    const toWorld = (road: MeshPrimitive | null, p: Point, out = new Vec3()) => {
        if (road?.modelTransform) return road.modelTransform.transformPoint(new Vec3(p.x, p.y, p.z), out);
        const o = draftOrigin ?? Vec3.ZERO;
        return out.set(o.x + p.x, o.y + p.y, o.z + p.z);
    };
    const toLocal = (road: MeshPrimitive | null, w: Vec3): Point => {
        if (road?.modelTransform) {
            inverse.copy(road.modelTransform).invert();
            const v = inverse.transformPoint(w, new Vec3());
            return { x: v.x, y: v.y, z: v.z };
        }
        const o = draftOrigin ?? Vec3.ZERO;
        return { x: w.x - o.x, y: w.y - o.y, z: w.z - o.z };
    };
    const pointAt = (i: number): Point => ({ x: params.points[i * 3], y: params.points[i * 3 + 1], z: params.points[i * 3 + 2] });

    // ---- panel

    const panel = new Container({ id: 'toolkit-road-panel', class: 'panel' });
    ['pointerdown', 'pointerup', 'pointermove', 'wheel', 'dblclick'].forEach((eventName) => {
        panel.dom.addEventListener(eventName, (event: Event) => event.stopPropagation());
    });
    const header = new Container({ class: 'panel-header' });
    header.append(headerIcon(roadSvg));
    header.append(new Label({ text: 'Road Maker', class: 'panel-header-label' }));
    panel.append(header);
    const body = new Container({ class: 'toolkit-lighting-body' });
    panel.append(body);

    let target: Container = body;
    const row = (text: string, tip: string) => {
        const r = new Container({ class: 'toolkit-row' });
        const label = new Label({ text, class: 'toolkit-label' });
        r.append(label);
        tooltips.register(label, tip, 'left');
        target.append(r);
        return { row: r, label };
    };
    const slider = (text: string, tip: string, min: number, max: number, precision: number) => {
        const { row: r } = row(text, tip);
        const s = new SliderInput({ class: 'toolkit-slider', min, max, precision, step: Math.pow(10, -precision), value: min });
        r.append(s);
        tooltips.register(s, tip, 'bottom');
        return { row: r, input: s };
    };
    const logSlider = (text: string, tip: string, min: number, max: number) => {
        const { row: r, label } = row(text, tip);
        const s = new LogSlider(min, max, min);
        r.append(s);
        tooltips.register(s, tip, 'bottom');
        return { row: r, input: s, label };
    };
    const toggle = (text: string, tip: string) => {
        const { row: r } = row(text, tip);
        const t = new BooleanInput({ type: 'toggle', class: 'toolkit-toggle', value: false });
        r.append(t);
        tooltips.register(t, tip, 'bottom');
        return { row: r, input: t };
    };

    // style tiles
    const styleRow = new Container({ class: 'toolkit-road-styles' });
    const styleTiles = new Map<RoadStyle, Container>();
    (Object.keys(styles) as RoadStyle[]).forEach((style) => {
        const tile = new Container({ class: 'toolkit-road-style' });
        const swatch = document.createElement('img');
        swatch.className = 'toolkit-road-swatch';
        swatch.src = stylePreview(style);
        tile.dom.appendChild(swatch);
        tile.append(new Label({ text: styles[style].name, class: 'toolkit-road-style-name' }));
        tooltips.register(tile, `${styles[style].name}: ${styles[style].hint}`, 'bottom');
        tile.dom.addEventListener('click', () => setStyle(style));
        styleRow.append(tile);
        styleTiles.set(style, tile);
    });
    body.append(styleRow);
    const styleHint = new Label({ text: '', class: 'toolkit-hint' });
    body.append(styleHint);

    // path
    const pathRow = new Container({ class: 'toolkit-row' });
    const drawButton = new Button({ text: 'Draw road', class: 'toolkit-bake' });
    const newButton = new Button({ text: 'New road', class: 'toolkit-button' });
    pathRow.append(drawButton);
    pathRow.append(newButton);
    tooltips.register(drawButton, tips.draw, 'bottom');
    tooltips.register(newButton, tips.newRoad, 'bottom');
    body.append(pathRow);
    const status = new Label({ text: '', class: 'toolkit-hint' });
    body.append(status);

    // shape
    const shape = collapsible('Shape', 'road.shape', true);
    body.append(shape.root);
    target = shape.body;
    const width = logSlider('Width', tips.width, 0.05, 10);
    const follow = toggle('Follow ground', tips.follow);
    const lift = logSlider('Lift', tips.lift, 0.0005, 0.2);
    const rim = slider('Frayed edge', tips.rim, 0, 0.6, 2);
    const border = toggle('Border stones', tips.border);
    const curb = toggle('Curb', tips.curb);
    const curbSize = logSlider('Curb height', tips.curbHeight, 0.002, 0.5);

    // look
    const look = collapsible('Look', 'road.look', true);
    body.append(look.root);
    target = look.body;
    const patternSize = logSlider('Stone size', '', 0.005, 5);
    const patternRow = row('Pattern', tips.pattern);
    const pattern = new SelectInput({ class: 'toolkit-select', type: 'string', options: (Object.keys(patternTexts) as PaverPattern[]).map(v => ({ v, t: patternTexts[v] })), value: 'running' });
    patternRow.row.append(pattern);
    const tintRow = row('Tint', tips.tint);
    const tint = new ColorPicker({ class: 'toolkit-color', value: [1, 1, 1] });
    tintRow.row.append(tint);
    tooltips.register(tint, tips.tint, 'bottom');
    const colorVariation = slider('Colour var.', tips.colorVariation, 0, 1, 2);
    const wear = slider('Wear', tips.wear, 0, 1, 2);
    const moss = slider('Moss', tips.moss, 0, 1, 2);
    const seedRow = row('Seed', tips.seed);
    const seed = new SliderInput({ class: 'toolkit-slider', min: 1, max: 999, precision: 0, step: 1, value: 1 });
    const dice = new Button({ text: '🎲', class: 'toolkit-convert' });
    seedRow.row.append(seed);
    seedRow.row.append(dice);
    tooltips.register(dice, tips.dice, 'bottom');
    target = body;

    const actions = new Container({ class: 'toolkit-row' });
    const toSplats = new Button({ text: 'To splats', class: 'toolkit-button' });
    const download = new Button({ text: 'Download .glb', class: 'toolkit-button' });
    actions.append(toSplats);
    actions.append(download);
    tooltips.register(toSplats, tips.toSplats, 'bottom');
    tooltips.register(download, tips.download, 'bottom');
    body.append(actions);

    canvasContainer.append(panel);
    registerPanel(ctx, {
        id: 'roads',
        panel,
        header,
        icon: roadSvg,
        title: 'Road Maker',
        tooltip: tips.toggle,
        order: 2.6,
        onHide: () => {
            if (toolManager.active === TOOL) toolManager.activate(null);
        }
    });

    // ---- ui <-> params

    const updateStatus = () => {
        const road = current();
        const n = params.points.length / 3;
        const drawing = toolManager.active === TOOL;
        if (road) {
            status.text = `Editing ${road.name}: ${n} points.${drawing ? ' Click to add, drag to move, click the line to insert, Alt+click to remove.' : ' Draw road to change its path.'}`;
        } else if (draftOrigin) {
            status.text = 'Click the next point of the road.';
        } else {
            status.text = drawing ? 'Click on the scene to put down the road\'s first point.' : 'Press Draw road, then click on the scene to lay out a path.';
        }
        toSplats.enabled = !!road;
        drawButton.text = drawing ? 'Finish' : (road ? 'Edit path' : 'Draw road');
    };

    const updateUI = () => {
        uiUpdating = true;
        const info = styles[params.style];
        styleTiles.forEach((tile, style) => tile.class[style === params.style ? 'add' : 'remove']('active'));
        styleHint.text = info.hint;
        width.input.value = params.width;
        follow.input.value = params.followGround;
        lift.input.value = params.lift;
        rim.input.value = params.style === 'dirt' ? params.edge : 0.18;
        border.input.value = params.style !== 'dirt' && params.edge > 0;
        curb.input.value = params.curb > 0;
        if (params.curb > 0) curbHeight = params.curb;
        curbSize.input.value = curbHeight;
        patternSize.input.value = params.patternSize;
        patternSize.label.text = info.patternLabel;
        pattern.value = params.pattern;
        tint.value = params.tint;
        colorVariation.input.value = params.colorVariation;
        wear.input.value = params.wear;
        moss.input.value = params.moss;
        seed.value = params.seed;
        rim.row.hidden = params.style !== 'dirt';
        border.row.hidden = params.style !== 'cobble' && params.style !== 'pavers';
        curb.row.hidden = params.style === 'dirt';
        curbSize.row.hidden = params.style === 'dirt' || params.curb <= 0;
        patternRow.row.hidden = params.style !== 'pavers';
        moss.row.hidden = params.style !== 'cobble' && params.style !== 'pavers';
        shape.extra.dom.textContent = `${Number(params.width.toPrecision(3))} wide`;
        look.extra.dom.textContent = info.name;
        uiUpdating = false;
        updateStatus();
    };

    // ---- building

    const raycaster = new MeshRaycaster(scene, events, p => !p.generator);
    const { probe } = createSurfaceProbe(scene, raycaster);

    // the ground under road-space points: probed where they are in view
    const groundSampler = (road: MeshPrimitive | null) => async (pts: Point[]) => {
        const result: (number | null)[] = pts.map((): null => null);
        const w = scene.canvas.clientWidth;
        const h = scene.canvas.clientHeight;
        const camera = scene.camera.mainCamera;
        const eye = camera.getPosition();
        const forward = camera.forward;
        const stride = Math.max(1, Math.ceil(pts.length / MAX_PROBES));
        const pixels: { x: number, y: number }[] = [];
        const index: number[] = [];
        const worlds: Vec3[] = [];
        const screen = new Vec3();
        for (let i = 0; i < pts.length; i += stride) {
            const world = toWorld(road, pts[i]);
            if (world.clone().sub(eye).dot(forward) <= 0) continue;
            scene.camera.worldToScreen(world, screen);
            if (screen.x < 0.005 || screen.x > 0.995 || screen.y < 0.005 || screen.y > 0.995) continue;
            pixels.push({ x: screen.x * w, y: screen.y * h });
            index.push(i);
            worlds.push(world);
        }
        if (!pixels.length) return result;
        const hits = await probe(pixels, false);
        const tolerance = Math.max(params.width * 0.3, 1e-3);
        hits.forEach((hit, j) => {
            if (!hit) return;
            const at = worlds[j];
            if (Math.hypot(hit.position.x - at.x, hit.position.z - at.z) > tolerance) return;
            result[index[j]] = toLocal(road, hit.position).y;
        });
        return result;
    };

    let building = false;
    let buildAgain = false;
    const rebuild = async () => {
        if (building) {
            buildAgain = true;
            return;
        }
        if (params.points.length < 6) return;
        building = true;
        try {
            const road = current();
            if (road && !road.scene) return;
            const p = clone(params);
            if (!p.id) p.id = newId();
            const built = await buildRoad(p, groundSampler(road));
            if (!built) return;
            p.ground = built.ground;
            const options = { name: 'Road', generator: { type: 'road', params: p }, unitScale: 1 };
            if (road) {
                if (selectedRoad() === road) {
                    await events.invoke('toolkit.addGeneratedModel', built.glb, { ...options, replace: road });
                } else {
                    await events.invoke('toolkit.addGeneratedModels', [{ glb: built.glb, options: { ...options, replace: road } }]);
                }
            } else if (draftOrigin) {
                const o = draftOrigin;
                await events.invoke('toolkit.addGeneratedModels', [{ glb: built.glb, options: { ...options, anchor: [o.x, o.y, o.z], yaw: 0 } }]);
                draftOrigin = null;
            }
            editingId = p.id;
            params.id = p.id;
            params.ground = p.ground;
        } catch (error) {
            await events.invoke('showPopup', { type: 'error', header: 'Road Maker', message: (error as Error).message ?? String(error) });
        } finally {
            building = false;
            updateStatus();
            if (buildAgain) {
                buildAgain = false;
                rebuild();
            }
        }
    };

    // settings: rebuild a moment after the last change
    let timer = 0;
    const changed = (change: Partial<RoadParams>) => {
        if (uiUpdating) return;
        params = { ...params, ...change };
        updateUI();
        if (current() && params.points.length >= 6) {
            window.clearTimeout(timer);
            timer = window.setTimeout(rebuild, 300);
        }
    };

    function setStyle(style: RoadStyle) {
        const info = styles[style];
        changed({
            style,
            patternSize: info.patternSize * params.width,
            edge: info.edge,
            curb: info.curb * params.width,
            moss: style === 'cobble' ? 0.25 : 0,
            lift: params.lift
        });
    }

    width.input.on('change', (v: number) => changed({ width: v }));
    follow.input.on('change', (v: boolean) => changed({ followGround: v }));
    lift.input.on('change', (v: number) => changed({ lift: v }));
    rim.input.on('change', (v: number) => changed({ edge: v }));
    border.input.on('change', (v: boolean) => changed({ edge: v ? 1 : 0 }));
    curb.input.on('change', (v: boolean) => changed({ curb: v ? curbHeight : 0 }));
    curbSize.input.on('change', (v: number) => {
        curbHeight = v;
        if (params.curb > 0) changed({ curb: v });
    });
    patternSize.input.on('change', (v: number) => changed({ patternSize: v }));
    pattern.on('change', (v: PaverPattern) => changed({ pattern: v }));
    tint.on('change', (v: number[]) => changed({ tint: [v[0], v[1], v[2]] }));
    colorVariation.input.on('change', (v: number) => changed({ colorVariation: v }));
    wear.input.on('change', (v: number) => changed({ wear: v }));
    moss.input.on('change', (v: number) => changed({ moss: v }));
    seed.on('change', (v: number) => changed({ seed: Math.round(v) }));
    dice.on('click', () => changed({ seed: 1 + Math.floor(Math.random() * 998) }));

    toSplats.on('click', async () => {
        const road = current();
        if (road) await events.invoke('toolkit.convertPrimitives', [road], { hideLights: false });
    });
    download.on('click', async () => {
        if (params.points.length < 6) return;
        const built = await buildRoad(clone(params), groundSampler(current()));
        if (!built) return;
        const url = URL.createObjectURL(new Blob([built.glb], { type: 'model/gltf-binary' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = `road_${params.style}.glb`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    });

    // a road selected anywhere (outliner, viewport) becomes the one edited
    events.on('toolkit.primitive.selected', (p: MeshPrimitive | null) => {
        if (p?.generator?.type !== 'road') {
            updateStatus();
            return;
        }
        editingId = p.generator.params.id;
        draftOrigin = null;
        params = clone(p.generator.params);
        updateUI();
    });

    // undo / redo bring back another version of the road: follow it
    let dragging = -1;
    events.on('scene.elementAdded', (e: unknown) => {
        if (e instanceof MeshPrimitive && e.generator?.type === 'road' && e.generator.params.id === editingId && dragging < 0 && !building) {
            params = clone(e.generator.params);
            updateUI();
        }
    });

    // ---- the pen tool

    const parent = ctx.toolsContainer.dom;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.classList.add('tool-svg', 'hidden');
    svg.id = 'toolkit-road-svg';
    const line = document.createElementNS(svg.namespaceURI, 'polyline') as SVGPolylineElement;
    const handles = document.createElementNS(svg.namespaceURI, 'g') as SVGGElement;
    const ghost = document.createElementNS(svg.namespaceURI, 'circle') as SVGCircleElement;
    ghost.setAttribute('r', '5');
    ghost.classList.add('ghost');
    svg.appendChild(line);
    svg.appendChild(handles);
    svg.appendChild(ghost);
    parent.appendChild(svg);

    // screen positions of the handles and of the line, from the last draw
    let handleScreen: { x: number, y: number }[] = [];
    let lineScreen: { x: number, y: number, segment: number }[] = [];
    let lineFor = '';
    let lineCache: Centerline | null = null;

    const project = (w: Vec3, out: { x: number, y: number }) => {
        const camera = scene.camera.mainCamera;
        if (w.clone().sub(camera.getPosition()).dot(camera.forward) <= 0) return false;
        const s = new Vec3();
        scene.camera.worldToScreen(w, s);
        out.x = s.x * scene.canvas.clientWidth;
        out.y = s.y * scene.canvas.clientHeight;
        return true;
    };

    const draw = () => {
        if (toolManager.active !== TOOL) return;
        const road = current();
        const n = params.points.length / 3;
        // handles
        while (handles.firstChild) handles.removeChild(handles.firstChild);
        handleScreen = [];
        for (let i = 0; i < n; ++i) {
            const at = { x: -1e6, y: -1e6 };
            if (project(toWorld(road, pointAt(i)), at)) {
                const c = document.createElementNS(svg.namespaceURI, 'circle');
                c.setAttribute('cx', at.x.toFixed(1));
                c.setAttribute('cy', at.y.toFixed(1));
                c.setAttribute('r', i === dragging ? '7' : '6');
                if (i === 0 || i === n - 1) c.classList.add('end');
                handles.appendChild(c);
            }
            handleScreen.push(at);
        }
        // the road's middle line
        const key = JSON.stringify([params.points, params.width, params.style, params.patternSize, params.pattern]);
        if (key !== lineFor) {
            lineFor = key;
            lineCache = n >= 2 ? centerline(params) : null;
        }
        lineScreen = [];
        if (lineCache) {
            const pts: string[] = [];
            const step = Math.max(1, Math.floor(lineCache.count / 400));
            for (let i = 0; i < lineCache.count; i += step) {
                const at = { x: 0, y: 0 };
                if (!project(toWorld(road, { x: lineCache.x[i], y: lineCache.y[i], z: lineCache.z[i] }), at)) continue;
                pts.push(`${at.x.toFixed(1)},${at.y.toFixed(1)}`);
                lineScreen.push({ ...at, segment: lineCache.segment[i] });
            }
            line.setAttribute('points', pts.join(' '));
        } else {
            line.setAttribute('points', '');
        }
    };
    events.on('postrender', draw);

    const handleAt = (x: number, y: number) => {
        let best = -1;
        let bestD = HANDLE_PX;
        handleScreen.forEach((h, i) => {
            const d = Math.hypot(h.x - x, h.y - y);
            if (d <= bestD) {
                bestD = d;
                best = i;
            }
        });
        return best;
    };
    const lineAt = (x: number, y: number) => {
        let best: number | null = null;
        let bestD = LINE_PX;
        for (let i = 1; i < lineScreen.length; ++i) {
            const a = lineScreen[i - 1];
            const b = lineScreen[i];
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const ll = dx * dx + dy * dy;
            const t = ll > 0 ? Math.min(1, Math.max(0, ((x - a.x) * dx + (y - a.y) * dy) / ll)) : 0;
            const d = Math.hypot(a.x + dx * t - x, a.y + dy * t - y);
            if (d < bestD) {
                bestD = d;
                best = t < 0.5 ? a.segment : b.segment;
            }
        }
        return best;
    };

    const surfaceAt = async (x: number, y: number) => {
        const [hit] = await probe([{ x, y }], false);
        return hit ? hit.position.clone() : null;
    };

    const setPoint = (i: number, p: Point) => {
        params.points[i * 3] = p.x;
        params.points[i * 3 + 1] = p.y;
        params.points[i * 3 + 2] = p.z;
    };

    const addPoint = async (world: Vec3) => {
        const road = current();
        if (!road && !draftOrigin) {
            // a new road: its space starts at the first point
            draftOrigin = world.clone();
            params = { ...params, id: '', points: [0, 0, 0], ground: [] };
            updateStatus();
            return;
        }
        const p = toLocal(road, world);
        params.points.push(p.x, p.y, p.z);
        updateStatus();
        await rebuild();
    };

    let dragPointer = -1;
    let dragBusy = false;
    let dragAt: { x: number, y: number } | null = null;
    // the button came up while the click was still finding the surface
    let releasedEarly = false;

    const pointerdown = async (e: PointerEvent) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        if (building) return;
        const x = e.offsetX;
        const y = e.offsetY;
        const h = handleAt(x, y);
        const n = params.points.length / 3;
        if (h >= 0) {
            if (e.altKey) {
                // remove a point: a road keeps two
                if (n > 2) {
                    params.points.splice(h * 3, 3);
                    await rebuild();
                } else if (!current()) {
                    draftOrigin = null;
                    params.points = [];
                } else {
                    status.text = 'A road needs at least two points. Delete the whole road in the Meshes list.';
                }
                updateStatus();
                return;
            }
            dragging = h;
            dragPointer = e.pointerId;
            parent.setPointerCapture(e.pointerId);
            return;
        }
        // the surface is found asynchronously: hold the pointer meanwhile
        const segment = n >= 2 ? lineAt(x, y) : null;
        dragPointer = e.pointerId;
        releasedEarly = false;
        parent.setPointerCapture(e.pointerId);
        const world = await surfaceAt(x, y);
        if (!world) {
            status.text = 'Nothing under the cursor to put the road on.';
            releaseCapture();
            return;
        }
        if (segment !== null) {
            // insert into the line, and keep dragging it
            const p = toLocal(current(), world);
            params.points.splice((segment + 1) * 3, 0, p.x, p.y, p.z);
            dragging = segment + 1;
            updateStatus();
            if (releasedEarly) endDrag();
            return;
        }
        releaseCapture();
        await addPoint(world);
    };

    const followDrag = async () => {
        if (dragBusy || !dragAt || dragging < 0) return;
        dragBusy = true;
        const at = dragAt;
        try {
            const world = await surfaceAt(at.x, at.y);
            if (world && dragging >= 0) {
                setPoint(dragging, toLocal(current(), world));
                scene.forceRender = true;
            }
        } finally {
            dragBusy = false;
        }
        if (dragAt !== at) followDrag();
    };

    const pointermove = (e: PointerEvent) => {
        const x = e.offsetX;
        const y = e.offsetY;
        if (dragging >= 0 && e.pointerId === dragPointer) {
            e.preventDefault();
            e.stopPropagation();
            dragAt = { x, y };
            followDrag();
            ghost.setAttribute('cx', '-100');
            return;
        }
        // where an insert would go
        const onLine = handleAt(x, y) < 0 && params.points.length >= 6 && lineAt(x, y) !== null;
        ghost.setAttribute('cx', onLine ? `${x}` : '-100');
        ghost.setAttribute('cy', `${y}`);
        parent.style.cursor = handleAt(x, y) >= 0 ? (e.altKey ? 'not-allowed' : 'move') : onLine ? 'copy' : 'crosshair';
    };

    function releaseCapture() {
        if (dragPointer >= 0 && parent.hasPointerCapture(dragPointer)) parent.releasePointerCapture(dragPointer);
        dragPointer = -1;
    }
    async function endDrag() {
        releaseCapture();
        dragAt = null;
        const was = dragging;
        dragging = -1;
        if (was >= 0) await rebuild();
    }
    const pointerup = (e: PointerEvent) => {
        if (e.pointerId !== dragPointer) return;
        e.preventDefault();
        e.stopPropagation();
        if (dragging < 0) {
            releasedEarly = true;
            return;
        }
        endDrag();
    };
    const keydown = (e: KeyboardEvent) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            toolManager.activate(null);
        }
    };

    toolManager.register(TOOL, {
        activate: () => {
            svg.classList.remove('hidden');
            parent.style.display = 'block';
            parent.addEventListener('pointerdown', pointerdown);
            parent.addEventListener('pointermove', pointermove);
            parent.addEventListener('pointerup', pointerup);
            window.addEventListener('keydown', keydown, true);
            updateStatus();
            scene.forceRender = true;
        },
        deactivate: () => {
            endDrag();
            // a road with a single point is no road
            if (draftOrigin) {
                draftOrigin = null;
                params.points = [];
            }
            svg.classList.add('hidden');
            parent.style.display = 'none';
            parent.style.cursor = '';
            parent.removeEventListener('pointerdown', pointerdown);
            parent.removeEventListener('pointermove', pointermove);
            parent.removeEventListener('pointerup', pointerup);
            window.removeEventListener('keydown', keydown, true);
            updateStatus();
        }
    });
    events.on('tool.activated', (name: string | null) => {
        drawButton.class[name === TOOL ? 'add' : 'remove']('active');
        updateStatus();
    });
    drawButton.on('click', () => {
        if (toolManager.active === TOOL) {
            toolManager.activate(null);
            return;
        }
        // keep editing the selected road, if there is one
        const road = selectedRoad();
        if (road) editingId = road.generator.params.id;
        events.fire(`tool.${TOOL}`);
    });
    newButton.on('click', () => {
        editingId = '';
        draftOrigin = null;
        params = { ...params, id: '', points: [], ground: [] };
        if (selectedRoad()) events.invoke('toolkit.meshes.select', null);
        if (toolManager.active !== TOOL) events.fire(`tool.${TOOL}`);
        updateUI();
    });

    // for tests and other modules: draw a road through viewport pixels
    events.function('toolkit.roads.draw', async (pixels: { x: number, y: number }[]) => {
        for (const px of pixels) {
            const world = await surfaceAt(px.x, px.y);
            if (world) await addPoint(world);
        }
        return current();
    });
    events.function('toolkit.roads.set', (change: Partial<RoadParams>) => changed(change));
    events.function('toolkit.roads.params', () => clone(params));

    // sizes follow the scene when the panel first opens on it
    let sizedFor = -1;
    events.on('toolkit.panel.roads.visible', (visible: boolean) => {
        if (!visible) return;
        const size = Math.max(0.1, scene.bound ? scene.bound.halfExtents.length() : 2);
        if (Math.abs(size - sizedFor) > 1e-6 && !roads().length && !current()) {
            sizedFor = size;
            const w = Math.max(0.01, size * 0.12);
            params = { ...defaultRoad(w, params.style), seed: params.seed };
            curbHeight = w * 0.06;
        }
        width.input.setRange(size * 0.01, size);
        lift.input.setRange(size * 0.0002, size * 0.05);
        patternSize.input.setRange(size * 0.002, size * 1.5);
        curbSize.input.setRange(size * 0.002, size * 0.1);
        updateUI();
    });

    updateUI();
};

const roadsModule: ToolkitModule = {
    id: 'roads',
    init
};

export { roadsModule };
