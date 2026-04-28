//! Validation guards shared across services. Limits come from runtime config.

use crate::types::{
    Config, ContactLinks, ContractError, MAX_ANNOUNCEMENT_BODY, MAX_ANNOUNCEMENT_TITLE,
    MAX_CONTACT_LINK, MAX_DESCRIPTION, MAX_GITHUB_URL, MAX_HANDLE_LEN, MAX_IDENTITY_FIELD,
    MAX_IDL_URL, MAX_SKILLS_URL, MAX_TAG_LEN, MAX_TAGS, MIN_HANDLE_LEN, RegisterAppReq,
};
use sails_rs::prelude::*;

pub fn ensure_participant_registration_enabled(config: &Config) -> Result<(), ContractError> {
    if !config.allow_participant_registration {
        return Err(ContractError::RegistrationDisabled);
    }
    Ok(())
}

pub fn ensure_application_registration_enabled(config: &Config) -> Result<(), ContractError> {
    if !config.allow_application_registration {
        return Err(ContractError::RegistrationDisabled);
    }
    Ok(())
}

pub fn ensure_chat_enabled(config: &Config) -> Result<(), ContractError> {
    if !config.allow_chat {
        return Err(ContractError::ChatDisabled);
    }
    Ok(())
}

pub fn ensure_board_enabled(config: &Config) -> Result<(), ContractError> {
    if !config.allow_board_updates {
        return Err(ContractError::BoardUpdatesDisabled);
    }
    Ok(())
}

pub fn ensure_user_mutations_allowed(config: &Config) -> Result<(), ContractError> {
    if config.paused {
        return Err(ContractError::Paused);
    }
    Ok(())
}

pub fn validate_handle(h: &str) -> Result<(), ContractError> {
    let bytes = h.as_bytes();
    if bytes.len() < MIN_HANDLE_LEN || bytes.len() > MAX_HANDLE_LEN {
        return Err(ContractError::HandleMalformed);
    }
    for &b in bytes {
        let ok = (b >= b'a' && b <= b'z') || (b >= b'0' && b <= b'9') || b == b'-' || b == b'_';
        if !ok {
            return Err(ContractError::HandleMalformed);
        }
    }
    Ok(())
}

pub fn check_register_app_req(req: &RegisterAppReq) -> Result<(), ContractError> {
    validate_handle(&req.handle)?;
    if req.program_id == ActorId::zero() {
        return Err(ContractError::UnknownApplication);
    }
    validate_hash(&req.skills_hash)?;
    validate_hash(&req.idl_hash)?;
    if req.github_url.len() > MAX_GITHUB_URL
        || req.skills_url.len() > MAX_SKILLS_URL
        || req.idl_url.len() > MAX_IDL_URL
        || req.description.len() > MAX_DESCRIPTION
    {
        return Err(ContractError::FieldTooLarge);
    }
    validate_github_url(&req.github_url)?;
    validate_idl_url(&req.idl_url)?;
    check_contact_links(req.contacts.as_ref())?;
    Ok(())
}

pub fn validate_hash(hash: &[u8; 32]) -> Result<(), ContractError> {
    if hash.iter().all(|b| *b == 0) {
        return Err(ContractError::InvalidHash);
    }
    Ok(())
}

pub fn validate_github_url(url: &str) -> Result<(), ContractError> {
    if url.starts_with("https://github.com/") {
        return Ok(());
    }
    Err(ContractError::InvalidGithubUrl)
}

pub fn validate_idl_url(url: &str) -> Result<(), ContractError> {
    if !(url.starts_with("https://") || url.starts_with("ipfs://")) {
        return Err(ContractError::InvalidIdlUrl);
    }
    if !url.ends_with(".idl") {
        return Err(ContractError::InvalidIdlUrl);
    }
    Ok(())
}

pub fn check_application_patch(
    description: Option<&String>,
    skills_url: Option<&String>,
    idl_url: Option<&String>,
    contacts: Option<&Option<ContactLinks>>,
) -> Result<(), ContractError> {
    if let Some(d) = description {
        if d.len() > MAX_DESCRIPTION {
            return Err(ContractError::FieldTooLarge);
        }
    }
    if let Some(u) = skills_url {
        if u.len() > MAX_SKILLS_URL {
            return Err(ContractError::FieldTooLarge);
        }
    }
    if let Some(u) = idl_url {
        if u.len() > MAX_IDL_URL {
            return Err(ContractError::FieldTooLarge);
        }
        validate_idl_url(u)?;
    }
    if let Some(Some(links)) = contacts {
        check_contact_links(Some(links))?;
    }
    Ok(())
}

fn check_contact_links(links: Option<&ContactLinks>) -> Result<(), ContractError> {
    let Some(links) = links else {
        return Ok(());
    };
    for value in [&links.discord, &links.telegram, &links.x]
        .into_iter()
        .flatten()
    {
        if value.len() > MAX_CONTACT_LINK {
            return Err(ContractError::FieldTooLarge);
        }
    }
    Ok(())
}

pub fn check_identity_card_req(
    who_i_am: &str,
    what_i_do: &str,
    how_to_interact: &str,
    what_i_offer: &str,
    tags: &[String],
) -> Result<(), ContractError> {
    if who_i_am.len() > MAX_IDENTITY_FIELD
        || what_i_do.len() > MAX_IDENTITY_FIELD
        || how_to_interact.len() > MAX_IDENTITY_FIELD
        || what_i_offer.len() > MAX_IDENTITY_FIELD
    {
        return Err(ContractError::FieldTooLarge);
    }
    check_tags(tags)
}

pub fn check_announcement_req(
    title: &str,
    body: &str,
    tags: &[String],
) -> Result<(), ContractError> {
    if title.len() > MAX_ANNOUNCEMENT_TITLE || body.len() > MAX_ANNOUNCEMENT_BODY {
        return Err(ContractError::FieldTooLarge);
    }
    check_tags(tags)
}

fn check_tags(tags: &[String]) -> Result<(), ContractError> {
    if tags.len() > MAX_TAGS {
        return Err(ContractError::FieldTooLarge);
    }
    for t in tags {
        if t.len() > MAX_TAG_LEN {
            return Err(ContractError::FieldTooLarge);
        }
    }
    Ok(())
}

pub fn check_chat_body(body: &str, config: &Config) -> Result<(), ContractError> {
    if body.is_empty() {
        return Err(ContractError::EmptyBody);
    }
    if body.len() > config.max_chat_body as usize {
        return Err(ContractError::FieldTooLarge);
    }
    Ok(())
}

pub fn check_mentions_cap<T>(mentions: &[T], config: &Config) -> Result<(), ContractError> {
    if mentions.len() > config.max_mentions_per_post as usize {
        return Err(ContractError::TooManyMentions);
    }
    Ok(())
}

pub fn clamp_page_size(limit: u32, max: u32) -> usize {
    limit.min(max) as usize
}

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handle_accepts_underscore_now() {
        assert!(validate_handle("alice_bot").is_ok());
    }

    #[test]
    fn handle_rejects_uppercase() {
        assert_eq!(
            validate_handle("Alice").unwrap_err(),
            ContractError::HandleMalformed,
        );
    }

    #[test]
    fn chat_body_boundary() {
        let cfg = Config::default();
        let max = "x".repeat(cfg.max_chat_body as usize);
        assert!(check_chat_body(&max, &cfg).is_ok());
        let over = "x".repeat(cfg.max_chat_body as usize + 1);
        assert_eq!(
            check_chat_body(&over, &cfg).unwrap_err(),
            ContractError::FieldTooLarge
        );
        assert_eq!(
            check_chat_body("", &cfg).unwrap_err(),
            ContractError::EmptyBody
        );
    }
}
