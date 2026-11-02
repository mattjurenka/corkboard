// The bridge as one executable (scripts/build-bridge.ts): the server, or
// one of the scripts that otherwise run with bun, so a machine with the
// app needs no bun.
//
//   corkboard-bridge [--dev] [--resources DIR]   the bridge (server.ts)
//   corkboard-bridge mcp                         the board's MCP server (mcp/board.ts)
//   corkboard-bridge memory-sync ...             bridge/memory-sync.ts
//   corkboard-bridge login|token|machine ...     bridge/cloud.ts
//   corkboard-bridge e2ee ...                    bridge/e2ee.ts
//   corkboard-bridge serve ...                   the node, headless (bridge/node/serve.ts)
//
// Each reads its arguments from process.argv as if run on its own, so the
// subcommand comes out of it first.

const command = process.argv[2];
const own = () => process.argv.splice(2, 1);

if (command === "mcp") {
  own();
  await import("../mcp/board");
} else if (command === "memory-sync") {
  own();
  await import("./memory-sync");
} else if (command === "login" || command === "token" || command === "machine") {
  const { cli } = await import("./cloud");
  await cli(process.argv.slice(2));
} else if (command === "e2ee") {
  const { cli } = await import("./e2ee");
  await cli(process.argv.slice(3));
} else if (command === "serve") {
  const { cli } = await import("./node/serve");
  await cli(process.argv.slice(3));
} else {
  await import("./server");
}

export {};
