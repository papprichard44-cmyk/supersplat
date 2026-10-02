// Stands in for a FileSystemWritableFileStream and keeps the bytes in memory,
// so the editor's own exporters can be used to write a file without touching
// the disk.
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

export { MemorySink };
