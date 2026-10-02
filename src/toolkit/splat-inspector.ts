import { BooleanInput, Button, Container, Label, NumericInput, VectorInput } from '@playcanvas/pcui';
import { Quat, Vec3 } from 'playcanvas';

import type { EditorSplatResource } from '../editor-splat-resource';
import type { Pivot } from '../pivot';
import type { Splat } from '../splat';
import { collapsible } from './inspector';
import { renderQuickLighting } from './lighting-quick';

import type { ToolkitContext, ToolkitModule } from './index';

// The inspector for a splat layer (.ply and the other splat formats): what is
// in it, where it stands, and how the studio lights treat it. The transform
// goes through the editor's pivot, exactly like SuperSplat's own transform
// panel, so it moves the selected splats when there are any, else the layer,
// and every change is one undo step.

const tips = {
    count: 'Splats in this layer, and how many of them are selected, locked or deleted.',
    sh: 'Colour detail: spherical harmonics degree. Higher degrees hold view-dependent colour (shine, reflections).',
    size: 'Size of the layer\'s bounding box in scene units (width × height × depth).',
    file: 'The file this layer was loaded from.',
    visible: 'Show or hide this layer.',
    transform: 'Moves the selected splats when some are selected, else the whole layer. Same as the Transform panel of the scene manager.',
    focus: 'Frame the layer (or its selection) in the view. Shortcut: F.'
};

const shText = ['0 (flat colour)', '1 (soft view-dependent colour)', '2 (view-dependent colour)', '3 (full view-dependent colour)'];

const formatCount = (n: number) => n.toLocaleString();
const shortCount = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} M` : n >= 1e3 ? `${Math.round(n / 1000)} k` : String(n));

const init = (ctx: ToolkitContext) => {
    const { events, tooltips } = ctx;

    let splat: Splat | null = null;
    let uiUpdating = false;

    const content = new Container({ class: 'toolkit-editor' });

    const row = (text: string, tip: string) => {
        const r = new Container({ class: 'toolkit-row' });
        const label = new Label({ text, class: 'toolkit-label' });
        r.append(label);
        tooltips.register(label, tip, 'right');
        return r;
    };
    const value = (r: Container, tip: string) => {
        const v = new Label({ text: '', class: 'toolkit-value' });
        r.append(v);
        tooltips.register(v, tip, 'bottom');
        return v;
    };

    // ---- what is in it
    const infoGroup = collapsible('Splats', 'splat.info');
    const countRow = row('Splats', tips.count);
    const count = value(countRow, tips.count);
    const stateRow = row('', tips.count);
    const state = value(stateRow, tips.count);
    const shRow = row('Colour detail', tips.sh);
    const sh = value(shRow, tips.sh);
    const sizeRow = row('Size', tips.size);
    const size = value(sizeRow, tips.size);
    const fileRow = row('File', tips.file);
    const file = value(fileRow, tips.file);
    const visibleRow = row('Visible', tips.visible);
    const visible = new BooleanInput({ type: 'toggle', class: 'toolkit-toggle', value: true });
    visibleRow.append(visible);
    tooltips.register(visible, tips.visible, 'bottom');
    const focus = new Button({ text: 'Frame in view', class: 'toolkit-convert' });
    visibleRow.append(new Container({ class: 'panel-header-spacer' }));
    visibleRow.append(focus);
    tooltips.register(focus, tips.focus, 'bottom');
    [countRow, stateRow, shRow, sizeRow, fileRow, visibleRow].forEach(r => infoGroup.body.append(r));
    const infoSummary = new Label({ text: '', class: 'toolkit-group-summary' });
    infoGroup.extra.append(infoSummary);

    // ---- where it stands (through the pivot)
    const transformGroup = collapsible('Transform', 'splat.transform');
    const transformHint = new Label({ text: '', class: 'toolkit-hint' });
    const vectorRow = (text: string, precision: number) => {
        const r = row(text, tips.transform);
        const input = new VectorInput({ class: 'toolkit-vector', precision, dimensions: 3, placeholder: ['X', 'Y', 'Z'], value: [0, 0, 0] });
        r.append(input);
        transformGroup.body.append(r);
        return input;
    };
    const position = vectorRow('Position', 3);
    const rotation = vectorRow('Rotation', 2);
    const scaleRow = row('Scale', tips.transform);
    const scale = new NumericInput({ class: 'toolkit-numeric', precision: 3, min: 0.001, value: 1 });
    scaleRow.append(scale);
    transformGroup.body.append(scaleRow);
    transformGroup.body.append(transformHint);

    // ---- the studio lights
    const lightGroup = collapsible('Lighting', 'splat.lighting');
    const lightBox = new Container();
    lightGroup.body.append(lightBox);
    const lightSummary = new Label({ text: '', class: 'toolkit-group-summary' });
    lightGroup.extra.append(lightSummary);

    [infoGroup, transformGroup, lightGroup].forEach(g => content.append(g.root));

    // ---- refresh

    const pivot = () => events.invoke('pivot') as Pivot;

    // the exact pivot values behind the rounded fields, so an edit of one
    // field doesn't nudge the others by their rounding
    const exact = { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 };
    const keep = (typed: number, held: number, precision: number) => {
        const step = 10 ** -precision;
        return Math.abs(typed - Math.round(held / step) * step) < step * 0.5 ? held : typed;
    };

    const updateTransform = () => {
        if (!splat) return;
        const t = pivot()?.transform;
        if (!t) return;
        const euler = new Vec3();
        t.rotation.getEulerAngles(euler);
        exact.position = [t.position.x, t.position.y, t.position.z];
        exact.rotation = [euler.x, euler.y, euler.z];
        exact.scale = t.scale.x;
        uiUpdating = true;
        position.value = exact.position;
        rotation.value = exact.rotation;
        scale.value = exact.scale;
        uiUpdating = false;
        transformHint.text = splat.numSelected > 0 ?
            `Moves the ${formatCount(splat.numSelected)} selected splats. Clear the selection to move the whole layer.` :
            'Moves the whole layer.';
    };

    const updateInfo = () => {
        if (!splat) return;
        const resource = splat.resource as EditorSplatResource;
        count.text = formatCount(splat.numSplats);
        const parts = [];
        if (splat.numSelected) parts.push(`${formatCount(splat.numSelected)} selected`);
        if (splat.numLocked) parts.push(`${formatCount(splat.numLocked)} locked`);
        if (splat.numDeleted) parts.push(`${formatCount(splat.numDeleted)} deleted`);
        stateRow.hidden = parts.length === 0;
        state.text = parts.join(' · ');
        sh.text = shText[resource?.shBands ?? 0] ?? String(resource?.shBands);
        const b = splat.worldBound;
        size.text = b ? `${(b.halfExtents.x * 2).toFixed(2)} × ${(b.halfExtents.y * 2).toFixed(2)} × ${(b.halfExtents.z * 2).toFixed(2)}` : '-';
        const name = (splat.filename ?? '').split('/').pop();
        fileRow.hidden = !name || name === splat.name.split('/').pop();
        file.text = name;
        uiUpdating = true;
        visible.value = splat.visible;
        uiUpdating = false;
        infoSummary.text = shortCount(splat.numSplats);
    };

    const updateLighting = () => {
        if (splat) renderQuickLighting(events, tooltips, lightBox, lightSummary, splat, 'splat');
    };

    const show = () => {
        if (!splat) {
            events.invoke('toolkit.inspector.hide', 'splat');
            return;
        }
        events.invoke('toolkit.inspector.show', 'splat', { title: splat.name, kind: splat.background ? 'Sky' : 'Splat layer', content });
        // the studio lights never reach a backdrop (edited in the Sky panel)
        lightGroup.root.hidden = splat.background;
        updateInfo();
        updateTransform();
        updateLighting();
    };

    // ---- edits

    const applyTransform = () => {
        if (uiUpdating || !splat) return;
        const p = position.value.map((v, i) => keep(v, exact.position[i], 3));
        const r = rotation.value.map((v, i) => keep(v, exact.rotation[i], 2));
        const q = new Quat().setFromEulerAngles(r[0], r[1], r[2]);
        if (q.w < 0) q.mulScalar(-1);
        const s = keep(scale.value, exact.scale, 3);
        const pv = pivot();
        // one undo step, like the scene manager's transform panel
        pv.start();
        pv.moveTRS(new Vec3(p[0], p[1], p[2]), q, new Vec3(s, s, s));
        pv.end();
    };
    position.on('change', applyTransform);
    rotation.on('change', applyTransform);
    scale.on('change', applyTransform);

    visible.on('change', (v: boolean) => {
        if (!uiUpdating && splat) splat.visible = v;
    });
    focus.on('click', () => events.fire('camera.focus'));

    // ---- follow the editor

    events.on('selection.changed', (selection: Splat | null) => {
        splat = selection ?? null;
        show();
        if (splat) events.invoke('toolkit.inspector.reveal');
    });
    // a click on the layer that is already selected brings it back (a mesh
    // may have taken the inspector meanwhile)
    const reselect = (picked: Splat | null) => {
        if (picked && picked === splat) {
            show();
            events.invoke('toolkit.inspector.reveal');
        }
    };
    events.on('selection', reselect);
    events.on('camera.focalPointPicked', (details: { splat: Splat }) => reselect(details?.splat));
    ['pivot.placed', 'pivot.moved', 'pivot.ended'].forEach((name) => {
        events.on(name, () => {
            if (splat) updateTransform();
        });
    });
    events.on('splat.stateChanged', (s: Splat) => {
        if (s === splat) {
            updateInfo();
            updateTransform();
        }
    });
    events.on('toolkit.sky.changed', (s: Splat) => {
        if (s === splat) show();
    });
    events.on('splat.name', (s: Splat) => {
        if (s === splat) show();
    });
    events.on('splat.visibility', (s: Splat) => {
        if (s === splat) updateInfo();
    });
    events.on('edit.apply', () => {
        if (!splat) return;
        updateInfo();
        updateLighting();
    });
};

const splatInspectorModule: ToolkitModule = {
    id: 'splatInspector',
    init
};

export { splatInspectorModule };
