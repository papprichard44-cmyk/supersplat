import { Button, Container, Label } from '@playcanvas/pcui';

import { Element, ElementType } from '../element';
import { Splat } from '../splat';
import type { ToolkitContext, ToolkitModule } from './index';

// Compression-aware export: writes the scene in several formats / settings into
// memory with the editor's own exporters (which are splat-transform running in
// the browser), lists the resulting sizes side by side, and can load any result
// back as a temporary layer so its quality can be judged against the original.

type Preset = {
    id: string;
    label: string;
    tip: string;
    fileType: 'ply' | 'compressedPly' | 'sog' | 'spz';
    extension: string;
    maxSHBands: number;
};

const presets: Preset[] = [
    { id: 'ply', label: 'PLY', tip: 'Uncompressed PLY with all spherical harmonics: the reference for size and quality.', fileType: 'ply', extension: 'ply', maxSHBands: 3 },
    { id: 'ply-sh0', label: 'PLY, no SH', tip: 'Uncompressed PLY without spherical harmonics: view-dependent colour (reflections, sheen) is dropped, everything else is exact.', fileType: 'ply', extension: 'ply', maxSHBands: 0 },
    { id: 'cply', label: 'Compressed PLY', tip: 'PlayCanvas compressed PLY: positions, rotations, scales and colours quantised in chunks of 256 splats.', fileType: 'compressedPly', extension: 'compressed.ply', maxSHBands: 3 },
    { id: 'sog', label: 'SOG', tip: 'SOG: splat data stored as WebP images with clustered spherical harmonics. Usually the smallest file; takes the longest to write.', fileType: 'sog', extension: 'sog', maxSHBands: 3 },
    { id: 'sog-sh0', label: 'SOG, no SH', tip: 'SOG without spherical harmonics: the smallest option, without view-dependent colour.', fileType: 'sog', extension: 'sog', maxSHBands: 0 },
    { id: 'spz', label: 'SPZ', tip: 'Niantic SPZ (version 4): quantised and gzip-compressed, widely supported outside PlayCanvas.', fileType: 'spz', extension: 'spz', maxSHBands: 3 }
];

const tips = {
    run: 'Write the current scene in every listed format into memory (nothing is saved to disk) and list the file sizes. SOG takes the longest.',
    size: 'File size, and how it compares to the uncompressed PLY.',
    preview: 'Load this result into the viewport in place of the original layers, to judge its quality. Nothing in the scene is changed.',
    original: 'Remove the preview and show the original layers again.',
    save: 'Save this result to a file.'
};

// stands in for a FileSystemWritableFileStream and keeps the bytes in memory
class MemorySink {
    chunks: Uint8Array[] = [];
    size = 0;

    seek() {
        return Promise.resolve();
    }

    write(data: Uint8Array) {
        // the exporters reuse their buffers, so keep a copy
        this.chunks.push(data.slice());
        this.size += data.byteLength;
        return Promise.resolve();
    }

    truncate() {
        return Promise.resolve();
    }

    close() {
        return Promise.resolve();
    }

    abort() {
        this.chunks = [];
        this.size = 0;
        return Promise.resolve();
    }

    blob() {
        return new Blob(this.chunks as BlobPart[], { type: 'application/octet-stream' });
    }
}

const megabytes = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 2 : 1)} MB`;

const init = (ctx: ToolkitContext) => {
    const { events, scene, canvasContainer, tooltips } = ctx;

    const panel = new Container({ id: 'toolkit-compare-panel', class: 'panel' });
    ['pointerdown', 'pointerup', 'pointermove', 'wheel', 'dblclick'].forEach((eventName) => {
        panel.dom.addEventListener(eventName, (event: Event) => event.stopPropagation());
    });

    const header = new Container({ class: 'panel-header' });
    header.append(new Label({ text: '\uE228', class: 'panel-header-icon' }));
    header.append(new Label({ text: 'Export compare', class: 'panel-header-label' }));

    const runRow = new Container({ class: 'toolkit-row' });
    const run = new Button({ text: 'Compare formats', class: 'toolkit-button' });
    const original = new Button({ text: 'Show original', class: 'toolkit-button', hidden: true });
    runRow.append(run);
    runRow.append(original);

    const table = new Container({ class: 'toolkit-compare-table' });

    panel.append(header);
    panel.append(runRow);
    panel.append(table);
    canvasContainer.append(panel);

    tooltips.register(run, tips.run, 'bottom');
    tooltips.register(original, tips.original, 'bottom');

    const splats = () => scene.getElementsByType(ElementType.splat) as Splat[];

    // ---- preview: a temporary layer shown instead of the originals

    let preview: { splat: Splat, hidden: Splat[], row: Container } | null = null;

    const endPreview = () => {
        if (!preview) return;
        const { splat, hidden, row } = preview;
        preview = null;
        scene.remove(splat);
        splat.destroy();
        hidden.forEach((other) => {
            if (other.scene) {
                other.visible = true;
            }
        });
        row.class.remove('previewing');
        original.hidden = true;
        scene.forceRender = true;
    };

    const startPreview = async (preset: Preset, blob: Blob, row: Container) => {
        endPreview();
        const hidden = splats().filter(splat => splat.visible);
        let created: Element | null = null;
        const handle = events.on('scene.elementAdded', (element: Element) => {
            if (element.type === ElementType.splat) {
                created = element;
            }
        });
        try {
            const filename = `preview ${preset.label}.${preset.extension}`;
            await events.invoke('import', [{ filename, contents: new File([blob], filename) }]);
        } finally {
            handle.off();
        }
        if (!created) return;
        hidden.forEach((splat) => {
            splat.visible = false;
        });
        preview = { splat: created as Splat, hidden, row };
        row.class.add('previewing');
        original.hidden = false;
        scene.forceRender = true;
    };

    original.on('click', endPreview);

    // the preview goes with the rest of the scene
    events.on('scene.clear', () => {
        preview = null;
        original.hidden = true;
        table.clear();
    });

    const save = async (preset: Preset, blob: Blob) => {
        const suggestedName = `scene.${preset.extension}`;
        const picker = (window as any).showSaveFilePicker;
        if (picker) {
            try {
                const handle = await picker({ suggestedName });
                const writable = await handle.createWritable();
                await writable.write(blob);
                await writable.close();
            } catch (error) {
                if ((error as Error).name !== 'AbortError') {
                    await events.invoke('showPopup', { type: 'error', header: 'Export compare', message: `${(error as Error).message} while saving file` });
                }
            }
        } else {
            const link = document.createElement('a');
            link.href = URL.createObjectURL(blob);
            link.download = suggestedName;
            link.click();
            URL.revokeObjectURL(link.href);
        }
    };

    // ---- the comparison run

    let running = false;

    const compare = async () => {
        if (running) return [];
        endPreview();
        table.clear();
        if (splats().length === 0) {
            table.append(new Label({ text: 'Load a splat first.', class: 'toolkit-compare-note' }));
            return [];
        }
        running = true;
        run.enabled = false;
        const results: { id: string, bytes: number, seconds: number }[] = [];
        let reference = 0;
        try {
            for (const preset of presets) {
                const sink = new MemorySink();
                const start = performance.now();
                const written = await events.invoke('scene.write', preset.fileType, {
                    filename: `compare.${preset.extension}`,
                    splatIdx: 'all',
                    serializeSettings: { maxSHBands: preset.maxSHBands }
                }, sink);
                if (!written) break;       // the exporter already reported the error
                const seconds = (performance.now() - start) / 1000;
                const blob = sink.blob();
                if (preset.id === 'ply') {
                    reference = blob.size;
                }
                results.push({ id: preset.id, bytes: blob.size, seconds });

                const row = new Container({ class: 'toolkit-compare-row' });
                const name = new Label({ text: preset.label, class: 'toolkit-compare-name' });
                const percent = reference > 0 ? ` · ${(blob.size / reference * 100).toFixed(blob.size / reference < 0.1 ? 1 : 0)}%` : '';
                const size = new Label({ text: `${megabytes(blob.size)}${percent}`, class: 'toolkit-compare-size' });
                const previewButton = new Button({ text: 'Preview', class: 'toolkit-compare-button' });
                const saveButton = new Button({ text: 'Save', class: 'toolkit-compare-button' });
                previewButton.on('click', () => startPreview(preset, blob, row));
                saveButton.on('click', () => save(preset, blob));
                tooltips.register(name, preset.tip, 'left');
                tooltips.register(size, tips.size, 'left');
                tooltips.register(previewButton, tips.preview, 'bottom');
                tooltips.register(saveButton, tips.save, 'bottom');
                row.append(name);
                row.append(size);
                row.append(previewButton);
                row.append(saveButton);
                table.append(row);
            }
        } finally {
            running = false;
            run.enabled = true;
        }
        return results;
    };

    events.function('toolkit.compareExports', compare);
    run.on('click', () => {
        compare();
    });
};

const exportCompareModule: ToolkitModule = {
    id: 'exportCompare',
    init
};

export { exportCompareModule };
