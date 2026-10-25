//! THE BAND (#1135; DESIGN.md invariant 1): one strip at the foot of every tab
//! root, never app-themed, frame destinations only. Rust words it and lights the
//! place the member is in; a shell draws it under a tab's root and sends
//! `select_tab` for a press. The apps are tiles on Home, not places in the band.
//!
//! Which places it holds follows the tabs that exist: Home always, the chat and
//! the backup when those lanes' roots are registered. A place whose tab does not
//! exist is not drawn, so the band never carries a control that opens nothing.

use centraid_api_proto::core_v1 as wire;

use crate::strings::{Locale, home as words};

pub const HOME: &str = "home";
pub const CHAT: &str = "chat";
pub const BACKUP: &str = "backup";

/// The band for the tabs `tabs` (the runtime's, in its order) with `selected` lit.
#[must_use]
pub fn view(locale: Locale, tabs: &[String], selected: &str) -> wire::ShellBand {
    let places = [
        (
            HOME,
            words::band_home(locale),
            words::band_home(locale),
            "Home",
        ),
        // THE ASSISTANT'S MARK, not a speech bubble: `Sparkle` is the design
        // system's `ask` concept, so the tab and every ask key agree.
        (
            CHAT,
            words::band_chat(locale),
            words::band_chat(locale),
            "Sparkle",
        ),
        (
            BACKUP,
            words::band_backup(locale),
            words::band_backup_spoken(locale),
            "Backup",
        ),
    ];
    wire::ShellBand {
        tabs: places
            .into_iter()
            .filter(|(tab, ..)| tabs.iter().any(|known| known == tab))
            .map(|(tab, label, spoken, icon)| {
                let lit = tab == selected;
                wire::ShellBandTab {
                    tab: tab.to_owned(),
                    label,
                    // SPEAK WHAT IS PAINTED, and which place is the current one.
                    spoken: if lit {
                        format!("{spoken}, {}", words::band_current_spoken(locale))
                    } else {
                        spoken
                    },
                    icon_key: icon.to_owned(),
                    selected: lit,
                }
            })
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tabs(ids: &[&str]) -> Vec<String> {
        ids.iter().map(|id| (*id).to_owned()).collect()
    }

    #[test]
    fn the_band_holds_the_places_whose_tabs_exist_in_order() {
        let band = view(
            Locale::En,
            &tabs(&["backup", "home", "chat", "proof"]),
            "chat",
        );
        let shown: Vec<_> = band.tabs.iter().map(|tab| tab.tab.as_str()).collect();
        assert_eq!(shown, ["home", "chat", "backup"]);
        assert_eq!(view(Locale::En, &tabs(&["home"]), "home").tabs.len(), 1);
    }

    #[test]
    fn the_lit_place_says_so_aloud_and_the_others_do_not() {
        let band = view(Locale::En, &tabs(&["home", "chat", "backup"]), "backup");
        let lit: Vec<_> = band.tabs.iter().filter(|tab| tab.selected).collect();
        assert_eq!(lit.len(), 1);
        assert_eq!(lit[0].tab, "backup");
        assert_eq!(lit[0].spoken, "Backup and recovery key, current place");
        assert_eq!(band.tabs[0].spoken, "Home");
        assert_eq!(band.tabs[0].label, "Home");
        assert_eq!(band.tabs[1].icon_key, "Sparkle");
    }
}
