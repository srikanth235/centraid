//! The vault shelf's sentences (#1135, lane H2), moved here from the Kotlin
//! `Shelf` constants. The refusals of a found are the words lane's
//! (`strings::custody`), which words them where the member makes a vault.

use super::{Locale, fill};

catalog! {
    plain default_vault_name = ("My vault", "My vault");
    plain default_owner_name = ("Me", "Me");
    counted frozen_changes = ("{n} change since {date}", "{n} changes since {date}");
}

/// WHAT THE MEMBER IS OWED WHEN THEY TOUCH A FROZEN VAULT (#1029 F1): "N
/// changes since <date>", where the number is the changes this phone is still
/// holding that no gateway acknowledged — not a count of what is lost: nothing
/// was. `since` is the `YYYY-MM-DD` the holdings read carries.
#[must_use]
pub fn frozen_line(locale: Locale, unacked: u64, since: &str) -> String {
    fill(&frozen_changes(locale, unacked), &[("date", since)])
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
