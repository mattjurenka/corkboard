// A push's ref updates, read off the front of git-receive-pack's request
// (pkt-lines up to a flush: any shallow lines, then "old new ref", the
// first with its capabilities after a NUL) without holding the pack behind
// them. The body goes on as it came, prefix and all.

export type Command = { old: string; new: string; ref: string };

const ZERO = /^0{40}$|^0{64}$/;
export const isDelete = (c: Command) => ZERO.test(c.new);

// More than this before the flush isn't a push of sensible size.
const MAX_COMMANDS = 1024 * 1024;

export class PushError extends Error {}

export async function readCommands(body: ReadableStream<Uint8Array>): Promise<{ commands: Command[]; body: ReadableStream<Uint8Array> }> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let buf = new Uint8Array(0);
  let at = 0;
  const commands: Command[] = [];
  const need = async (n: number) => {
    while (buf.length - at < n) {
      if (buf.length > MAX_COMMANDS) throw new PushError("a push's commands are too long");
      const { done, value } = await reader.read();
      if (done) throw new PushError("a push ended before its commands did");
      chunks.push(value);
      const next = new Uint8Array(buf.length + value.length);
      next.set(buf);
      next.set(value, buf.length);
      buf = next;
    }
  };
  for (;;) {
    await need(4);
    const len = parseInt(new TextDecoder().decode(buf.subarray(at, at + 4)), 16);
    if (Number.isNaN(len) || (len !== 0 && len < 4)) throw new PushError("not a pkt-line");
    if (len === 0) break;
    await need(len);
    let line = new TextDecoder().decode(buf.subarray(at + 4, at + len));
    at += len;
    line = line.split("\0")[0].replace(/\n$/, "");
    if (line.startsWith("shallow ")) continue;
    if (line.startsWith("push-cert")) throw new PushError("signed pushes aren't taken from a grant");
    const [old, nw, ref, ...rest] = line.split(" ");
    if (!ref || rest.length || !/^[0-9a-f]{40,64}$/.test(old) || !/^[0-9a-f]{40,64}$/.test(nw)) throw new PushError(`not a ref update: ${line.slice(0, 100)}`);
    commands.push({ old, new: nw, ref });
  }
  let replayed = false;
  const out = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!replayed) {
        replayed = true;
        for (const c of chunks) controller.enqueue(c);
        return;
      }
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return { commands, body: out };
}
