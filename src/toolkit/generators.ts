import { Button, Container, Label } from '@playcanvas/pcui';

import { callTool, serviceTools } from './service';

import type { ToolkitContext, ToolkitModule } from './index';

// Generators: tools that create a new splat layer from something else. They
// run in the local helper service; this module is only the ui around them.

const tips = {
    sharp: 'Turn a single photo into a gaussian splat with Apple SHARP, running locally on this Mac. The first run after starting the service loads the model and is slower. Good for views close to the original camera, not for walking around. Apple licenses the model for non-commercial research use only.',
    status: 'State of the local toolkit service that runs the generators. If it is offline, start it from the project folder with: npm run toolkit:server'
};

const init = (ctx: ToolkitContext) => {
    const { events, canvasContainer, tooltips } = ctx;

    const panel = new Container({ id: 'toolkit-generators-panel', class: 'panel' });
    ['pointerdown', 'pointerup', 'pointermove', 'wheel', 'dblclick'].forEach((eventName) => {
        panel.dom.addEventListener(eventName, (event: Event) => event.stopPropagation());
    });

    const header = new Container({ class: 'panel-header' });
    header.append(new Label({ text: '\uE195', class: 'panel-header-icon' }));
    header.append(new Label({ text: 'Generate', class: 'panel-header-label' }));
    const status = new Label({ text: '…', class: 'toolkit-status' });
    header.append(status);

    const row = new Container({ class: 'toolkit-row' });
    const sharp = new Button({ text: 'Photo → splat (SHARP)', class: 'toolkit-button' });
    row.append(sharp);

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/png,image/jpeg,image/webp,image/heic';
    fileInput.style.display = 'none';
    panel.dom.appendChild(fileInput);

    panel.append(header);
    panel.append(row);
    canvasContainer.append(panel);

    tooltips.register(sharp, tips.sharp, 'bottom');
    tooltips.register(status, tips.status, 'bottom');

    const refreshStatus = async () => {
        const tools = await serviceTools();
        status.text = tools ? 'service on' : 'service off';
        status.class[tools ? 'add' : 'remove']('online');
        return tools;
    };
    refreshStatus();
    panel.dom.addEventListener('pointerenter', () => {
        refreshStatus();
    });

    const photoToSplat = async (file: File) => {
        sharp.enabled = false;
        sharp.text = 'Generating…';
        events.fire('startSpinner');
        try {
            const ply = await callTool('sharp', file, { name: file.name });
            const filename = `${file.name.replace(/\.[^.]+$/, '')}_sharp.ply`;
            await events.invoke('import', [{ filename, contents: new File([ply], filename) }]);
        } catch (error) {
            await events.invoke('showPopup', {
                type: 'error',
                header: 'Photo → splat',
                message: (error as Error).message
            });
        } finally {
            events.fire('stopSpinner');
            sharp.text = 'Photo → splat (SHARP)';
            sharp.enabled = true;
            refreshStatus();
        }
    };

    events.function('toolkit.photoToSplat', photoToSplat);

    sharp.on('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
        const file = fileInput.files?.[0];
        fileInput.value = '';
        if (file) {
            photoToSplat(file);
        }
    });
};

const generatorsModule: ToolkitModule = {
    id: 'generators',
    init
};

export { generatorsModule };
