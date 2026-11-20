// The page dom.ts makes is enough like a browser's where the tests lean on
// it: Node.prototype's nodeName, a NodeIterator that keeps its place as the
// nodes it's on are removed, and DOMPurify working as it does in one; and
// executable() finds what runs in markup nothing has sanitised.
import "./dom";
import { describe, expect, test } from "bun:test";
import DOMPurify from "dompurify";
import { executable, RAW_HTML } from "./xss";

describe("dom.ts", () => {
  test("there's a page, with what the store reads as it loads", () => {
    expect(location.href).toBe("http://localhost:4321/");
    expect(typeof matchMedia("(max-width: 800px)").matches).toBe("boolean");
    localStorage.setItem("k", "v");
    expect(localStorage.getItem("k")).toBe("v");
    localStorage.clear();
  });

  test("Node.prototype's nodeName is the node's", () => {
    let proto: object | null = Node.prototype;
    while (proto && !Object.hasOwn(proto, "nodeName")) proto = Object.getPrototypeOf(proto);
    const nodeName = Object.getOwnPropertyDescriptor(proto!, "nodeName")!.get!;
    const div = document.createElement("div");
    div.innerHTML = "<p>a<!--c--></p>";
    expect([div, div.firstChild!, div.firstChild!.firstChild!, div.firstChild!.lastChild!].map((n) => nodeName.call(n))).toEqual(["DIV", "P", "#text", "#comment"]);
  });

  test("a NodeIterator goes on past the node it's on being removed, or swapped for its children", () => {
    const div = document.createElement("div");
    div.innerHTML = "<a></a><b><i>1</i></b><u>2</u><template><s>3</s></template>";
    const it = document.createNodeIterator(div, NodeFilter.SHOW_ELEMENT);
    const seen: string[] = [];
    for (let n = it.nextNode(); n; n = it.nextNode()) {
      seen.push(n.nodeName);
      if (n.nodeName === "A") (n as Element).remove();
      if (n.nodeName === "B") (n as Element).replaceWith(...n.childNodes);
    }
    // A template's content isn't its children.
    expect(seen).toEqual(["DIV", "A", "B", "I", "U", "TEMPLATE"]);
    expect(div.innerHTML).toBe("<i>1</i><u>2</u><template><s>3</s></template>");
  });

  test("DOMPurify as in a browser", () => {
    expect(DOMPurify.isSupported).toBe(true);
    expect(DOMPurify.sanitize('<p>a</p><img src=x onerror=alert(1)><script>x</script><a href="javascript:x">l</a><b>b</b>')).toBe(
      '<p>a</p><img src="x"><a>l</a><b>b</b>',
    );
    expect(DOMPurify.sanitize("<x-y>kept</x-y><template><script>1</script><i>t</i></template>")).toBe("kept<template><i>t</i></template>");
  });

  test("executable finds what runs in markup that isn't sanitised", () => {
    const found = (html: string) => {
      const div = document.createElement("div");
      div.innerHTML = html;
      return executable(div);
    };
    expect(found("<script>alert(1)</script>")).toEqual(["<script>"]);
    expect(found("<img src=x onerror=alert(1)>")).toEqual(["onerror on <img>"]);
    expect(found('<a href=" JaVa\tScRipt:alert(1)">x</a>')).toEqual(['href= JaVa\tScRipt:alert(1) on <a>']);
    expect(found("<svg><a xlink:href=javascript:alert(1)>x</a></svg>")).toEqual(["xlink:href=javascript:alert(1) on <a>"]);
    expect(found("<iframe srcdoc=x></iframe>")).toEqual(["<iframe>", "srcdoc on <iframe>"]);
    expect(found("<template><img src=x onerror=1></template>")).toEqual(["onerror on <img>"]);
    expect(found("<p>fine</p>")).toEqual([]);
    // And in most of the vectors as they are.
    expect(RAW_HTML.filter((s) => found(s).length).length).toBeGreaterThan(20);
  });
});
