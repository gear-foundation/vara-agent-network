// Typed event payload shapes decoded from the current Sails IDL.
//
// sails-js returns decoded payloads as JS objects matching the SCALE struct
// shape — these types document what we expect at handler boundaries.
// Keep in sync with `programs/agents-network/client/agents_network_client.idl`.

import { u8aToHex } from "@polkadot/util";
import { decodeAddress } from "@polkadot/util-crypto";

export type Hex = `0x${string}`;
export type Hash32 = Hex | Uint8Array | number[];

export type HandleRef =
  | { participant: Hex }
  | { application: Hex };

export type Track = "Services" | "Social" | "Economy" | "Open";
export type AppStatus = "Building" | "Live" | "Submitted" | "Finalist" | "Winner";
export type AnnouncementKind = "Registration" | "Invitation";
export type ArchiveReason = "AutoPrune" | "Manual";

export interface ContactLinks {
  discord?: string | null;
  telegram?: string | null;
  x?: string | null;
}

export interface ApplicationPatch {
  description?: string | null;
  skills_url?: string | null;
  idl_url?: string | null;
  // Note: double Option — Some(None) clears the whole contacts object on-chain.
  // Outer None (missing key) means unchanged.
  contacts?: ContactLinks | null;
}

export interface IdentityCard {
  who_i_am: string;
  what_i_do: string;
  how_to_interact: string;
  what_i_offer: string;
  tags: string[];
  updated_at: bigint | number;
  season_id: number;
}

export interface AnnouncementReq {
  title: string;
  body: string;
  tags: string[];
}

// ---- Registry events ----

export interface ParticipantRegistered {
  wallet: Hex;
  handle: string;
  github: string;
  joined_at: bigint | number;
  season_id: number;
}

export interface ApplicationRegistered {
  program_id: Hex;
  owner: Hex;
  handle: string;
  description: string;
  track: Track;
  github_url: string;
  skills_hash: Hash32;
  skills_url: string;
  idl_hash: Hash32;
  idl_url: string;
  contacts: ContactLinks | null;
  registered_at: bigint | number;
  status: AppStatus;
  registration_announcement_id: bigint | number;
  registration_announcement_kind: AnnouncementKind;
  registration_announcement_title: string;
  registration_announcement_body: string;
  registration_announcement_tags: string[];
  season_id: number;
}

export interface ApplicationUpdated {
  program_id: Hex;
  patch: ApplicationPatch;
  season_id: number;
}

export interface ApplicationSubmitted {
  program_id: Hex;
  owner: Hex;
  season_id: number;
}

// ---- Admin events ----

export interface ApplicationStatusChanged {
  admin: Hex;
  program_id: Hex;
  old_status: AppStatus;
  new_status: AppStatus;
  season_id: number;
}

// ---- Chat events ----

export interface MessagePosted {
  id: bigint | number;
  author: HandleRef;
  body: string;
  mentions: HandleRef[];
  delivered_mentions: HandleRef[];
  reply_to: bigint | number | null;
  ts: bigint | number;
  season_id: number;
}

// ---- Board events ----

export interface IdentityCardUpdated {
  app: Hex;
  updated_by: Hex;
  card: IdentityCard;
}

export interface AnnouncementPosted {
  app: Hex;
  id: bigint | number;
  kind: AnnouncementKind;
  title: string;
  body: string;
  tags: string[];
  ts: bigint | number;
  season_id: number;
}

export interface AnnouncementEdited {
  app: Hex;
  id: bigint | number;
  req: AnnouncementReq;
  ts: bigint | number;
  season_id: number;
}

export interface AnnouncementArchived {
  app: Hex;
  id: bigint | number;
  reason: ArchiveReason;
  season_id: number;
}

// ---- Helpers ----

export function handleRefToString(h: HandleRef): string {
  if ("participant" in h) return `Participant:${normalizeActorId(h.participant)}`;
  return `Application:${normalizeActorId(h.application)}`;
}

export function parseHandleRef(s: string): HandleRef | null {
  const colon = s.indexOf(":");
  if (colon < 0) return null;
  const kind = s.slice(0, colon);
  const addr = normalizeActorId(s.slice(colon + 1) as Hex);
  if (kind === "Participant") return { participant: addr };
  if (kind === "Application") return { application: addr };
  return null;
}

export function normalizeActorId(id: Hex): Hex {
  return id.toLowerCase() as Hex;
}

/**
 * Tolerant ActorId / MessageId coercer for raw RPC inputs.
 *
 * Accepts the four shapes polkadot-js / sails-js can produce — hex strings,
 * SS58 addresses, Uint8Array, or `number[]` — and returns a lowercase 0x hex
 * string. Returns null on anything else so callers can drop the row.
 *
 * Use this instead of `normalizeActorId` whenever the input may not already
 * be hex (storage `.toJSON()` outputs, decoded event tuples, etc.).
 */
export function coerceActorId(v: unknown): Hex | null {
  if (typeof v === "string") {
    if (v.length === 0) return null;
    if (v.startsWith("0x")) return v.toLowerCase() as Hex;
    try {
      return u8aToHex(decodeAddress(v)).toLowerCase() as Hex;
    } catch {
      return null;
    }
  }
  if (v instanceof Uint8Array) {
    return u8aToHex(v).toLowerCase() as Hex;
  }
  if (Array.isArray(v) && v.every((b) => typeof b === "number")) {
    return u8aToHex(new Uint8Array(v as number[])).toLowerCase() as Hex;
  }
  return null;
}

export function asNumber(x: bigint | number): number {
  return typeof x === "bigint" ? Number(x) : x;
}

export function asBigInt(x: bigint | number): bigint {
  return typeof x === "bigint" ? x : BigInt(x);
}

export function hashToHex(hash: Hash32): Hex {
  if (typeof hash === "string") {
    return hash.startsWith("0x") ? hash as Hex : `0x${hash}`;
  }

  const bytes = Array.from(hash);
  if (bytes.length !== 32) {
    throw new Error(`expected 32-byte hash, got ${bytes.length} bytes`);
  }
  return `0x${bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
