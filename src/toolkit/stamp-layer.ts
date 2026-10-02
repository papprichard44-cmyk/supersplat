import { AddSplatOp, RemoveInstancesOp } from '../edit-ops';
import type { EditorSplatResource } from '../editor-splat-resource';
import { GaussianInstances } from '../gaussian-instances';
import { IndexRanges } from '../index-ranges';
import { MappedReadFileSystem } from '../io';
import type { Scene } from '../scene';
import { Splat } from '../splat';
import { floatsOf, plyBlob } from './stamp-math';

// Stamp layers: splat layers the stamp brush paints into. Each one keeps the
// raw rows of its file as a Blob, so a stroke only has to append the new
// copies' bytes (Blobs compose without copying) and reload the layer from
// that. The history ops below only hold their own stroke's bytes, so a long
// painting session costs no more memory than the gaussians actually painted.
//
// A stroke swaps the layer's static data for a longer one and appends one
// instance per new row; the existing instances (with their selection, lock,
// transform and colour state) are kept as they are. The history is strictly
// LIFO, so when a stroke is undone its instances are exactly the last ones and
// cutting them off restores the layer's previous state exactly.

type LayerData = {
    rest: number;           // f_rest floats per gaussian
    body: Blob;             // the layer's rows, without a PLY header
    rows: number;
    // per copy (COPY floats): first row, row count, centre xyz and radius in
    // the layer's file space - what the eraser works from
    copies: number[];
};

const COPY = 6;

const layers = new WeakMap<Splat, LayerData>();

const stampLayerData = (splat: Splat | null) => (splat ? layers.get(splat) ?? null : null);

let fileCounter = 0;

// a gsplat asset over the given rows, in file order (no reordering: rows must
// keep their indices from one stroke to the next)
const loadRows = async (scene: Scene, body: Blob, rows: number, rest: number) => {
    const filename = `stamp-layer-${++fileCounter}.ply`;
    const fileSystem = new MappedReadFileSystem();
    fileSystem.addFile(filename, plyBlob(body, rows, rest));
    const loaded = await scene.assetLoader.loadAsset(filename, fileSystem, true, true);
    if (!loaded) {
        throw new Error('the stamp layer could not be loaded');
    }
    return loaded;
};

// bind new static data and instances to a layer, keeping everything else
// about it (name, transform, palettes, list position). Mirrors Splat.replaceData
const swapData = async (splat: Splat, data: { asset: any }, instances: GaussianInstances) => {
    const oldAsset = splat.asset;
    const oldResource = splat.resource;
    const oldInstances = splat.instances;

    (splat as any).bindAsset(data.asset, undefined, instances);
    await splat.updateState();
    splat.scene?.events.fire('splat.replaced', splat);

    oldInstances.destroy();
    if (oldResource.release()) {
        oldAsset.registry?.remove(oldAsset);
        oldAsset.unload();
    }
    splat.changedCounter++;
    if (splat.scene) splat.scene.forceRender = true;
};

// the layer's instances plus one clean instance per appended row
const extendedInstances = (splat: Splat, numRows: number, firstRow: number, appended: number) => {
    const old = splat.instances;
    const count = old.count + appended;
    const sourceRow = new Uint32Array(count);
    const flags = new Uint8Array(count);
    const palette = new Uint32Array(count);
    sourceRow.set(old.sourceRow.subarray(0, old.count));
    flags.set(old.flags.subarray(0, old.count));
    palette.set(old.palette.subarray(0, old.count));
    for (let i = 0; i < appended; ++i) {
        sourceRow[old.count + i] = firstRow + i;
    }
    return GaussianInstances.fromRecords((splat.resource as EditorSplatResource).device, numRows, sourceRow, flags, palette);
};

// the layer's instances without the last `removed` ones
const truncatedInstances = (splat: Splat, numRows: number, removed: number) => {
    const old = splat.instances;
    const count = Math.max(0, old.count - removed);
    return GaussianInstances.fromRecords(
        (splat.resource as EditorSplatResource).device,
        numRows,
        old.sourceRow.slice(0, count),
        old.flags.slice(0, count),
        old.palette.slice(0, count)
    );
};

// adds a new stamp layer; `applied` resolves once it is in the scene
class AddStampLayerOp extends AddSplatOp {
    applied: Promise<void>;
    private resolveApplied: () => void;

    constructor(scene: Scene, splat: Splat) {
        super(scene, splat);
        this.applied = new Promise((resolve) => {
            this.resolveApplied = resolve;
        });
    }

    async do() {
        try {
            await super.do();
        } finally {
            this.resolveApplied?.();
            this.resolveApplied = null;
        }
    }

    destroy() {
        this.resolveApplied?.();
        super.destroy();
    }
}

// create a new stamp layer from its first stroke. The caller adds it to the
// scene with the returned op, so creating it is undoable like any stroke
const createStampLayer = async (scene: Scene, rows: Float32Array, rest: number, copies: number[], name: string) => {
    const count = rows.length / floatsOf(rest);
    const body = new Blob([rows as BlobPart]);
    const { asset, rotation } = await loadRows(scene, body, count, rest);
    const splat = new Splat(asset, rotation);
    splat._name = name;
    // the rows are in PLY space: give the layer exactly the frame the exporter
    // undoes (180 degrees about z), whatever the loader picked
    splat.entity.setLocalPosition(0, 0, 0);
    splat.entity.setLocalEulerAngles(0, 0, 180);
    splat.entity.setLocalScale(1, 1, 1);
    layers.set(splat, { rest, body, rows: count, copies: copies.slice() });
    return { splat, op: new AddStampLayerOp(scene, splat) };
};

// one stroke painted into an existing stamp layer
class StampStrokeOp {
    name = 'toolkitStampStroke';
    splat: Splat;
    private tail: Blob;
    private tailRows: number;
    private copies: number[];
    // resolves once the stroke has been applied the first time
    applied: Promise<void>;
    private resolveApplied: () => void;

    constructor(splat: Splat, rows: Float32Array, copies: number[]) {
        const data = layers.get(splat);
        this.splat = splat;
        this.tail = new Blob([rows as BlobPart]);
        this.tailRows = rows.length / floatsOf(data.rest);
        this.copies = copies.slice();
        this.applied = new Promise((resolve) => {
            this.resolveApplied = resolve;
        });
    }

    async do() {
        try {
            const data = layers.get(this.splat);
            const body = new Blob([data.body, this.tail]);
            const rows = data.rows + this.tailRows;
            const loaded = await loadRows(this.splat.scene, body, rows, data.rest);
            const instances = extendedInstances(this.splat, rows, data.rows, this.tailRows);
            await swapData(this.splat, loaded, instances);
            data.body = body;
            data.rows = rows;
            data.copies.push(...this.copies);
        } finally {
            this.resolveApplied?.();
            this.resolveApplied = null;
        }
    }

    async undo() {
        const data = layers.get(this.splat);
        const rows = data.rows - this.tailRows;
        const body = data.body.slice(0, rows * floatsOf(data.rest) * 4);
        const loaded = await loadRows(this.splat.scene, body, rows, data.rest);
        const instances = truncatedInstances(this.splat, rows, this.tailRows);
        await swapData(this.splat, loaded, instances);
        data.body = body;
        data.rows = rows;
        data.copies.length -= this.copies.length;
    }

    destroy() {
        this.resolveApplied?.();
        this.splat = null;
        this.tail = null;
    }
}

// remove whole copies from a stamp layer: every instance showing one of their
// rows. A plain instance removal, so it undoes like a delete
const eraseCopies = (splat: Splat, copyIndices: number[]) => {
    const data = layers.get(splat);
    if (!data || copyIndices.length === 0) return null;
    const erase = new Uint8Array(data.rows);
    copyIndices.forEach((c) => {
        const first = data.copies[c * COPY];
        erase.fill(1, first, first + data.copies[c * COPY + 1]);
    });
    const { sourceRow, count } = splat.instances;
    const ranges = IndexRanges.fromPredicate(count, i => erase[sourceRow[i]] === 1);
    if (ranges.count === 0) return null;
    const op = new RemoveInstancesOp(splat);
    op.ranges = ranges;
    return op;
};

// the copies of a layer that still show at least one gaussian
const liveCopies = (splat: Splat) => {
    const data = layers.get(splat);
    if (!data) return [];
    const present = new Uint8Array(data.rows);
    const { sourceRow, count } = splat.instances;
    for (let i = 0; i < count; ++i) present[sourceRow[i]] = 1;
    const result: number[] = [];
    for (let c = 0; c < data.copies.length / COPY; ++c) {
        const first = data.copies[c * COPY];
        const end = first + data.copies[c * COPY + 1];
        for (let r = first; r < end; ++r) {
            if (present[r]) {
                result.push(c);
                break;
            }
        }
    }
    return result;
};

export { COPY, LayerData, StampStrokeOp, createStampLayer, eraseCopies, liveCopies, stampLayerData };
