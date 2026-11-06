// A board replica's records (.agent/plans/local-boards.md): its cards, and
// beside them, by id, the board's own settings (`board`: name, root, first
// commit, remotes, each environment's root) and its attachments
// (`media:<id>`) and its working cards' leases (`lease:<card>`, leases.ts).
// Only the cards are cards.
//
// A card's extra is kept a key at a time, as fields `extra.<key>`, so two
// devices setting a worktree and a media list at once keep both; a null one
// is a key taken out. A whole `extra`, as a card written before this has it,
// is what they're laid over.

import type { CardChange, MergedCard } from "../../lib/e2ee/merge";
import { random } from "../../lib/e2ee/keys";
import { CODE_ALPHABET } from "../../lib/e2ee/wire";
import { SEP } from "./objects";

export const BOARD_RECORD = "board";
export const mediaRecord = (id: string) => `media${SEP}${id}`;
export const MEDIA_PREFIX = mediaRecord("");
export const leaseRecord = (card: string) => `lease${SEP}${card}`;

export const isCard = (id: string) => id !== BOARD_RECORD && !id.includes(SEP);

const EXTRA = "extra.";

// The card's extra, laid together.
export function extraOf(m: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = m.extra && typeof m.extra === "object" && !Array.isArray(m.extra) ? { ...(m.extra as Record<string, unknown>) } : {};
  for (const [k, v] of Object.entries(m)) {
    if (!k.startsWith(EXTRA)) continue;
    if (v === null) delete out[k.slice(EXTRA.length)];
    else out[k.slice(EXTRA.length)] = v;
  }
  return out;
}

export const isExtraField = (k: string) => k.startsWith(EXTRA);

// The fields that make a card's extra `next`, from `had`: each key that
// changed, and null for each that's gone.
export function extraSet(had: Record<string, unknown>, next: Record<string, unknown>): Record<string, unknown> {
  const set: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(next)) if (JSON.stringify(had[k]) !== JSON.stringify(v)) set[EXTRA + k] = v ?? null;
  for (const k of Object.keys(had)) if (!(k in next)) set[EXTRA + k] = null;
  return set;
}

// A new card's id: the prefix and four random characters of Crockford's
// base32, TASK-7F3K, which two devices making cards offline won't both pick
// (one in a million, and not one this board has).
export function newCardId(ids: string[]): string {
  const counts = new Map<string, number>();
  for (const id of ids) {
    const m = id.match(/^([A-Z]+)-/);
    if (m) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  }
  const prefix = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "TASK";
  const taken = new Set(ids);
  for (;;) {
    const id = `${prefix}-${[...random(4)].map((b) => CODE_ALPHABET[b & 31]).join("")}`;
    if (!taken.has(id)) return id;
  }
}

export type BoardSettings = { name?: string; root?: string | null; commit?: string | null; remotes?: string[]; roots?: Record<string, string>; [k: string]: unknown };

export function settingsOf(cards: MergedCard[]): BoardSettings {
  const b = cards.find((c) => c.id === BOARD_RECORD);
  const { id: _, log: __, ...f } = b ?? { id: "", log: [] };
  return f;
}

// What a replica lacks of a plain card (the Worker's, or the card files'):
// the fields that differ, extra a key at a time, and the log entries it
// doesn't have, so bringing a board over twice adds nothing.
export type PlainCard = { id: string; log?: { at: string; who: string; note: string }[]; [k: string]: unknown };
export function changesFor(card: PlainCard, had: MergedCard | undefined): CardChange[] {
  const { id, log = [], version: _v, waiting_on: _w, extra, ...fields } = card;
  const set: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) if (JSON.stringify(had?.[k]) !== JSON.stringify(v)) set[k] = v;
  if (extra && typeof extra === "object" && !Array.isArray(extra)) Object.assign(set, extraSet(had ? extraOf(had) : {}, extra as Record<string, unknown>));
  const seen = new Set((had?.log ?? []).map((e) => JSON.stringify([e.at, e.who, e.note])));
  const out: CardChange[] = Object.keys(set).length ? [{ t: "card", card: id, set }] : [];
  for (const e of log) if (!seen.has(JSON.stringify([e.at, e.who, e.note]))) out.push({ t: "log", card: id, entry: { at: e.at, who: e.who, note: e.note } });
  return out;
}
