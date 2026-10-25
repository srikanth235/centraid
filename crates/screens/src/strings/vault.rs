//! The vault shelf's sentences (#1135, lane H2), moved here from the Kotlin
//! `Shelf` and `HomeSession` constants.

use super::{Locale, fill};

catalog! {
    plain default_vault_name = ("My vault", "My vault");
    plain default_owner_name = ("Me", "Me");
    counted frozen_changes = ("{n} change since {date}", "{n} changes since {date}");
    plain found_no_core = ("Couldn't make a vault on this phone.", "Couldn't make a vault on this phone.");
    plain found_not_founded = ("Couldn't make the vault. Try again.", "Couldn't make the vault. Try again.");
    plain found_already_held = ("This phone already holds that vault.", "This phone already holds that vault.");
    plain moved_refusal = ("Moved to your other phone. Still readable here.", "Moved to your other phone. Still readable here.");
}

/// WHAT THE MEMBER IS OWED WHEN THEY TOUCH A FROZEN VAULT (#1029 F1): "N
/// changes since <date>", where the number is the changes this phone is still
/// holding that no gateway acknowledged — not a count of what is lost: nothing
/// was. `since` is the `YYYY-MM-DD` the holdings read carries.
#[must_use]
pub fn frozen_line(locale: Locale, unacked: u64, since: &str) -> String {
    fill(&frozen_changes(locale, unacked), &[("date", since)])
}

/// Why a found did not add a vault, as a sentence.
#[must_use]
pub fn found_refusal(locale: Locale, because: crate::vault::FoundRefusal) -> String {
    match because {
        crate::vault::FoundRefusal::NoCore => found_no_core(locale),
        crate::vault::FoundRefusal::NotFounded => found_not_founded(locale),
        crate::vault::FoundRefusal::AlreadyHeld => found_already_held(locale),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_frozen_line_counts_and_dates() {
        assert_eq!(
            frozen_line(Locale::En, 1, "2026-02-03"),
            "1 change since 2026-02-03"
        );
        assert_eq!(
            frozen_line(Locale::En, 0, "2026-02-03"),
            "0 changes since 2026-02-03"
        );
        assert_eq!(
            frozen_line(Locale::En, 12, "2026-02-03"),
            "12 changes since 2026-02-03"
        );
    }
}
