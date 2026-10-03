import { BooleanInput, Button, Container, Label, SliderInput } from '@playcanvas/pcui';

import { AddSplatOp, MultiOp, RemoveInstancesOp } from '../edit-ops';
import { Element, ElementType } from '../element';
import { Splat } from '../splat';
import snapSvg from './icons/snap.svg';
import { LogSlider } from './log-slider';
import { MemorySink } from './memory-sink';
import { headerIcon, registerPanel } from './panels';
import { parsePly, writePly } from './stamp-math';
import { readNeighbours, rowsBound, snapRows, SnapOptions } from './surface-snap';

import type { ToolkitContext, ToolkitModule } from './index';

// The snap-to-surface tool: select gaussians that drifted off a surface
// (floaters, fuzz), then put them back onto it - see surface-snap.ts. The
// snapped gaussians replace the selected ones as a new layer, in one undo step.

const tips = {
    intro: 'Select the gaussians that drifted off a surface (floaters in front of a wall, fuzz around an object) with any selection tool, then snap them back onto it. Unlike deleting them this leaves no hole: they keep covering the surface, flat on it.',
    reach: 'How far from the surface a selected gaussian may be and still be snapped back. Those farther away are left as they are.',
    strength: 'How far they move: 1 puts them right onto the surface (flattened onto it), 0.5 halfway there.',
    fitSize: 'Keep snapped gaussians no wider than a few of the surface\'s own, so a big blurry floater does not smear over the surface.',
    color: 'Blend their colour towards the surface around them. 0 keeps their own colour.',
    calm: 'Tone down their view-dependent colour (spherical harmonics). Floaters often carry colour seen from one side only, which would flicker on the surface.',
    run: 'Snap the selected gaussians onto the surface. They are replaced by a new layer of snapped gaussians (undo with Ctrl+Z).'
};

const init = (ctx: ToolkitContext) => {
    const { events, scene, canvasContainer, tooltips } = ctx;

    const panel = new Container({ id: 'toolkit-snap-panel', class: 'panel' });
    ['pointerdown', 'pointerup', 'pointermove', 'wheel', 'dblclick'].forEach((eventName) => {
        panel.dom.addEventListener(eventName, (event: Event) => event.stopPropagation());
    });
    const header = new Container({ class: 'panel-header' });
    header.append(headerIcon(snapSvg));
    header.append(new Label({ text: 'Snap to surface', class: 'panel-header-label' }));
    panel.append(header);
    const body = new Container({ class: 'toolkit-lighting-body' });
    panel.append(body);

    body.append(new Label({ text: tips.intro, class: ['toolkit-hint', 'toolkit-intro'] }));

    const row = (text: string, tip: string) => {
        const r = new Container({ class: 'toolkit-row' });
        const label = new Label({ text, class: 'toolkit-label' });
        r.append(label);
        tooltips.register(label, tip, 'left');
        body.append(r);
        return r;
    };
    const slider = (text: string, tip: string, value: number) => {
        const s = new SliderInput({ class: 'toolkit-slider', min: 0, max: 1, precision: 2, step: 0.01, value });
        row(text, tip).append(s);
        tooltips.register(s, tip, 'bottom');
        return s;
    };
    const toggle = (text: string, tip: string, value: boolean) => {
        const t = new BooleanInput({ type: 'toggle', class: 'toolkit-toggle', value });
        row(text, tip).append(t);
        tooltips.register(t, tip, 'bottom');
        return t;
    };

    const reach = new LogSlider(0.001, 10, 0.1);
    row('Reach', tips.reach).append(reach);
    tooltips.register(reach, tips.reach, 'bottom');
    const strength = slider('Strength', tips.strength, 1);
    const fitSize = toggle('Fit size', tips.fitSize, true);
    const color = slider('Match colour', tips.color, 0);
    const calm = toggle('Calm colour', tips.calm, true);

    const runRow = new Container({ class: 'toolkit-row' });
    const run = new Button({ text: 'Snap selected', class: 'toolkit-button' });
    runRow.append(run);
    body.append(runRow);
    tooltips.register(run, tips.run, 'bottom');
    const status = new Label({ text: '', class: 'toolkit-hint' });
    body.append(status);

    canvasContainer.append(panel);

    const splats = () => (scene.getElementsByType(ElementType.splat) as Splat[]).filter(s => s.visible && s.numSplats > 0);
    const selectedCount = () => splats().reduce((sum, s) => sum + s.numSelected, 0);

    // the reach follows the scene's size
    let rangedFor = -1;
    const applyRange = () => {
        const size = scene.bound.halfExtents.length() * 2;
        if (!(size > 0) || Math.abs(size - rangedFor) < 1e-6) return;
        const first = rangedFor < 0;
        rangedFor = size;
        reach.setRange(size * 0.0005, size * 0.5);
        if (first) reach.value = size * 0.03;
    };

    let busy = false;

    const updateStatus = () => {
        if (busy) return;
        const n = selectedCount();
        status.text = n ? `${n.toLocaleString()} gaussians selected.` : 'Nothing is selected: select the floaters first.';
        run.enabled = n > 0;
    };

    const handle = registerPanel(ctx, {
        id: 'snap',
        panel,
        header,
        icon: snapSvg,
        title: 'Snap to surface',
        tooltip: 'Snap to surface: put floaters and fuzz back onto the surface they drifted off, instead of deleting them and leaving holes.',
        order: 3.5
    });

    // load a PLY as a new layer and return it
    const importLayer = async (filename: string, data: BlobPart) => {
        let created: Splat | null = null;
        const onAdded = (element: Element) => {
            if (element.type === ElementType.splat) created = element as Splat;
        };
        const added = events.on('scene.elementAdded', onAdded);
        try {
            await events.invoke('import', [{ filename, contents: new File([data], filename) }]);
        } finally {
            added.off();
        }
        return created as Splat | null;
    };

    const snap = async (options: SnapOptions) => {
        const layers = splats().filter(s => s.numSelected > 0 && !s.background);
        if (!layers.length || busy) return null;
        busy = true;
        run.enabled = false;
        const ops = [];
        const summary = { moved: 0, unmoved: 0, distance: 0, layers: 0 };
        events.fire('progressStart', 'Snapping to surface', false);
        try {
            for (let l = 0; l < layers.length; ++l) {
                const splat = layers[l];
                const span = 100 / layers.length;
                events.fire('progressUpdate', { text: `Reading the selection of ${splat.name}`, progress: span * l });

                // the selected gaussians, as the exporter writes them
                const sink = new MemorySink();
                const written = await events.invoke('scene.write', 'ply', {
                    filename: 'snap.ply',
                    splatIdx: events.invoke('scene.splats').indexOf(splat),
                    serializeSettings: { maxSHBands: 3, selected: true }
                }, sink);
                if (!written) continue;
                const { rows, rest } = parsePly(await sink.blob().arrayBuffer());
                if (!rows.length) continue;

                // the surface around them
                events.fire('progressUpdate', { text: `Finding the surface around ${splat.name}`, progress: span * (l + 0.3) });
                const { min, max } = rowsBound(rows, rest);
                const margin = options.reach * 1.5;
                const neighbours = await readNeighbours(
                    splat,
                    min.map(v => v - margin),
                    max.map(v => v + margin),
                    options.colorBlend > 0
                );

                events.fire('progressUpdate', { text: `Snapping ${splat.name}`, progress: span * (l + 0.7) });
                const result = snapRows(rows, rest, neighbours, options);
                if (!result.moved) {
                    summary.unmoved += result.unmoved;
                    continue;
                }

                // replace the selected gaussians with the snapped ones
                const remove = new RemoveInstancesOp(splat);
                const created = await importLayer(`${splat.name.replace(/\.[^.]+$/, '').replace(/[^\w\- ]+/g, '_')} snapped.ply`, writePly(result.rows, rest));
                if (!created) continue;
                created.name = `${splat.name.replace(/\.[^.]+$/, '')} · snapped`;
                ops.push(remove, new AddSplatOp(scene, created));
                summary.moved += result.moved;
                summary.unmoved += result.unmoved;
                summary.distance += result.distance * result.moved;
                summary.layers++;
            }
        } catch (error) {
            console.error(error);
            await events.invoke('showPopup', {
                type: 'error',
                header: 'Snapping failed',
                message: (error as Error).message ?? String(error)
            });
        } finally {
            events.fire('progressEnd');
            busy = false;
        }
        if (ops.length) {
            events.fire('edit.add', new MultiOp(ops));
        }
        const unit = summary.moved ? summary.distance / summary.moved : 0;
        const left = summary.unmoved ? `; ${summary.unmoved.toLocaleString()} had no surface within reach and were left as they were.` : '.';
        if (summary.moved) {
            status.text = `Snapped ${summary.moved.toLocaleString()} gaussians (moved ${unit.toPrecision(2)} on average)${left}`;
        } else {
            status.text = summary.unmoved ? `No surface within reach of the ${summary.unmoved.toLocaleString()} selected gaussians: raise the reach.` : 'Nothing was snapped.';
        }
        run.enabled = selectedCount() > 0;
        scene.forceRender = true;
        return { ...summary, distance: unit };
    };

    const currentOptions = (): SnapOptions => ({
        reach: reach.value,
        strength: strength.value,
        limitSize: fitSize.value,
        colorBlend: color.value,
        calmSH: calm.value
    });

    run.on('click', () => {
        snap(currentOptions());
    });

    // keep the status and range current while the panel is open
    const refresh = () => {
        if (!handle.visible) return;
        applyRange();
        updateStatus();
    };
    events.on('splat.stateChanged', refresh);
    events.on('scene.elementAdded', refresh);
    events.on('scene.elementRemoved', refresh);
    events.on('selection.changed', refresh);
    const observer = new MutationObserver(refresh);
    observer.observe(panel.dom, { attributes: true, attributeFilter: ['class', 'style'] });
    refresh();

    // scripted access (and tests)
    events.function('toolkit.snap.run', (options: Partial<SnapOptions> = {}) => {
        applyRange();
        return snap({ ...currentOptions(), ...options });
    });
};

const snapToolModule: ToolkitModule = { id: 'snap', init };

export { snapToolModule };
