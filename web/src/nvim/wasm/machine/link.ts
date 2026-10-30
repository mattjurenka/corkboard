// Calls from Neovim's worker to the machine's (machine.ts), answered while
// the caller blocks: the call goes as a message on a MessagePort, and the
// answer comes back in shared memory, which the caller waits on with
// Atomics.wait. A worker may block; the machine's is the one that doesn't.
//
// The reply buffer: Int32 [0] state (0 waiting, 1 answered), Int32 [1] the
// answer's length (-1: too big to fit), then the answer's bytes.

const HEADER = 8;
// Neovim reads files a piece at a time; nothing it asks comes near this.
export const REPLY_BYTES = 16 * 1024 * 1024;

type Call = { path: string; body: Uint8Array; wait: boolean };

export function replyBuffer() {
  return new SharedArrayBuffer(REPLY_BYTES);
}

// The caller's side: call(path, body) is the answer; send(path, body) has none.
export function caller(port: MessagePort, reply: SharedArrayBuffer) {
  const state = new Int32Array(reply, 0, 2);
  const bytes = new Uint8Array(reply, HEADER);
  return {
    call(path: string, body: Uint8Array): Uint8Array {
      Atomics.store(state, 0, 0);
      port.postMessage({ path, body, wait: true } satisfies Call);
      Atomics.wait(state, 0, 0);
      const n = state[1];
      if (n < 0) throw new Error(`${path}: the answer was too big`);
      return bytes.slice(0, n);
    },
    send(path: string, body: Uint8Array) {
      port.postMessage({ path, body, wait: false } satisfies Call);
    },
  };
}

// The machine's side. An answer may take a while (git's work is all
// promises); calls are answered one at a time, in order.
export function answer(port: MessagePort, reply: SharedArrayBuffer, handle: (path: string, body: Uint8Array) => Uint8Array | Promise<Uint8Array>) {
  const state = new Int32Array(reply, 0, 2);
  const bytes = new Uint8Array(reply, HEADER);
  let queue = Promise.resolve();
  port.onmessage = ({ data }: MessageEvent<Call>) => {
    queue = queue.then(() => respond(data));
  };
  const respond = async (data: Call) => {
    const out = await handle(data.path, data.body);
    if (!data.wait) return;
    if (out.length > bytes.length) state[1] = -1;
    else {
      bytes.set(out);
      state[1] = out.length;
    }
    Atomics.store(state, 0, 1);
    Atomics.notify(state, 0);
  };
}
