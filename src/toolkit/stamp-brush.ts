import { BooleanInput, Button, Container, Label, SelectInput, SliderInput } from '@playcanvas/pcui';
import { Ray, Vec3 } from 'playcanvas';

import { MultiOp } from '../edit-ops';
import { ElementType } from '../element';
import { Splat } from '../splat';
import stampSvg from './icons/stamp.svg';
import { MemorySink } from './memory-sink';
import { MeshRaycaster } from './mesh-raycast';
import { headerIcon, registerPanel } from './panels';
import { COPY, StampStrokeOp, createStampLayer, eraseCopies, liveCopies, stampLayerData } from './stamp-layer';
import { deleteStamp, loadStamps, saveStamp } from './stamp-library';
import {
    Quat, Stamp, Vec,
    createRandom, cross, floatsOf, makeStamp, normalize, parsePly, placeStamp,
    quatAxisAngle, quatBetween, quatConj, quatMul, quatRotate, stampFromPly, stampThumbnail, stampToPly
} from './stamp-math';

import type { ToolkitContext, ToolkitModule } from './index';

// Stamp brush: capture a patch of selected gaussians as a stamp, then paint
// copies of it onto the surfaces of the scene - splats as well as mesh
// primitives and models. Each copy sits on the surface point under the stroke,
// turned to follow the surface there. Every stroke is one undo step, and an
// eraser takes whole copies off again.

const TOOL = 'toolkitStamp';
const MAX_SAMPLES = 240;            // surface probes per stroke
const MAX_GAUSSIANS = 6_000_000;    // per stamp layer
const NORMAL_PROBE = 6;             // px: offset of the two extra probes the surface normal is taken from
const THUMB = 56;                   // px, drawn at half size
const HOVER_INTERVAL = 70;          // ms between hover probes for the preview

type Mode = 'paint' | 'erase';
type Orient = 'surface' | 'up' | 'captured';

type Entry = {
    id: string;
    stamp: Stamp;
    active: boolean;
    order: number;
};

type Hit = { position: Vec3, normal: Vec3 };

const tips = {
    capture: 'Turn the currently selected splats into a stamp and add it to the library. Select a patch with any selection tool first - a flat piece of surface, a pebble, a tuft of grass.',
    load: 'Add stamps from .ply files (stamps saved with Save, or any splat file - it is laid flat on its thinnest side).',
    save: 'Save the highlighted stamp as a .ply file, to keep it or use it in another project.',
    library: 'Stamps are kept in this browser, so they are still here next time. Click a name to paint with that stamp alone; tick several to scatter a random mix of them.',
    paint: 'Paint: click to place one copy, or drag over a surface to place copies along the stroke. Works on splats and on mesh primitives / models. Every stroke is one undo step (Ctrl+Z). Press again to stop.',
    erase: 'Erase: click or drag over painted copies to take them off again, whole. Undo brings them back.',
    orient: 'How each copy is turned: lie on the surface under it, stand upright (world up), or keep the orientation the patch was captured in.',
    size: 'Size of each copy relative to the captured patch (1 = original size).',
    spacing: 'Distance between copies along a stroke, in stamp widths. Below 1 the copies overlap, above 1 they leave gaps.',
    scatter: 'Random sideways offset of each copy from the stroke, in stamp widths. 0 keeps every copy on the line.',
    spin: 'Random turn of each copy around its up axis, in degrees either way. 0 keeps every copy turned the same; 180 hides the repetition best.',
    jitter: 'Random size variation between copies (0 = all the same size, 0.5 = up to 50% larger or smaller).',
    tone: 'Random brightness variation between copies, so a repeated stamp looks less like a copy.',
    feather: 'Fades each copy out towards its rim, so overlapping copies blend instead of meeting at a visible edge. 0 = hard edge.',
    lift: 'Moves each copy along its up axis, in stamp widths: below 0 it sinks into the surface, above 0 it floats above it.',
    layer: 'The splat layer strokes go into. Select a stamp layer in the layer list to paint into it again.',
    newLayer: 'Put the next stroke into a new stamp layer.'
};

const toPly = (v: Vec3): Vec => [-v.x, -v.y, v.z];
const fromPly = (v: Vec): Vec3 => new Vec3(-v[0], -v[1], v[2]);

// world -> a layer's file space (and the same for rotations and sizes)
type Frame = { toFile: (e: Vec) => Vec, rotate: (q: Quat) => Quat, scale: number, fromFile: (f: Vec) => Vec3 };

const identityFrame: Frame = {
    toFile: e => e,
    rotate: q => q,
    scale: 1,
    fromFile: f => fromPly(f)
};

const frameOf = (splat: Splat | null): Frame => {
    if (!splat) return identityFrame;
    const p = splat.entity.getPosition();
    const r = splat.entity.getRotation();
    const s = splat.entity.getWorldTransform().getScale().x || 1;
    const qw: Quat = [r.w, r.x, r.y, r.z];
    const qInv = quatConj(qw);
    // PLY space -> world is a half turn about z
    const toFileRot = quatMul(qInv, [0, 0, 0, 1]);
    return {
        toFile: (e) => {
            const d = quatRotate(qInv, [-e[0] - p.x, -e[1] - p.y, e[2] - p.z]);
            return [d[0] / s, d[1] / s, d[2] / s];
        },
        rotate: q => quatMul(toFileRot, q),
        scale: 1 / s,
        fromFile: (f) => {
            const w = quatRotate(qw, [f[0] * s, f[1] * s, f[2] * s]);
            return new Vec3(w[0] + p.x, w[1] + p.y, w[2] + p.z);
        }
    };
};

const init = (ctx: ToolkitContext) => {
    const { events, scene, toolManager, canvasContainer, toolsContainer, tooltips } = ctx;
    const parent = toolsContainer.dom;
    const raycaster = new MeshRaycaster(scene, events);

    const entries: Entry[] = [];
    let highlighted: Entry | null = null;
    let mode: Mode = 'paint';
    let lastLayer: Splat | null = null;
    let forceNew = false;
    let busy = false;
    let strokeCounter = 0;

    // ---- ui

    const panel = new Container({ id: 'toolkit-stamp-panel', class: 'panel' });
    ['pointerdown', 'pointerup', 'pointermove', 'wheel', 'dblclick'].forEach((eventName) => {
        panel.dom.addEventListener(eventName, (event: Event) => event.stopPropagation());
    });

    const header = new Container({ class: 'panel-header' });
    header.append(headerIcon(stampSvg));
    header.append(new Label({ text: 'Stamp brush', class: 'panel-header-label' }));
    panel.append(header);

    const body = new Container({ class: 'toolkit-stamp-body' });
    panel.append(body);

    const section = (text: string) => body.append(new Label({ text, class: 'toolkit-section' }));
    const hint = (text = '') => new Label({ text, class: 'toolkit-hint' });
    const row = () => new Container({ class: 'toolkit-row' });

    // library
    section('Stamps');
    const libraryButtons = row();
    const capture = new Button({ text: 'Capture selection', class: 'toolkit-button' });
    const loadButton = new Button({ text: 'Load…', class: 'toolkit-convert' });
    const saveButton = new Button({ text: 'Save…', class: 'toolkit-convert', enabled: false });
    libraryButtons.append(capture);
    libraryButtons.append(loadButton);
    libraryButtons.append(saveButton);
    body.append(libraryButtons);
    tooltips.register(capture, tips.capture, 'bottom');
    tooltips.register(loadButton, tips.load, 'bottom');
    tooltips.register(saveButton, tips.save, 'bottom');

    const list = new Container({ class: ['toolkit-checklist', 'toolkit-stamp-list'] });
    body.append(list);
    tooltips.register(list, tips.library, 'left');
    const libraryHint = hint();
    body.append(libraryHint);

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.ply';
    fileInput.multiple = true;
    fileInput.style.display = 'none';
    panel.dom.appendChild(fileInput);

    // brush
    section('Brush');
    const modeRow = row();
    const paintButton = new Button({ text: 'Paint', class: 'toolkit-button', enabled: false });
    const eraseButton = new Button({ text: 'Erase', class: 'toolkit-button' });
    modeRow.append(paintButton);
    modeRow.append(eraseButton);
    body.append(modeRow);
    tooltips.register(paintButton, tips.paint, 'bottom');
    tooltips.register(eraseButton, tips.erase, 'bottom');

    const orientRow = row();
    const orientLabel = new Label({ text: 'Orientation', class: 'toolkit-label' });
    const orientSelect = new SelectInput({
        class: 'toolkit-select',
        type: 'string',
        options: [
            { v: 'surface', t: 'Lie on the surface' },
            { v: 'up', t: 'Stand upright' },
            { v: 'captured', t: 'As captured' }
        ],
        value: 'surface'
    });
    orientRow.append(orientLabel);
    orientRow.append(orientSelect);
    body.append(orientRow);
    tooltips.register(orientLabel, tips.orient, 'left');
    tooltips.register(orientSelect, tips.orient, 'bottom');

    const sliderRow = (text: string, tip: string, args: { min: number, max: number, precision: number, value: number }) => {
        const r = row();
        const label = new Label({ text, class: 'toolkit-label' });
        const slider = new SliderInput({ class: 'toolkit-slider', ...args });
        r.append(label);
        r.append(slider);
        body.append(r);
        tooltips.register(label, tip, 'left');
        tooltips.register(slider, tip, 'bottom');
        return slider;
    };

    const size = sliderRow('Size', tips.size, { min: 0.1, max: 4, precision: 2, value: 1 });
    const spacing = sliderRow('Spacing', tips.spacing, { min: 0.1, max: 3, precision: 2, value: 0.8 });
    const scatter = sliderRow('Scatter', tips.scatter, { min: 0, max: 3, precision: 2, value: 0 });
    const spin = sliderRow('Spin', tips.spin, { min: 0, max: 180, precision: 0, value: 180 });
    const jitter = sliderRow('Size var.', tips.jitter, { min: 0, max: 0.9, precision: 2, value: 0.15 });
    const tone = sliderRow('Tone var.', tips.tone, { min: 0, max: 0.5, precision: 2, value: 0 });
    const feather = sliderRow('Feather', tips.feather, { min: 0, max: 1, precision: 2, value: 0.3 });
    const lift = sliderRow('Lift', tips.lift, { min: -0.5, max: 0.5, precision: 2, value: 0 });

    // target layer
    section('Layer');
    const layerRow = row();
    const layerLabel = new Label({ text: 'New layer', class: ['toolkit-check-name', 'toolkit-stamp-layer'] });
    const newLayer = new Button({ text: 'New layer', class: 'toolkit-convert' });
    layerRow.append(layerLabel);
    layerRow.append(newLayer);
    body.append(layerRow);
    tooltips.register(layerLabel, tips.layer, 'left');
    tooltips.register(newLayer, tips.newLayer, 'bottom');
    const status = hint();
    body.append(status);

    canvasContainer.append(panel);

    registerPanel(ctx, {
        id: 'stamp',
        panel,
        header,
        icon: stampSvg,
        title: 'Stamp brush',
        tooltip: 'Stamp brush: capture selected splats as a stamp and paint copies of it onto surfaces.',
        order: 3,
        // painting needs the panel's controls
        onHide: () => {
            if (toolManager.active === TOOL) toolManager.activate(null);
        }
    });

    // cursor, footprint preview and stroke, drawn over the viewport while the tool is active
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.classList.add('tool-svg', 'hidden');
    svg.id = 'toolkit-stamp-svg';
    const path = document.createElementNS(svg.namespaceURI, 'polyline') as SVGPolylineElement;
    const footprint = document.createElementNS(svg.namespaceURI, 'polygon') as SVGPolygonElement;
    footprint.classList.add('toolkit-stamp-footprint');
    const cursor = document.createElementNS(svg.namespaceURI, 'circle') as SVGCircleElement;
    cursor.setAttribute('r', '4');
    svg.appendChild(footprint);
    svg.appendChild(path);
    svg.appendChild(cursor);
    parent.appendChild(svg);

    const splats = () => scene.getElementsByType(ElementType.splat) as Splat[];

    const error = (message: string) => events.invoke('showPopup', { type: 'error', header: 'Stamp brush', message });

    // ---- library

    const activeEntries = () => entries.filter(e => e.active);

    const refreshButtons = () => {
        paintButton.enabled = activeEntries().length > 0;
        saveButton.enabled = !!highlighted;
        if (!paintButton.enabled && toolManager.active === TOOL && mode === 'paint') {
            toolManager.activate(null);
        }
    };

    const describeBrush = () => {
        const active = activeEntries();
        if (entries.length === 0) {
            libraryHint.text = 'No stamps yet: select a patch of splats, then press Capture selection.';
        } else if (active.length === 0) {
            libraryHint.text = 'Tick a stamp to paint with it.';
        } else if (active.length === 1) {
            libraryHint.text = `Painting with ${active[0].stamp.name}.`;
        } else {
            libraryHint.text = `Scattering a random mix of ${active.length} stamps.`;
        }
    };

    const thumbnail = (stamp: Stamp) => {
        const canvas = document.createElement('canvas');
        canvas.width = THUMB;
        canvas.height = THUMB;
        canvas.className = 'toolkit-stamp-thumb';
        const context = canvas.getContext('2d');
        if (context) {
            context.putImageData(new ImageData(stampThumbnail(stamp, THUMB), THUMB, THUMB), 0, 0);
        }
        return canvas;
    };

    const persist = (entry: Entry) => {
        saveStamp({ id: entry.id, name: entry.stamp.name, ply: stampToPly(entry.stamp), order: entry.order });
    };

    const rebuildList = () => {
        list.clear();
        list.hidden = entries.length === 0;
        entries.forEach((entry) => {
            const r = new Container({ class: ['toolkit-check-row', 'toolkit-stamp-row'] });
            if (entry === highlighted) r.class.add('selected');
            const box = new BooleanInput({ type: 'checkbox', value: entry.active });
            const name = new Label({ text: entry.stamp.name, class: 'toolkit-check-name' });
            const count = new Label({ text: entry.stamp.count.toLocaleString(), class: 'toolkit-check-kind' });
            const remove = new Label({ text: '✕', class: 'toolkit-stamp-remove' });
            r.append(box);
            r.dom.appendChild(thumbnail(entry.stamp));
            r.append(name);
            r.append(count);
            r.append(remove);
            box.on('change', (value: boolean) => {
                entry.active = value;
                if (value) highlighted = entry;
                rebuildList();
            });
            // a click on the name paints with this stamp alone
            name.dom.addEventListener('click', () => {
                entries.forEach((e) => {
                    e.active = e === entry;
                });
                highlighted = entry;
                rebuildList();
            });
            remove.dom.addEventListener('click', () => {
                entries.splice(entries.indexOf(entry), 1);
                if (highlighted === entry) highlighted = entries.find(e => e.active) ?? null;
                deleteStamp(entry.id);
                rebuildList();
            });
            tooltips.register(remove, 'Remove this stamp from the library', 'bottom');
            list.append(r);
        });
        refreshButtons();
        describeBrush();
    };

    let entryCounter = 0;
    const addEntry = (stamp: Stamp, store = true, id?: string, order?: number) => {
        const entry: Entry = {
            id: id ?? `${Date.now().toString(36)}-${(entryCounter++).toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
            stamp,
            active: true,
            order: order ?? Date.now() + entryCounter
        };
        entries.push(entry);
        if (store) {
            // a fresh stamp is the one to paint with
            entries.forEach((e) => {
                e.active = e === entry;
            });
            persist(entry);
        } else {
            entry.active = entries.length === 1;
        }
        highlighted = entry.active ? entry : highlighted;
        rebuildList();
        return entry;
    };

    const nextStampName = () => {
        const names = new Set(entries.map(e => e.stamp.name));
        let n = entries.length + 1;
        while (names.has(`Stamp ${n}`)) n++;
        return `Stamp ${n}`;
    };

    // restore the library of earlier sessions
    loadStamps().then(async (stored) => {
        for (const s of stored) {
            try {
                const stamp = stampFromPly(await s.ply.arrayBuffer(), s.name);
                stamp.name = s.name;
                addEntry(stamp, false, s.id, s.order);
            } catch (e) {
                console.warn('stamp library: skipping', s.name, e);
            }
        }
        rebuildList();
    });
    rebuildList();

    // ---- capture

    const captureStamp = async () => {
        const selected = splats().reduce((sum, splat) => sum + (splat.visible ? splat.numSelected : 0), 0);
        if (selected === 0) {
            libraryHint.text = 'Nothing is selected: select some splats first.';
            return 0;
        }
        const sink = new MemorySink();
        const written = await events.invoke('scene.write', 'ply', {
            filename: 'stamp.ply',
            splatIdx: 'all',
            serializeSettings: { maxSHBands: 3, selected: true }
        }, sink);
        if (!written) {
            return 0;       // the exporter already reported the error
        }
        const { rows, rest } = parsePly(await sink.blob().arrayBuffer());
        if (rows.length === 0) {
            libraryHint.text = 'Nothing is selected: select some splats first.';
            return 0;
        }
        const stamp = makeStamp(rows, rest, toPly(scene.camera.mainCamera.getPosition()), nextStampName());
        addEntry(stamp);
        return stamp.count;
    };

    const loadFiles = async (files: File[]) => {
        for (const file of files) {
            try {
                addEntry(stampFromPly(await file.arrayBuffer(), file.name.replace(/\.ply$/i, '')));
            } catch (e) {
                await error(`${file.name}: ${(e as Error).message ?? e}`);
            }
        }
    };

    const saveHighlighted = () => {
        if (!highlighted) return;
        const url = URL.createObjectURL(stampToPly(highlighted.stamp));
        const link = document.createElement('a');
        link.href = url;
        link.download = `${highlighted.stamp.name.replace(/[\\/:*?"<>|]+/g, '_')}.ply`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
    };

    // ---- target layer

    const isLive = (splat: Splat | null) => !!splat && splat.scene === scene && !!stampLayerData(splat);

    const targetLayer = (): Splat | null => {
        if (forceNew) return null;
        const selection = events.invoke('selection') as Splat | null;
        if (isLive(selection)) return selection;
        return isLive(lastLayer) ? lastLayer : null;
    };

    const updateLayerLabel = () => {
        const layer = targetLayer();
        layerLabel.text = layer ? layer.name : 'A new stamp layer';
        layerLabel.class[layer ? 'remove' : 'add']('dimmed');
    };

    const nextLayerName = () => {
        const names = new Set(splats().map(s => s.name));
        let n = 1;
        while (names.has(`Stamps ${n}`)) n++;
        return `Stamps ${n}`;
    };

    // ---- surface probes

    const snapshotPose = () => ({
        position: scene.camera.mainCamera.getPosition().clone(),
        rotation: scene.camera.mainCamera.getRotation().clone(),
        orthoHeight: scene.camera.camera.orthoHeight,
        near: scene.camera.near,
        far: scene.camera.far
    });

    // the nearest surface - splat or mesh - under each viewport pixel. With
    // `normals` every pixel is probed three times and splat hits get a normal
    // from the two neighbouring probes; mesh hits have their exact normal.
    const ray = new Ray();
    const probe = async (pixels: { x: number, y: number }[], normals: boolean): Promise<(Hit | null)[]> => {
        // without `normals`, splat hits face the camera
        const width = scene.canvas.clientWidth || 1;
        const height = scene.canvas.clientHeight || 1;
        const canvas = scene.canvas;
        const points: { x: number, y: number }[] = [];
        pixels.forEach(({ x, y }) => {
            points.push({ x: x / width, y: y / height });
            if (normals) {
                points.push({ x: (x + NORMAL_PROBE) / width, y: y / height });
                points.push({ x: x / width, y: (y + NORMAL_PROBE) / height });
            }
        });

        // mesh rays under the current camera, before anything can move it
        await raycaster.update();
        const pose = snapshotPose();
        const rays = points.map(({ x, y }) => {
            scene.camera.getRay(x * canvas.clientWidth, y * canvas.clientHeight, ray);
            const direction = ray.direction.clone().normalize();
            const origin = ray.origin.clone();
            return { origin, direction, mesh: raycaster.cast(origin, direction) };
        });

        const visible = splats().filter(splat => splat.visible);
        const splatHits = visible.length ? await scene.camera.intersectMany(points, visible, pose) : points.map((): null => null);

        // a pixel the splats barely cover reads back an unstable depth, which can
        // land far off in space: only trust hits inside the scene's bounds
        const bound = scene.bound;
        const slack = bound ? Math.max(bound.halfExtents.x, bound.halfExtents.y, bound.halfExtents.z) * 0.1 + 1e-3 : 0;
        const inScene = (p: Vec3) => !bound || (
            Math.abs(p.x - bound.center.x) <= bound.halfExtents.x + slack &&
            Math.abs(p.y - bound.center.y) <= bound.halfExtents.y + slack &&
            Math.abs(p.z - bound.center.z) <= bound.halfExtents.z + slack
        );

        const nearest = rays.map(({ origin, mesh }, i) => {
            const s = splatHits[i] && inScene(splatHits[i].position) ? splatHits[i] : null;
            const st = s ? s.position.distance(origin) : Infinity;
            if (mesh && mesh.t <= st) return { position: mesh.position, normal: mesh.normal, mesh: true };
            return s ? { position: s.position, normal: origin.clone().sub(s.position).normalize(), mesh: false } : null;
        });

        if (!normals) return nearest;

        const camera = scene.camera.mainCamera.getPosition();
        return pixels.map((_, i) => {
            const hit = nearest[i * 3];
            if (!hit) return null;
            if (hit.mesh) return hit;
            const toEye = camera.clone().sub(hit.position).normalize();
            const hx = nearest[i * 3 + 1];
            const hy = nearest[i * 3 + 2];
            let normal = toEye;
            if (hx && hy) {
                const n = new Vec3().cross(hx.position.clone().sub(hit.position), hy.position.clone().sub(hit.position)).normalize();
                if (n.dot(toEye) < 0) n.mulScalar(-1);
                // a normal almost edge-on to the view comes from a depth jump
                // between the probes, not from the surface
                if (n.dot(toEye) > 0.17) normal = n;
            }
            return { position: hit.position, normal };
        });
    };

    // evenly resample a stroke given in viewport pixels
    const resample = (stroke: { x: number, y: number }[]) => {
        const lengths = [0];
        for (let i = 1; i < stroke.length; ++i) {
            lengths.push(lengths[i - 1] + Math.hypot(stroke[i].x - stroke[i - 1].x, stroke[i].y - stroke[i - 1].y));
        }
        const total = lengths[lengths.length - 1];
        const numSamples = Math.max(1, Math.min(MAX_SAMPLES, Math.round(total / 3) + 1));
        const samples: { x: number, y: number }[] = [];
        let segment = 0;
        for (let i = 0; i < numSamples; ++i) {
            const at = numSamples === 1 ? 0 : total * i / (numSamples - 1);
            while (segment < stroke.length - 2 && lengths[segment + 1] < at) segment++;
            const span = (lengths[segment + 1] ?? 0) - lengths[segment];
            const f = span > 0 ? (at - lengths[segment]) / span : 0;
            const a = stroke[segment];
            const b = stroke[Math.min(segment + 1, stroke.length - 1)];
            samples.push({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f });
        }
        return samples;
    };

    const averageRadius = (list: Entry[]) => list.reduce((sum, e) => sum + e.stamp.radius, 0) / Math.max(1, list.length);

    // the up axis a copy is turned about, in PLY space
    const upAxis = (orient: Orient, normal: Vec, stamp: Stamp): Vec => {
        if (orient === 'surface') return normal;
        if (orient === 'up') return [0, -1, 0];
        return stamp.normal;
    };

    // ---- painting

    type Placement = { entry: Entry, point: Vec, normal: Vec, q: Quat, k: number, tone: number };

    const paint = async (stroke: { x: number, y: number }[]) => {
        const active = activeEntries();
        if (active.length === 0 || busy || stroke.length === 0) return 0;
        busy = true;
        status.text = 'Painting…';
        try {
            const samples = resample(stroke);
            const hits = await probe(samples, true);
            const random = createRandom(0x51a7 + strokeCounter++ * 7919);
            const orient = orientSelect.value as Orient;
            const scale = size.value;
            const meanRadius = averageRadius(active);
            const step = Math.max(1e-6, spacing.value * meanRadius * 2 * scale);

            // pick the copies' spots along the stroke
            const spots: { point: Vec, normal: Vec, dir: Vec | null }[] = [];
            let last: Vec | null = null;
            let previous: Vec | null = null;
            let travelled = 0;
            for (let i = 0; i < samples.length; ++i) {
                const hit = hits[i];
                if (!hit) continue;
                const point = toPly(hit.position);
                if (previous) {
                    travelled += Math.hypot(point[0] - previous[0], point[1] - previous[1], point[2] - previous[2]);
                }
                previous = point;
                if (last && travelled < step) continue;
                const dir = last ? normalize([point[0] - last[0], point[1] - last[1], point[2] - last[2]]) : null;
                last = point;
                travelled = 0;
                spots.push({ point, normal: toPly(hit.normal), dir });
            }
            if (spots.length > 1 && !spots[0].dir) spots[0].dir = spots[1].dir;

            // scatter: move each spot sideways along the surface and find the
            // surface again there
            if (scatter.value > 0 && spots.length) {
                const width = scene.canvas.clientWidth || 1;
                const height = scene.canvas.clientHeight || 1;
                const moved = spots.map((spot) => {
                    let side: Vec;
                    if (spot.dir) {
                        side = normalize(cross(spot.normal, spot.dir));
                    } else {
                        const a = random() * Math.PI * 2;
                        const t = normalize(cross(spot.normal, Math.abs(spot.normal[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]));
                        const b = cross(spot.normal, t);
                        side = [t[0] * Math.cos(a) + b[0] * Math.sin(a), t[1] * Math.cos(a) + b[1] * Math.sin(a), t[2] * Math.cos(a) + b[2] * Math.sin(a)];
                    }
                    const offset = (random() * 2 - 1) * scatter.value * meanRadius * 2 * scale;
                    const world = fromPly([spot.point[0] + side[0] * offset, spot.point[1] + side[1] * offset, spot.point[2] + side[2] * offset]);
                    const screen = new Vec3();
                    scene.camera.worldToScreen(world, screen);
                    return { x: screen.x * width, y: screen.y * height };
                });
                const again = await probe(moved, true);
                again.forEach((hit, i) => {
                    if (hit) {
                        spots[i].point = toPly(hit.position);
                        spots[i].normal = toPly(hit.normal);
                    }
                });
            }

            // turn each spot into a copy
            const placements: Placement[] = spots.map((spot) => {
                const entry = active[Math.min(active.length - 1, Math.floor(random() * active.length))];
                const { stamp } = entry;
                const axis = upAxis(orient, spot.normal, stamp);
                const tilt: Quat = orient === 'captured' ? [1, 0, 0, 0] : quatBetween(stamp.normal, axis);
                const turn = quatAxisAngle(axis, (random() * 2 - 1) * spin.value * Math.PI / 180);
                const k = scale * Math.max(0.05, 1 + (random() * 2 - 1) * jitter.value);
                const rise = lift.value * stamp.radius * 2 * k;
                const point: Vec = [spot.point[0] + axis[0] * rise, spot.point[1] + axis[1] * rise, spot.point[2] + axis[2] * rise];
                return {
                    entry,
                    point,
                    normal: axis,
                    q: quatMul(turn, tilt),
                    k,
                    tone: Math.max(0.05, 1 + (random() * 2 - 1) * tone.value)
                };
            });

            if (placements.length === 0) {
                status.text = 'Nothing under the stroke to paint on.';
                return 0;
            }

            // the layer the copies go into; a full one is left for a new one
            let layer = targetLayer();
            let data = stampLayerData(layer);
            const upper = placements.reduce((sum, p) => sum + p.entry.stamp.count, 0);
            if (data && data.rows + upper > MAX_GAUSSIANS) {
                layer = null;
                data = null;
            }
            if (upper > MAX_GAUSSIANS) {
                const fit = Math.max(1, Math.floor(placements.length * MAX_GAUSSIANS / upper));
                placements.length = fit;
            }
            const rest = data ? data.rest : Math.max(...placements.map(p => p.entry.stamp.rest));
            const floats = floatsOf(rest);
            const frame = frameOf(layer);

            const rows = new Float32Array(upper * floats);
            const copies: number[] = [];
            let written = 0;
            const firstRow = data ? data.rows : 0;
            placements.forEach((p) => {
                const point = frame.toFile(p.point);
                const k = p.k * frame.scale;
                const count = placeStamp(p.entry.stamp, rows, written * floats, point, frame.rotate(p.q), k, {
                    destRest: rest,
                    feather: feather.value,
                    tone: p.tone
                });
                if (count > 0) {
                    copies.push(firstRow + written, count, point[0], point[1], point[2], p.entry.stamp.radius * k);
                    written += count;
                }
            });
            if (written === 0) {
                status.text = 'The feather left nothing of the stamp: lower Feather.';
                return 0;
            }
            const used = rows.subarray(0, written * floats);

            if (layer) {
                const op = new StampStrokeOp(layer, used, copies);
                events.fire('edit.add', op);
                await op.applied;
            } else {
                const created = await createStampLayer(scene, used, rest, copies, nextLayerName());
                events.fire('edit.add', created.op);
                await created.op.applied;
                lastLayer = created.splat;
                forceNew = false;
            }
            const target = layer ?? lastLayer;
            lastLayer = target;
            status.text = `${placements.length} ${placements.length === 1 ? 'copy' : 'copies'} painted into ${target.name} (${target.numSplats.toLocaleString()} splats).`;
            updateLayerLabel();
            return placements.length;
        } catch (e) {
            status.text = '';
            await error(`${(e as Error).message ?? e} while painting`);
            return 0;
        } finally {
            busy = false;
        }
    };

    // ---- erasing

    const erase = async (stroke: { x: number, y: number }[]) => {
        if (busy || stroke.length === 0) return 0;
        busy = true;
        try {
            const samples = resample(stroke);
            const hits = (await probe(samples, false)).filter(h => h) as Hit[];
            const layers = splats().filter(s => s.visible && stampLayerData(s));
            const ops = [];
            let total = 0;
            for (const layer of layers) {
                const data = stampLayerData(layer);
                const frame = frameOf(layer);
                const points = hits.map(h => frame.toFile(toPly(h.position)));
                const live = liveCopies(layer);
                const doomed = live.filter((c) => {
                    const o = c * COPY;
                    const cx = data.copies[o + 2], cy = data.copies[o + 3], cz = data.copies[o + 4];
                    const r = data.copies[o + 5];
                    return points.some(p => (p[0] - cx) ** 2 + (p[1] - cy) ** 2 + (p[2] - cz) ** 2 < r * r);
                });
                const op = eraseCopies(layer, doomed);
                if (op) {
                    ops.push(op);
                    total += doomed.length;
                }
            }
            if (ops.length) {
                events.fire('edit.add', ops.length === 1 ? ops[0] : new MultiOp(ops));
            }
            status.text = total ? `${total} ${total === 1 ? 'copy' : 'copies'} erased.` : 'No painted copies under the stroke.';
            return total;
        } catch (e) {
            await error(`${(e as Error).message ?? e} while erasing`);
            return 0;
        } finally {
            busy = false;
        }
    };

    // ---- footprint preview

    let ghost: { centre: Vec3, normal: Vec3, radius: number } | null = null;

    const drawGhost = () => {
        if (!ghost || mode === 'erase') {
            footprint.setAttribute('points', '');
            return;
        }
        const width = scene.canvas.clientWidth;
        const height = scene.canvas.clientHeight;
        const { centre, normal, radius } = ghost;
        const t = new Vec3().cross(normal, Math.abs(normal.y) < 0.9 ? Vec3.UP : Vec3.RIGHT).normalize();
        const b = new Vec3().cross(normal, t);
        const screen = new Vec3();
        const world = new Vec3();
        const camera = scene.camera.mainCamera;
        const forward = camera.forward;
        const pts: string[] = [];
        for (let i = 0; i < 40; ++i) {
            const a = i / 40 * Math.PI * 2;
            world.copy(centre).add(t.clone().mulScalar(Math.cos(a) * radius)).add(b.clone().mulScalar(Math.sin(a) * radius));
            if (world.clone().sub(camera.getPosition()).dot(forward) <= 0) {
                footprint.setAttribute('points', '');
                return;
            }
            scene.camera.worldToScreen(world, screen);
            pts.push(`${(screen.x * width).toFixed(1)},${(screen.y * height).toFixed(1)}`);
        }
        footprint.setAttribute('points', pts.join(' '));
    };

    // eslint-disable-next-line prefer-const
    let scheduleGhost: () => void;
    let hoverAt: { x: number, y: number } | null = null;
    let hovering = false;
    let lastHover = 0;

    const updateGhost = async () => {
        if (hovering || busy || !hoverAt || toolManager.active !== TOOL || mode === 'erase') return;
        const active = activeEntries();
        if (!active.length) {
            ghost = null;
            drawGhost();
            return;
        }
        hovering = true;
        lastHover = performance.now();
        const at = hoverAt;
        try {
            const [hit] = await probe([at], true);
            if (!hit) {
                ghost = null;
            } else {
                const orient = orientSelect.value as Orient;
                const stamp = active[0].stamp;
                const axis = upAxis(orient, toPly(hit.normal), stamp);
                const radius = averageRadius(active) * size.value;
                const rise = lift.value * radius * 2;
                const normal = fromPly(axis);
                ghost = { centre: hit.position.clone().add(normal.clone().mulScalar(rise)), normal, radius };
            }
            drawGhost();
        } catch {
            ghost = null;
        } finally {
            hovering = false;
        }
        // the cursor moved on while probing
        if (hoverAt !== at) scheduleGhost();
    };

    let ghostTimer: ReturnType<typeof setTimeout> | null = null;
    scheduleGhost = () => {
        if (ghostTimer) return;
        const wait = Math.max(0, HOVER_INTERVAL - (performance.now() - lastHover));
        ghostTimer = setTimeout(() => {
            ghostTimer = null;
            updateGhost();
        }, wait);
    };

    // keep the footprint on the surface while the camera moves
    events.on('postrender', () => {
        if (ghost && toolManager.active === TOOL) drawGhost();
    });

    // ---- tool

    let dragId: number | undefined;
    let stroke: { x: number, y: number }[] = [];

    const drawStroke = () => {
        path.setAttribute('points', stroke.map(p => `${p.x},${p.y}`).join(' '));
    };

    const moveCursor = (e: PointerEvent) => {
        cursor.setAttribute('cx', e.offsetX.toString());
        cursor.setAttribute('cy', e.offsetY.toString());
    };

    const pointerdown = (e: PointerEvent) => {
        if (dragId === undefined && e.button === 0) {
            e.preventDefault();
            e.stopPropagation();
            if (busy) return;       // a stroke is still being applied
            dragId = e.pointerId;
            parent.setPointerCapture(dragId);
            stroke = [{ x: e.offsetX, y: e.offsetY }];
            drawStroke();
        }
    };

    const pointermove = (e: PointerEvent) => {
        moveCursor(e);
        hoverAt = { x: e.offsetX, y: e.offsetY };
        scheduleGhost();
        if (dragId !== undefined) {
            e.preventDefault();
            e.stopPropagation();
            const lastPoint = stroke[stroke.length - 1];
            if (Math.hypot(e.offsetX - lastPoint.x, e.offsetY - lastPoint.y) >= 3) {
                stroke.push({ x: e.offsetX, y: e.offsetY });
                drawStroke();
            }
        }
    };

    const pointerleave = () => {
        hoverAt = null;
        ghost = null;
        drawGhost();
    };

    const endDrag = () => {
        if (dragId !== undefined && parent.hasPointerCapture(dragId)) {
            parent.releasePointerCapture(dragId);
        }
        dragId = undefined;
        path.setAttribute('points', '');
    };

    const pointerup = (e: PointerEvent) => {
        if (e.pointerId === dragId) {
            e.preventDefault();
            e.stopPropagation();
            const finished = stroke;
            endDrag();
            if (mode === 'erase') erase(finished); else paint(finished);
        }
    };

    const pointercancel = (e: PointerEvent) => {
        if (e.pointerId === dragId) endDrag();
    };

    toolManager.register(TOOL, {
        activate: () => {
            svg.classList.remove('hidden');
            svg.classList.toggle('erase', mode === 'erase');
            parent.style.display = 'block';
            parent.addEventListener('pointerdown', pointerdown);
            parent.addEventListener('pointermove', pointermove);
            parent.addEventListener('pointerup', pointerup);
            parent.addEventListener('pointercancel', pointercancel);
            parent.addEventListener('pointerleave', pointerleave);
        },
        deactivate: () => {
            endDrag();
            ghost = null;
            drawGhost();
            svg.classList.add('hidden');
            parent.style.display = 'none';
            parent.removeEventListener('pointerdown', pointerdown);
            parent.removeEventListener('pointermove', pointermove);
            parent.removeEventListener('pointerup', pointerup);
            parent.removeEventListener('pointercancel', pointercancel);
            parent.removeEventListener('pointerleave', pointerleave);
        }
    });

    const updateModeButtons = () => {
        const on = toolManager.active === TOOL;
        paintButton.class[on && mode === 'paint' ? 'add' : 'remove']('active');
        eraseButton.class[on && mode === 'erase' ? 'add' : 'remove']('active');
        svg.classList.toggle('erase', mode === 'erase');
    };

    events.on('tool.activated', updateModeButtons);

    const toggleMode = (next: Mode) => {
        if (toolManager.active === TOOL && mode === next) {
            toolManager.activate(null);
        } else {
            mode = next;
            ghost = null;
            drawGhost();
            if (toolManager.active !== TOOL) events.fire(`tool.${TOOL}`);
        }
        updateModeButtons();
    };

    capture.on('click', async () => {
        capture.enabled = false;
        try {
            await captureStamp();
        } catch (e) {
            await error(`${(e as Error).message ?? e} while capturing`);
        } finally {
            capture.enabled = true;
        }
    });
    loadButton.on('click', () => {
        fileInput.value = '';
        fileInput.click();
    });
    fileInput.addEventListener('change', () => {
        loadFiles(Array.from(fileInput.files ?? []));
    });
    saveButton.on('click', saveHighlighted);
    paintButton.on('click', () => {
        if (activeEntries().length) toggleMode('paint');
    });
    eraseButton.on('click', () => toggleMode('erase'));
    newLayer.on('click', () => {
        forceNew = true;
        updateLayerLabel();
    });

    events.on('selection.changed', () => {
        // picking a stamp layer in the list makes it the target again
        if (isLive(events.invoke('selection'))) forceNew = false;
        updateLayerLabel();
    });
    events.on('scene.elementAdded', updateLayerLabel);
    events.on('scene.elementRemoved', updateLayerLabel);
    events.on('splat.name', updateLayerLabel);
    events.on('scene.clear', () => {
        lastLayer = null;
        updateLayerLabel();
    });
    updateLayerLabel();

    events.function('toolkit.stamp.capture', captureStamp);
    events.function('toolkit.stamp.paint', paint);
    events.function('toolkit.stamp.erase', erase);
    events.function('toolkit.stamp.mode', (next: Mode) => {
        mode = next;
        updateModeButtons();
    });
    events.function('toolkit.stamp.newLayer', () => {
        forceNew = true;
        updateLayerLabel();
    });
    events.function('toolkit.stamp.settings', (values: Record<string, number | string>) => {
        const sliders: Record<string, SliderInput> = { size, spacing, scatter, spin, jitter, tone, feather, lift };
        Object.entries(values).forEach(([key, value]) => {
            if (key === 'orient') orientSelect.value = value as string;
            else if (sliders[key]) sliders[key].value = value as number;
        });
    });
    events.function('toolkit.stamp.library', () => entries.map(e => ({ name: e.stamp.name, count: e.stamp.count, rest: e.stamp.rest, active: e.active })));
};

const stampBrushModule: ToolkitModule = {
    id: 'stampBrush',
    init
};

export { stampBrushModule };
