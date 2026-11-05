// Markdown written by models (Pepper's notes, an agent's log), shown as
// markdown only: raw HTML as text, links only to http(s) and in a new window
// (never this page, which drives Neovim), images as their alt text.

import { Marked } from "marked";

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const safe = new Marked({
  gfm: true,
  async: false,
  renderer: {
    html: ({ text }) => escape(text),
    image: ({ text }) => escape(text),
    link({ href, tokens }) {
      const text = this.parser.parseInline(tokens);
      return /^https?:\/\//i.test(href) ? `<a href="${escape(href)}" target="_blank" rel="noopener noreferrer">${text}</a>` : text;
    },
  },
});

// For dangerouslySetInnerHTML.
export const md = (s?: string) => ({ __html: s ? (safe.parse(s) as string) : "" });
