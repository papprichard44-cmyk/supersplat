import { BooleanInput, Button, Container, Label, SliderInput } from '@playcanvas/pcui';
import { Vec3 } from 'playcanvas';

import { Element, ElementType } from '../element';
import { Splat } from '../splat';
import { MemorySink } from './memory-sink';
import {
    FLOATS, Quat, Stamp, Vec,
    cross, dot, makeStamp, normalize, parsePly, placeStamp, quatAxisAngle, quatBetween, quatMul, writePly
} from './stamp-math';

import type { ToolkitContext, ToolkitModule } from './index';

// Stamp brush: capture a patch of selected gaussians as a stamp, then paint
// copies of it onto the surfaces of the scene. Each copy sits on the surface
// point under the stroke, turned to follow the surface there.

const TOOL = 'toolkitStamp';
const MAX_SAMPLES = 200;            // surface probes per stroke
const MAX_GAUSSIANS = 6_000_000;    // per stamp layer
const NORMAL_PROBE = 6;             // px: offset of the two extra probes the surface normal is taken from

const tips = {
    capture: 'Use the currently selected splats as the stamp. Select a patch with any selection tool first (a flat piece of surface works best), then press this.',
    paint: 'Paint with the stamp: click or drag over a surface in the viewport to place copies of the stamp along the stroke. Press again to stop painting.',
    size: 'Size of each copy relative to the captured patch (1 = original size).',
    spacing: 'Distance between copies along a stroke, measured in stamp widths. Below 1 the copies overlap, above 1 they leave gaps.',
    spin: 'Random turn of each copy around the surface normal, in degrees either way. 0 keeps every copy in the same orientation; 180 hides the repetition best.',
    jitter: 'Random size variation between copies (0 = all the same size, 0.5 = up to 50% larger or smaller).',
    align: 'On: each copy is tilted to lie on the surface under it. Off: copies keep the orientation the patch was captured in.',
    newLayer: 'Start a new stamp layer. Until then every stroke is added to the same layer.',
    status: 'The stamp currently loaded in the brush.'
};

const toPly = (v: Vec3): Vec => [-v.x, -v.y, v.z];

type StampLayer = {
    splat: Splat;
    rows: Float32Array;
    numSplats: number;
    transform: number[];
};

const init = (ctx: ToolkitContext) => {
    const { events, scene, toolManager, canvasContainer, toolsContainer, tooltips } = ctx;
    const parent = toolsContainer.dom;

    let stamp: Stamp | null = null;
    let layer: StampLayer | null = null;
    let layerCounter = 0;
    let busy = false;

    // ---- ui

    const panel = new Container({ id: 'toolkit-stamp-panel', class: 'panel' });
    ['pointerdown', 'pointerup', 'pointermove', 'wheel', 'dblclick'].forEach((eventName) => {
        panel.dom.addEventListener(eventName, (event: Event) => event.stopPropagation());
    });

    const header = new Container({ class: 'panel-header' });
    header.append(new Label({ text: '', class: 'panel-header-icon' }));
    header.append(new Label({ text: 'Stamp brush', class: 'panel-header-label' }));

    const buttons = new Container({ class: 'toolkit-row' });
    const capture = new Button({ text: 'Capture selection', class: 'toolkit-button' });
    const paintButton = new Button({ text: 'Paint', class: 'toolkit-button', enabled: false });
    buttons.append(capture);
    buttons.append(paintButton);

    const statusRow = new Container({ class: 'toolkit-row' });
    const status = new Label({ text: 'No stamp captured yet.', class: 'toolkit-compare-note' });
    statusRow.append(status);

    panel.append(header);
    panel.append(buttons);
    panel.append(statusRow);

    const sliderRow = (text: string, tip: string, args: { min: number, max: number, precision: number, value: number }) => {
        const row = new Container({ class: 'toolkit-row' });
        const label = new Label({ text, class: 'toolkit-label' });
        const slider = new SliderInput({ class: 'toolkit-slider', ...args });
        row.append(label);
        row.append(slider);
        panel.append(row);
        tooltips.register(label, tip, 'left');
        tooltips.register(slider, tip, 'bottom');
        return slider;
    };

    const size = sliderRow('Size', tips.size, { min: 0.1, max: 4, precision: 2, value: 1 });
    const spacing = sliderRow('Spacing', tips.spacing, { min: 0.1, max: 3, precision: 2, value: 0.8 });
    const spin = sliderRow('Spin', tips.spin, { min: 0, max: 180, precision: 0, value: 180 });
    const jitter = sliderRow('Size var.', tips.jitter, { min: 0, max: 0.9, precision: 2, value: 0.15 });

    const lastRow = new Container({ class: 'toolkit-row' });
    const alignLabel = new Label({ text: 'Follow surface', class: ['toolkit-label', 'toolkit-label-wide'] });
    const align = new BooleanInput({ class: 'toolkit-toggle', type: 'toggle', value: true });
    const newLayer = new Button({ text: 'New layer', class: 'toolkit-convert' });
    lastRow.append(alignLabel);
    lastRow.append(align);
    lastRow.append(new Container({ class: 'panel-header-spacer' }));
    lastRow.append(newLayer);
    panel.append(lastRow);

    canvasContainer.append(panel);

    tooltips.register(capture, tips.capture, 'bottom');
    tooltips.register(paintButton, tips.paint, 'bottom');
    tooltips.register(status, tips.status, 'left');
    tooltips.register(alignLabel, tips.align, 'left');
    tooltips.register(align, tips.align, 'bottom');
    tooltips.register(newLayer, tips.newLayer, 'bottom');

    // cursor + stroke preview, drawn over the viewport while the tool is active
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.classList.add('tool-svg', 'hidden');
    svg.id = 'toolkit-stamp-svg';
    const path = document.createElementNS(svg.namespaceURI, 'polyline') as SVGPolylineElement;
    const cursor = document.createElementNS(svg.namespaceURI, 'circle') as SVGCircleElement;
    cursor.setAttribute('r', '9');
    svg.appendChild(path);
    svg.appendChild(cursor);
    parent.appendChild(svg);

    const splats = () => scene.getElementsByType(ElementType.splat) as Splat[];

    const error = (message: string) => events.invoke('showPopup', { type: 'error', header: 'Stamp brush', message });

    // ---- capture

    const captureStamp = async () => {
        const selected = splats().reduce((sum, splat) => sum + (splat.visible ? splat.numSelected : 0), 0);
        if (selected === 0) {
            status.text = 'Nothing is selected: select some splats first.';
            return 0;
        }
        const sink = new MemorySink();
        const written = await events.invoke('scene.write', 'ply', {
            filename: 'stamp.ply',
            splatIdx: 'all',
            serializeSettings: { maxSHBands: 0, selected: true }
        }, sink);
        if (!written) {
            return 0;       // the exporter already reported the error
        }
        const rows = parsePly(await sink.blob().arrayBuffer());
        if (rows.length === 0) {
            status.text = 'Nothing is selected: select some splats first.';
            return 0;
        }
        stamp = makeStamp(rows, toPly(scene.camera.mainCamera.getPosition()));
        status.text = `Stamp: ${stamp.count.toLocaleString()} splats`;
        paintButton.enabled = true;
        return stamp.count;
    };

    // ---- painting

    // the layer strokes are added to; a layer the user has since moved, edited
    // or removed is left alone and a new one is started
    const currentLayer = () => {
        if (!layer) return null;
        const { splat } = layer;
        const same = splat.scene === scene && splat.numSplats === layer.numSplats && splat.numDeleted === 0 &&
            Array.from(splat.entity.getLocalTransform().data).every((value, i) => Math.abs(value - layer.transform[i]) < 1e-6);
        if (!same) {
            layer = null;
        }
        return layer;
    };

    // place copies of the stamp along a stroke given in viewport pixels
    const paint = async (stroke: { x: number, y: number }[]) => {
        if (!stamp || busy || stroke.length === 0) return 0;
        busy = true;
        try {
            // resample the stroke evenly, then probe the surface under every
            // sample - plus two neighbours each, for the surface normal
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
                const span = lengths[segment + 1] - lengths[segment];
                const f = span > 0 ? (at - lengths[segment]) / span : 0;
                const a = stroke[segment];
                const b = stroke[Math.min(segment + 1, stroke.length - 1)];
                samples.push({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f });
            }

            const width = parent.clientWidth;
            const height = parent.clientHeight;
            const points: { x: number, y: number }[] = [];
            samples.forEach(({ x, y }) => {
                points.push({ x: x / width, y: y / height });
                points.push({ x: (x + NORMAL_PROBE) / width, y: y / height });
                points.push({ x: x / width, y: (y + NORMAL_PROBE) / height });
            });
            const hits = await scene.camera.intersectMany(points, splats().filter(splat => splat.visible));

            const eye = toPly(scene.camera.mainCamera.getPosition());
            const scale = size.value;
            const step = Math.max(1e-6, spacing.value * stamp.radius * 2 * scale);
            const placements: { point: Vec, q: Quat, k: number }[] = [];
            let last: Vec | null = null;
            let previous: Vec | null = null;
            let travelled = 0;
            const capacity = Math.floor((MAX_GAUSSIANS - (currentLayer()?.rows.length ?? 0) / FLOATS) / stamp.count);

            for (let i = 0; i < samples.length && placements.length < capacity; ++i) {
                const hit = hits[i * 3];
                if (!hit) continue;
                const point = toPly(hit.position);
                if (previous) {
                    travelled += Math.hypot(point[0] - previous[0], point[1] - previous[1], point[2] - previous[2]);
                }
                previous = point;
                if (last && travelled < step) continue;
                last = point;
                travelled = 0;

                // surface normal from the two neighbouring probes, facing the viewer;
                // without them (edge of an object) the copy simply faces the viewer
                const toEye = normalize([eye[0] - point[0], eye[1] - point[1], eye[2] - point[2]]);
                let normal = toEye;
                const hx = hits[i * 3 + 1];
                const hy = hits[i * 3 + 2];
                if (hx && hy) {
                    const px = toPly(hx.position);
                    const py = toPly(hy.position);
                    let n = normalize(cross(
                        [px[0] - point[0], px[1] - point[1], px[2] - point[2]],
                        [py[0] - point[0], py[1] - point[1], py[2] - point[2]]
                    ));
                    if (dot(n, toEye) < 0) n = [-n[0], -n[1], -n[2]];
                    // a normal almost edge-on to the view comes from a depth jump
                    // between the probes, not from the surface
                    if (dot(n, toEye) > 0.17) normal = n;
                }

                const axis = align.value ? normal : stamp.normal;
                const tilt: Quat = align.value ? quatBetween(stamp.normal, normal) : [1, 0, 0, 0];
                const turn = quatAxisAngle(axis, (Math.random() * 2 - 1) * spin.value * Math.PI / 180);
                const k = scale * Math.max(0.05, 1 + (Math.random() * 2 - 1) * jitter.value);
                placements.push({ point, q: quatMul(turn, tilt), k });
            }

            if (placements.length === 0) {
                return 0;
            }

            const existing = currentLayer();
            const rows = new Float32Array((existing?.rows.length ?? 0) + placements.length * stamp.count * FLOATS);
            if (existing) {
                rows.set(existing.rows);
            }
            let offset = existing?.rows.length ?? 0;
            placements.forEach(({ point, q, k }) => {
                placeStamp(stamp, rows, offset, point, q, k);
                offset += stamp.count * FLOATS;
            });

            // (re)load the stamp layer with the new copies added
            let created: Element | null = null;
            const handle = events.on('scene.elementAdded', (element: Element) => {
                if (element.type === ElementType.splat) {
                    created = element;
                }
            });
            try {
                if (!existing) layerCounter++;
                const filename = `Stamps ${layerCounter}.ply`;
                await events.invoke('import', [{ filename, contents: new File([writePly(rows)], filename) }]);
            } finally {
                handle.off();
            }
            if (created) {
                existing?.splat.destroy();
                const splat = created as Splat;
                layer = {
                    splat,
                    rows,
                    numSplats: splat.numSplats,
                    transform: Array.from(splat.entity.getLocalTransform().data)
                };
            }
            return placements.length;
        } catch (e) {
            await error(`${(e as Error).message ?? e} while painting`);
            return 0;
        } finally {
            busy = false;
        }
    };

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
            paint(finished);
        }
    };

    const pointercancel = (e: PointerEvent) => {
        if (e.pointerId === dragId) endDrag();
    };

    toolManager.register(TOOL, {
        activate: () => {
            svg.classList.remove('hidden');
            parent.style.display = 'block';
            parent.addEventListener('pointerdown', pointerdown);
            parent.addEventListener('pointermove', pointermove);
            parent.addEventListener('pointerup', pointerup);
            parent.addEventListener('pointercancel', pointercancel);
        },
        deactivate: () => {
            endDrag();
            svg.classList.add('hidden');
            parent.style.display = 'none';
            parent.removeEventListener('pointerdown', pointerdown);
            parent.removeEventListener('pointermove', pointermove);
            parent.removeEventListener('pointerup', pointerup);
            parent.removeEventListener('pointercancel', pointercancel);
        }
    });

    events.on('tool.activated', (name: string | null) => {
        paintButton.class[name === TOOL ? 'add' : 'remove']('active');
    });

    capture.on('click', async () => {
        capture.enabled = false;
        try {
            await captureStamp();
        } finally {
            capture.enabled = true;
        }
    });
    paintButton.on('click', () => {
        if (stamp) events.fire(`tool.${TOOL}`);
    });
    newLayer.on('click', () => {
        layer = null;
    });

    events.on('scene.clear', () => {
        layer = null;
    });

    events.function('toolkit.stamp.capture', captureStamp);
    events.function('toolkit.stamp.paint', paint);
};

const stampBrushModule: ToolkitModule = {
    id: 'stampBrush',
    init
};

export { stampBrushModule };
