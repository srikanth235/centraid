//! Container appearance is a saved vault choice; native shells never invent a hue or icon.
use crate::strings::{Locale, agenda as words};
use centraid_api_proto::core_v1 as wire;

pub const COLORS: [&str; 8] = [
    "listBlue",
    "listYellow",
    "listViolet",
    "listPetrol",
    "listNavy",
    "listGraphite",
    "listRaspberry",
    "listOrchid",
];
pub const ICONS: [&str; 9] = [
    "List", "Calendar", "Home", "Heart", "Star", "Folder", "Book", "Gift", "Music",
];

pub fn color(id: &str, stored: Option<&str>) -> String {
    if let Some(value) = stored.filter(|value| COLORS.contains(value)) {
        return value.to_owned();
    }
    let hue = centraid_design::party_hue_key(id, stored)
        .unwrap_or_else(|| centraid_design::identity_hue_key(id));
    centraid_design::hue_role_key(hue).to_owned()
}

#[derive(Clone, Debug)]
pub struct Appearance {
    pub color: String,
    pub icon: String,
}
impl Default for Appearance {
    fn default() -> Self {
        Self {
            color: COLORS[0].to_owned(),
            icon: "List".to_owned(),
        }
    }
}
impl Appearance {
    pub fn of(id: &str, stored: Option<&str>, icon: &str) -> Self {
        Self {
            color: color(id, stored),
            icon: if ICONS.contains(&icon) {
                icon.to_owned()
            } else {
                "List".to_owned()
            },
        }
    }
    pub fn change(&mut self, field: &str, value: &str) -> bool {
        match field {
            "color" if COLORS.contains(&value) => self.color = value.to_owned(),
            "icon" if ICONS.contains(&value) => self.icon = value.to_owned(),
            _ => return false,
        }
        true
    }
    pub fn view(&self, locale: Locale) -> wire::AgendaAppearance {
        let colors = [
            words::color_blue(locale),
            words::color_yellow(locale),
            words::color_violet(locale),
            words::color_petrol(locale),
            words::color_navy(locale),
            words::color_graphite(locale),
            words::color_raspberry(locale),
            words::color_orchid(locale),
        ];
        let icons = [
            words::icon_list(locale),
            words::icon_calendar(locale),
            words::icon_home(locale),
            words::icon_heart(locale),
            words::icon_star(locale),
            words::icon_folder(locale),
            words::icon_book(locale),
            words::icon_gift(locale),
            words::icon_music(locale),
        ];
        let option = |key: &str, label: String, selected: bool, icon: &str| wire::TodoChoice {
            key: key.to_owned(),
            label,
            selected,
            enabled: true,
            icon_key: icon.to_owned(),
            ..Default::default()
        };
        wire::AgendaAppearance {
            color_label: words::appearance_color(locale),
            icon_label: words::appearance_icon(locale),
            colors: COLORS
                .into_iter()
                .zip(colors)
                .map(|(key, label)| option(key, label, self.color == key, ""))
                .collect(),
            icons: ICONS
                .into_iter()
                .zip(icons)
                .map(|(key, label)| option(key, label, self.icon == key, key))
                .collect(),
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct CalendarEditor {
    pub id: String,
    pub name: String,
    pub appearance: Appearance,
}
impl CalendarEditor {
    pub fn view(&self, locale: Locale) -> wire::AgendaContainerForm {
        wire::AgendaContainerForm {
            title: if self.id.is_empty() {
                words::calendar_new(locale)
            } else {
                words::calendar_edit(locale)
            },
            name: self.name.clone(),
            name_label: words::container_name(locale),
            save_label: words::container_save(locale),
            can_save: !self.name.trim().is_empty(),
            appearance: Some(self.appearance.view(locale)),
        }
    }
}
