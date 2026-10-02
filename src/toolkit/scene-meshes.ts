import { BooleanInput, Container, Label, Element as PcuiElement } from '@playcanvas/pcui';

import type { MeshPrimitive } from './mesh-primitive';
import { primitiveIcon } from './primitive-icons';
import deleteSvg from '../ui/svg/delete.svg';
import hiddenSvg from '../ui/svg/hidden.svg';
import shownSvg from '../ui/svg/shown.svg';

import type { ToolkitContext, ToolkitModule } from './index';

// The meshes in SuperSplat's scene manager, under the splat layers: one list
// for everything in the scene. A click selects the mesh (and shows it in the
// inspector), the eye hides it, the bin deletes it - all through the history.
// A "Show meshes" checkbox under the header turns the list on and off.

type MeshRow = {
    primitive: MeshPrimitive,
    name: string,
    glyph: string,
    kind: string,
    visible: boolean,
    selected: boolean
};

const STORAGE_KEY = 'supersplat.toolkit.sceneMeshes';

const tips = {
    show: 'List the meshes (shapes, images, models, plants, rocks) here too, under the splat layers.',
    row: 'Click to select and edit in the inspector. Double-click to frame it in the view.',
    visible: 'Hide or show this mesh (undo with Ctrl+Z).',
    remove: 'Delete this mesh (undo with Ctrl+Z).'
};

const createSvg = (svgString: string) => {
    const decodedStr = decodeURIComponent(svgString.substring('data:image/svg+xml,'.length));
    return new DOMParser().parseFromString(decodedStr, 'image/svg+xml').documentElement;
};

const loadShow = () => {
    try {
        return localStorage.getItem(STORAGE_KEY) !== 'false';
    } catch {
        return true;
    }
};

const saveShow = (value: boolean) => {
    try {
        localStorage.setItem(STORAGE_KEY, String(value));
    } catch {
        // storage unavailable: the choice lasts this session
    }
};

const init = (ctx: ToolkitContext) => {
    const { events, tooltips } = ctx;

    const panel = document.getElementById('scene-panel');
    const listContainer = panel?.querySelector('.splat-list-container');
    if (!panel || !listContainer) return;

    // ---- the checkbox, between the header and the lists
    const options = new Container({ class: 'toolkit-scene-options' });
    const show = new BooleanInput({ type: 'checkbox', value: loadShow() });
    const showLabel = new Label({ text: 'Show meshes', class: 'toolkit-scene-options-label' });
    const count = new Label({ text: '', class: 'toolkit-scene-options-count' });
    options.append(show);
    options.append(showLabel);
    options.append(count);
    tooltips.register(options, tips.show, 'right');
    showLabel.dom.addEventListener('click', () => {
        show.value = !show.value;
    });
    panel.insertBefore(options.dom, listContainer);

    // ---- the meshes, under the splat layers
    const section = new Container({ class: 'toolkit-scene-meshes' });
    const title = new Label({ text: 'Meshes', class: 'toolkit-scene-meshes-title' });
    const list = new Container({ class: ['splat-list', 'toolkit-scene-mesh-list'] });
    section.append(title);
    section.append(list);
    listContainer.appendChild(section.dom);

    const refresh = () => {
        const rows = (events.invoke('toolkit.meshes.list') ?? []) as MeshRow[];
        const anySelected = rows.some(r => r.selected);
        panel.classList.toggle('toolkit-mesh-active', anySelected);
        panel.classList.toggle('toolkit-has-meshes', show.value && rows.length > 0);
        count.text = rows.length ? String(rows.length) : '';
        section.hidden = !show.value || rows.length === 0;

        list.clear();
        if (section.hidden) return;

        rows.forEach((r) => {
            const item = new Container({ class: ['splat-item', 'toolkit-scene-mesh'] });
            if (r.visible) item.class.add('visible');
            if (r.selected) item.class.add('selected');

            const icon = new Container({ class: 'toolkit-scene-mesh-icon' });
            icon.dom.innerHTML = primitiveIcon(r.glyph, 14);
            const text = new Label({ text: r.name, class: 'splat-item-text' });
            // the svg is the element, as in the splat rows, so the sizes match
            const eye = new PcuiElement({ dom: createSvg(r.visible ? shownSvg : hiddenSvg), class: 'splat-item-visible' });
            const remove = new PcuiElement({ dom: createSvg(deleteSvg), class: 'splat-item-delete' });

            item.append(icon);
            item.append(text);
            item.append(eye);
            item.append(remove);

            item.dom.addEventListener('click', () => {
                events.invoke('toolkit.meshes.select', r.primitive);
            });
            item.dom.addEventListener('dblclick', () => {
                events.invoke('toolkit.meshes.select', r.primitive);
                events.fire('camera.focus');
            });
            eye.dom.addEventListener('click', (event) => {
                event.stopPropagation();
                events.invoke('toolkit.meshes.toggleVisible', r.primitive);
            });
            remove.dom.addEventListener('click', (event) => {
                event.stopPropagation();
                events.invoke('toolkit.meshes.remove', r.primitive);
            });

            tooltips.register(text, `${r.kind}. ${tips.row}`, 'right');
            tooltips.register(eye, tips.visible, 'top');
            tooltips.register(remove, tips.remove, 'top');

            list.append(item);
        });
    };

    show.on('change', (value: boolean) => {
        saveShow(value);
        refresh();
    });
    events.on('toolkit.meshes.changed', refresh);
    events.on('scene.clear', refresh);
    refresh();
};

const sceneMeshesModule: ToolkitModule = {
    id: 'sceneMeshes',
    init
};

export { sceneMeshesModule };
