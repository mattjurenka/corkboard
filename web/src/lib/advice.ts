// The JSON Pepper ends its usage note with (fleet/pepper/guest.nix), which
// the usage view shows a section per project of (views/Usage.tsx).

export type Recommendation = { title: string; saving?: number; change?: string; evidence?: string; cards?: string[] };
export type Earlier = { title: string; status?: string; evidence?: string };
export type ProjectAdvice = { project: string; board?: string | null; recommendations?: Recommendation[]; earlier?: Earlier[] };

const FENCE = /```json\s*\n([\s\S]*?)\n```\s*$/;

// A model wrote it: each field is kept only as the type it should be.
const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const objects = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x)) : [];
const recommendation = (r: Record<string, unknown>): Recommendation => ({
  title: str(r.title) ?? "",
  saving: typeof r.saving === "number" && Number.isFinite(r.saving) ? r.saving : undefined,
  change: str(r.change),
  evidence: str(r.evidence),
  cards: Array.isArray(r.cards) ? r.cards.filter((c): c is string => typeof c === "string") : undefined,
});
const earlier = (e: Record<string, unknown>): Earlier => ({ title: str(e.title) ?? "", status: str(e.status), evidence: str(e.evidence) });

// The note's projects, this one's first and the boardless last; the
// markdown without its JSON when there are none.
export function parseAdvice(body: string, board?: string): { projects?: ProjectAdvice[]; markdown: string } {
  const m = FENCE.exec(body.trimEnd());
  const markdown = m ? body.trimEnd().slice(0, m.index) : body;
  let projects: ProjectAdvice[] | undefined;
  try {
    const parsed = m && JSON.parse(m[1]);
    projects = objects(parsed?.projects)
      .filter((p) => typeof p.project === "string")
      .map((p) => ({
        project: p.project as string,
        board: str(p.board) ?? null,
        recommendations: objects(p.recommendations).map(recommendation),
        earlier: objects(p.earlier).map(earlier),
      }));
  } catch {}
  if (!projects?.length) return { markdown };
  const rank = (p: ProjectAdvice) => (board && p.board === board ? 0 : p.board ? 1 : 2);
  return { projects: [...projects].sort((a, b) => rank(a) - rank(b)), markdown };
}
