//! WHERE THE RECOVERY KEY IS (R-ONBOARD-10), read from the stores each time —
//! never remembered by the screen, so a keychain turned off elsewhere is said as
//! off.
//!
//! The key is the vault's seed. This module reads what [`VaultSecrets`] last
//! heard from the shell and the platform's answer to whether its synchronised
//! store would carry a key to another device, and words it. It never sees the
//! 24 words themselves: showing them is `words.show`'s, behind the passcode, and
//! what crosses into a view is whether they are here, never what they are.

use centraid_api_proto::core_v1 as wire;

use crate::custody::secrets::VaultSecrets;
use crate::strings::{Locale, backup_home as words};

/// Where this phone's recovery key is.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct KeyCustody {
    /// This phone holds a key at all.
    pub held: bool,
    /// The synchronised store holds this phone's key.
    pub synced: bool,
    /// The member said they saved a copy.
    pub saved: bool,
    /// This phone keeps the words, so it can show them.
    pub words_here: bool,
    /// The platform's sentence for a synchronised key.
    pub sentence: String,
    /// Where the platform synchronises to ("iCloud Keychain", "Google"); empty
    /// for nowhere.
    pub place: String,
}

impl KeyCustody {
    /// The key as the stores last said it. `probe` is the platform's answer to
    /// whether it synchronises, `None` when it would not say.
    #[must_use]
    pub fn read(
        locale: Locale,
        secrets: &VaultSecrets,
        platform: &str,
        probe: Option<&wire::SyncedSecretsStatus>,
    ) -> Self {
        let android = platform == "android";
        let synchronizing = probe.is_some_and(|status| status.synchronizing);
        Self {
            held: secrets.seed().is_some(),
            synced: secrets.seed_synced(),
            saved: secrets.words_saved(),
            words_here: secrets.words().is_some(),
            sentence: match (android, probe) {
                // ANDROID SAYS THE UNCOMFORTABLE THING: Block Store hands the key
                // back during the new-phone setup and at no other time.
                (true, Some(_)) => words::key_saved_android(locale),
                (false, Some(_)) if synchronizing => words::key_saved_ios(locale),
                (false, Some(_)) => words::key_saved_ios_off(locale),
                (_, None) => words::key_saved_unknown(locale),
            },
            place: if !synchronizing {
                String::new()
            } else if android {
                words::key_place_android(locale)
            } else {
                words::key_place_ios(locale)
            },
        }
    }
}
