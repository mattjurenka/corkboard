// isomorphic-git wants node's Buffer as a global; imported first, so it is
// there before isomorphic-git is.
import { Buffer } from "buffer";

(globalThis as any).Buffer ??= Buffer;
