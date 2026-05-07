export const log = {
  info(message: string, meta?: unknown) {
    console.log(JSON.stringify({ level: "info", message, ...asMeta(meta) }));
  },
  warn(message: string, meta?: unknown) {
    console.warn(JSON.stringify({ level: "warn", message, ...asMeta(meta) }));
  },
  error(message: string, meta?: unknown) {
    console.error(JSON.stringify({ level: "error", message, ...asMeta(meta) }));
  },
};

function asMeta(meta: unknown): Record<string, unknown> {
  if (meta === undefined) return {};
  if (meta instanceof Error) return { error: meta.message, stack: meta.stack };
  if (typeof meta === "object" && meta !== null) return meta as Record<string, unknown>;
  return { meta };
}
