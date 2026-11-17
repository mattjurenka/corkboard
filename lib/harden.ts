// Object.prototype's __proto__ setter made harmless, before anything else
// runs: `o["__proto__"] = v`, or Object.assign from parsed JSON, makes a key
// like any other instead of replacing o's prototype. Reading o.__proto__
// still gives the prototype, which some libraries do (transformers.js's
// typed-array check). Node's --disable-proto, which Bun hasn't, kinder.
const { get } = Object.getOwnPropertyDescriptor(Object.prototype, "__proto__") ?? {};
if (get)
  Object.defineProperty(Object.prototype, "__proto__", {
    get,
    set(this: unknown, value: unknown) {
      if (this !== null && typeof this === "object") Object.defineProperty(this, "__proto__", { value, writable: true, enumerable: true, configurable: true });
    },
    configurable: true,
  });
export {};
