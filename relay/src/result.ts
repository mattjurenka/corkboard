// Methods return a Result instead of throwing, because an error crossing RPC
// keeps its message but not its class, and the Worker needs the status.
export type Result<T> = { ok: true; value: T } | { ok: false; status: number; error: string };
