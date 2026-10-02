import { BooleanInput, Button, Container, Label, SelectInput } from '@playcanvas/pcui';

import type { Events } from '../events';
import type { Splat } from '../splat';
import type { MeshPrimitive } from './mesh-primitive';
import type { Tooltips } from '../ui/tooltips';

// The inspector's "Lighting" group, for a mesh or a splat layer: which studio
// lights reach it, its shadows, and quick actions (a setup around it, aiming
// the lights at it). Everything goes through the studio lighting module.

type LightingInfo = {
    lights: { index: number, name: string, visible: boolean, reaches: boolean }[],
    casts: boolean,
    subject: boolean,
    presets: { v: string, t: string }[],
    lightSplats: boolean
};

const tips = {
    lightWith: 'Light this object with a ready-made setup: the lights are placed around it and aimed at it.',
    reach: 'Which studio lights reach this object. Untick a light to keep it off this object (the light then lights only the objects ticked for it).',
    casts: 'Whether this object casts shadows onto others when the lighting is baked.',
    aimHere: 'Make this object the subject: every light that is set to aim turns to it.',
    lightSplats: 'Let the studio lights reach splat layers (for all splat layers; untick lights below to keep them off this one).',
    relight: 'Bake the lights that reach this layer into a lit copy of it. The original is kept, hidden.',
    panel: 'Open the studio lighting panel: add single lights, the environment and the bake quality.'
};

// the setup last picked, shared by every inspector
let lastPreset = '';

const renderQuickLighting = (
    events: Events,
    tooltips: Tooltips,
    box: Container,
    summary: Label,
    target: MeshPrimitive | Splat,
    kind: 'mesh' | 'splat'
) => {
    const info = events.invoke('toolkit.studio.meshLighting', target) as LightingInfo | null;
    box.clear();
    if (!info) return;
    const isSplat = kind === 'splat';
    const reachable = !isSplat || info.lightSplats;
    const on = reachable ? info.lights.filter(l => l.visible && l.reaches).length : 0;
    summary.text = info.lights.length ? `${on} of ${info.lights.length} lights` : 'no lights';

    const row = () => new Container({ class: 'toolkit-row' });
    const toggleRow = (text: string, tip: string, value: boolean, change: (v: boolean) => void) => {
        const r = row();
        const label = new Label({ text, class: 'toolkit-label' });
        const toggle = new BooleanInput({ type: 'toggle', class: 'toolkit-toggle', value });
        r.append(label);
        r.append(toggle);
        tooltips.register(label, tip, 'right');
        tooltips.register(toggle, tip, 'bottom');
        toggle.on('change', change);
        box.append(r);
    };

    if (isSplat) {
        toggleRow('Light splats', tips.lightSplats, info.lightSplats, v => events.invoke('toolkit.studio.setLightSplats', v));
    }

    let text: string;
    if (!info.lights.length) text = 'No studio lights yet. Light it with a setup:';
    else if (!reachable) text = 'The studio lights don\'t reach splat layers. Switch "Light splats" on to light this layer.';
    else text = `Lit by ${on} of ${info.lights.length} light${info.lights.length === 1 ? '' : 's'}${info.subject ? '. The lights aim at it.' : '.'}`;
    box.append(new Label({ text, class: 'toolkit-hint' }));

    // a setup around this object
    const setupRow = row();
    const setupSelect = new SelectInput({ class: 'toolkit-select', type: 'string', options: info.presets, value: lastPreset || info.presets[0]?.v });
    const setupButton = new Button({ text: info.lights.length ? 'Relight' : 'Light it', class: 'toolkit-convert' });
    setupRow.append(setupSelect);
    setupRow.append(setupButton);
    box.append(setupRow);
    tooltips.register(setupSelect, tips.lightWith, 'bottom');
    tooltips.register(setupButton, tips.lightWith, 'bottom');
    setupSelect.on('change', (v: string) => {
        lastPreset = v;
    });
    setupButton.on('click', () => {
        lastPreset = setupSelect.value;
        if (isSplat && !info.lightSplats) events.invoke('toolkit.studio.setLightSplats', true);
        events.invoke('toolkit.studio.lightWith', target, setupSelect.value);
    });

    if (info.lights.length && reachable) {
        const checklist = new Container({ class: 'toolkit-checklist' });
        tooltips.register(checklist, tips.reach, 'left');
        info.lights.forEach((light) => {
            const r = new Container({ class: 'toolkit-check-row' });
            if (!light.visible) r.class.add('dimmed');
            const check = new BooleanInput({ type: 'checkbox', value: light.reaches });
            const name = new Label({ text: light.name, class: 'toolkit-check-name' });
            const state = new Label({ text: light.visible ? '' : 'off', class: 'toolkit-check-kind' });
            r.append(check);
            r.append(name);
            r.append(state);
            check.on('change', (value: boolean) => events.invoke('toolkit.studio.setReach', target, light.index, value));
            name.dom.addEventListener('click', () => {
                check.value = !check.value;
            });
            checklist.append(r);
        });
        box.append(checklist);
    }
    if (info.lights.length) {
        toggleRow('Shadows', tips.casts, info.casts, v => events.invoke('toolkit.studio.setCasts', target, v));
    }

    const actions = row();
    if (info.lights.length) {
        const aimHere = new Button({ text: info.subject ? 'Lights aim here' : 'Aim lights here', class: 'toolkit-button' });
        aimHere.enabled = !info.subject;
        aimHere.on('click', () => events.invoke('toolkit.studio.aimHere', target));
        tooltips.register(aimHere, tips.aimHere, 'bottom');
        actions.append(aimHere);
    }
    const openPanel = new Button({ text: 'Lighting panel…', class: 'toolkit-button' });
    openPanel.on('click', () => events.invoke('toolkit.studio.openPanel'));
    tooltips.register(openPanel, tips.panel, 'bottom');
    actions.append(openPanel);
    box.append(actions);

    if (isSplat && info.lights.length && reachable && on > 0) {
        const bakeRow = row();
        const bake = new Button({ text: 'Bake lighting into a lit copy', class: 'toolkit-bake' });
        bake.on('click', async () => {
            bake.enabled = false;
            try {
                await events.invoke('toolkit.studio.relightSplat', target);
            } finally {
                if (!bake.destroyed) bake.enabled = true;
            }
        });
        tooltips.register(bake, tips.relight, 'bottom');
        bakeRow.append(bake);
        box.append(bakeRow);
    }
};

export { renderQuickLighting };
