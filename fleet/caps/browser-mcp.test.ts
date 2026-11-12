// What browser_start makes of an extension spec.   bun test fleet/caps
import { expect, test } from "bun:test";
import { absoluteLinks, extensionId, storeId, zipOf } from "./browser-mcp";

const ID = "bfnaelmomeimhlpmgjnjophhpkkoljpa";

test("a store ID is found bare or in either store's link", () => {
  expect(storeId(ID)).toBe(ID);
  expect(storeId(`https://chromewebstore.google.com/detail/phantom/${ID}`)).toBe(ID);
  expect(storeId(`https://chrome.google.com/webstore/detail/phantom/${ID}?hl=en`)).toBe(ID);
});

test("anything else isn't a store ID", () => {
  expect(storeId("https://example.com/phantom.crx")).toBeNull();
  expect(storeId("/tmp/phantom")).toBeNull();
  expect(storeId(ID.replace("b", "z"))).toBeNull();
});

test("a .crx loses its header and a zip is left alone", () => {
  const header = Buffer.alloc(12);
  header.write("Cr24", 0, "latin1");
  header.writeUInt32LE(3, 4);
  header.writeUInt32LE(5, 8);
  const zip = Buffer.from("PK\x03\x04rest", "latin1");
  expect(zipOf(Buffer.concat([header, Buffer.alloc(5), zip]))).toEqual(zip);
  expect(zipOf(zip)).toEqual(zip);
});

test("the files Playwright reports get absolute paths and nothing else changes", () => {
  const text = [
    "- [Snapshot](./page-1.yml)",
    "- [Screenshot of viewport](sub/shot one.png)",
    "- New console entries: ./console.log#L2",
    '- Downloaded file a.bin to "./download-a.bin"',
    "- [Docs](https://example.com/x)",
    "- Page URL: ./not-a-file",
  ].join("\n");
  expect(absoluteLinks(text, "/out").split("\n")).toEqual([
    "- [Snapshot](/out/page-1.yml)",
    "- [Screenshot of viewport](/out/sub/shot one.png)",
    "- New console entries: /out/console.log#L2",
    '- Downloaded file a.bin to "/out/download-a.bin"',
    "- [Docs](https://example.com/x)",
    "- Page URL: ./not-a-file",
  ]);
});

test("an extension's ID comes from its key, or else from where it was loaded", () => {
  const key = Buffer.from("a public key").toString("base64");
  expect(extensionId("/one", key)).toBe(extensionId("/two", key));
  expect(extensionId("/one")).not.toBe(extensionId("/two"));
  expect(extensionId("/one")).toMatch(/^[a-p]{32}$/);
});
