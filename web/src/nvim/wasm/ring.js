// neovim-wasm's web/ring.js, whose layout its pre.js reads: keep the two alike.
// Producer side of the stdin ring buffer read by web/pre.js.
//
// Layout of the SharedArrayBuffer:
//   Int32 [0]  bytes written (wrapping counter, written here)
//   Int32 [1]  bytes read    (wrapping counter, written by the worker)
//   bytes 16.. data, power-of-two length
export class InputRing {
  constructor(dataSize = 1 << 20) {
    this.buffer = new SharedArrayBuffer(16 + dataSize);
    this.head = new Int32Array(this.buffer, 0, 4);
    this.data = new Uint8Array(this.buffer, 16);
    this.mask = dataSize - 1;
    this.pending = [];
  }

  write(bytes) {
    this.pending.push(bytes);
    this.flush();
  }

  // Copy as much pending input as fits; retry later if the worker is behind.
  flush() {
    while (this.pending.length) {
      const chunk = this.pending[0];
      const w = this.head[0];
      const free = this.data.length - ((w - Atomics.load(this.head, 1)) | 0);
      const n = Math.min(free, chunk.length);
      for (let i = 0; i < n; i++) this.data[(w + i) & this.mask] = chunk[i];
      Atomics.store(this.head, 0, (w + n) | 0);
      Atomics.notify(this.head, 0);
      if (n < chunk.length) {
        this.pending[0] = chunk.subarray(n);
        setTimeout(() => this.flush(), 5);
        return;
      }
      this.pending.shift();
    }
  }
}
