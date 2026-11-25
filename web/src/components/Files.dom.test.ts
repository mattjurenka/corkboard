// The file browser's folder reads: corkboard.dir answers by id, and only a
// folder's latest read is used, whichever order they answer in.
import "@/testing/dom";
import { describe, expect, test } from "bun:test";
import { listDir, onDir } from "./Files";

function fake() {
  const asked: string[] = [];
  return { asked, notify: (_method: string, _code: string, [, id]: [string, string]) => void asked.push(id) };
}

describe("listDir", () => {
  test("an earlier read answering last is dropped", async () => {
    const nvim = fake();
    const first = listDir(nvim, "/p");
    const second = listDir(nvim, "/p");
    onDir([nvim.asked[1], [{ name: "new" }]]);
    onDir([nvim.asked[0], [{ name: "old" }]]);
    expect(await second).toEqual([{ name: "new" }]);
    expect(await first).toBeUndefined();
  });

  test("a folder gone answers null, and other folders don't get in the way", async () => {
    const nvim = fake();
    const a = listDir(nvim, "/a");
    const b = listDir(nvim, "/b");
    onDir([nvim.asked[0], null]);
    onDir([nvim.asked[1], [{ name: "x" }]]);
    expect(await a).toBeNull();
    expect(await b).toEqual([{ name: "x" }]);
  });

  test("no answer at all comes back undefined, not as gone", async () => {
    expect(await listDir(fake(), "/never", 10)).toBeUndefined();
  });
});
