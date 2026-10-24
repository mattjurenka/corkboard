// msgpack-RPC with Neovim, carried as JSON over the bridge's websocket.
// [0, id, method, params] request, [1, id, error, result] response,
// [2, method, params] notification.

export class Rpc {
  constructor(url, protocols) {
    this.ws = new WebSocket(url, protocols);
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
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
    this.ws.send(JSON.stringify([0, id, method, params]));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  notify(method, ...params) {
    this.ws.send(JSON.stringify([2, method, params]));
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
