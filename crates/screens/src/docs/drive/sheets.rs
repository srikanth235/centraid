//! THE ONE SHEET UP on the drive, and its body, rebuilt from the state on every
//! view so it follows every re-read.

use centraid_api_proto::core_v1 as wire;
use wire::docs_sheet::{Body, Kind};

use super::{
    Drive, KEY_EXPORT, KEY_FOLLOW_FOLDER, KEY_FOLLOWED, KEY_NEW_FOLDER, KEY_RECENT, KEY_SCAN,
    KEY_STOP_PREFIX, KEY_TEXT, KEY_TRASH_SHELF, KEY_UPLOAD,
};
use crate::docs::fold::{self, TRASH_ICON};
use crate::docs::{folders, routes};
use crate::kit::export;
use crate::strings::{Locale, docs as words, shared};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum Sheet {
    None,
    More,
    Add,
    RowMenu(String),
    Move(String),
    Labels { document_id: String, draft: String },
    NewFolder(String),
    Followed,
}

fn sheet(
    kind: Kind,
    title: String,
    document_id: &str,
    locale: Locale,
    body: Body,
) -> wire::DocsSheet {
    wire::DocsSheet {
        kind: kind as i32,
        title,
        document_id: document_id.to_owned(),
        close_label: words::close(locale),
        body: Some(body),
    }
}

pub(super) fn none() -> wire::DocsSheet {
    wire::DocsSheet {
        kind: Kind::None as i32,
        ..wire::DocsSheet::default()
    }
}

fn actions(actions: Vec<wire::DocsAction>) -> Body {
    Body::Actions(wire::DocsActionList {
        actions,
        footer: String::new(),
    })
}

fn choices(choices: Vec<wire::DocsChoice>) -> Body {
    Body::Choices(wire::DocsChoiceList { choices })
}

/// The open sheet as the view draws it.
pub(super) fn view(drive: &Drive, locale: Locale) -> wire::DocsSheet {
    let empty_rail = super::Rail::default();
    let rail = drive.rail.as_ref().unwrap_or(&empty_rail);
    match &drive.sheet {
        Sheet::None => none(),
        Sheet::More => {
            let mut rows = vec![fold::action(
                KEY_RECENT,
                words::more_recent(locale),
                "Clock",
            )];
            if !drive.followed.is_empty() {
                rows.push(fold::action(
                    KEY_FOLLOWED,
                    words::more_followed(locale),
                    "Folder",
                ));
            }
            // EXPORT (#1185): the kit's row, the same in every app, a route the shell pushes.
            let export = export::entry(locale, crate::docs::EXPORT);
            rows.push(wire::DocsAction {
                route: Some(export.route),
                meta: words::more_export_meta(locale),
                ..fold::action(KEY_EXPORT, export.label, export.icon_key)
            });
            rows.push(wire::DocsAction {
                detail: if rail.trash_count > 0 {
                    fold::count_label(locale, rail.trash_count)
                } else {
                    String::new()
                },
                route: Some(routes::trash()),
                meta: shared::trash_entry_meta(locale),
                ..fold::action(KEY_TRASH_SHELF, words::more_trash(locale), TRASH_ICON)
            });
            sheet(
                Kind::More,
                words::more_title(locale),
                "",
                locale,
                actions(rows),
            )
        }
        Sheet::Followed => {
            let rows = drive
                .followed
                .iter()
                .map(|folder| wire::DocsAction {
                    detail: words::followed_detail(
                        locale,
                        u64::try_from(folder.documents).unwrap_or(0),
                    ),
                    ..fold::action(
                        &format!("{KEY_STOP_PREFIX}{}", folder.origin_id),
                        crate::kit::follow::stop_row(locale, &folder.name),
                        "Folder",
                    )
                })
                .collect();
            sheet(
                Kind::Followed,
                words::followed_title(locale),
                "",
                locale,
                Body::Actions(wire::DocsActionList {
                    actions: rows,
                    footer: words::followed_footer(locale),
                }),
            )
        }
        Sheet::Add => sheet(
            Kind::Add,
            words::add_title(locale),
            "",
            locale,
            actions(add_rows(drive, locale)),
        ),
        Sheet::RowMenu(document_id) => {
            let Some(row) = drive.row(document_id) else {
                return none();
            };
            sheet(
                Kind::RowMenu,
                row.title.clone(),
                document_id,
                locale,
                actions(fold::menu(locale, row.starred)),
            )
        }
        Sheet::Move(document_id) => {
            let Some(row) = drive.row(document_id) else {
                return none();
            };
            sheet(
                Kind::Move,
                words::move_title(locale),
                document_id,
                locale,
                choices(folders::move_choices(locale, &rail.folders, &row.folder_id)),
            )
        }
        Sheet::Labels { document_id, draft } => {
            let Some(row) = drive.row(document_id) else {
                return none();
            };
            sheet(
                Kind::Labels,
                words::labels_title(locale),
                document_id,
                locale,
                Body::Labels(fold::labels_sheet(
                    locale,
                    row,
                    &rail.labels,
                    &rail.label_entries,
                    draft,
                )),
            )
        }
        Sheet::NewFolder(name) => {
            let parent = drive.new_item_folder();
            sheet(
                Kind::NewFolder,
                words::new_folder_title(locale),
                "",
                locale,
                Body::NewFolder(wire::DocsNewFolderSheet {
                    name: name.clone(),
                    placeholder: words::folder_placeholder(locale),
                    create_label: words::create(locale),
                    can_create: !name.trim().is_empty(),
                    where_label: if parent.is_empty() {
                        words::where_top(locale)
                    } else {
                        format!(
                            "{} {}",
                            words::where_in(locale),
                            if drive.folder_name.is_empty() {
                                words::band_browse(locale)
                            } else {
                                drive.folder_name.clone()
                            }
                        )
                    },
                }),
            )
        }
    }
}

/// The Add sheet: what the OS lets the shell offer (law 4), and a folder.
fn add_rows(drive: &Drive, locale: Locale) -> Vec<wire::DocsAction> {
    use wire::DocsPermission as P;
    let gated = |key: &str,
                 label: String,
                 icon: &str,
                 permission: P,
                 denied: String,
                 restricted: String| {
        match permission {
            P::Unavailable => None,
            P::Denied => Some(wire::DocsAction {
                enabled: false,
                detail: denied,
                ..fold::action(key, label, icon)
            }),
            P::Restricted => Some(wire::DocsAction {
                enabled: false,
                detail: restricted,
                ..fold::action(key, label, icon)
            }),
            _ => Some(fold::action(key, label, icon)),
        }
    };
    [
        gated(
            KEY_UPLOAD,
            words::add_upload(locale),
            "Upload",
            drive.files,
            words::files_denied(locale),
            words::files_restricted(locale),
        ),
        Some(fold::action(
            KEY_FOLLOW_FOLDER,
            words::add_follow(locale),
            "Folder",
        )),
        gated(
            KEY_SCAN,
            words::add_scan(locale),
            "Camera",
            drive.camera,
            words::camera_denied(locale),
            words::camera_restricted(locale),
        ),
        Some(fold::action(KEY_TEXT, words::add_text(locale), "FileText")),
        Some(fold::action(
            KEY_NEW_FOLDER,
            words::add_folder(locale),
            "FolderPlus",
        )),
    ]
    .into_iter()
    .flatten()
    .collect()
}
