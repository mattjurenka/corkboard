// --pre-js for the browser build; runs inside the Web Worker hosting nvim.
//
// The page talks msgpack-RPC to `nvim --embed` over fds 0 and 1, which are
// replaced by two devices typed as FIFOs (so libuv treats them as pipes):
//   fd 0 <- ring buffer in Module.inputBuffer, a SharedArrayBuffer the page
//           writes into (layout in web/ring.js)
//   fd 1 -> postMessage({type: 'out'}) to the page
// libuv calls Module.uvWait(timeout) when it has nothing to do; it sleeps on
// the ring with Atomics.wait, so nvim blocks like a native process instead
// of spinning.

Module.preRun = (Module.preRun || []).concat(() => {
  const EAGAIN = 6, POLLIN = 1, POLLOUT = 4, S_IFIFO = 0o010000;

  const head = new Int32Array(Module.inputBuffer, 0, 4);
  const data = new Uint8Array(Module.inputBuffer, 16);
  const mask = data.length - 1;  // power of two
  const available = () => (Atomics.load(head, 0) - head[1]) | 0;

  Module.uvWait = (timeout) => {
    const w = Atomics.load(head, 0);
    if (w !== head[1]) return;
    Atomics.wait(head, 0, w, timeout < 0 ? Infinity : timeout);
  };

  const input = {
    read(stream, buffer, offset, length) {
      const r = head[1];
      const n = Math.min(length, available());
      if (n === 0) throw new FS.ErrnoError(EAGAIN);
      for (let i = 0; i < n; i++) buffer[offset + i] = data[(r + i) & mask];
      Atomics.store(head, 1, (r + n) | 0);
      return n;
    },
    poll: () => (available() > 0 ? POLLIN : 0),
  };

  const output = {
    write(stream, buffer, offset, length) {
      const chunk = new Uint8Array(buffer.buffer, buffer.byteOffset + offset, length).slice();
      postMessage({ type: 'out', data: chunk }, [chunk.buffer]);
      return length;
    },
    poll: () => POLLOUT,
  };

  for (const [name, ops, minor] of [['ui-in', input, 0], ['ui-out', output, 1]]) {
    const dev = FS.makedev(64, minor);
    FS.registerDevice(dev, ops);
    FS.mkdev('/dev/' + name, 0o666, dev);
    FS.lookupPath('/dev/' + name).node.mode = S_IFIFO | 0o666;
  }

  FS.mkdirTree('/home/web');
  Object.assign(ENV, {
    HOME: '/home/web',
    VIMRUNTIME: '/usr/share/nvim/runtime',
    LANG: 'en_US.UTF-8',
  });

  // An embedder's own setup (mounts, environment), with what it needs from
  // inside the module.
  Module.hostSetup?.({ FS, ENV });
});

// Standard streams exist once the runtime is up; swap ours in before main.
Module.onRuntimeInitialized = () => {
  FS.close(FS.getStream(0));
  if (FS.open('/dev/ui-in', 0).fd !== 0) throw new Error('stdin not on fd 0');
  FS.close(FS.getStream(1));
  if (FS.open('/dev/ui-out', 1).fd !== 1) throw new Error('stdout not on fd 1');
};

Module.onExit = (code) => postMessage({ type: 'exit', code });
Module.onAbort = (what) => postMessage({ type: 'abort', what: String(what) });
