import { Container, Label } from '@playcanvas/pcui';

import inspectorSvg from './icons/inspector.svg';
import { headerIcon, registerPanel } from './panels';

import type { ToolkitContext, ToolkitModule } from './index';

// The inspector: one panel that shows whatever is selected - a mesh or a
// studio light - with its settings in collapsible groups, the way the
// inspector / properties / details panels of 3D and design tools work. The
// modules that own a selection hand their content over with
// 'toolkit.inspector.show' and take it back with 'toolkit.inspector.hide'.
// Scene-wide things (lighting setups, environment) stay in their own panels.

type InspectorContent = {
    title: string;          // the object's name
    kind: string;           // what it is ("Box", "Spot light"...)
    content: Container;
};

// ---- collapsible groups

const GROUPS_KEY = 'supersplat.toolkit.groups';

const loadGroups = (): Record<string, boolean> => {
    try {
        return JSON.parse(localStorage.getItem(GROUPS_KEY) ?? '{}') ?? {};
    } catch {
        return {};
    }
};

const saveGroup = (id: string, open: boolean) => {
    try {
        const all = loadGroups();
        all[id] = open;
        localStorage.setItem(GROUPS_KEY, JSON.stringify(all));
    } catch {
        // storage unavailable: groups just don't remember
    }
};

type Group = {
    root: Container;
    body: Container;
    // right end of the title bar: a short summary, or a quick control
    extra: Container;
    setOpen: (open: boolean) => void;
    readonly open: boolean;
};

// a titled group whose content folds away; it remembers whether it was open
const collapsible = (title: string, id: string, defaultOpen = true): Group => {
    const root = new Container({ class: 'toolkit-group' });
    const head = new Container({ class: 'toolkit-group-head' });
    const chevron = new Label({ text: '', class: 'toolkit-group-chevron' });
    const label = new Label({ text: title, class: 'toolkit-group-title' });
    const extra = new Container({ class: 'toolkit-group-extra' });
    head.append(chevron);
    head.append(label);
    head.append(extra);
    const body = new Container({ class: 'toolkit-group-body' });
    root.append(head);
    root.append(body);

    let open = loadGroups()[id] ?? defaultOpen;
    const apply = () => {
        body.hidden = !open;
        root.class[open ? 'add' : 'remove']('open');
    };
    apply();
    head.dom.addEventListener('click', (event: MouseEvent) => {
        // controls in the title bar work without folding the group
        if ((event.target as HTMLElement).closest('.toolkit-group-extra .pcui-button, .toolkit-group-extra .pcui-boolean-input, .toolkit-group-extra input')) return;
        open = !open;
        saveGroup(id, open);
        apply();
    });
    return {
        root,
        body,
        extra,
        setOpen: (value: boolean) => {
            open = value;
            apply();
        },
        get open() {
            return open;
        }
    };
};

// ---- the panel

const init = (ctx: ToolkitContext) => {
    const { events, canvasContainer } = ctx;

    const panel = new Container({ id: 'toolkit-inspector-panel', class: 'panel' });
    ['pointerdown', 'pointerup', 'pointermove', 'wheel', 'dblclick'].forEach((eventName) => {
        panel.dom.addEventListener(eventName, (event: Event) => event.stopPropagation());
    });
    const header = new Container({ class: 'panel-header' });
    header.append(headerIcon(inspectorSvg));
    const title = new Label({ text: 'Inspector', class: 'panel-header-label' });
    header.append(title);
    const kind = new Label({ text: '', class: 'toolkit-inspector-kind' });
    header.append(kind);
    panel.append(header);

    const body = new Container({ class: 'toolkit-inspector-body' });
    panel.append(body);
    const empty = new Label({
        text: 'Select a mesh (in the Objects list or the viewport) or a light to see and change it here: placement, look, lighting and conversion to splats, all in one place.',
        class: ['toolkit-hint', 'toolkit-inspector-empty']
    });
    body.append(empty);
    canvasContainer.append(panel);

    const handle = registerPanel(ctx, {
        id: 'inspector',
        panel,
        header,
        icon: inspectorSvg,
        title: 'Inspector',
        tooltip: 'Inspector: the selected mesh or light, with everything you can set on it.',
        order: 0.5,
        defaultVisible: true
    });

    // who has something to show; the latest wins
    const owners = new Map<string, InspectorContent>();
    let shown: Container | null = null;

    const render = () => {
        const current = [...owners.values()].pop() ?? null;
        if (shown && shown !== current?.content) {
            body.remove(shown);
            shown = null;
        }
        if (current && shown !== current.content) {
            body.append(current.content);
            shown = current.content;
        }
        empty.hidden = !!current;
        title.text = current ? current.title : 'Inspector';
        kind.text = current ? current.kind : '';
    };

    events.function('toolkit.inspector.show', (owner: string, content: InspectorContent) => {
        owners.delete(owner);
        owners.set(owner, content);
        render();
    });
    events.function('toolkit.inspector.hide', (owner: string) => {
        if (owners.delete(owner)) render();
    });
    events.function('toolkit.inspector.reveal', () => handle.setVisible(true));
    events.function('toolkit.inspector.visible', () => handle.visible);
};

const inspectorModule: ToolkitModule = {
    id: 'inspector',
    init
};

export { inspectorModule, collapsible, Group };
