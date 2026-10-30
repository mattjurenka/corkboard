// --pre-js for the node build: emscripten starts with a canned environment,
// so hand the real process environment (HOME, TMPDIR, VIMRUNTIME, ...) to
// the wasm side before main runs.
Module.preRun = (Module.preRun || []).concat(() => {
  Object.assign(ENV, process.env);
});
