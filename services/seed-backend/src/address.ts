import { u8aToHex } from "@polkadot/util";
import { decodeAddress } from "@polkadot/util-crypto";

export function normalizeAddress(input: unknown): string | null {
  if (typeof input !== "string") return null;
  if (input.startsWith("0x")) return input.toLowerCase();
  try {
    return u8aToHex(decodeAddress(input)).toLowerCase();
  } catch {
    return input.toLowerCase();
  }
}

export function requireAddress(input: unknown, name: string): string {
  const value = normalizeAddress(input);
  if (!value || !value.startsWith("0x")) {
    throw new Error(`${name} is not a valid SS58 or hex address`);
  }
  return value;
}

export function toBigIntString(value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") return Math.trunc(value).toString();
  if (typeof value === "string") return value.replaceAll(",", "");
  if (value && typeof value === "object") {
    const maybe = value as { toBigInt?: () => bigint; toString?: () => string };
    if (typeof maybe.toBigInt === "function") return maybe.toBigInt().toString();
    if (typeof maybe.toString === "function") return maybe.toString().replaceAll(",", "");
  }
  return "0";
}
