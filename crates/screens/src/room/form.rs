//! Forms, repeatable rows, and save behavior. Prose autosaves; a
//! structured form has Cancel and Save and one "Discard changes?" confirm when dismissed dirty.
//! Text is the shared text field: its value and `rev` live in [`super::field::Fields`].

use centraid_api_proto::core_v1 as wire;
use wire::room_field::Input as I;

use super::blocks::block;
use super::field::Fields;
use super::selector::{Handler, Sel};

pub struct Field(wire::RoomField);

pub struct TextEntry<'a> {
    pub name: &'a str,
    pub selector: &'a str,
    pub label: &'a str,
    pub kind: wire::RoomTextKind,
    pub initial: &'a str,
    pub max_chars: usize,
}

fn field(sel: &mut Sel, name: &str, label: &str, input: I) -> Field {
    field_with_selector(sel, name, &format!("field/{name}"), label, input)
}

fn field_with_selector(sel: &mut Sel, name: &str, selector: &str, label: &str, input: I) -> Field {
    Field(wire::RoomField {
        selector_id: sel.on(selector, Handler::Field(name.to_owned())),
        label: label.to_owned(),
        input: Some(input),
        ..wire::RoomField::default()
    })
}

/// A text field: `initial` is its value only until the member or Rust changes it.
pub fn text(
    sel: &mut Sel,
    fields: &mut Fields,
    name: &str,
    label: &str,
    kind: wire::RoomTextKind,
    initial: &str,
    max_chars: usize,
) -> Field {
    text_with_selector(
        sel,
        fields,
        TextEntry {
            name,
            selector: &format!("field/{name}"),
            label,
            kind,
            initial,
            max_chars,
        },
    )
}

/// A text field with a caller-chosen shell identity and the usual named zeroizing state.
pub fn text_with_selector(sel: &mut Sel, fields: &mut Fields, entry: TextEntry<'_>) -> Field {
    fields.limit(entry.name, entry.max_chars);
    let state = fields.get_or(entry.name, entry.initial);
    field_with_selector(
        sel,
        entry.name,
        entry.selector,
        entry.label,
        I::Text(wire::RoomText {
            kind: entry.kind as i32,
            value: state.value().to_owned(),
            rev: state.rev(),
            max_chars: u32::try_from(entry.max_chars).unwrap_or(u32::MAX),
            chips: Vec::new(),
        }),
    )
}

pub fn money(
    sel: &mut Sel,
    name: &str,
    label: &str,
    minor: i64,
    currency: &str,
    exponent: u32,
    display: &str,
) -> Field {
    field(
        sel,
        name,
        label,
        I::Money(wire::RoomMoney {
            minor,
            currency: currency.to_owned(),
            exponent,
            display: display.to_owned(),
        }),
    )
}

pub fn moment(sel: &mut Sel, name: &str, label: &str, moment: wire::RoomMoment) -> Field {
    field(sel, name, label, I::Moment(moment))
}

pub fn toggle(sel: &mut Sel, name: &str, label: &str, on: bool) -> Field {
    field(sel, name, label, I::Toggle(wire::RoomToggle { on }))
}

pub fn choice(
    sel: &mut Sel,
    name: &str,
    label: &str,
    style: wire::RoomChoiceStyle,
    options: Vec<wire::RoomOption>,
) -> Field {
    let own = sel.on(
        format!("field/{name}/choice"),
        Handler::Field(name.to_owned()),
    );
    field(
        sel,
        name,
        label,
        I::Choice(wire::RoomChoice {
            selector_id: own,
            label: label.to_owned(),
            style: style as i32,
            multiple: false,
            options,
        }),
    )
}

pub fn item_pick(sel: &mut Sel, name: &str, label: &str, display: &str, noun: &str) -> Field {
    field(
        sel,
        name,
        label,
        I::Item(wire::RoomItemPick {
            display: display.to_owned(),
            noun: noun.to_owned(),
            clear_selector_id: String::new(),
        }),
    )
}

pub fn file_pick(sel: &mut Sel, name: &str, label: &str, display: &str) -> Field {
    field(
        sel,
        name,
        label,
        I::File(wire::RoomFilePick {
            display: display.to_owned(),
            clear_selector_id: String::new(),
        }),
    )
}

/// A secret value, masked until `reveal` is taken. An unsealed value never reaches a draft.
pub fn secret(sel: &mut Sel, name: &str, label: &str, masked: bool, value: &str) -> Field {
    let reveal = sel.on(
        format!("field/{name}/reveal"),
        Handler::Tag(format!("reveal:{name}")),
    );
    field(
        sel,
        name,
        label,
        I::Secret(wire::RoomSecret {
            masked,
            value: if masked {
                String::new()
            } else {
                value.to_owned()
            },
            reveal_selector_id: reveal,
        }),
    )
}

/// A write-only secret entry. The value lives in the room's zeroizing form state, while the
/// protocol block stays masked and empty so shells never receive or echo the typed secret.
pub fn secret_entry(
    sel: &mut Sel,
    fields: &mut Fields,
    name: &str,
    selector: &str,
    label: &str,
) -> Field {
    // RoomSecret has no length/revision fields for the shell to adopt a corrected value from.
    // Keep committed keystrokes intact and let the owning form validate its save limit.
    fields.limit(name, 0);
    fields.get_or(name, "");
    field_with_selector(
        sel,
        name,
        selector,
        label,
        I::Secret(wire::RoomSecret {
            masked: true,
            value: String::new(),
            reveal_selector_id: String::new(),
        }),
    )
}

impl Field {
    #[must_use]
    pub fn hint(mut self, hint: &str) -> Self {
        self.0.hint = hint.to_owned();
        self
    }

    #[must_use]
    pub fn error(mut self, error: &str) -> Self {
        self.0.error = error.to_owned();
        self
    }

    #[must_use]
    pub fn required(mut self) -> Self {
        self.0.required = true;
        self
    }

    /// Takes focus when the room appears.
    #[must_use]
    pub fn focused(mut self) -> Self {
        self.0.focused = true;
        self
    }

    #[must_use]
    pub fn chip(mut self, chip: wire::RoomChip) -> Self {
        if let Some(I::Text(text)) = &mut self.0.input {
            text.chips.push(chip);
        }
        self
    }

    /// Clear control of an item or file pick.
    #[must_use]
    pub fn clearable(mut self, sel: &mut Sel, name: &str) -> Self {
        let id = sel.on(
            format!("field/{name}/clear"),
            Handler::Tag(format!("clear:{name}")),
        );
        match &mut self.0.input {
            Some(I::Item(pick)) => pick.clear_selector_id = id,
            Some(I::File(pick)) => pick.clear_selector_id = id,
            _ => {}
        }
        self
    }

    #[must_use]
    pub fn build(self) -> wire::RoomField {
        self.0
    }
}

/// One row of a repeat: its fields and its remove control.
pub fn group(
    id: &str,
    fields: Vec<wire::RoomField>,
    remove: Handler,
    sel: &mut Sel,
) -> wire::RoomFieldGroup {
    wire::RoomFieldGroup {
        selector_id: sel.anchor(id),
        fields,
        remove_selector_id: sel.on(format!("{id}/remove"), remove),
    }
}

pub fn repeat(
    sel: &mut Sel,
    id: &str,
    label: &str,
    rows: Vec<wire::RoomFieldGroup>,
    add_label: &str,
    add: Handler,
) -> wire::RoomRepeat {
    wire::RoomRepeat {
        selector_id: sel.anchor(id),
        label: label.to_owned(),
        rows,
        add: Some(super::blocks::action(
            sel,
            &format!("{id}/add"),
            add_label,
            "plus",
            add,
        )),
    }
}

#[must_use]
pub fn autosave(phase: wire::RoomAutosavePhase, label: &str) -> wire::RoomAutosave {
    wire::RoomAutosave {
        phase: phase as i32,
        label: label.to_owned(),
        refused: phase == wire::RoomAutosavePhase::Refused,
        ..wire::RoomAutosave::default()
    }
}

/// A stale save: the vault's sentence and a reload, and the words stay.
pub fn conflict(
    sel: &mut Sel,
    label: &str,
    reload_label: &str,
    reload: Handler,
) -> wire::RoomAutosave {
    wire::RoomAutosave {
        phase: wire::RoomAutosavePhase::Conflict as i32,
        label: label.to_owned(),
        refused: true,
        reload_label: reload_label.to_owned(),
        reload_selector_id: sel.on("autosave/reload", reload),
    }
}

/// What a structured form's Cancel and Save say and do.
pub struct Explicit<'a> {
    pub save_label: &'a str,
    pub save: Handler,
    pub cancel_label: &'a str,
    pub cancel: Handler,
    pub save_enabled: bool,
    pub dirty: bool,
    pub drafted: bool,
}

/// Cancel and Save.
pub fn explicit(sel: &mut Sel, spec: Explicit<'_>) -> wire::RoomExplicitSave {
    wire::RoomExplicitSave {
        save_label: spec.save_label.to_owned(),
        save_selector_id: sel.on("form/save", spec.save),
        cancel_label: spec.cancel_label.to_owned(),
        cancel_selector_id: sel.on("form/cancel", spec.cancel),
        save_enabled: spec.save_enabled,
        dirty: spec.dirty,
        drafted: spec.drafted,
    }
}

pub enum Save {
    Autosave(wire::RoomAutosave),
    Explicit(wire::RoomExplicitSave),
}

#[must_use]
pub fn form(
    fields: Vec<wire::RoomField>,
    repeats: Vec<wire::RoomRepeat>,
    save: Save,
) -> wire::RoomBlock {
    block(wire::room_block::Kind::Form(wire::RoomForm {
        fields,
        repeats,
        save: Some(match save {
            Save::Autosave(save) => wire::room_form::Save::Autosave(save),
            Save::Explicit(save) => wire::room_form::Save::Explicit(save),
        }),
    }))
}
