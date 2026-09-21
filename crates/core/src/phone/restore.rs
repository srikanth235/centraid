//! RESTORE FROM 24 WORDS (#1029 §5, W15-3).

use centraid_api_proto::core_v1 as wire;

use crate::error::{CoreError, Result};

/// **Bring every vault back from 24 words.**
///
/// # Errors
/// [`CoreError::InvalidRequest`] when the phrase is not 24 valid BIP-39 words.
pub fn run(request: &wire::RestoreRequest) -> Result<wire::RestoreResponse> {
    let phrase =
        centraid_identity::RecoveryPhrase::parse(request.phrase.trim()).map_err(|error| {
            CoreError::InvalidRequest {
                detail: format!("those are not your 24 words: {error}"),
            }
        })?;
    let _seed = phrase.seed();
    if let Some(endpoint) = &request.endpoint
        && endpoint.len() != 32
    {
        return Err(CoreError::InvalidRequest {
            detail: "a typed laptop id is 32 bytes".to_owned(),
        });
    }
    Err(CoreError::Unavailable {
        reason: "a restore dials the laptop over iroh, and this core has no transport yet"
            .to_owned(),
    })
}
