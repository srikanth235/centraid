//! Constructors for room protocol blocks. Builders register selector meaning; shells own layout.

use centraid_api_proto::core_v1 as wire;
use wire::room_block::Kind as B;

use super::selector::{Handler, Sel};

#[must_use]
pub fn block(kind: B) -> wire::RoomBlock {
    wire::RoomBlock { kind: Some(kind) }
}

#[must_use]
pub fn glyph(icon: &str, hue_key: &str) -> wire::RoomGlyph {
    wire::RoomGlyph {
        icon: icon.to_owned(),
        hue_key: hue_key.to_owned(),
    }
}

#[must_use]
pub fn glyph_mark(icon: &str, hue_key: &str) -> wire::RoomMark {
    wire::RoomMark {
        kind: Some(wire::room_mark::Kind::Glyph(glyph(icon, hue_key))),
    }
}

#[must_use]
pub fn thumb_mark(reference: &str, alt: &str, hue_key: &str) -> wire::RoomMark {
    wire::RoomMark {
        kind: Some(wire::room_mark::Kind::Thumb(wire::RoomThumb {
            r#ref: reference.to_owned(),
            alt: alt.to_owned(),
            hue_key: hue_key.to_owned(),
        })),
    }
}

/// A check mark whose tap is `id`.
pub fn check_mark(
    sel: &mut Sel,
    id: &str,
    state: wire::RoomCheckState,
    handler: Handler,
) -> wire::RoomMark {
    wire::RoomMark {
        kind: Some(wire::room_mark::Kind::Check(wire::RoomCheck {
            selector_id: sel.on(id, handler),
            state: state as i32,
        })),
    }
}

#[must_use]
pub fn chip(label: &str, tone: wire::RoomTone) -> wire::RoomChip {
    wire::RoomChip {
        label: label.to_owned(),
        tone: tone as i32,
        remove_selector_id: String::new(),
    }
}

/// A chip the member can remove: a typed date that became a chip.
pub fn removable_chip(sel: &mut Sel, id: &str, label: &str, handler: Handler) -> wire::RoomChip {
    wire::RoomChip {
        label: label.to_owned(),
        tone: wire::RoomTone::Neutral as i32,
        remove_selector_id: sel.on(id, handler),
    }
}

pub fn action(
    sel: &mut Sel,
    id: &str,
    label: &str,
    icon: &str,
    handler: Handler,
) -> wire::RoomAction {
    wire::RoomAction {
        selector_id: sel.on(id, handler),
        label: label.to_owned(),
        icon: icon.to_owned(),
        enabled: true,
        destructive: false,
    }
}

pub fn destructive(
    sel: &mut Sel,
    id: &str,
    label: &str,
    icon: &str,
    handler: Handler,
) -> wire::RoomAction {
    wire::RoomAction {
        destructive: true,
        ..action(sel, id, label, icon, handler)
    }
}

pub fn menu_item(sel: &mut Sel, id: &str, label: &str, handler: Handler) -> wire::RoomMenuItem {
    wire::RoomMenuItem {
        selector_id: sel.on(id, handler),
        label: label.to_owned(),
        enabled: true,
        ..wire::RoomMenuItem::default()
    }
}

#[must_use]
pub fn submenu(label: &str, items: Vec<wire::RoomMenuItem>) -> wire::RoomMenuItem {
    wire::RoomMenuItem {
        label: label.to_owned(),
        enabled: true,
        submenu: items,
        ..wire::RoomMenuItem::default()
    }
}

#[must_use]
pub fn menu_section(heading: &str, items: Vec<wire::RoomMenuItem>) -> wire::RoomMenuSection {
    wire::RoomMenuSection {
        heading: heading.to_owned(),
        items,
    }
}

/// A menu addressed as `id` (the control that opens it). `sel` comes last so the items inside
/// can be built in the same expression.
pub fn menu(id: &str, sections: Vec<wire::RoomMenuSection>, sel: &mut Sel) -> wire::RoomMenu {
    wire::RoomMenu {
        selector_id: sel.anchor(id),
        sections,
    }
}

#[must_use]
pub fn menu_block(menu: wire::RoomMenu) -> wire::RoomBlock {
    block(B::Menu(menu))
}

pub struct Hero(wire::RoomHero);

#[must_use]
pub fn hero(title: &str) -> Hero {
    Hero(wire::RoomHero {
        title: title.to_owned(),
        ..wire::RoomHero::default()
    })
}

impl Hero {
    #[must_use]
    pub fn noun(mut self, noun: &str) -> Self {
        self.0.noun = noun.to_owned();
        self
    }

    #[must_use]
    pub fn mark(mut self, mark: wire::RoomMark) -> Self {
        self.0.mark = Some(mark);
        self
    }

    #[must_use]
    pub fn line(mut self, line: &str) -> Self {
        self.0.lines.push(line.to_owned());
        self
    }

    #[must_use]
    pub fn chip(mut self, chip: wire::RoomChip) -> Self {
        self.0.chips.push(chip);
        self
    }

    #[must_use]
    pub fn primary(mut self, action: wire::RoomAction) -> Self {
        self.0.primary = Some(action);
        self
    }

    #[must_use]
    pub fn menu(mut self, menu: wire::RoomMenu) -> Self {
        self.0.menu = Some(menu);
        self
    }

    #[must_use]
    pub fn block(self) -> wire::RoomBlock {
        block(B::Hero(self.0))
    }
}

pub struct Section(wire::RoomSection);

pub fn section(sel: &mut Sel, id: &str, heading: &str) -> Section {
    Section(wire::RoomSection {
        selector_id: sel.anchor(id),
        heading: heading.to_owned(),
        ..wire::RoomSection::default()
    })
}

impl Section {
    #[must_use]
    pub fn count_label(mut self, label: &str) -> Self {
        self.0.count_label = label.to_owned();
        self
    }

    #[must_use]
    pub fn trailing(mut self, action: wire::RoomAction) -> Self {
        self.0.trailing = Some(action);
        self
    }

    #[must_use]
    pub fn block(mut self, block: wire::RoomBlock) -> Self {
        self.0.blocks.push(block);
        self
    }

    #[must_use]
    pub fn blocks(mut self, blocks: impl IntoIterator<Item = wire::RoomBlock>) -> Self {
        self.0.blocks.extend(blocks);
        self
    }

    /// More rows follow: the shell sends a tap on this selector when the last row scrolls into view.
    #[must_use]
    pub fn next_page(mut self, sel: &mut Sel, id: &str) -> Self {
        self.0.next_page_selector_id = sel.on(id, Handler::NextPage(self.0.selector_id.clone()));
        self
    }

    #[must_use]
    pub fn into_block(self) -> wire::RoomBlock {
        block(B::Section(self.0))
    }
}

pub struct Row(wire::RoomRow);

/// A row whose tap is `id`.
pub fn row(sel: &mut Sel, id: &str, title: &str, handler: Handler) -> Row {
    Row(wire::RoomRow {
        selector_id: sel.on(id, handler),
        title: title.to_owned(),
        ..wire::RoomRow::default()
    })
}

/// A row nothing taps (a finished fact in a list).
pub fn still_row(sel: &mut Sel, id: &str, title: &str) -> Row {
    Row(wire::RoomRow {
        selector_id: sel.anchor(id),
        title: title.to_owned(),
        ..wire::RoomRow::default()
    })
}

impl Row {
    #[must_use]
    pub fn meta(mut self, meta: &str) -> Self {
        self.0.meta = meta.to_owned();
        self
    }

    #[must_use]
    pub fn trailing(mut self, text: &str, tone: wire::RoomTone) -> Self {
        self.0.trailing = text.to_owned();
        self.0.trailing_tone = tone as i32;
        self
    }

    #[must_use]
    pub fn chip(mut self, chip: wire::RoomChip) -> Self {
        self.0.chips.push(chip);
        self
    }

    #[must_use]
    pub fn mark(mut self, mark: wire::RoomMark) -> Self {
        self.0.mark = Some(mark);
        self
    }

    #[must_use]
    pub fn a11y(mut self, label: &str) -> Self {
        self.0.a11y_label = label.to_owned();
        self
    }

    #[must_use]
    pub fn dimmed(mut self) -> Self {
        self.0.dimmed = true;
        self
    }

    #[must_use]
    pub fn pending(mut self) -> Self {
        self.0.pending = true;
        self
    }

    #[must_use]
    pub fn selected(mut self, on: bool) -> Self {
        self.0.selected = on;
        self
    }

    #[must_use]
    pub fn menu(mut self, menu: wire::RoomMenu) -> Self {
        self.0.menu = Some(menu);
        self
    }

    /// The trailing swipe: move to trash with no confirm.
    #[must_use]
    pub fn swipe(mut self, sel: &mut Sel, id: &str, label: &str, handler: Handler) -> Self {
        self.0.swipe = Some(wire::RoomSwipe {
            selector_id: sel.on(id, handler),
            label: label.to_owned(),
        });
        self
    }

    #[must_use]
    pub fn build(self) -> wire::RoomRow {
        self.0
    }

    #[must_use]
    pub fn into_block(self) -> wire::RoomBlock {
        block(B::Row(self.0))
    }
}

#[must_use]
pub fn fact(label: &str, value: &str, kind: wire::RoomFactKind) -> wire::RoomFact {
    wire::RoomFact {
        label: label.to_owned(),
        value: value.to_owned(),
        kind: kind as i32,
        ..wire::RoomFact::default()
    }
}

/// A fact whose value opens (a link, a phone, an address) and copies.
pub fn fact_actions(
    sel: &mut Sel,
    mut fact: wire::RoomFact,
    id: &str,
    open: Option<Handler>,
    copy: Option<Handler>,
) -> wire::RoomFact {
    if let Some(open) = open {
        fact.open_selector_id = sel.on(format!("{id}/open"), open);
    }
    if let Some(copy) = copy {
        fact.copy_selector_id = sel.on(format!("{id}/copy"), copy);
    }
    fact
}

/// A masked value: `value` stays empty until the member reveals it.
pub fn sealed_fact(sel: &mut Sel, label: &str, id: &str, reveal: Handler) -> wire::RoomFact {
    wire::RoomFact {
        label: label.to_owned(),
        kind: wire::RoomFactKind::Secret as i32,
        sealed: true,
        reveal_selector_id: sel.on(format!("{id}/reveal"), reveal),
        ..wire::RoomFact::default()
    }
}

#[must_use]
pub fn facts(facts: Vec<wire::RoomFact>) -> wire::RoomBlock {
    block(B::Facts(wire::RoomFacts { facts }))
}

#[must_use]
pub fn option(id: &str, label: &str, selected: bool) -> wire::RoomOption {
    wire::RoomOption {
        id: id.to_owned(),
        label: label.to_owned(),
        selected,
    }
}

/// A choice whose change is the room's `tag`.
pub fn choice(
    sel: &mut Sel,
    id: &str,
    label: &str,
    style: wire::RoomChoiceStyle,
    multiple: bool,
    options: Vec<wire::RoomOption>,
    tag: &str,
) -> wire::RoomChoice {
    wire::RoomChoice {
        selector_id: sel.on(id, Handler::Tag(tag.to_owned())),
        label: label.to_owned(),
        style: style as i32,
        multiple,
        options,
    }
}

#[must_use]
pub fn choice_block(choice: wire::RoomChoice) -> wire::RoomBlock {
    block(B::Choice(choice))
}

#[must_use]
pub fn figure(label: &str, value: &str, caption: &str, tone: wire::RoomTone) -> wire::RoomBlock {
    block(B::Figure(wire::RoomFigure {
        label: label.to_owned(),
        value: value.to_owned(),
        caption: caption.to_owned(),
        tone: tone as i32,
        selector_id: String::new(),
    }))
}

#[must_use]
pub fn prose(text: &str) -> wire::RoomBlock {
    block(B::Prose(wire::RoomProse {
        text: text.to_owned(),
        spans: Vec::new(),
    }))
}

/// Prose with link ranges (in chars), each a selector.
pub fn prose_with_links(
    sel: &mut Sel,
    text: &str,
    links: Vec<(u32, u32, &str, Handler)>,
) -> wire::RoomBlock {
    let spans = links
        .into_iter()
        .map(|(start, end, id, handler)| wire::RoomLinkSpan {
            start,
            end,
            selector_id: sel.on(id, handler),
        })
        .collect();
    block(B::Prose(wire::RoomProse {
        text: text.to_owned(),
        spans,
    }))
}

pub fn media(
    sel: &mut Sel,
    id: &str,
    kind: wire::RoomMediaKind,
    thumb: wire::RoomThumb,
    handler: Handler,
) -> wire::RoomMedia {
    wire::RoomMedia {
        selector_id: sel.on(id, handler),
        kind: kind as i32,
        thumb: Some(thumb),
        ..wire::RoomMedia::default()
    }
}

#[must_use]
pub fn media_block(media: wire::RoomMedia) -> wire::RoomBlock {
    block(B::Media(media))
}

#[must_use]
pub fn progress(
    label: &str,
    done: u64,
    total: u64,
    count_label: &str,
    cancel: Option<wire::RoomAction>,
) -> wire::RoomBlock {
    block(B::Progress(wire::RoomProgress {
        label: label.to_owned(),
        done,
        total,
        count_label: count_label.to_owned(),
        cancel,
    }))
}

#[must_use]
pub fn empty(
    glyph: wire::RoomGlyph,
    title: &str,
    body: &str,
    action: Option<wire::RoomAction>,
) -> wire::RoomBlock {
    block(B::Empty(wire::RoomEmpty {
        glyph: Some(glyph),
        title: title.to_owned(),
        body: body.to_owned(),
        action,
    }))
}

#[must_use]
pub fn wall(title: &str, body: &str, unlock: wire::RoomAction, failure: &str) -> wire::RoomBlock {
    block(B::Wall(wire::RoomWall {
        title: title.to_owned(),
        body: body.to_owned(),
        unlock: Some(unlock),
        failure: failure.to_owned(),
    }))
}

pub fn tile(
    sel: &mut Sel,
    id: &str,
    label: &str,
    subtitle: &str,
    glyph: wire::RoomGlyph,
    handler: Handler,
) -> wire::RoomTile {
    wire::RoomTile {
        selector_id: sel.on(id, handler),
        label: label.to_owned(),
        subtitle: subtitle.to_owned(),
        glyph: Some(glyph),
    }
}

#[must_use]
pub fn tiles(tiles: Vec<wire::RoomTile>) -> wire::RoomBlock {
    block(B::Tiles(wire::RoomTiles { tiles }))
}

pub fn glance(
    sel: &mut Sel,
    id: &str,
    title: &str,
    lines: &[&str],
    glyph: wire::RoomGlyph,
    handler: Handler,
) -> wire::RoomBlock {
    block(B::Glance(wire::RoomGlance {
        selector_id: sel.on(id, handler),
        title: title.to_owned(),
        lines: lines.iter().map(|line| (*line).to_owned()).collect(),
        glyph: Some(glyph),
    }))
}

pub fn trash_row(
    sel: &mut Sel,
    id: &str,
    title: &str,
    meta: &str,
    restore: Handler,
    purge: Handler,
) -> wire::RoomTrashRow {
    wire::RoomTrashRow {
        selector_id: sel.anchor(id),
        title: title.to_owned(),
        meta: meta.to_owned(),
        mark: None,
        restore_selector_id: sel.on(format!("{id}/restore"), restore),
        purge_selector_id: sel.on(format!("{id}/purge"), purge),
    }
}

#[must_use]
pub fn trash(
    heading: &str,
    retention: &str,
    rows: Vec<wire::RoomTrashRow>,
    empty_trash: Option<wire::RoomAction>,
) -> wire::RoomTrash {
    wire::RoomTrash {
        heading: heading.to_owned(),
        retention: retention.to_owned(),
        rows,
        empty_trash,
        next_page_selector_id: String::new(),
    }
}

#[must_use]
pub fn trash_block(trash: wire::RoomTrash) -> wire::RoomBlock {
    block(B::Trash(trash))
}

/// What a confirm block says and does.
pub struct Confirm<'a> {
    pub class: wire::RoomConfirmClass,
    pub title: &'a str,
    pub body: &'a str,
    pub warning: &'a str,
    pub confirm_label: &'a str,
    pub confirm: Handler,
    pub cancel_label: &'a str,
    pub cancel: Handler,
}

/// The outlined or owner confirm. `confirm` runs on the confirm key, `cancel` on Cancel.
pub fn confirm(sel: &mut Sel, spec: Confirm<'_>) -> wire::RoomBlock {
    block(B::Confirm(wire::RoomConfirm {
        class: spec.class as i32,
        title: spec.title.to_owned(),
        body: spec.body.to_owned(),
        warning: spec.warning.to_owned(),
        confirm_label: spec.confirm_label.to_owned(),
        confirm_selector_id: sel.on("confirm/yes", spec.confirm),
        cancel_label: spec.cancel_label.to_owned(),
        cancel_selector_id: sel.on("confirm/no", spec.cancel),
    }))
}

#[must_use]
pub fn attachments(
    heading: &str,
    items: Vec<wire::RoomRow>,
    add: Option<wire::RoomMenu>,
) -> wire::RoomBlock {
    block(B::Attachments(wire::RoomAttachments {
        heading: heading.to_owned(),
        items,
        add,
        next_page_selector_id: String::new(),
    }))
}

#[must_use]
pub fn linked(
    heading: &str,
    items: Vec<wire::RoomRow>,
    add: Option<wire::RoomAction>,
) -> wire::RoomBlock {
    block(B::Linked(wire::RoomLinked {
        heading: heading.to_owned(),
        items,
        add,
        next_page_selector_id: String::new(),
    }))
}

#[must_use]
pub fn mentioned_in(heading: &str, items: Vec<wire::RoomRow>) -> wire::RoomBlock {
    block(B::MentionedIn(wire::RoomMentionedIn {
        heading: heading.to_owned(),
        items,
        next_page_selector_id: String::new(),
    }))
}

#[must_use]
pub fn says_field(
    sel: &mut Sel,
    id: &str,
    label: &str,
    stated: &str,
    mine: &str,
    take: Handler,
) -> wire::RoomSaysField {
    wire::RoomSaysField {
        label: label.to_owned(),
        stated: stated.to_owned(),
        mine: mine.to_owned(),
        take_selector_id: sel.on(id, take),
    }
}

#[must_use]
pub fn says(
    source: wire::RoomSaysSource,
    heading: &str,
    fields: Vec<wire::RoomSaysField>,
    take_label: &str,
) -> wire::RoomBlock {
    block(B::Says(wire::RoomSays {
        source: source as i32,
        heading: heading.to_owned(),
        fields,
        take_label: take_label.to_owned(),
    }))
}

pub fn earlier_versions(
    sel: &mut Sel,
    summary: &str,
    count: u32,
    open: Handler,
) -> wire::RoomBlock {
    block(B::EarlierVersions(wire::RoomEarlierVersions {
        summary: summary.to_owned(),
        count,
        selector_id: sel.on("earlier", open),
    }))
}

pub fn origin(sel: &mut Sel, line: &str, open: Option<Handler>) -> wire::RoomBlock {
    block(B::Origin(wire::RoomOrigin {
        line: line.to_owned(),
        selector_id: open
            .map(|handler| sel.on("origin", handler))
            .unwrap_or_default(),
    }))
}

/// The four canvases: a block that owns the room's scrolling area. Its own selector is claimed
/// here and its events are the room's `Tag` for it.
pub fn canvas(sel: &mut Sel, id: &str, tag: &str) -> String {
    sel.on(id, Handler::Tag(tag.to_owned()))
}

#[must_use]
pub fn calendar_grid(grid: wire::RoomCalendarGrid) -> wire::RoomBlock {
    block(B::CalendarGrid(grid))
}

#[must_use]
pub fn photo_grid(grid: wire::RoomPhotoGrid) -> wire::RoomBlock {
    block(B::PhotoGrid(grid))
}

#[must_use]
pub fn note_editor(editor: wire::RoomNoteEditor) -> wire::RoomBlock {
    block(B::NoteEditor(editor))
}

#[must_use]
pub fn chart(chart: wire::RoomChart) -> wire::RoomBlock {
    block(B::Chart(chart))
}
