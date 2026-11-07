// What each of Forgejo's routes needs of a grant (lib/e2ee/forge.ts), the
// way GitHub's fine-grained tokens' permissions map to its API. A route not
// here is refused to a grant: Actions, packages, forks, notifications,
// anything account-wide, and whatever a newer Forgejo adds.
//
// The API's repo routes are matched on what follows
// /api/v1/repos/:owner/:repo; git's smart HTTP is gitRoute's.

import type { Level, Permission } from "../../lib/e2ee/forge";

export type Need = { perm: Permission; level: Level };

// What a rule's refs function can ask: the route's params, the request's
// JSON body, and Forgejo (as the account's user) for what the request
// doesn't say.
export type RefsContext = { params: Record<string, string>; body: any; get: (path: string) => Promise<any> };

export type Rule = {
  needs: Need[];
  // An issue's routes serve pull requests too: by its number (param n) or
  // a comment's id (param c), the gate asks which, and a pull request's
  // needs pull_requests where this says issues.
  issue?: "n" | "c";
  // The refs a write moves, checked against a grant's refs.
  refs?: (ctx: RefsContext) => Promise<string[]>;
  // Deleting the repository: administration:write and the grant's del.
  del?: true;
  // The rule reads the body (refs); the gate buffers it.
  body?: true;
};

const r = (perm: Permission): Rule => ({ needs: [{ perm, level: "read" }] });
const w = (perm: Permission, more: Partial<Rule> = {}): Rule => ({ needs: [{ perm, level: "write" }], ...more });

const head = (name: unknown) => (typeof name === "string" && name ? [`refs/heads/${name}`] : []);
const tag = (name: unknown) => (typeof name === "string" && name ? [`refs/tags/${name}`] : []);

// A contents write lands on new_branch if it makes one, else branch, else the default.
const contentsRefs = async ({ body, get }: RefsContext) => {
  const b = body?.new_branch || body?.branch;
  if (typeof b === "string" && b) return head(b);
  return head((await get(""))?.default_branch);
};

const pull = (ctx: RefsContext) => ctx.get(`/pulls/${ctx.params.n}`);

const RULES: [string, string, Rule][] = [
  // metadata
  ["GET", "", r("metadata")],
  ["GET", "/branches", r("metadata")],
  ["GET", "/branches/*", r("metadata")],
  ["GET", "/tags", r("metadata")],
  ["GET", "/tags/*", r("metadata")],
  ["GET", "/languages", r("metadata")],
  ["GET", "/topics", r("metadata")],
  ["GET", "/collaborators", r("metadata")],
  ["GET", "/collaborators/:u", r("metadata")],
  ["GET", "/collaborators/:u/permission", r("metadata")],
  ["GET", "/assignees", r("metadata")],
  ["GET", "/reviewers", r("metadata")],
  ["GET", "/signing-key.gpg", r("metadata")],

  // contents
  ["GET", "/contents", r("contents")],
  ["GET", "/contents/*", r("contents")],
  ["GET", "/raw/*", r("contents")],
  ["GET", "/media/*", r("contents")],
  ["GET", "/archive/*", r("contents")],
  ["GET", "/commits", r("contents")],
  ["GET", "/git/*", r("contents")],
  ["GET", "/compare/*", r("contents")],
  ["GET", "/editorconfig/*", r("contents")],
  ["POST", "/branches", w("contents", { body: true, refs: async ({ body }) => head(body?.new_branch_name) })],
  ["DELETE", "/branches/*", w("contents", { refs: async ({ params }) => head(params["*"]) })],
  ["PATCH", "/branches/*", w("contents", { body: true, refs: async ({ params, body }) => [...head(params["*"]), ...head(body?.name)] })],
  ["POST", "/tags", w("contents", { body: true, refs: async ({ body }) => tag(body?.tag_name) })],
  ["DELETE", "/tags/*", w("contents", { refs: async ({ params }) => tag(params["*"]) })],
  ["POST", "/contents", w("contents", { body: true, refs: contentsRefs })],
  ["POST", "/contents/*", w("contents", { body: true, refs: contentsRefs })],
  ["PUT", "/contents/*", w("contents", { body: true, refs: contentsRefs })],
  ["DELETE", "/contents/*", w("contents", { body: true, refs: contentsRefs })],
  ["POST", "/diffpatch", w("contents", { body: true, refs: contentsRefs })],

  // pull requests
  ["GET", "/pulls", r("pull_requests")],
  ["GET", "/pulls/*", r("pull_requests")],
  ["POST", "/pulls", w("pull_requests")],
  ["PATCH", "/pulls/:n", w("pull_requests")],
  ["POST", "/pulls/:n/reviews", w("pull_requests")],
  ["POST", "/pulls/:n/reviews/*", w("pull_requests")],
  ["DELETE", "/pulls/:n/reviews/*", w("pull_requests")],
  ["POST", "/pulls/:n/requested_reviewers", w("pull_requests")],
  ["DELETE", "/pulls/:n/requested_reviewers", w("pull_requests")],
  [
    "POST",
    "/pulls/:n/merge",
    {
      needs: [
        { perm: "pull_requests", level: "write" },
        { perm: "contents", level: "write" },
      ],
      body: true,
      refs: async (ctx) => {
        const p = await pull(ctx);
        const same = p?.head?.repo?.id === p?.base?.repo?.id;
        return [...head(p?.base?.ref), ...(ctx.body?.delete_branch_after_merge && same ? head(p?.head?.ref) : [])];
      },
    },
  ],
  ["DELETE", "/pulls/:n/merge", w("pull_requests")],
  [
    "POST",
    "/pulls/:n/update",
    {
      needs: [
        { perm: "pull_requests", level: "write" },
        { perm: "contents", level: "write" },
      ],
      refs: async (ctx) => {
        const p = await pull(ctx);
        // A fork's head is another repository's ref; such a grant can't say.
        if (p?.head?.repo?.id !== p?.base?.repo?.id) return ["refs/(another repository)"];
        return head(p?.head?.ref);
      },
    },
  ],

  // issues (and, by the gate's lookup, pull requests' conversations)
  ["GET", "/issues", r("issues")],
  ["POST", "/issues", w("issues")],
  ["GET", "/issues/comments", r("issues")],
  ["GET", "/issues/comments/:c", { ...r("issues"), issue: "c" }],
  ["GET", "/issues/comments/:c/*", { ...r("issues"), issue: "c" }],
  ["PATCH", "/issues/comments/:c", w("issues", { issue: "c" })],
  ["DELETE", "/issues/comments/:c", w("issues", { issue: "c" })],
  ["POST", "/issues/comments/:c/*", w("issues", { issue: "c" })],
  ["DELETE", "/issues/comments/:c/*", w("issues", { issue: "c" })],
  ["GET", "/issues/:n", { ...r("issues"), issue: "n" }],
  ["GET", "/issues/:n/*", { ...r("issues"), issue: "n" }],
  ["PATCH", "/issues/:n", w("issues", { issue: "n" })],
  ["POST", "/issues/:n/*", w("issues", { issue: "n" })],
  ["PUT", "/issues/:n/*", w("issues", { issue: "n" })],
  ["PATCH", "/issues/:n/*", w("issues", { issue: "n" })],
  ["DELETE", "/issues/:n/*", w("issues", { issue: "n" })],
  ["GET", "/labels", r("issues")],
  ["GET", "/labels/*", r("issues")],
  ["POST", "/labels", w("issues")],
  ["PATCH", "/labels/*", w("issues")],
  ["DELETE", "/labels/*", w("issues")],
  ["GET", "/milestones", r("issues")],
  ["GET", "/milestones/*", r("issues")],
  ["POST", "/milestones", w("issues")],
  ["PATCH", "/milestones/*", w("issues")],
  ["DELETE", "/milestones/*", w("issues")],
  ["GET", "/issue_templates", r("issues")],
  ["GET", "/issue_config", r("issues")],

  // releases; making one makes its tag if it isn't there
  ["GET", "/releases", r("releases")],
  ["GET", "/releases/*", r("releases")],
  ["POST", "/releases", w("releases", { body: true, refs: async ({ body }) => tag(body?.tag_name) })],
  ["PATCH", "/releases/:id", w("releases", { body: true, refs: async ({ body }) => tag(body?.tag_name) })],
  ["DELETE", "/releases/:id", w("releases")],
  ["DELETE", "/releases/tags/*", w("releases")],
  ["POST", "/releases/:id/assets", w("releases")],
  ["PATCH", "/releases/:id/assets/:a", w("releases")],
  ["DELETE", "/releases/:id/assets/:a", w("releases")],

  // statuses
  ["GET", "/statuses/:sha", r("statuses")],
  ["GET", "/commits/:ref/status", r("statuses")],
  ["GET", "/commits/:ref/statuses", r("statuses")],
  ["POST", "/statuses/:sha", w("statuses")],

  // wiki
  ["GET", "/wiki/*", r("wiki")],
  ["POST", "/wiki/new", w("wiki")],
  ["PATCH", "/wiki/page/*", w("wiki")],
  ["DELETE", "/wiki/page/*", w("wiki")],

  // administration
  ["GET", "/branch_protections", r("administration")],
  ["GET", "/branch_protections/*", r("administration")],
  ["GET", "/keys", r("administration")],
  ["GET", "/keys/*", r("administration")],
  ["GET", "/push_mirrors", r("administration")],
  ["GET", "/push_mirrors/*", r("administration")],
  ["PATCH", "", w("administration")],
  ["DELETE", "", w("administration", { del: true })],
  ["PUT", "/collaborators/:u", w("administration")],
  ["DELETE", "/collaborators/:u", w("administration")],
  ["POST", "/branch_protections", w("administration")],
  ["PATCH", "/branch_protections/*", w("administration")],
  ["DELETE", "/branch_protections/*", w("administration")],
  ["POST", "/keys", w("administration")],
  ["DELETE", "/keys/*", w("administration")],
  ["PUT", "/topics", w("administration")],
  ["PUT", "/topics/:t", w("administration")],
  ["DELETE", "/topics/:t", w("administration")],
  ["POST", "/avatar", w("administration")],
  ["DELETE", "/avatar", w("administration")],
  ["POST", "/push_mirrors", w("administration")],
  ["POST", "/push_mirrors-sync", w("administration")],
  ["DELETE", "/push_mirrors/*", w("administration")],
  ["POST", "/mirror-sync", w("administration")],
  // Transferring or renaming takes the repository out of the grant's names.
  ["POST", "/transfer", { needs: [{ perm: "administration", level: "write" }], del: true }],

  // webhooks
  ["GET", "/hooks", r("webhooks")],
  ["GET", "/hooks/*", r("webhooks")],
  ["POST", "/hooks", w("webhooks")],
  ["PATCH", "/hooks/*", w("webhooks")],
  ["DELETE", "/hooks/*", w("webhooks")],
  ["POST", "/hooks/:id/tests", w("webhooks")],
];

type Compiled = { method: string; re: RegExp; names: string[]; rule: Rule };

const compiled: Compiled[] = RULES.map(([method, pattern, rule]) => {
  const names: string[] = [];
  const re = pattern
    .split("/")
    .slice(1)
    .map((seg) => {
      if (seg === "*") return names.push("*"), "/(.+)";
      if (seg.startsWith(":")) return names.push(seg.slice(1)), "/([^/]+)";
      return "/" + seg.replace(/[.+?^${}()|[\]\\-]/g, "\\$&");
    })
    .join("");
  return { method, re: new RegExp(`^${re}$`), names, rule };
});

// The rule for an API route on a repository, rest being what follows
// /api/v1/repos/:owner/:repo (decoded, no query).
export function apiRule(method: string, rest: string): { rule: Rule; params: Record<string, string> } | null {
  for (const c of compiled) {
    if (c.method !== method) continue;
    const m = rest.match(c.re);
    if (!m) continue;
    // A number is a number: /issues/comments isn't issue "comments".
    const params = Object.fromEntries(c.names.map((n, i) => [n, m[i + 1]]));
    if ((params.n !== undefined && !/^\d+$/.test(params.n)) || (params.c !== undefined && !/^\d+$/.test(params.c))) continue;
    return { rule: c.rule, params };
  }
  return null;
}

// API routes off a repository a grant may use.
export const OPEN_API = new Set(["GET /api/v1/version"]);

// git's smart HTTP: /:owner/:repo(.git)/info/refs?service=, /git-upload-pack,
// /git-receive-pack. A repo named x.wiki is x's wiki.
export type GitRoute = { owner: string; repo: string; wiki: boolean; push: boolean; advertise: boolean };

const GIT = /^\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/;

export function gitRoute(method: string, path: string, service: string | null): GitRoute | null {
  const m = path.match(GIT);
  if (!m) return null;
  const [, owner, name, what] = m;
  const wiki = name.endsWith(".wiki");
  const repo = wiki ? name.slice(0, -5) : name;
  if (what === "info/refs") {
    if (method !== "GET" || (service !== "git-upload-pack" && service !== "git-receive-pack")) return null;
    return { owner, repo, wiki, push: service === "git-receive-pack", advertise: true };
  }
  if (method !== "POST") return null;
  return { owner, repo, wiki, push: what === "git-receive-pack", advertise: false };
}
