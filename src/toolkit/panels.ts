import { Button, Container, Element as PcuiElement, Label } from '@playcanvas/pcui';

import type { ToolkitContext } from './index';

// The toolkit's floating panels: each one gets a toggle button in its own
// group at the bottom of the right toolbar, a close button, and can be dragged
// around by its title bar (double-click the title bar to put it back). Which
// panels are open and where they stand is remembered in the browser.

type PanelOptions = {
    id: string;
    panel: Container;
    header: Container;
    // toolbar button: icon (svg data url), name and tooltip
    icon: string;
    title: string;
    tooltip: string;
    // position in the toolbar group, top to bottom
    order: number;
    defaultVisible?: boolean;
    // called when the panel is closed (e.g. to end what only the panel controls)
    onHide?: () => void;
};

type PanelHandle = {
    readonly visible: boolean;
    // true while the panel sits at its default place (not dragged)
    readonly docked: boolean;
    setVisible: (visible: boolean) => void;
    toggle: () => void;
};

type StoredPanel = { visible?: boolean, left?: number, top?: number };

const STORAGE_KEY = 'supersplat.toolkit.panels';

const load = (): Record<string, StoredPanel> => {
    try {
        return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') ?? {};
    } catch {
        return {};
    }
};

const save = (id: string, change: StoredPanel | null) => {
    try {
        const all = load();
        if (change === null) {
            delete all[id];
        } else {
            all[id] = { ...all[id], ...change };
        }
        localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
    } catch {
        // storage unavailable (private window): panels just don't remember
    }
};

const createSvg = (svgString: string) => {
    const decodedStr = decodeURIComponent(svgString.substring('data:image/svg+xml,'.length));
    return new DOMParser().parseFromString(decodedStr, 'image/svg+xml').documentElement;
};

// toolbar group shared by all panels
const buttons: { order: number, dom: HTMLElement }[] = [];
let separator: HTMLElement | null = null;
let zTop = 10;

const placeButton = (order: number, dom: HTMLElement) => {
    const toolbar = document.getElementById('right-toolbar');
    if (!toolbar) return;
    if (!separator) {
        separator = new PcuiElement({ class: 'right-toolbar-separator' }).dom;
    }
    buttons.push({ order, dom });
    buttons.sort((a, b) => a.order - b.order);
    toolbar.appendChild(separator);
    buttons.forEach(b => toolbar.appendChild(b.dom));
};

const registerPanel = (ctx: ToolkitContext, options: PanelOptions): PanelHandle => {
    const { events, tooltips } = ctx;
    const { id, panel, header } = options;
    const stored = load()[id] ?? {};

    panel.class.add('toolkit-floating');

    // ---- toolbar toggle
    const toggle = new Button({ id: `right-toolbar-toolkit-${id}`, class: 'right-toolbar-toggle' });
    toggle.dom.appendChild(createSvg(options.icon));
    toggle.dom.setAttribute('aria-label', options.title);
    tooltips.register(toggle, options.tooltip, 'left');
    placeButton(options.order, toggle.dom);

    // ---- close button in the title bar
    const close = new Button({ class: ['panel-header-button', 'toolkit-panel-close'], icon: 'E389' });
    header.append(close);
    tooltips.register(close, 'Close (reopen it from the right toolbar)', 'bottom');

    const bringToFront = () => {
        panel.dom.style.zIndex = String(++zTop);
    };

    let docked = stored.left === undefined;

    // ---- position
    const parentRect = () => (panel.dom.offsetParent as HTMLElement ?? panel.dom.parentElement)?.getBoundingClientRect();

    const place = (left: number, top: number, persist: boolean) => {
        const parent = parentRect();
        if (!parent) return;
        const width = panel.dom.offsetWidth || 300;
        const l = Math.max(0, Math.min(parent.width - Math.min(width, 120), left));
        const t = Math.max(0, Math.min(parent.height - 40, top));
        const style = panel.dom.style;
        style.left = `${l}px`;
        style.top = `${t}px`;
        style.right = 'auto';
        style.bottom = 'auto';
        style.transform = 'none';
        style.maxHeight = `${Math.max(120, parent.height - t - 12)}px`;
        docked = false;
        if (persist) save(id, { left: l, top: t });
    };

    const dock = () => {
        const style = panel.dom.style;
        style.left = style.top = style.right = style.bottom = style.transform = style.maxHeight = '';
        docked = true;
        save(id, { left: undefined, top: undefined });
    };

    // ---- visibility
    const setVisible = (visible: boolean) => {
        if (visible === !panel.hidden) return;
        panel.hidden = !visible;
        toggle.class[visible ? 'add' : 'remove']('active');
        save(id, { visible });
        if (visible) {
            bringToFront();
            if (!docked) {
                // re-clamp: the window may have changed size meanwhile
                const s = load()[id];
                if (s?.left !== undefined) place(s.left, s.top, false);
            }
        } else {
            options.onHide?.();
        }
        events.fire(`toolkit.panel.${id}.visible`, visible);
    };

    toggle.on('click', () => setVisible(panel.hidden));
    close.on('click', () => setVisible(false));

    // ---- dragging by the title bar
    header.class.add('toolkit-drag-handle');
    let drag: { dx: number, dy: number, pointer: number } | null = null;

    header.dom.addEventListener('pointerdown', (event: PointerEvent) => {
        if (event.button !== 0) return;
        if ((event.target as HTMLElement).closest('.pcui-button, input, .pcui-select-input, .panel-header-button')) return;
        const rect = panel.dom.getBoundingClientRect();
        drag = { dx: event.clientX - rect.left, dy: event.clientY - rect.top, pointer: event.pointerId };
        header.dom.setPointerCapture(event.pointerId);
        header.class.add('dragging');
        event.preventDefault();
    });
    header.dom.addEventListener('pointermove', (event: PointerEvent) => {
        if (!drag || event.pointerId !== drag.pointer) return;
        const parent = parentRect();
        if (!parent) return;
        place(event.clientX - parent.left - drag.dx, event.clientY - parent.top - drag.dy, false);
    });
    const endDrag = (event: PointerEvent) => {
        if (!drag || event.pointerId !== drag.pointer) return;
        drag = null;
        header.class.remove('dragging');
        if (!docked) {
            const parent = parentRect();
            const rect = panel.dom.getBoundingClientRect();
            if (parent) save(id, { left: rect.left - parent.left, top: rect.top - parent.top });
        }
    };
    header.dom.addEventListener('pointerup', endDrag);
    header.dom.addEventListener('pointercancel', endDrag);
    header.dom.addEventListener('dblclick', (event: MouseEvent) => {
        if ((event.target as HTMLElement).closest('.pcui-button, input, .pcui-select-input')) return;
        dock();
    });

    // clicking anywhere in a panel puts it on top of the others
    panel.dom.addEventListener('pointerdown', bringToFront, true);

    window.addEventListener('resize', () => {
        if (!docked && !panel.hidden) {
            const s = load()[id];
            if (s?.left !== undefined) place(s.left, s.top, false);
        }
    });

    // ---- initial state
    panel.hidden = true;
    const visible = stored.visible ?? !!options.defaultVisible;
    if (stored.left !== undefined) {
        // applied once the panel is laid out
        requestAnimationFrame(() => place(stored.left, stored.top, false));
    }
    if (visible) setVisible(true);

    return {
        get visible() {
            return !panel.hidden;
        },
        get docked() {
            return docked;
        },
        setVisible,
        toggle: () => setVisible(panel.hidden)
    };
};

// a title bar icon from an svg
const headerIcon = (icon: string) => {
    const label = new Label({ class: ['panel-header-icon', 'toolkit-header-icon'] });
    label.dom.appendChild(createSvg(icon));
    return label;
};

export { registerPanel, headerIcon, PanelHandle };
