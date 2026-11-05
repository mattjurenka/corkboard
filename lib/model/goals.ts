// The goals as the day plan and the phone show them: read out of the goal
// notes Pepper writes, which are Markdown with a title like "Goal: Fitness,
// gain lean weight (3 sessions/week)" and sections under ## headings. Only
// the high-level parts are picked out: the name and aim from the title, the
// why, how it's measured, and this week's steps.

import type { Note } from "./plans";

export type Goal = {
  id: string;
  // "Fitness", and the rest of the title: "gain lean weight (3 sessions/week)".
  name: string;
  aim: string;
  // The first paragraph under ## Why.
  why: string;
  // ## Measured by: its list items, or its paragraphs.
  measures: string[];
  // ## This week: its items, and the week it names ("2026-10-26").
  week: string[];
  week_of?: string;
  updated: string;
};

// Markdown as plain text: no emphasis or code marks, a link as its text, a
// [[note-id]] as that goal's name (or the id, readable).
function plain(text: string, names: Map<string, string>) {
  return text
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, id: string, label?: string) => label ?? names.get(id) ?? id.replace(/^goal-/, "").replace(/-/g, " "))
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|\*|_|`)(.+?)\1/g, "$2")
    .replace(/\s+/g, " ")
    .trim();
}

// "Goal: Fitness, gain lean weight" -> ["Fitness", "gain lean weight"].
export function nameOf(title: string): [string, string] {
  const t = title.replace(/^goal:\s*/i, "").trim();
  const at = t.indexOf(", ");
  return at < 0 ? [t, ""] : [t.slice(0, at).trim(), t.slice(at + 2).trim()];
}

// Each ## section's lines, by its heading in lower case.
function sections(body: string) {
  const out = new Map<string, string[]>();
  let lines: string[] | undefined;
  for (const line of body.split("\n")) {
    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h) out.set(h[1].toLowerCase(), (lines = []));
    else lines?.push(line);
  }
  return out;
}

// A section's list items; with none, its paragraphs.
function items(lines: string[] = []) {
  const list = lines.filter((l) => /^\s*(?:[-*+]|\d+[.)])\s+/.test(l)).map((l) => l.replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, ""));
  return list.length ? list : paragraphs(lines);
}

function paragraphs(lines: string[] = []) {
  return lines.join("\n").split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
}

export function goals(notes: Note[]): Goal[] {
  const names = new Map(notes.map((n) => [n.id, nameOf(n.title)[0]]));
  return notes.map((n) => {
    const [name, aim] = nameOf(n.title);
    const s = sections(n.body);
    const weekKey = [...s.keys()].find((k) => k.startsWith("this week"));
    const weekOf = weekKey?.match(/\d{4}-\d\d-\d\d/)?.[0];
    const text = (t: string) => plain(t, names);
    return {
      id: n.id,
      name: text(name),
      aim: text(aim),
      why: text(paragraphs(s.get("why"))[0] ?? ""),
      measures: items(s.get("measured by")).map(text).filter(Boolean),
      week: weekKey ? items(s.get(weekKey)).map(text).filter(Boolean) : [],
      ...(weekOf ? { week_of: weekOf } : {}),
      updated: n.updated,
    };
  });
}
