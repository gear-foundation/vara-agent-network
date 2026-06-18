// Typed event payload shapes decoded from the current Sails IDL.
//
// sails-js returns decoded payloads as JS objects matching the SCALE struct
// shape — these types document what we expect at handler boundaries.
// Keep in sync with `programs/agents-network/client/agents_network_client.idl`.

export type Hex = `0x${string}`;
export type Hash32 = Hex | Uint8Array | number[];

export type HandleRef =
  | { participant: Hex }
  | { application: Hex };

export type Track = "Services" | "Social" | "Economy" | "Open";
export type AppStatus = "Building" | "Live" | "Submitted" | "Finalist" | "Winner";
export type AnnouncementKind = "Registration" | "Invitation";
export type ArchiveReason = "AutoPrune" | "Manual";
export type ReviewAuthorRole = "Reviewer" | "Owner";
export type ReviewVerdict = "ApprovedForListing" | "RevisionRequested";
export type PublishOutcome = "Published" | "ChangesRequested";
export type CriterionCoverage = "Missing" | "Partial" | "Met" | "NotApplicable";
export type ProjectReviewStatus = "Submitted" | "Commented" | "GuidanceRecorded" | "Linked";
export type ProjectGuidanceOutcome = "Proceed" | "NeedsChanges" | "NotRecommended";

export interface ContactLinks {
  discord?: string | null;
  telegram?: string | null;
  x?: string | null;
}

export interface ApplicationPatch {
  handle?: string | null;
  description?: string | null;
  track?: Track | null;
  github_url?: string | null;
  skills_hash?: Hash32 | null;
  skills_url?: string | null;
  idl_hash?: Hash32 | null;
  idl_url?: string | null;
  // Note: double Option — Some(None) clears the whole contacts object on-chain.
  // Outer None (missing key) means unchanged.
  contacts?: ContactLinks | null;
}

export interface ApplicationSnapshot {
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
  season_id: number;
  status: AppStatus;
}

export interface CriterionAssessment {
  coverage: CriterionCoverage;
  note?: string | null;
}

export interface ReviewCriteria {
  technical_readiness: CriterionAssessment;
  network_value: CriterionAssessment;
  evidence_quality: CriterionAssessment;
  safety_maintenance: CriterionAssessment;
}

export interface ReviewRevisionSnapshot {
  program_id: Hex;
  owner: Hex;
  revision: number;
  handle: string;
  description: string;
  track: Track;
  github_url: string;
  skills_hash: Hash32;
  skills_url: string;
  idl_hash: Hash32;
  idl_url: string;
  contacts: ContactLinks | null;
  submitted_at: bigint | number;
  season_id: number;
}

export interface ReviewSummarySnapshot {
  program_id: Hex;
  pending_submission_revision: number | null;
  submission_revision: number | null;
  display_revision: number | null;
  active_request_revision: number | null;
  active_request_acknowledged: boolean;
  latest_verdict: ReviewVerdict | null;
  latest_reviewer: Hex | null;
  latest_reason: string | null;
  current_revision_comment_count: number;
  total_comment_count: number;
  manual_override: boolean;
  deleted: boolean;
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
  application: ApplicationSnapshot;
  season_id: number;
}

export interface ApplicationDeleted {
  program_id: Hex;
  owner: Hex;
  handle: string;
  deleted_at: bigint | number;
  season_id: number;
}

export interface ApplicationSubmitted {
  program_id: Hex;
  owner: Hex;
  revision: number;
  season_id: number;
}

export interface ReviewRevisionSubmitted {
  program_id: Hex;
  owner: Hex;
  revision: number;
  snapshot: ReviewRevisionSnapshot;
  submitted_at: bigint | number;
  season_id: number;
}

export interface ApplicationProgramReplaced {
  old_program_id: Hex;
  new_program_id: Hex;
  application: ApplicationSnapshot;
  review_summary: ReviewSummarySnapshot;
  reason: string;
  replaced_by: Hex;
  replaced_at: bigint | number;
  replacement_count: number;
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

// ---- Review events ----

export interface ReviewerAdded {
  admin: Hex;
  reviewer: Hex;
  season_id: number;
  ts: bigint | number;
}

export interface ReviewerRemoved {
  admin: Hex;
  reviewer: Hex;
  season_id: number;
  ts: bigint | number;
}

export interface CoachAdded {
  admin: Hex;
  coach: Hex;
  season_id: number;
  ts: bigint | number;
}

export interface CoachRemoved {
  admin: Hex;
  coach: Hex;
  season_id: number;
  ts: bigint | number;
}

export interface ReviewRequested {
  program_id: Hex;
  owner: Hex;
  revision: number;
  reason: string;
  requested_at: bigint | number;
  season_id: number;
}

export interface ReviewCommentPosted {
  program_id: Hex;
  revision: number;
  author: Hex;
  author_role: ReviewAuthorRole;
  body: string;
  ts: bigint | number;
  season_id: number;
}

export interface ReviewDecisionRecorded {
  program_id: Hex;
  revision: number;
  reviewer: Hex;
  verdict: ReviewVerdict;
  reason: string;
  criteria: ReviewCriteria;
  old_status: AppStatus;
  new_status: AppStatus;
  decided_at: bigint | number;
  season_id: number;
}

export interface PublishDecisionRecorded {
  program_id: Hex;
  revision: number;
  reviewer: Hex;
  outcome: PublishOutcome;
  reason: string;
  criteria: ReviewCriteria;
  old_status: AppStatus;
  new_status: AppStatus;
  decided_at: bigint | number;
  season_id: number;
}

export interface ProjectReviewSubmitted {
  project_review_id: bigint | number;
  owner: Hex;
  github_url: string;
  idea: string;
  submitted_at: bigint | number;
  season_id: number;
}

export interface ProjectReviewSubmissionApproved {
  approval_id: bigint | number;
  applicant: Hex;
  coach: Hex;
  request_message_id: bigint | number;
  approved_at: bigint | number;
  season_id: number;
}

export interface ProjectReviewApprovalConsumed {
  approval_id: bigint | number;
  project_review_id: bigint | number;
  applicant: Hex;
  coach: Hex;
  request_message_id: bigint | number;
  consumed_at: bigint | number;
  season_id: number;
}

export interface ProjectReviewCommentPosted {
  project_review_id: bigint | number;
  author: Hex;
  author_role: ReviewAuthorRole;
  body: string;
  ts: bigint | number;
  season_id: number;
}

export interface ProjectReviewGuidanceRecorded {
  project_review_id: bigint | number;
  reviewer: Hex;
  outcome: ProjectGuidanceOutcome;
  body: string;
  ts: bigint | number;
  season_id: number;
}

export interface ProjectReviewLinked {
  project_review_id: bigint | number;
  owner: Hex;
  program_id: Hex;
  linked_at: bigint | number;
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
