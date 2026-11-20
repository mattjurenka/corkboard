// md()'s HTML goes into the page with dangerouslySetInnerHTML, under no
// sanitiser (Review.tsx, Usage.tsx), and the page drives Neovim, so a script
// in it is a shell. What comes out is held to a list: the tags markdown
// makes, the attributes they have, every value quoted and with no quote of
// its own, and an href only to http(s). Every < in text is escaped, so each
// one in the output starts a tag.
import { describe, expect, test } from "bun:test";
import { fuzz } from "../../../lib/testing/fuzz";
import { md } from "./markdown";

const TAGS = new Map<string, Set<string>>([
  ["a", new Set(["href", "target", "rel"])],
  ["code", new Set(["class"])],
  ["input", new Set(["disabled", "type", "checked"])],
  ["ol", new Set(["start"])],
  ["th", new Set(["align"])],
  ["td", new Set(["align"])],
  ...["p", "em", "strong", "del", "pre", "ul", "li", "blockquote", "table", "thead", "tbody", "tr", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6"].map(
    (t) => [t, new Set<string>()] as const,
  ),
]);

// The tags in html, each checked; the problems found, none when it's safe.
function problems(html: string): string[] {
  const out: string[] = [];
  const tag = /<(\/?)([a-z0-9]+)((?:\s+[a-z-]+(?:="[^"]*")?)*)\s*(\/?)>/y;
  for (let at = html.indexOf("<"); at >= 0; at = html.indexOf("<", at + 1)) {
    tag.lastIndex = at;
    const m = tag.exec(html);
    if (!m) {
      out.push(`not a tag: ${html.slice(at, at + 40)}`);
      continue;
    }
    const allowed = TAGS.get(m[2]);
    if (!allowed) out.push(`tag ${m[2]}`);
    for (const [, name, value] of m[3].matchAll(/([a-z-]+)(?:="([^"]*)")?/g)) {
      if (!allowed?.has(name)) out.push(`attribute ${name} on ${m[2]}`);
      if (value !== undefined && /[<>]/.test(value)) out.push(`${name}=${value}`);
      if (name === "href" && !/^https?:\/\//i.test(value ?? "")) out.push(`href ${value}`);
      if (name === "target" && value !== "_blank") out.push(`target ${value}`);
      if (name === "rel" && value !== "noopener noreferrer") out.push(`rel ${value}`);
    }
    if (m[2] === "a" && !m[1] && !/ rel="noopener noreferrer"/.test(m[3])) out.push("a link without rel");
  }
  return out;
}

const html = (s: string) => md(s).__html;
const safe = (s: string) => expect({ input: s, problems: problems(html(s)) }).toEqual({ input: s, problems: [] });

describe("md", () => {
  test("nothing for nothing", () => {
    expect(md()).toEqual({ __html: "" });
    expect(md("")).toEqual({ __html: "" });
  });

  test("markdown is still markdown", () => {
    expect(html("# Title\n\n*a* **b** ~~c~~ `d`")).toBe("<h1>Title</h1>\n<p><em>a</em> <strong>b</strong> <del>c</del> <code>d</code></p>\n");
    expect(html("- one\n- two")).toBe("<ul>\n<li>one</li>\n<li>two</li>\n</ul>\n");
    expect(html("3. x\n4. y")).toContain('<ol start="3">');
    expect(html("| a | b |\n|:-|-:|\n| 1 | 2 |")).toContain('<td align="left">1</td>');
    expect(html("- [x] done")).toContain('<input checked="" disabled="" type="checkbox">');
    expect(html("```js\nlet a = 1 < 2;\n```")).toBe('<pre><code class="language-js">let a = 1 &lt; 2;\n</code></pre>\n');
  });

  test("a web link opens in a new window, and nothing else is a link", () => {
    expect(html("[x](https://a.example/p?q=1&r=2)")).toBe('<p><a href="https://a.example/p?q=1&#38;r=2" target="_blank" rel="noopener noreferrer">x</a></p>\n');
    expect(html("[x](HTTP://A.EXAMPLE)")).toContain('href="HTTP://A.EXAMPLE"');
    expect(html("see https://a.example and www.b.example")).toContain('href="http://www.b.example"');
    for (const href of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      " javascript:alert(1)",
      "java\tscript:alert(1)",
      "&#106;avascript:alert(1)",
      "&#x6A;avascript:alert(1)",
      "javascript&colon;alert(1)",
      "vbscript:msgbox(1)",
      "data:text/html,<script>alert(1)</script>",
      "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
      "file:///etc/passwd",
      "//evil.example",
      "/local",
      "#top",
      "http:evil",
      "mailto:a@b.example",
    ]) {
      safe(`[x](${href})`);
      expect(html(`[x](${href})`)).not.toContain("<a");
    }
    // By reference, and as an autolink.
    expect(html("[x][r]\n\n[r]: javascript:alert(1)")).toBe("<p>x</p>\n");
    expect(html("<javascript:alert(1)>")).not.toContain("<a");
  });

  test("a link's href and title can't break out of the attribute", () => {
    for (const s of [
      '[x](http://a.example"onmouseover="alert(1))',
      "[x](http://a.example'onmouseover='alert(1))",
      '[x](<http://a.example/" onclick="alert(1)>)',
      '[x](http://a.example "t\\" onclick=\\"alert(1)")',
      "[x](http://a.example 'it\\'s' )",
      '[x][r]\n\n[r]: http://a.example "t\\" onclick=x"',
      '<http://a.example/"onclick=alert(1)>',
      'www.a.example/"onclick=alert(1)',
      "https://a.example/<script>alert(1)</script>",
      "[x](http://a.example&#34;onclick=alert(1))",
      "[x](http://a.example&quot;onclick=alert(1))",
      "[x](http://a.example/%22onclick=alert(1))",
    ])
      safe(s);
    // The title is dropped rather than put through.
    expect(html('[x](http://a.example "the title")')).not.toContain("title");
    expect(html('[x](http://a.example"onclick="y)')).toContain('href="http://a.example&#34;onclick=&#34;y"');
  });

  test("raw HTML is text", () => {
    for (const s of [
      "<script>alert(1)</script>",
      "<SCRIPT SRC=//evil.example/x.js></SCRIPT>",
      "<iframe src=javascript:alert(1)></iframe>",
      "<style>body{display:none}</style>",
      "<img src=x onerror=alert(1)>",
      "a <img src=x onerror=alert(1)> b",
      "<svg onload=alert(1)>",
      "<svg><script>alert(1)</script></svg>",
      "<math><mi xlink:href=javascript:alert(1)>x</mi></math>",
      '<a href="javascript:alert(1)">x</a>',
      "<details open ontoggle=alert(1)>",
      "<div>\n<script>alert(1)</script>\n</div>",
      "Text\n<div onclick=alert(1)>\n\nmore\n</div>",
      "<!-- x --><b>",
      "<![CDATA[<script>alert(1)</script>]]>",
      "<?php echo 1 ?>",
      "<img src=x onerror=alert(1)",
      "<a href=x",
      "<",
      "<<script>>",
      "</p><script>",
      "<body onload=alert(1)>",
      "<object data=x>",
      "<embed src=x>",
      "<base href=//evil.example>",
      "<meta http-equiv=refresh content=0;url=//evil.example>",
      "<form action=//evil.example><input name=p></form>",
      "<textarea><script>",
      "<noscript><p title=\"</noscript><img src=x onerror=alert(1)>\">",
      "<template><script>alert(1)</script></template>",
      "> <style>*{}</style>",
      "- <img src=x onerror=1>",
      "| <img src=x onerror=1> | b |\n|---|---|\n| c | <script>d</script> |",
      "# <i onclick=x>h</i>",
      "*<b onclick=x>*",
      "[<img src=x onerror=1>](http://a.example)",
      "[a](http://a.example)<img src=x onerror=1>",
      "```\n</code></pre><script>alert(1)</script>\n```",
      '```"><script>alert(1)</script>\nx\n```',
      "    <script>alert(1)</script>",
      "`</code><script>`",
    ]) {
      safe(s);
      expect(html(s)).not.toMatch(/<(script|iframe|style|img|svg|math|object|embed|base|meta|form|textarea|template|details|body|noscript|div|b|i)\b/i);
    }
    expect(html("<b>x</b>")).toBe("<p>&#60;b&#62;x&#60;/b&#62;</p>\n");
  });

  // marked takes what follows an inline <script>, <pre>, <code> or <kbd> as
  // raw HTML, up to its end tag, and put it out as it was: a tag left
  // unclosed there (so not an html token, which is escaped) went into the page.
  test("text after an inline <script>, <pre>, <code> or <kbd> is escaped too", () => {
    for (const open of ["<script>", "<pre>", "<code>", "<kbd>", "<SCRIPT>", "<pre class=x>"]) {
      const s = `a ${open} b <img src=x onerror=alert(1)//`;
      safe(s);
      expect(html(s)).toBe(`<p>a ${open.replace("<", "&#60;").replace(">", "&#62;")} b &#60;img src=x onerror=alert(1)//</p>\n`);
      safe(`a ${open} <svg/onload=alert(1)`);
      safe(`a ${open} <!-- x`);
      expect(html(`a ${open} & b`)).toContain(" &#38; b");
    }
    // After its end tag, text is as it was.
    expect(html("a <pre> </pre> b &amp; c")).toContain(" b &amp; c");
  });

  test("an image is its alt text", () => {
    expect(html("![a cat](https://a.example/cat.png)")).toBe("<p>a cat</p>\n");
    for (const s of ["![x](javascript:alert(1))", '![x" onerror="alert(1)](http://a.example/x.png)', "![<script>](x)", "![a](x \"t\" onerror=alert(1))", "[![a](i.png)](http://a.example)"]) {
      safe(s);
      expect(html(s)).not.toContain("<img");
    }
  });

  test("escaped and entity text stays text", () => {
    for (const s of ["&lt;script&gt;", "&#60;script&#62;", "&#x3C;script&#x3E;", "\\<script>", "&amp;lt;script&amp;gt;"]) {
      safe(s);
      expect(html(s)).not.toContain("<script");
    }
  });
});

// Markdown made of the pieces above and random text, run together.
const PIECES = [
  "<script>", "</script>", "<img src=x onerror=alert(1)>", "<svg onload=x>", "<a href=", "javascript:", "JAVASCRIPT:", "data:text/html,", "vbscript:",
  "http://a.example", "https://a.example/", "www.a.example", "[", "]", "(", ")", "![", "<", ">", '"', "'", "`", "```", "\n", "\n\n", "    ", "- ", "> ", "# ",
  "| a |", "|---|", "*", "**", "_", "~~", "\\", "&", "&#", "&#106;", "&quot;", "&lt;", ";", ":", "=", " on", "onclick=", "/", "<!--", "-->", "[r]: ", "1. ",
];
fuzz("md's output is always within the list", (g) => {
  let s = "";
  for (let n = g.size(40); n > 0; n--) s += g.bool(0.8) ? g.pick(PIECES) : g.string(8);
  const found = problems(html(s));
  if (found.length) throw new Error(`${JSON.stringify(s)}: ${found.join("; ")}`);
}, { runs: 2000 });
