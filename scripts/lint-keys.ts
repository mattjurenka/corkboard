// No object indexed by a key it might inherit (bun run lint:keys). `o[k]`,
// with k any string, on an object typed { [k: string]: T }, reads what
// Object.prototype has for "constructor" or "toString", and `k in o` says
// it's there; data keyed by strings from outside goes in a Map, or a Dict
// (lib/dict.ts), which has no prototype. A line that knows its keys says
// why: `// keys: hex digests only`, on it or the line above.
import { API, type Checker, type Type, TypeFlags } from "typescript/unstable/async";
import { isBinaryExpression, isElementAccessExpression } from "typescript/unstable/ast/is";
import { type Expression, type Node, type SourceFile, SyntaxKind } from "typescript/unstable/ast";
import { relative, resolve } from "node:path";

// The tsconfigs to read, by default corkboard's; another repo runs this with its own: bun lint-keys.ts tsconfig.json
const ROOT = process.cwd();
const PROJECTS = (process.argv.length > 2 ? process.argv.slice(2) : ["tsconfig.json", "relay/tsconfig.json", "scripts/tsconfig.keys.json"]).map((p) => resolve(ROOT, p));

const api = new API({ cwd: ROOT });
const snapshot = await api.updateSnapshot({ openProjects: PROJECTS });
// A project that didn't load would pass for one with nothing wrong.
const loaded = snapshot.getProjects().map((p) => resolve(p.configFileName));
for (const p of PROJECTS) if (!loaded.includes(p)) throw new Error(`${relative(ROOT, p)} didn't load`);
const found = new Map<string, string>();

for (const { program, checker } of snapshot.getProjects()) {
  for (const name of await program.getSourceFileNames()) {
    // Tests choose their keys.
    if (name.includes("/node_modules/") || !name.startsWith(ROOT) || /\.d\.ts$|\.test\.tsx?$/.test(name)) continue;
    const file = await program.getSourceFile(name);
    if (!file) continue;
    // Each `o[k]` and `k in o`: the object and the key to ask about.
    const sites: { at: Node; object: Expression; key: Expression }[] = [];
    const visit = (n: Node): void => {
      if (isElementAccessExpression(n)) sites.push({ at: n, object: n.expression, key: n.argumentExpression });
      else if (isBinaryExpression(n) && n.operatorToken.kind === SyntaxKind.InKeyword) sites.push({ at: n, object: n.right, key: n.left });
      n.forEachChild(visit);
    };
    file.forEachChild(visit);
    if (!sites.length) continue;
    const [keys, objects] = await Promise.all([checker.getTypeAtLocation(sites.map((s) => s.key)), checker.getTypeAtLocation(sites.map((s) => s.object))]);
    for (const [i, s] of sites.entries()) {
      const [key, object] = [keys[i], objects[i]];
      if (!key || !object || excused(file, s.at) || !(await anyString(key))) continue;
      // An any key passes the checker on any object, index signature or not.
      if (!(await byString(checker, object)) && !(key.flags & TypeFlags.Any && (await plain(checker, object)))) continue;
      found.set(`${relative(ROOT, name)}:${lineOf(file, s.at.getStart(file))}`, s.at.getText(file).replace(/\s+/g, " ").slice(0, 80));
    }
  }
}
await api.close();

// A key that can be any string: string itself, a template, or any.
async function anyString(t: Type): Promise<boolean> {
  if (t.flags & (TypeFlags.String | TypeFlags.TemplateLiteral | TypeFlags.StringMapping | TypeFlags.Any)) return true;
  if (t.isUnionType()) for (const u of await t.getTypes()) if (await anyString(u)) return true;
  return false;
}

// An object indexed by any string, other than a Dict or an array.
async function byString(checker: Checker, t: Type): Promise<boolean> {
  if (t.flags & TypeFlags.Any) return true;
  if (t.isUnionType()) {
    for (const u of await t.getTypes()) if (await byString(checker, u)) return true;
    return false;
  }
  if (!(t.flags & (TypeFlags.Object | TypeFlags.Intersection))) return false;
  if ((await checker.getPropertyOfType(t, "__dict")) || (await checker.isArrayLikeType(t))) return false;
  // The environment is ours.
  if ((await t.getSymbol())?.name === "ProcessEnv") return false;
  return (await checker.getIndexInfosOfType(t)).some((i) => i.keyType.flags & TypeFlags.String);
}

// An object with no index signature, other than a Dict or an array: { high, low }.
async function plain(checker: Checker, t: Type): Promise<boolean> {
  if (t.isUnionType()) {
    for (const u of await t.getTypes()) if (await plain(checker, u)) return true;
    return false;
  }
  if (!(t.flags & (TypeFlags.Object | TypeFlags.Intersection))) return false;
  return !(await checker.getPropertyOfType(t, "__dict")) && !(await checker.isArrayLikeType(t));
}

// `// keys: <why>` on the line, or alone on the one above.
function excused(file: SourceFile, at: Node): boolean {
  const lines = file.text.slice(0, at.getStart(file)).split("\n");
  const rest = file.text.slice(at.getStart(file)).split("\n", 1)[0];
  return /\/\/ keys: \S/.test(lines.at(-1)! + rest) || /^\s*\/\/ keys: \S/.test(lines.at(-2) ?? "");
}

function lineOf(file: SourceFile, pos: number) {
  return file.text.slice(0, pos).split("\n").length;
}

for (const [at, text] of [...found].sort()) console.log(`${at}  ${text}`);
if (found.size) {
  console.log(`\n${found.size} lookups by a key the object might inherit: use a Map or a Dict (lib/dict.ts), or say why the keys are safe with // keys: <why>.`);
  process.exit(1);
}
