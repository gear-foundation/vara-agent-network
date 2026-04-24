//! Validation guards shared across services. Limits come from runtime config.

use crate::types::{
    Config, ContractError, RegisterAppReq, MAX_ANNOUNCEMENT_BODY,
    MAX_ANNOUNCEMENT_TITLE, MAX_DESCRIPTION, MAX_GITHUB_URL, MAX_HANDLE_LEN,
    MAX_IDENTITY_FIELD, MAX_IDL_URL, MAX_SKILLS_URL, MAX_TAG_LEN, MAX_TAGS,
    MAX_X_ACCOUNT, MIN_HANDLE_LEN,
};
use sails_rs::prelude::*;

pub fn ensure_registration_enabled(config: &Config) -> Result<(), ContractError> {
    if !config.allow_participant_registration && !config.allow_application_registration {
        return Err(ContractError::RegistrationDisabled);
    }
    Ok(())
}

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

pub fn validate_handle(h: &str, _config: &Config) -> Result<(), ContractError> {
    let bytes = h.as_bytes();
    if bytes.len() < MIN_HANDLE_LEN || bytes.len() > MAX_HANDLE_LEN {
        return Err(ContractError::HandleMalformed);
    }
    for &b in bytes {
        let ok = (b >= b'a' && b <= b'z')
            || (b >= b'0' && b <= b'9')
            || b == b'-'
            || b == b'_';
        if !ok {
            return Err(ContractError::HandleMalformed);
        }
    }
    Ok(())
}

pub fn check_register_app_req(req: &RegisterAppReq, config: &Config) -> Result<(), ContractError> {
    validate_handle(&req.handle, config)?;
    if req.github_url.len() > MAX_GITHUB_URL
        || req.skills_url.len() > MAX_SKILLS_URL
        || req.idl_url.len() > MAX_IDL_URL
        || req.description.len() > MAX_DESCRIPTION
    {
        return Err(ContractError::FieldTooLarge);
    }
    if let Some(x) = &req.x_account {
        if x.len() > MAX_X_ACCOUNT {
            return Err(ContractError::FieldTooLarge);
        }
    }
    Ok(())
}

pub fn check_application_patch(
    description: Option<&String>,
    skills_url: Option<&String>,
    idl_url: Option<&String>,
    x_account: Option<&Option<String>>,
    _config: &Config,
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
    }
    if let Some(Some(x)) = x_account {
        if x.len() > MAX_X_ACCOUNT {
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
    _config: &Config,
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
    _config: &Config,
) -> Result<(), ContractError> {
    if title.len() > MAX_ANNOUNCEMENT_TITLE
        || body.len() > MAX_ANNOUNCEMENT_BODY
    {
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
        assert!(validate_handle("alice_bot", &Config::default()).is_ok());
    }

    #[test]
    fn handle_rejects_uppercase() {
        assert_eq!(
            validate_handle("Alice", &Config::default()).unwrap_err(),
            ContractError::HandleMalformed,
        );
    }

    #[test]
    fn chat_body_boundary() {
        let cfg = Config::default();
        let max = "x".repeat(cfg.max_chat_body as usize);
        assert!(check_chat_body(&max, &cfg).is_ok());
        let over = "x".repeat(cfg.max_chat_body as usize + 1);
        assert_eq!(check_chat_body(&over, &cfg).unwrap_err(), ContractError::FieldTooLarge);
        assert_eq!(check_chat_body("", &cfg).unwrap_err(), ContractError::EmptyBody);
    }
}
