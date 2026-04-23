//! Validation guards shared across services. Each guard returns a typed
//! error variant; panics propagate the rollback boundary up to the message
//! boundary.

use crate::types::*;
use sails_rs::prelude::*;

// ---------------------------------------------------------------------------
// Handle regex: [a-z0-9-]{3,32}
// ---------------------------------------------------------------------------

/// `^[a-z0-9-]{3,32}$` enforced without pulling in a regex crate. `no_std`
/// friendly. Rejects mixed case (contract is strict — frontend must
/// lowercase).
pub fn validate_handle(h: &str) -> Result<(), RegistryError> {
    let bytes = h.as_bytes();
    if bytes.len() < MIN_HANDLE_LEN || bytes.len() > MAX_HANDLE_LEN {
        return Err(RegistryError::HandleMalformed);
    }
    for &b in bytes {
        let ok = (b >= b'a' && b <= b'z') || (b >= b'0' && b <= b'9') || b == b'-';
        if !ok {
            return Err(RegistryError::HandleMalformed);
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Field size caps (Registry)
// ---------------------------------------------------------------------------

pub fn check_register_app_req(req: &RegisterAppReq) -> Result<(), RegistryError> {
    validate_handle(&req.handle)?;
    if req.github_url.len() > MAX_GITHUB_URL
        || req.skills_url.len() > MAX_SKILLS_URL
        || req.idl_url.len() > MAX_IDL_URL
        || req.description.len() > MAX_DESCRIPTION
    {
        return Err(RegistryError::FieldTooLarge);
    }
    if let Some(x) = &req.x_account {
        if x.len() > MAX_X_ACCOUNT {
            return Err(RegistryError::FieldTooLarge);
        }
    }
    Ok(())
}

pub fn check_application_patch(patch: &ApplicationPatch) -> Result<(), RegistryError> {
    if let Some(d) = &patch.description {
        if d.len() > MAX_DESCRIPTION {
            return Err(RegistryError::FieldTooLarge);
        }
    }
    if let Some(u) = &patch.skills_url {
        if u.len() > MAX_SKILLS_URL {
            return Err(RegistryError::FieldTooLarge);
        }
    }
    if let Some(u) = &patch.idl_url {
        if u.len() > MAX_IDL_URL {
            return Err(RegistryError::FieldTooLarge);
        }
    }
    if let Some(Some(x)) = &patch.x_account {
        if x.len() > MAX_X_ACCOUNT {
            return Err(RegistryError::FieldTooLarge);
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Field size caps (Board)
// ---------------------------------------------------------------------------

pub fn check_identity_card_req(req: &IdentityCardReq) -> Result<(), BoardError> {
    if req.who_i_am.len() > MAX_IDENTITY_FIELD
        || req.what_i_do.len() > MAX_IDENTITY_FIELD
        || req.how_to_interact.len() > MAX_IDENTITY_FIELD
        || req.what_i_offer.len() > MAX_IDENTITY_FIELD
    {
        return Err(BoardError::FieldTooLarge);
    }
    check_tags(&req.tags)
}

pub fn check_announcement_req(req: &AnnouncementReq) -> Result<(), BoardError> {
    if req.title.len() > MAX_ANNOUNCEMENT_TITLE
        || req.body.len() > MAX_ANNOUNCEMENT_BODY
    {
        return Err(BoardError::FieldTooLarge);
    }
    check_tags(&req.tags)
}

fn check_tags(tags: &[String]) -> Result<(), BoardError> {
    if tags.len() > MAX_TAGS {
        return Err(BoardError::FieldTooLarge);
    }
    for t in tags {
        if t.len() > MAX_TAG_LEN {
            return Err(BoardError::FieldTooLarge);
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Chat body + mentions
// ---------------------------------------------------------------------------

pub fn check_chat_body(body: &str) -> Result<(), ChatError> {
    if body.is_empty() {
        return Err(ChatError::EmptyBody);
    }
    if body.len() > MAX_CHAT_BODY {
        return Err(ChatError::BodyTooLarge);
    }
    Ok(())
}

pub fn check_mentions_cap(mentions: &[HandleRef]) -> Result<(), ChatError> {
    if mentions.len() > MAX_MENTIONS_PER_POST {
        return Err(ChatError::TooManyMentions);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Rate-limit helper
// ---------------------------------------------------------------------------

/// Generic timestamp-keyed rate limit. Callers pass the current block
/// timestamp (milliseconds). On success, updates `last_at[key]` to `now`.
pub fn check_and_bump_rate_limit(
    last_at: &mut sails_rs::collections::BTreeMap<ActorId, u64>,
    key: ActorId,
    now: u64,
    min_gap_ms: u64,
) -> Result<(), ()> {
    if let Some(&prev) = last_at.get(&key) {
        if now.saturating_sub(prev) < min_gap_ms {
            return Err(());
        }
    }
    last_at.insert(key, now);
    Ok(())
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handle_min_len() {
        assert!(validate_handle("abc").is_ok());
        assert_eq!(validate_handle("ab").unwrap_err(), RegistryError::HandleMalformed);
    }

    #[test]
    fn handle_max_len() {
        let thirty_two = "a".repeat(32);
        assert!(validate_handle(&thirty_two).is_ok());
        let thirty_three = "a".repeat(33);
        assert_eq!(
            validate_handle(&thirty_three).unwrap_err(),
            RegistryError::HandleMalformed,
        );
    }

    #[test]
    fn handle_rejects_uppercase() {
        assert_eq!(
            validate_handle("Alice").unwrap_err(),
            RegistryError::HandleMalformed,
        );
        assert_eq!(
            validate_handle("alice-BOT").unwrap_err(),
            RegistryError::HandleMalformed,
        );
    }

    #[test]
    fn handle_rejects_underscore() {
        assert_eq!(
            validate_handle("alice_bot").unwrap_err(),
            RegistryError::HandleMalformed,
        );
    }

    #[test]
    fn handle_rejects_unicode() {
        assert_eq!(
            validate_handle("áliçe").unwrap_err(),
            RegistryError::HandleMalformed,
        );
        // emoji
        assert_eq!(
            validate_handle("alice🤖").unwrap_err(),
            RegistryError::HandleMalformed,
        );
    }

    #[test]
    fn handle_accepts_digits_and_dashes() {
        assert!(validate_handle("nft-007").is_ok());
        assert!(validate_handle("a1").is_err()); // length
        assert!(validate_handle("a1b").is_ok());
    }

    #[test]
    fn handle_rejects_empty() {
        assert_eq!(
            validate_handle("").unwrap_err(),
            RegistryError::HandleMalformed,
        );
    }

    #[test]
    fn chat_body_boundary() {
        let max = "x".repeat(MAX_CHAT_BODY);
        assert!(check_chat_body(&max).is_ok());
        let over = "x".repeat(MAX_CHAT_BODY + 1);
        assert_eq!(check_chat_body(&over).unwrap_err(), ChatError::BodyTooLarge);
        assert_eq!(check_chat_body("").unwrap_err(), ChatError::EmptyBody);
    }

    #[test]
    fn mentions_cap() {
        let eight: Vec<HandleRef> = (0..8)
            .map(|_| HandleRef::Participant(ActorId::default()))
            .collect();
        assert!(check_mentions_cap(&eight).is_ok());

        let nine: Vec<HandleRef> = (0..9)
            .map(|_| HandleRef::Participant(ActorId::default()))
            .collect();
        assert_eq!(
            check_mentions_cap(&nine).unwrap_err(),
            ChatError::TooManyMentions,
        );
    }

    #[test]
    fn rate_limit_bump() {
        let mut m = sails_rs::collections::BTreeMap::new();
        let k = ActorId::default();
        assert!(check_and_bump_rate_limit(&mut m, k, 1000, 5000).is_ok());
        assert!(check_and_bump_rate_limit(&mut m, k, 2000, 5000).is_err());
        assert!(check_and_bump_rate_limit(&mut m, k, 6000, 5000).is_ok());
    }

    #[test]
    fn register_req_field_caps() {
        let mut req = RegisterAppReq {
            handle: "ok".repeat(16), // 32 chars, valid
            operator: ActorId::default(),
            github_url: "x".repeat(MAX_GITHUB_URL),
            skills_hash: [0; 32],
            skills_url: "x".repeat(MAX_SKILLS_URL),
            idl_hash: [0; 32],
            idl_url: "x".repeat(MAX_IDL_URL),
            description: "x".repeat(MAX_DESCRIPTION),
            track: Track::Services,
            x_account: Some("x".repeat(MAX_X_ACCOUNT)),
        };
        // Handle 32 chars of "ok" = all 'o' and 'k' chars, valid.
        req.handle = "a".repeat(32);
        assert!(check_register_app_req(&req).is_ok());

        req.github_url = "x".repeat(MAX_GITHUB_URL + 1);
        assert_eq!(
            check_register_app_req(&req).unwrap_err(),
            RegistryError::FieldTooLarge,
        );
    }
}
