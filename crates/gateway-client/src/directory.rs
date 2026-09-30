//! Which gateway, and how a member gets onto one (#1029 §3, W5B-3).
//!
//! Three things a member does that are not a request about a vault's bytes:
//!
//! 1. **add a gateway and switch to it** — the machine a member runs, and a
//!    household may run more than one;
//! 2. **redeem an invite** on it, which is how a vault becomes known to a
//!    server at all.
//!
//! # THE GATEWAY IS A SETTING, AND SWITCHING IS NOT A MIGRATION
//!
//! [`Directory`] holds gateways and names one as current *per vault*, because a
//! vault's objects live where they were uploaded — a household may keep one
//! vault on one machine and another on a second, and a single
//! "current gateway" would be a setting that silently moved somebody's
//! photographs. Switching a vault's gateway changes where the *next* commit
//! goes and moves nothing; the old gateway still holds what it held, which is
//! why [`Directory::switch`] returns the gateway that was displaced rather than
//! dropping it.
//!

use std::collections::BTreeMap;

use centraid_gateway_core::ids::{AccountId, VaultId};
use centraid_identity::GatewayUrl;
use serde::Deserialize;

use crate::outcome::{ClientError, ErrorBody};
use crate::transport::{HttpRequest, Transport};

/// A gateway a member has added.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Gateway {
    /// Its base URL, checked once at the edge by `centraid_identity`.
    pub url: GatewayUrl,
    /// What a member called it. Their word, never derived from the host: a
    /// member who calls their box "the shed" should see "the shed".
    pub label: String,
}

/// The gateways this phone knows, and which one each vault is on.
#[derive(Debug, Clone, Default)]
pub struct Directory {
    gateways: Vec<Gateway>,
    current: BTreeMap<[u8; 32], GatewayUrl>,
}

impl Directory {
    /// An empty directory — a phone before setup.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Add a gateway, or rename one already here.
    ///
    /// Keyed by URL: adding the same box twice under two labels would give a
    /// member two rows that are one thing, and a switcher they cannot reason
    /// about.
    pub fn add(&mut self, gateway: Gateway) {
        if let Some(existing) = self
            .gateways
            .iter_mut()
            .find(|held| held.url.as_str() == gateway.url.as_str())
        {
            existing.label = gateway.label;
            return;
        }
        self.gateways.push(gateway);
    }

    /// Every gateway, in the order they were added.
    #[must_use]
    pub fn gateways(&self) -> &[Gateway] {
        &self.gateways
    }

    /// Where this vault's next commit goes.
    #[must_use]
    pub fn current(&self, vault: &VaultId) -> Option<&GatewayUrl> {
        self.current.get(vault.as_bytes())
    }

    /// Point a vault at a gateway, and answer with the one it was on.
    ///
    /// **Nothing moves.** The old gateway still holds every object it held, and
    /// the member can switch back. A switch that deleted would be a switch that
    /// loses a vault when somebody taps the wrong row.
    ///
    /// # Errors
    ///
    /// [`SwitchRefused`] when the gateway is not one this phone has added —
    /// a vault pointed at a URL the member never entered is a vault whose bytes
    /// go somewhere nobody chose.
    pub fn switch(
        &mut self,
        vault: &VaultId,
        url: &GatewayUrl,
    ) -> Result<Option<GatewayUrl>, SwitchRefused> {
        if !self
            .gateways
            .iter()
            .any(|held| held.url.as_str() == url.as_str())
        {
            return Err(SwitchRefused::NotAdded {
                url: url.as_str().to_owned(),
            });
        }
        Ok(self.current.insert(*vault.as_bytes(), url.clone()))
    }
}

/// Why a switch was refused.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SwitchRefused {
    /// The gateway is not in the directory.
    #[error("{url} is not a gateway this phone has added")]
    NotAdded {
        /// The URL that was asked for.
        url: String,
    },
}

/// What a server answered an invite with.
///
/// It carries a quota and an append-only flag and **no price**: what a
/// self-hoster charges, if anything, is not this protocol's business.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub struct Admission {
    /// The bytes this vault may store.
    pub quota_bytes: u64,
    /// Whether this deployment refuses tombstones (F10).
    pub append_only: bool,
}

/// Redeem an invite on a gateway.
///
/// **Unsigned, and it must be**: this is how a vault becomes known to a server
/// at all, and a signature would be verified against a registration that does
/// not exist yet. Every invite refusal is the same answer on the server's side,
/// so a caller cannot enumerate which invites a household has minted.
///
/// # Errors
///
/// [`ClientError::Refused`] with `Unauthorized` for any invite the server did
/// not accept — which is deliberately indistinguishable from an unknown vault.
pub async fn redeem_invite<T: Transport>(
    transport: &T,
    vault: &VaultId,
    account: &AccountId,
    invite: &str,
) -> Result<Admission, ClientError> {
    let body = serde_json::to_vec(&serde_json::json!({
        "invite": invite,
        "account": account.hex(),
    }))
    .map_err(|error| ClientError::Malformed {
        reason: error.to_string(),
    })?;
    let response = transport
        .send(HttpRequest {
            method: "POST".to_owned(),
            path: format!("/v1/vaults/{}/admit", vault.hex()),
            headers: [("content-type".to_owned(), "application/json".to_owned())]
                .into_iter()
                .collect(),
            body,
        })
        .await?;
    if response.status >= 400 {
        let refusal: ErrorBody =
            serde_json::from_slice(&response.body).map_err(|error| ClientError::Malformed {
                reason: error.to_string(),
            })?;
        return Err(ClientError::from_body(response.status, &refusal));
    }
    serde_json::from_slice(&response.body).map_err(|error| ClientError::Malformed {
        reason: error.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use centraid_gateway_core::ids::Key32;

    use super::*;

    fn url(text: &str) -> GatewayUrl {
        GatewayUrl::parse(text).expect("a usable gateway URL")
    }

    fn vault(byte: u8) -> VaultId {
        Key32::from_bytes([byte; 32])
    }

    /// TWO VAULTS, TWO GATEWAYS. The setting is per vault because a vault's
    /// objects live where they were uploaded.
    #[test]
    fn two_vaults_can_sit_on_two_gateways() {
        let mut directory = Directory::new();
        directory.add(Gateway {
            url: url("https://shed.example"),
            label: "the shed".to_owned(),
        });
        directory.add(Gateway {
            url: url("https://second.example"),
            label: "Centraid".to_owned(),
        });
        directory
            .switch(&vault(1), &url("https://shed.example"))
            .expect("added");
        directory
            .switch(&vault(2), &url("https://second.example"))
            .expect("added");
        assert_eq!(
            directory.current(&vault(1)).map(GatewayUrl::as_str),
            Some("https://shed.example/")
        );
        assert_eq!(
            directory.current(&vault(2)).map(GatewayUrl::as_str),
            Some("https://second.example/")
        );
    }

    /// SWITCHING IS NOT A MIGRATION, and the displaced gateway comes back so a
    /// member can be told where the old copy still is.
    #[test]
    fn a_switch_answers_with_the_gateway_it_displaced() {
        let mut directory = Directory::new();
        directory.add(Gateway {
            url: url("https://one.example"),
            label: "one".to_owned(),
        });
        directory.add(Gateway {
            url: url("https://two.example"),
            label: "two".to_owned(),
        });
        assert_eq!(
            directory.switch(&vault(1), &url("https://one.example")),
            Ok(None)
        );
        assert_eq!(
            directory
                .switch(&vault(1), &url("https://two.example"))
                .expect("added")
                .map(|old| old.as_str().to_owned()),
            Some("https://one.example/".to_owned())
        );
    }

    /// A vault pointed at a URL the member never entered is a vault whose bytes
    /// go somewhere nobody chose.
    #[test]
    fn a_vault_cannot_be_switched_to_a_gateway_nobody_added() {
        let mut directory = Directory::new();
        assert!(matches!(
            directory.switch(&vault(1), &url("https://stranger.example")),
            Err(SwitchRefused::NotAdded { .. })
        ));
    }

    #[test]
    fn adding_the_same_box_twice_renames_it_rather_than_duplicating_it() {
        let mut directory = Directory::new();
        directory.add(Gateway {
            url: url("https://shed.example"),
            label: "box".to_owned(),
        });
        directory.add(Gateway {
            url: url("https://shed.example"),
            label: "the shed".to_owned(),
        });
        assert_eq!(directory.gateways().len(), 1);
        assert_eq!(directory.gateways()[0].label, "the shed");
    }
}
