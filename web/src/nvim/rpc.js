// msgpack-RPC with Neovim, carried as JSON over the bridge's websocket.
// [0, id, method, params] request, [1, id, error, result] response,
// [2, method, params] notification.

export class Rpc {
  constructor(url, protocols) {
    this.ws = new WebSocket(url, protocols);
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
    // What was sent before the socket opened, sent once it has.
    this.queue = [];
    this.ready = new Promise((resolve, reject) => {
      this.ws.onopen = (e) => {
        for (const msg of this.queue) this.ws.send(msg);
        this.queue = [];
        resolve(e);
      };
      this.ws.onerror = reject;
    });
    this.ws.onmessage = (e) => this.#receive(JSON.parse(e.data));
    this.ws.onclose = (e) => this.handlers.get("close")?.(e);
  }

  on(method, fn) {
    this.handlers.set(method, fn);
  }

  request(method, ...params) {
    const id = this.nextId++;
    this.#send(JSON.stringify([0, id, method, params]));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  notify(method, ...params) {
    this.#send(JSON.stringify([2, method, params]));
  }

  #send(msg) {
    if (this.ws.readyState === WebSocket.CONNECTING) this.queue.push(msg);
    else this.ws.send(msg);
  }

  #receive(msg) {
    if (msg[0] === 1) {
      const [, id, err, result] = msg;
      const p = this.pending.get(id);
      this.pending.delete(id);
      if (err) p?.reject(err);
      else p?.resolve(result);
    } else if (msg[0] === 2) {
      this.handlers.get(msg[1])?.(msg[2]);
    } else if (msg[0] === 0) {
      // Neovim asking us something (rpcrequest); nothing answers yet.
      this.ws.send(JSON.stringify([1, msg[1], "no handler", null]));
    }
  }
}
