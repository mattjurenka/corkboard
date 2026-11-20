// The JSON Pepper ends its usage note with (fleet/pepper/guest.nix), which
// the usage view shows a section per project of (views/Usage.tsx).

export type Recommendation = { title: string; saving?: number; change?: string; evidence?: string; cards?: string[] };
export type Earlier = { title: string; status?: string; evidence?: string };
export type ProjectAdvice = { project: string; board?: string | null; recommendations?: Recommendation[]; earlier?: Earlier[] };

const FENCE = /```json\s*\n([\s\S]*?)\n```\s*$/;

// The note's projects, this one's first and the boardless last; the
// markdown without its JSON when there are none.
export function parseAdvice(body: string, board?: string): { projects?: ProjectAdvice[]; markdown: string } {
  const m = FENCE.exec(body.trimEnd());
  const markdown = m ? body.trimEnd().slice(0, m.index) : body;
  let projects: ProjectAdvice[] | undefined;
  try {
    const parsed = m && JSON.parse(m[1]);
    if (Array.isArray(parsed?.projects)) projects = parsed.projects.filter((p: ProjectAdvice) => p && typeof p.project === "string");
  } catch {}
  if (!projects?.length) return { markdown };
  const rank = (p: ProjectAdvice) => (board && p.board === board ? 0 : p.board ? 1 : 2);
  return { projects: [...projects].sort((a, b) => rank(a) - rank(b)), markdown };
}
