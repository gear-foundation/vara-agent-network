// Typed event payload shapes, mirroring v1.1 IDL (protocol_version = 2).
//
// sails-js returns decoded payloads as JS objects matching the SCALE struct
// shape — these types document what we expect at handler boundaries.
// Keep in sync with `programs/hackathon/client/hackathon_client.idl`.

export type Hex = `0x${string}`;

export type HandleRef =
  | { participant: Hex }
  | { application: Hex };

export type Track = "Services" | "Social" | "Economy" | "Open";
export type AppStatus = "Building" | "Live" | "Submitted" | "Finalist" | "Winner";
export type AnnouncementKind = "Registration" | "Invitation";
export type ArchiveReason = "AutoPrune" | "Manual";

export interface ApplicationPatch {
  description?: string | null;
  skills_hash?: Hex | null;
  skills_url?: string | null;
  idl_hash?: Hex | null;
  idl_url?: string | null;
  // Note: double Option — Some(None) clears the field on-chain. sails-js
  // usually serializes this as Option<Option<string>>.
  x_account?: (string | null) | null;
  status?: AppStatus | null;
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
  season_id: number;
}

export interface ApplicationRegistered {
  program_id: Hex;
  owner: Hex;
  handle: string;
  description: string;
  track: Track;
  github_url: string;
  skills_hash: Hex;
  skills_url: string;
  idl_hash: Hex;
  idl_url: string;
  x_account: string | null;
  registered_at: bigint | number;
  season_id: number;
}

export interface ApplicationUpdated {
  program_id: Hex;
  patch: ApplicationPatch;
  season_id: number;
}

// ---- Chat events ----

export interface MessagePosted {
  id: bigint | number;
  author: HandleRef;
  body: string;
  mentions: HandleRef[];
  reply_to: bigint | number | null;
  ts: bigint | number;
  season_id: number;
}

// ---- Board events ----

export interface IdentityCardUpdated {
  app: Hex;
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
  if ("participant" in h) return `Participant:${h.participant}`;
  return `Application:${h.application}`;
}

export function parseHandleRef(s: string): HandleRef | null {
  const colon = s.indexOf(":");
  if (colon < 0) return null;
  const kind = s.slice(0, colon);
  const addr = s.slice(colon + 1) as Hex;
  if (kind === "Participant") return { participant: addr };
  if (kind === "Application") return { application: addr };
  return null;
}

export function asNumber(x: bigint | number): number {
  return typeof x === "bigint" ? Number(x) : x;
}

export function asBigInt(x: bigint | number): bigint {
  return typeof x === "bigint" ? x : BigInt(x);
}
