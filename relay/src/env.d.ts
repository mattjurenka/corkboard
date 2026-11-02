// What `wrangler types` would generate: the relay's Env, and the main
// module, so `exports` from cloudflare:workers is typed.
declare namespace Cloudflare {
  interface Env extends import("./index").Env {}
  interface GlobalProps {
    mainModule: typeof import("./index");
    durableNamespaces: "Log";
  }
}
