// DOMPurify as the page uses it, for markdown it draws as HTML (Viewers'
// preview, Claude's turns and an agent's results). Its defaults keep what
// can't run but still reaches past the markdown: a <style> applies to the
// whole page, a style attribute can lay a fixed box over it, and a form (or
// a button's formaction) sends what's typed in it to anywhere.

import DOMPurify from "dompurify";

const CONFIG = { FORBID_TAGS: ["style", "form"], FORBID_ATTR: ["style", "action", "formaction", "form"] };

export const sanitize = (html: string) => DOMPurify.sanitize(html, CONFIG);
