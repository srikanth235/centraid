//! THE ACTION TABLE: every vault command a member or the assistant intends, as an action
//! (app-plane section 4). Each row's input is the vault command's own, typed; the registry test
//! holds each field to the command's schema and each row to the rules of the catalogue.

use crate::action::{ActionDecl, Handoff, Scope, Ty, act, mint, mint_req, opt, req};

pub const ACTIONS: &[ActionDecl] = &[
    act(
        "account",
        "add",
        "account.add",
        &[
            opt("currency", Ty::Text),
            opt("external_ref", Ty::Text),
            mint("id"),
            opt("on_budget", Ty::Bool),
            opt("opening_minor", Ty::Int),
            opt("opening_on", Ty::Text),
            req("title", Ty::Text),
            req("type", Ty::Text),
        ],
    )
    .pair("entity.trash")
    .say("create", &["account"])
    .names(&[("title", &["name"]), ("type", &["type"])]),
    act(
        "account",
        "edit",
        "account.edit",
        &[
            opt("currency", Ty::Text),
            opt("expected_rev", Ty::Int),
            opt("external_ref", Ty::Text),
            req("id", Ty::Text),
            opt("on_budget", Ty::Bool),
            opt("title", Ty::Text),
            opt("type", Ty::Text),
        ],
    )
    .say("edit", &["account"])
    .names(&[("title", &["name"])]),
    act(
        "account",
        "edit",
        "account.edit",
        &[
            opt("currency", Ty::Text),
            opt("expected_rev", Ty::Int),
            opt("external_ref", Ty::Text),
            req("id", Ty::Text),
            opt("on_budget", Ty::Bool),
            opt("title", Ty::Text),
            opt("type", Ty::Text),
        ],
    )
    .q("currency")
    .pair("account.edit/currency")
    .outlined()
    .hand(Handoff::Destructive),
    act(
        "account",
        "set_opening",
        "account.set_opening",
        &[
            req("id", Ty::Text),
            req("opening_minor", Ty::Int),
            opt("opening_on", Ty::Text),
        ],
    )
    .say_q("edit", &["account"], "opening"),
    act(
        "budget",
        "set",
        "budget.set",
        &[
            req("amount_minor", Ty::Int),
            opt("carry", Ty::Bool),
            req("category_id", Ty::Text),
            req("month", Ty::Text),
        ],
    )
    .pair("budget.set")
    .say("edit", &["budget"]),
    act(
        "budget",
        "set_carry",
        "budget.set_carry",
        &[
            req("carry", Ty::Bool),
            req("category_id", Ty::Text),
            req("month", Ty::Text),
        ],
    )
    .pair("budget.set_carry")
    .say_q("edit", &["budget"], "carry"),
    act(
        "category",
        "add",
        "category.add",
        &[
            mint("id"),
            opt("parent_id", Ty::Text),
            req("title", Ty::Text),
        ],
    )
    .pair("entity.purge")
    .say("create", &["category"])
    .names(&[("title", &["name"])]),
    act(
        "checkpoint",
        "record",
        "checkpoint.record",
        &[
            req("account_id", Ty::Text),
            req("balance_minor", Ty::Int),
            req("day", Ty::Text),
        ],
    )
    .here(&[Scope::Account])
    .pair("checkpoint.record")
    .say("log", &["account"]),
    act(
        "rule",
        "add",
        "rule.add",
        &[
            opt("account_id", Ty::Text),
            req("category_id", Ty::Text),
            opt("display_name", Ty::Text),
            mint("id"),
            req("match", Ty::OneOf(&["is", "contains", "matches"])),
            opt("max", Ty::Int),
            opt("min", Ty::Int),
            opt("position", Ty::Num),
            req("text", Ty::Text),
        ],
    )
    .here(&[Scope::Account])
    .pair("rule.delete")
    .say("create", &["rule"])
    .names(&[
        ("category_id", &["category"]),
        ("match", &["match"]),
        ("text", &["name"]),
    ]),
    act(
        "rule",
        "edit",
        "rule.edit",
        &[
            opt("account_id", Ty::Text),
            opt("category_id", Ty::Text),
            opt("display_name", Ty::Text),
            req("id", Ty::Text),
            opt("match", Ty::OneOf(&["is", "contains", "matches"])),
            opt("max", Ty::Int),
            opt("min", Ty::Int),
            opt("position", Ty::Num),
            opt("text", Ty::Text),
        ],
    )
    .pair("rule.edit")
    .say("edit", &["rule"]),
    act("rule", "delete", "rule.delete", &[req("id", Ty::Text)])
        .pair("rule.add")
        .say("delete", &["rule"]),
    act(
        "rule",
        "apply",
        "rule.apply",
        &[opt("id", Ty::Text), opt("overwrite", Ty::Bool)],
    )
    .hand(Handoff::Open),
    act(
        "txn",
        "add",
        "txn.add",
        &[
            req("account_id", Ty::Text),
            req("amount_minor", Ty::Int),
            opt("arrived_label", Ty::Text),
            opt("arrived_via", Ty::OneOf(&["csv"])),
            opt("category_id", Ty::Text),
            mint("id"),
            opt("memo", Ty::Text),
            opt("original_amount_minor", Ty::Int),
            opt("original_currency", Ty::Text),
            req("posted_on", Ty::Text),
            opt("splits", Ty::List),
            opt("status", Ty::OneOf(&["pending", "posted"])),
            opt("title", Ty::Text),
        ],
    )
    .here(&[Scope::Account, Scope::Day, Scope::Person])
    .with(&["edge.add"])
    .pair("entity.trash")
    .say("create", &["transaction"])
    .names(&[
        ("account_id", &["account"]),
        ("amount_minor", &["amount"]),
        ("category_id", &["category"]),
        ("posted_on", &["date"]),
        ("title", &["name"]),
    ]),
    act(
        "txn",
        "add",
        "txn.add",
        &[
            req("account_id", Ty::Text),
            req("amount_minor", Ty::Int),
            opt("arrived_label", Ty::Text),
            opt("arrived_via", Ty::OneOf(&["csv"])),
            opt("category_id", Ty::Text),
            mint("id"),
            opt("memo", Ty::Text),
            opt("original_amount_minor", Ty::Int),
            opt("original_currency", Ty::Text),
            req("posted_on", Ty::Text),
            opt("splits", Ty::List),
            opt("status", Ty::OneOf(&["pending", "posted"])),
            opt("title", Ty::Text),
        ],
    )
    .q("csv")
    .here(&[Scope::Account])
    .pair("entity.trash")
    .hand(Handoff::PickFile),
    act(
        "txn",
        "edit",
        "txn.edit",
        &[
            opt("account_id", Ty::Text),
            opt("amount_minor", Ty::Int),
            opt("expected_rev", Ty::Int),
            req("id", Ty::Text),
            opt("memo", Ty::Text),
            opt("original_amount_minor", Ty::Int),
            opt("original_currency", Ty::Text),
            opt("posted_on", Ty::Text),
            opt("splits", Ty::List),
            opt("status", Ty::OneOf(&["pending", "posted"])),
        ],
    )
    .say("edit", &["transaction"]),
    act(
        "txn",
        "categorize",
        "txn.categorize",
        &[
            req("category_id", Ty::Text),
            opt("expected_rev", Ty::Int),
            req("ids", Ty::List),
        ],
    )
    .set()
    .say("categorize", &["transaction"])
    .names(&[("category_id", &["category"])]),
    act(
        "txn",
        "split",
        "txn.split",
        &[
            opt("expected_rev", Ty::Int),
            req("id", Ty::Text),
            req("parts", Ty::List),
        ],
    )
    .say_q("edit", &["transaction"], "split"),
    act(
        "txn",
        "link_transfer",
        "txn.link_transfer",
        &[req("id", Ty::Text), req("other_id", Ty::Text)],
    )
    .pair("txn.unlink_transfer")
    .hand(Handoff::Open),
    act(
        "txn",
        "unlink_transfer",
        "txn.unlink_transfer",
        &[req("id", Ty::Text)],
    )
    .pair("txn.link_transfer")
    .say_q("unlink", &["transaction"], "transfer"),
    act(
        "txn",
        "confirm_match",
        "txn.confirm_match",
        &[req("hand_id", Ty::Text), req("statement_id", Ty::Text)],
    )
    .hand(Handoff::Open),
    act(
        "txn",
        "dismiss_match",
        "txn.dismiss_match",
        &[req("hand_id", Ty::Text), req("statement_id", Ty::Text)],
    )
    .hand(Handoff::Open),
    act(
        "txn",
        "export_csv",
        "txn.export_csv",
        &[opt("account_id", Ty::Text), opt("transaction_id", Ty::Text)],
    )
    .irreversible()
    .owner()
    .hand(Handoff::OwnerCheck),
    act(
        "container",
        "create",
        "container.create",
        &[
            opt("color", Ty::Text),
            opt("icon", Ty::Text),
            mint("id"),
            req(
                "kind",
                Ty::OneOf(&[
                    "notebook",
                    "folder",
                    "album",
                    "list",
                    "task_list",
                    "calendar",
                ]),
            ),
            opt("parent", Ty::Text),
            opt("position", Ty::Num),
            req("title", Ty::Text),
        ],
    )
    .here(&[Scope::Home])
    .pair("entity.trash")
    .say("create", &["folder", "notebook", "album", "list"])
    .names(&[("parent", &["area", "parent"]), ("title", &["name"])]),
    act(
        "container",
        "move",
        "container.move",
        &[
            req("id", Ty::Text),
            opt("parent", Ty::Text),
            opt("position", Ty::Num),
        ],
    )
    .say_q("edit", &["folder", "notebook", "album", "list"], "position"),
    act(
        "container",
        "style",
        "container.style",
        &[
            opt("color", Ty::Text),
            opt("icon", Ty::Text),
            req("id", Ty::Text),
        ],
    )
    .say_q("edit", &["folder", "notebook", "album", "list"], "color"),
    act(
        "album",
        "set_cover",
        "album.set_cover",
        &[req("id", Ty::Text), opt("photo_id", Ty::Text)],
    )
    .say_q("edit", &["album"], "cover"),
    act(
        "entity",
        "trash",
        "entity.trash",
        &[opt("id", Ty::Text), opt("ids", Ty::List)],
    )
    .set()
    .pair("entity.restore")
    .say(
        "delete",
        &[
            "event",
            "document",
            "workout",
            "locker_item",
            "transaction",
            "note",
            "photo",
            "task",
            "person",
            "folder",
            "notebook",
            "album",
            "list",
            "account",
        ],
    ),
    act(
        "entity",
        "restore",
        "entity.restore",
        &[opt("id", Ty::Text), opt("ids", Ty::List)],
    )
    .set()
    .pair("entity.trash")
    .say(
        "restore",
        &[
            "event",
            "document",
            "workout",
            "locker_item",
            "transaction",
            "note",
            "photo",
            "task",
            "person",
            "folder",
            "notebook",
            "album",
            "list",
            "account",
        ],
    ),
    act(
        "entity",
        "move",
        "entity.move",
        &[
            opt("id", Ty::Text),
            opt("ids", Ty::List),
            opt("parent", Ty::Text),
        ],
    )
    .set()
    .say_q(
        "edit",
        &["note", "document", "task", "person", "folder", "notebook"],
        "move",
    ),
    act(
        "entity",
        "retitle",
        "entity.retitle",
        &[
            opt("expected_rev", Ty::Int),
            req("id", Ty::Text),
            req("title", Ty::Text),
        ],
    )
    .say_q(
        "edit",
        &[
            "event",
            "document",
            "workout",
            "locker_item",
            "transaction",
            "note",
            "photo",
            "task",
            "person",
            "folder",
            "notebook",
            "album",
            "list",
            "account",
        ],
        "title",
    )
    .names(&[("title", &["name"])]),
    act("entity", "purge", "entity.purge", &[req("id", Ty::Text)])
        .irreversible()
        .outlined()
        .hand(Handoff::Destructive),
    act(
        "entity",
        "empty_trash",
        "entity.empty_trash",
        &[
            opt("defer_collect", Ty::Bool),
            opt("due_only", Ty::Bool),
            opt("kind", Ty::Text),
            opt("limit", Ty::Int),
            opt("with_kind", Ty::Text),
        ],
    )
    .irreversible()
    .outlined()
    .hand(Handoff::Destructive),
    act(
        "flag",
        "set",
        "flag.set",
        &[
            req("flag", Ty::OneOf(&["starred", "pinned", "archived"])),
            opt("id", Ty::Text),
            opt("ids", Ty::List),
        ],
    )
    .q("starred")
    .set()
    .pair("flag.clear/starred")
    .say(
        "star",
        &["document", "locker_item", "note", "person", "photo", "task"],
    )
    .fixed(&[("flag", "\"starred\"")]),
    act(
        "flag",
        "set",
        "flag.set",
        &[
            req("flag", Ty::OneOf(&["starred", "pinned", "archived"])),
            opt("id", Ty::Text),
            opt("ids", Ty::List),
        ],
    )
    .q("pinned")
    .set()
    .pair("flag.clear/pinned")
    .say_q("edit", &["note"], "pinned")
    .fixed(&[("flag", "\"pinned\"")]),
    act(
        "flag",
        "set",
        "flag.set",
        &[
            req("flag", Ty::OneOf(&["starred", "pinned", "archived"])),
            opt("id", Ty::Text),
            opt("ids", Ty::List),
        ],
    )
    .q("archived")
    .set()
    .pair("flag.clear/archived")
    .say("archive", &["locker_item", "account", "category", "photo"])
    .fixed(&[("flag", "\"archived\"")]),
    act(
        "flag",
        "clear",
        "flag.clear",
        &[
            req("flag", Ty::OneOf(&["starred", "pinned", "archived"])),
            opt("id", Ty::Text),
            opt("ids", Ty::List),
        ],
    )
    .q("starred")
    .set()
    .pair("flag.set/starred")
    .say(
        "unstar",
        &["document", "locker_item", "note", "person", "photo", "task"],
    )
    .fixed(&[("flag", "\"starred\"")]),
    act(
        "flag",
        "clear",
        "flag.clear",
        &[
            req("flag", Ty::OneOf(&["starred", "pinned", "archived"])),
            opt("id", Ty::Text),
            opt("ids", Ty::List),
        ],
    )
    .q("pinned")
    .set()
    .pair("flag.set/pinned")
    .say_q("edit", &["note"], "unpinned")
    .fixed(&[("flag", "\"pinned\"")]),
    act(
        "flag",
        "clear",
        "flag.clear",
        &[
            req("flag", Ty::OneOf(&["starred", "pinned", "archived"])),
            opt("id", Ty::Text),
            opt("ids", Ty::List),
        ],
    )
    .q("archived")
    .set()
    .pair("flag.set/archived")
    .say(
        "unarchive",
        &["locker_item", "account", "category", "photo"],
    )
    .fixed(&[("flag", "\"archived\"")]),
    act(
        "tag",
        "add",
        "tag.add",
        &[
            opt(
                "color",
                Ty::OneOf(&[
                    "blue",
                    "mustard",
                    "violet",
                    "petrol",
                    "indigo",
                    "graphite",
                    "raspberry",
                    "orchid",
                ]),
            ),
            opt("id", Ty::Text),
            opt("ids", Ty::List),
            req("label", Ty::Text),
        ],
    )
    .set()
    .pair("tag.remove")
    .say("tag", &["document", "locker_item", "note", "photo", "task"])
    .names(&[("label", &["label"])]),
    act(
        "tag",
        "remove",
        "tag.remove",
        &[
            opt("id", Ty::Text),
            opt("ids", Ty::List),
            req("label", Ty::Text),
        ],
    )
    .set()
    .pair("tag.add")
    .say(
        "untag",
        &["document", "locker_item", "note", "photo", "task"],
    )
    .names(&[("label", &["label"])]),
    act(
        "tag",
        "color",
        "tag.color",
        &[
            req(
                "color",
                Ty::OneOf(&[
                    "blue",
                    "mustard",
                    "violet",
                    "petrol",
                    "indigo",
                    "graphite",
                    "raspberry",
                    "orchid",
                ]),
            ),
            req("label", Ty::Text),
        ],
    )
    .say_q("edit", &["document"], "label_color"),
    act(
        "edge",
        "add",
        "edge.add",
        &[
            opt("anchor", Ty::Object),
            req("from", Ty::Text),
            opt("label", Ty::Text),
            opt("position", Ty::Num),
            req(
                "rel",
                Ty::OneOf(&[
                    "contains", "tagged", "about", "attached", "with", "related", "depicts",
                ]),
            ),
            req("to", Ty::Text),
        ],
    )
    .pair("edge.remove")
    .hand(Handoff::Open),
    act(
        "edge",
        "add",
        "edge.add",
        &[
            opt("anchor", Ty::Object),
            req("from", Ty::Text),
            opt("label", Ty::Text),
            opt("position", Ty::Num),
            req(
                "rel",
                Ty::OneOf(&[
                    "contains", "tagged", "about", "attached", "with", "related", "depicts",
                ]),
            ),
            req("to", Ty::Text),
        ],
    )
    .q("contains")
    .pair("edge.remove/contains")
    .say("add_to", &["photo"])
    .names(&[("from", &["to"])])
    .fixed(&[("rel", "\"contains\"")]),
    act(
        "edge",
        "remove",
        "edge.remove",
        &[
            req("from", Ty::Text),
            opt("label", Ty::Text),
            req(
                "rel",
                Ty::OneOf(&[
                    "contains", "tagged", "about", "attached", "with", "related", "depicts",
                ]),
            ),
            req("to", Ty::Text),
        ],
    )
    .pair("edge.add")
    .hand(Handoff::Open),
    act(
        "edge",
        "remove",
        "edge.remove",
        &[
            req("from", Ty::Text),
            opt("label", Ty::Text),
            req(
                "rel",
                Ty::OneOf(&[
                    "contains", "tagged", "about", "attached", "with", "related", "depicts",
                ]),
            ),
            req("to", Ty::Text),
        ],
    )
    .q("contains")
    .pair("edge.add/contains")
    .say("remove_from", &["photo"])
    .names(&[("from", &["from"])])
    .fixed(&[("rel", "\"contains\"")]),
    act(
        "edge",
        "move",
        "edge.move",
        &[
            req("from", Ty::Text),
            req("position", Ty::Num),
            req("to", Ty::Text),
        ],
    )
    .pair("edge.move")
    .hand(Handoff::Open),
    act(
        "link",
        "add",
        "link.add",
        &[req("a", Ty::Text), req("b", Ty::Text)],
    )
    .pair("link.remove")
    .say(
        "link",
        &[
            "event",
            "document",
            "workout",
            "locker_item",
            "transaction",
            "note",
            "photo",
            "task",
            "person",
        ],
    ),
    act(
        "link",
        "remove",
        "link.remove",
        &[req("a", Ty::Text), req("b", Ty::Text)],
    )
    .pair("link.add")
    .say(
        "unlink",
        &[
            "event",
            "document",
            "workout",
            "locker_item",
            "transaction",
            "note",
            "photo",
            "task",
            "person",
        ],
    ),
    act(
        "concept",
        "merge",
        "concept.merge",
        &[req("from", Ty::Text), req("into", Ty::Text)],
    )
    .irreversible()
    .outlined()
    .hand(Handoff::Destructive),
    act(
        "history",
        "keep_version",
        "history.keep_version",
        &[req("fields", Ty::Object), req("id", Ty::Text)],
    )
    .hand(Handoff::Open),
    act(
        "history",
        "restore_version",
        "history.restore_version",
        &[req("id", Ty::Text), req("seq", Ty::Int)],
    )
    .hand(Handoff::Open),
    act("vault", "rename", "vault.rename", &[req("name", Ty::Text)])
        .pair("vault.rename")
        .hand(Handoff::Open),
    act("vault", "export_all", "vault.export_all", &[])
        .irreversible()
        .owner()
        .hand(Handoff::OwnerCheck),
    act(
        "event",
        "propose",
        "event.propose",
        &[
            opt("arrived_label", Ty::Text),
            opt(
                "arrived_via",
                Ty::OneOf(&[
                    "picker", "vcard", "markdown", "csv", "scan", "upload", "share", "ics",
                ]),
            ),
            opt("busy", Ty::Bool),
            opt("calendar_id", Ty::Text),
            opt("description", Ty::Text),
            opt("ends", Ty::Text),
            opt("guests", Ty::List),
            mint("id"),
            opt("location", Ty::Text),
            opt("place_id", Ty::Text),
            opt("reminders", Ty::List),
            opt("rule", Ty::Text),
            req("starts", Ty::Text),
            opt(
                "status",
                Ty::OneOf(&["confirmed", "tentative", "cancelled"]),
            ),
            opt("timing", Ty::OneOf(&["zoned", "floating", "all-day"])),
            req("title", Ty::Text),
            opt("travel_min", Ty::Int),
            opt("url", Ty::Text),
            opt("zone", Ty::Text),
        ],
    )
    .here(&[Scope::Home, Scope::Day, Scope::Person])
    .with(&["edge.add"])
    .pair("entity.trash")
    .say("create", &["event"])
    .names(&[
        ("description", &["description"]),
        ("ends", &["duration"]),
        ("starts", &["date", "start"]),
        ("title", &["name"]),
    ]),
    act(
        "event",
        "propose",
        "event.propose",
        &[
            opt("arrived_label", Ty::Text),
            opt(
                "arrived_via",
                Ty::OneOf(&[
                    "picker", "vcard", "markdown", "csv", "scan", "upload", "share", "ics",
                ]),
            ),
            opt("busy", Ty::Bool),
            opt("calendar_id", Ty::Text),
            opt("description", Ty::Text),
            opt("ends", Ty::Text),
            opt("guests", Ty::List),
            mint("id"),
            opt("location", Ty::Text),
            opt("place_id", Ty::Text),
            opt("reminders", Ty::List),
            opt("rule", Ty::Text),
            req("starts", Ty::Text),
            opt(
                "status",
                Ty::OneOf(&["confirmed", "tentative", "cancelled"]),
            ),
            opt("timing", Ty::OneOf(&["zoned", "floating", "all-day"])),
            req("title", Ty::Text),
            opt("travel_min", Ty::Int),
            opt("url", Ty::Text),
            opt("zone", Ty::Text),
        ],
    )
    .q("ics")
    .here(&[Scope::Home])
    .pair("entity.trash")
    .hand(Handoff::PickFile),
    act(
        "event",
        "add_guest",
        "event.add_guest",
        &[
            opt("address", Ty::Text),
            req("id", Ty::Text),
            opt("name", Ty::Text),
            opt("organizer", Ty::Bool),
            opt("person_id", Ty::Text),
            opt(
                "role",
                Ty::OneOf(&["required", "optional", "non-participant"]),
            ),
            opt(
                "status",
                Ty::OneOf(&["needs-action", "accepted", "declined", "tentative"]),
            ),
        ],
    )
    .say_q("edit", &["event"], "guest"),
    act(
        "event",
        "edit",
        "event.edit",
        &[
            opt("busy", Ty::Bool),
            opt("description", Ty::Text),
            opt("ends", Ty::Text),
            opt("expected_rev", Ty::Int),
            opt("guests", Ty::List),
            req("id", Ty::Text),
            opt("location", Ty::Text),
            opt("place_id", Ty::Text),
            opt("reminders", Ty::List),
            opt("rule", Ty::Text),
            opt("starts", Ty::Text),
            opt(
                "status",
                Ty::OneOf(&["confirmed", "tentative", "cancelled"]),
            ),
            opt("timing", Ty::OneOf(&["zoned", "floating", "all-day"])),
            opt("title", Ty::Text),
            opt("travel_min", Ty::Int),
            opt("url", Ty::Text),
            opt("zone", Ty::Text),
        ],
    )
    .say("edit", &["event"])
    .names(&[
        ("description", &["description"]),
        ("ends", &["duration"]),
        ("title", &["name"]),
    ]),
    act(
        "event",
        "edit_occurrence",
        "event.edit_occurrence",
        &[
            req("action", Ty::OneOf(&["skip", "override", "restore"])),
            opt("description", Ty::Text),
            opt("ends", Ty::Text),
            opt("expected_rev", Ty::Int),
            req("id", Ty::Text),
            opt("location", Ty::Text),
            req("original_start", Ty::Text),
            opt("place_id", Ty::Text),
            opt("starts", Ty::Text),
            opt("timing", Ty::OneOf(&["zoned", "floating", "all-day"])),
            opt("title", Ty::Text),
            opt("url", Ty::Text),
            opt("zone", Ty::Text),
        ],
    )
    .pair("event.edit_occurrence")
    .say("reschedule", &["event"]),
    act(
        "event",
        "split",
        "event.split",
        &[
            opt("busy", Ty::Bool),
            opt("description", Ty::Text),
            opt("ends", Ty::Text),
            opt("expected_rev", Ty::Int),
            opt("guests", Ty::List),
            req("id", Ty::Text),
            opt("location", Ty::Text),
            req("original_start", Ty::Text),
            opt("place_id", Ty::Text),
            opt("reminders", Ty::List),
            opt("rule", Ty::Text),
            opt("starts", Ty::Text),
            opt(
                "status",
                Ty::OneOf(&["confirmed", "tentative", "cancelled"]),
            ),
            opt("timing", Ty::OneOf(&["zoned", "floating", "all-day"])),
            opt("title", Ty::Text),
            opt("travel_min", Ty::Int),
            opt("url", Ty::Text),
            opt("zone", Ty::Text),
        ],
    )
    .say_q("reschedule", &["event"], "split"),
    act("event", "cancel", "event.cancel", &[req("id", Ty::Text)]).say("cancel", &["event"]),
    act(
        "event",
        "respond",
        "event.respond",
        &[
            opt("address", Ty::Text),
            req("id", Ty::Text),
            opt("person_id", Ty::Text),
            req("status", Ty::OneOf(&["accepted", "declined", "tentative"])),
        ],
    )
    .say("respond", &["event"])
    .names(&[("status", &["answer"])]),
    act(
        "event",
        "export_ics",
        "event.export_ics",
        &[opt("calendar_id", Ty::Text), opt("event_id", Ty::Text)],
    )
    .irreversible()
    .owner()
    .hand(Handoff::OwnerCheck),
    act(
        "alert",
        "snooze",
        "alert.snooze",
        &[
            opt("date_id", Ty::Text),
            req("entity_id", Ty::Text),
            opt("field_id", Ty::Text),
            req("until", Ty::Text),
        ],
    )
    .say_q(
        "reschedule",
        &["task", "event", "person", "locker_item"],
        "snooze",
    ),
    act(
        "reminder",
        "add",
        "reminder.add",
        &[
            opt("date_id", Ty::Text),
            req("entity_id", Ty::Text),
            opt("field_id", Ty::Text),
            req("offset_min", Ty::Int),
        ],
    )
    .pair("reminder.remove")
    .say_q(
        "edit",
        &["task", "event", "person", "locker_item"],
        "reminder",
    ),
    act(
        "reminder",
        "remove",
        "reminder.remove",
        &[req("id", Ty::Text)],
    )
    .pair("reminder.add")
    .say_q(
        "edit",
        &["task", "event", "person", "locker_item"],
        "no_reminder",
    ),
    act(
        "task",
        "add",
        "task.add",
        &[
            opt("anchor", Ty::OneOf(&["scheduled", "completion"])),
            opt("description", Ty::Text),
            opt("done_at", Ty::Text),
            opt("due", Ty::Text),
            mint("id"),
            opt("parent_id", Ty::Text),
            opt("position", Ty::Num),
            opt("priority", Ty::Int),
            opt("reminders", Ty::List),
            opt("rule", Ty::Text),
            opt("scheduled_on", Ty::Text),
            req("title", Ty::Text),
            opt("url", Ty::Text),
            opt("zone", Ty::Text),
        ],
    )
    .here(&[Scope::Home, Scope::Day, Scope::Person])
    .with(&["edge.add"])
    .pair("entity.trash")
    .say("create", &["task"])
    .names(&[
        ("description", &["description"]),
        ("due", &["date", "due"]),
        ("parent_id", &["list", "parent"]),
        ("priority", &["priority"]),
        ("title", &["name"]),
    ]),
    act(
        "task",
        "edit",
        "task.edit",
        &[
            opt("description", Ty::Text),
            opt("due", Ty::Text),
            opt("expected_rev", Ty::Int),
            req("id", Ty::Text),
            opt("priority", Ty::Int),
            opt("reminders", Ty::List),
            opt("rule", Ty::Text),
            opt("scheduled_on", Ty::Text),
            opt("title", Ty::Text),
            opt("url", Ty::Text),
            opt("zone", Ty::Text),
        ],
    )
    .say("edit", &["task"])
    .names(&[
        ("description", &["description"]),
        ("due", &["date"]),
        ("priority", &["priority"]),
        ("title", &["name"]),
    ]),
    act(
        "task",
        "edit",
        "task.edit",
        &[
            opt("description", Ty::Text),
            opt("due", Ty::Text),
            opt("expected_rev", Ty::Int),
            req("id", Ty::Text),
            opt("priority", Ty::Int),
            opt("reminders", Ty::List),
            opt("rule", Ty::Text),
            opt("scheduled_on", Ty::Text),
            opt("title", Ty::Text),
            opt("url", Ty::Text),
            opt("zone", Ty::Text),
        ],
    )
    .q("reschedule")
    .say("reschedule", &["task"])
    .names(&[
        ("description", &["description"]),
        ("due", &["date"]),
        ("priority", &["priority"]),
        ("title", &["name"]),
    ]),
    act("task", "complete", "task.complete", &[req("id", Ty::Text)])
        .pair("task.reopen")
        .say("complete", &["task"]),
    act("task", "reopen", "task.reopen", &[req("id", Ty::Text)])
        .pair("task.complete")
        .say("reopen", &["task"]),
    act("task", "cancel", "task.cancel", &[req("id", Ty::Text)]).say("cancel", &["task"]),
    act(
        "task",
        "organize",
        "task.organize",
        &[
            opt("anchor", Ty::OneOf(&["scheduled", "completion"])),
            opt("expected_rev", Ty::Int),
            req("id", Ty::Text),
            opt("position", Ty::Num),
            opt("zone", Ty::Text),
        ],
    )
    .say("add_to", &["task"]),
    act(
        "task",
        "export_ics",
        "task.export_ics",
        &[opt("list_id", Ty::Text), opt("task_id", Ty::Text)],
    )
    .irreversible()
    .owner()
    .hand(Handoff::OwnerCheck),
    act(
        "note",
        "create",
        "note.create",
        &[
            opt("body", Ty::Text),
            opt("format", Ty::OneOf(&["markdown", "plain"])),
            mint("id"),
            opt("journal_on", Ty::Text),
            opt("notebook_id", Ty::Text),
            req("title", Ty::Text),
        ],
    )
    .here(&[Scope::Home, Scope::Member, Scope::Person, Scope::Day])
    .with(&["edge.add"])
    .pair("entity.trash")
    .say("create", &["note"])
    .names(&[
        ("body", &["body"]),
        ("notebook_id", &["notebook"]),
        ("title", &["name"]),
    ]),
    act(
        "note",
        "edit",
        "note.edit",
        &[
            opt("body", Ty::Text),
            opt("expected_rev", Ty::Int),
            opt("format", Ty::OneOf(&["markdown", "plain"])),
            req("id", Ty::Text),
            opt("journal_on", Ty::Text),
            opt("title", Ty::Text),
        ],
    )
    .say("edit", &["note"])
    .names(&[("body", &["body"]), ("title", &["name"])]),
    act(
        "note",
        "asset_add",
        "note.asset_add",
        &[
            req("blob", Ty::Text),
            req("id", Ty::Text),
            req("media_type", Ty::Text),
            req("name", Ty::Text),
        ],
    )
    .pair("note.asset_remove")
    .hand(Handoff::Open),
    act(
        "note",
        "asset_remove",
        "note.asset_remove",
        &[req("asset_id", Ty::Text), req("id", Ty::Text)],
    )
    .pair("note.asset_add")
    .hand(Handoff::Open),
    act(
        "note",
        "asset_reorder",
        "note.asset_reorder",
        &[req("id", Ty::Text), req("order", Ty::List)],
    )
    .hand(Handoff::Open),
    act(
        "note",
        "import",
        "note.import",
        &[
            opt("arrived_label", Ty::Text),
            opt(
                "arrived_via",
                Ty::OneOf(&[
                    "picker", "vcard", "markdown", "csv", "scan", "upload", "share", "ics",
                ]),
            ),
            opt("dry_run", Ty::Bool),
            req("files", Ty::List),
        ],
    )
    .pair("entity.trash")
    .hand(Handoff::PickFile),
    act(
        "note",
        "export",
        "note.export",
        &[opt("notebook_id", Ty::Text)],
    )
    .irreversible()
    .owner()
    .hand(Handoff::OwnerCheck),
    act(
        "note",
        "restore_version",
        "note.restore_version",
        &[req("id", Ty::Text), req("seq", Ty::Int)],
    )
    .say_q("restore", &["note"], "version"),
    act(
        "document",
        "add",
        "document.add",
        &[
            opt("arrived_label", Ty::Text),
            opt(
                "arrived_via",
                Ty::OneOf(&[
                    "picker", "vcard", "markdown", "csv", "scan", "upload", "share", "ics",
                ]),
            ),
            req("blob", Ty::Text),
            opt("folder_id", Ty::Text),
            opt("home", Ty::Text),
            mint("id"),
            req("media_type", Ty::Text),
            opt("size", Ty::Int),
            opt("text", Ty::Text),
            req("title", Ty::Text),
        ],
    )
    .here(&[Scope::Home, Scope::Member, Scope::Person])
    .with(&["edge.add"])
    .pair("entity.trash")
    .hand(Handoff::PickFile),
    act(
        "document",
        "create_text",
        "document.create_text",
        &[
            opt("body_text", Ty::Text),
            opt("folder_id", Ty::Text),
            mint("id"),
            opt("media_type", Ty::OneOf(&["text/plain", "text/markdown"])),
            req("title", Ty::Text),
        ],
    )
    .here(&[Scope::Home, Scope::Member, Scope::Person])
    .with(&["edge.add"])
    .pair("entity.trash")
    .say("create", &["document"])
    .names(&[
        ("body_text", &["text"]),
        ("folder_id", &["folder"]),
        ("title", &["name"]),
    ]),
    act(
        "document",
        "edit",
        "document.edit",
        &[
            opt("body_text", Ty::Text),
            opt("expected_rev", Ty::Int),
            req("id", Ty::Text),
            opt("title", Ty::Text),
        ],
    )
    .say("edit", &["document"]),
    act(
        "document",
        "replace",
        "document.replace",
        &[
            req("blob", Ty::Text),
            req("id", Ty::Text),
            opt("media_type", Ty::Text),
            opt("size", Ty::Int),
            opt("text", Ty::Text),
            opt("title", Ty::Text),
        ],
    )
    .hand(Handoff::PickFile),
    act(
        "document",
        "restore_version",
        "document.restore_version",
        &[req("id", Ty::Text), req("seq", Ty::Int)],
    )
    .say_q("restore", &["document"], "version"),
    act(
        "document",
        "export_zip",
        "document.export_zip",
        &[opt("folder_id", Ty::Text)],
    )
    .irreversible()
    .owner()
    .hand(Handoff::OwnerCheck),
    act(
        "photo",
        "add",
        "photo.add",
        &[
            opt("arrived_label", Ty::Text),
            opt(
                "arrived_via",
                Ty::OneOf(&[
                    "picker", "vcard", "markdown", "csv", "scan", "upload", "share", "ics",
                ]),
            ),
            req("blob", Ty::Text),
            opt("burst", Ty::Text),
            opt("duration_s", Ty::Num),
            opt("edited_from", Ty::Text),
            opt("exif", Ty::Object),
            opt("form", Ty::Text),
            opt("height", Ty::Int),
            opt("home", Ty::Text),
            mint("id"),
            opt("lat", Ty::Num),
            opt("lon", Ty::Num),
            req("media_type", Ty::Text),
            opt("motion_blob", Ty::Text),
            opt("motion_duration_s", Ty::Num),
            opt("motion_size", Ty::Int),
            opt("offset_min", Ty::Int),
            opt("phash", Ty::Text),
            opt("place_id", Ty::Text),
            opt("size", Ty::Int),
            opt("taken_at", Ty::Text),
            opt("thumbhash", Ty::Text),
            opt("title", Ty::Text),
            opt("width", Ty::Int),
        ],
    )
    .here(&[Scope::Home, Scope::Member, Scope::Person])
    .with(&["edge.add"])
    .pair("entity.trash")
    .hand(Handoff::PickFile),
    act(
        "photo",
        "edit",
        "photo.edit",
        &[
            opt("edited_from", Ty::Text),
            req("id", Ty::Text),
            opt("lat", Ty::Num),
            opt("lon", Ty::Num),
            opt("offset_min", Ty::Int),
            opt("taken_at", Ty::Text),
        ],
    )
    .say("edit", &["photo"]),
    act(
        "photo",
        "set_place",
        "photo.set_place",
        &[req("id", Ty::Text), opt("place_id", Ty::Text)],
    )
    .say_q("edit", &["photo"], "place"),
    act(
        "photo",
        "export_zip",
        "photo.export_zip",
        &[opt("album_id", Ty::Text)],
    )
    .irreversible()
    .owner()
    .hand(Handoff::OwnerCheck),
    act(
        "place",
        "add",
        "place.add",
        &[
            opt("address", Ty::Text),
            mint("id"),
            opt("lat", Ty::Num),
            opt("lon", Ty::Num),
            req("title", Ty::Text),
            opt("zone", Ty::Text),
        ],
    )
    .pair("entity.trash")
    .hand(Handoff::Open),
    act(
        "place",
        "edit",
        "place.edit",
        &[
            opt("address", Ty::Text),
            req("id", Ty::Text),
            opt("lat", Ty::Num),
            opt("lon", Ty::Num),
            opt("title", Ty::Text),
            opt("zone", Ty::Text),
        ],
    )
    .hand(Handoff::Open),
    act(
        "place",
        "locate",
        "place.locate",
        &[req("id", Ty::Text), opt("locality", Ty::Text)],
    )
    .hand(Handoff::Open),
    act(
        "place",
        "merge",
        "place.merge",
        &[req("from", Ty::Text), req("into", Ty::Text)],
    )
    .irreversible()
    .outlined()
    .hand(Handoff::Destructive),
    act(
        "person",
        "add",
        "person.add",
        &[
            opt("cadence_days", Ty::Int),
            opt("family", Ty::Text),
            opt("form", Ty::Text),
            opt("given", Ty::Text),
            mint("id"),
            opt("list_id", Ty::Text),
            opt("met", Ty::Text),
            opt("nickname", Ty::Text),
            opt("org", Ty::Text),
            opt("phonetic", Ty::Text),
            opt("role", Ty::Text),
            req("title", Ty::Text),
        ],
    )
    .here(&[Scope::Home])
    .pair("entity.trash")
    .say("create", &["person"])
    .names(&[
        ("cadence_days", &["cadence"]),
        ("nickname", &["nickname"]),
        ("role", &["role"]),
        ("title", &["name"]),
    ]),
    act(
        "person",
        "edit",
        "person.edit",
        &[
            opt("cadence_days", Ty::Int),
            opt("expected_rev", Ty::Int),
            opt("family", Ty::Text),
            opt("form", Ty::Text),
            opt("given", Ty::Text),
            req("id", Ty::Text),
            opt("met", Ty::Text),
            opt("nickname", Ty::Text),
            opt("org", Ty::Text),
            opt("phonetic", Ty::Text),
            opt("role", Ty::Text),
            opt("sort_name", Ty::Text),
            opt("title", Ty::Text),
        ],
    )
    .say("edit", &["person"])
    .names(&[
        ("cadence_days", &["cadence"]),
        ("met", &["met"]),
        ("nickname", &["nickname"]),
        ("role", &["role"]),
        ("title", &["name"]),
    ]),
    act(
        "person",
        "edit",
        "person.edit",
        &[
            opt("cadence_days", Ty::Int),
            opt("expected_rev", Ty::Int),
            opt("family", Ty::Text),
            opt("form", Ty::Text),
            opt("given", Ty::Text),
            req("id", Ty::Text),
            opt("met", Ty::Text),
            opt("nickname", Ty::Text),
            opt("org", Ty::Text),
            opt("phonetic", Ty::Text),
            opt("role", Ty::Text),
            opt("sort_name", Ty::Text),
            opt("title", Ty::Text),
        ],
    )
    .q("cadence")
    .say_q("edit", &["person"], "cadence")
    .names(&[
        ("cadence_days", &["cadence"]),
        ("met", &["met"]),
        ("nickname", &["nickname"]),
        ("role", &["role"]),
        ("title", &["name"]),
    ]),
    act(
        "person",
        "add_date",
        "person.add_date",
        &[
            req("date", Ty::Text),
            req("id", Ty::Text),
            opt("kind", Ty::Text),
            opt("label", Ty::Text),
            opt("reminders", Ty::List),
        ],
    )
    .hand(Handoff::Open),
    act(
        "person",
        "edit_date",
        "person.edit_date",
        &[
            opt("date", Ty::Text),
            req("date_id", Ty::Text),
            opt("kind", Ty::Text),
            opt("label", Ty::Text),
        ],
    )
    .hand(Handoff::Open),
    act(
        "person",
        "remove_date",
        "person.remove_date",
        &[req("date_id", Ty::Text)],
    )
    .hand(Handoff::Open),
    act(
        "person",
        "add_note",
        "person.add_note",
        &[req("id", Ty::Text), req("text", Ty::Text)],
    )
    .here(&[Scope::Person])
    .pair("entity.trash")
    .say_q("create", &["note"], "person"),
    act(
        "person",
        "add_relationship",
        "person.add_relationship",
        &[
            req("id", Ty::Text),
            req("kind", Ty::Text),
            req("name", Ty::Text),
            opt("pet", Ty::Text),
            opt("related_id", Ty::Text),
        ],
    )
    .pair("edge.remove")
    .hand(Handoff::Open),
    act(
        "person",
        "save_contact_point",
        "person.save_contact_point",
        &[
            req("id", Ty::Text),
            req("kind", Ty::Text),
            opt("label", Ty::Text),
            opt("point_id", Ty::Text),
            opt("preferred", Ty::Bool),
            req("value", Ty::Text),
        ],
    )
    .hand(Handoff::Open),
    act(
        "person",
        "remove_contact_point",
        "person.remove_contact_point",
        &[req("point_id", Ty::Text)],
    )
    .hand(Handoff::Open),
    act(
        "person",
        "prefer_contact_point",
        "person.prefer_contact_point",
        &[req("point_id", Ty::Text), opt("preferred", Ty::Bool)],
    )
    .hand(Handoff::Open),
    act(
        "person",
        "reorder_contact_points",
        "person.reorder_contact_points",
        &[req("id", Ty::Text), req("order", Ty::List)],
    )
    .hand(Handoff::Open),
    act(
        "person",
        "set_avatar",
        "person.set_avatar",
        &[opt("blob", Ty::Text), req("id", Ty::Text)],
    )
    .hand(Handoff::Open),
    act(
        "person",
        "move",
        "person.move",
        &[req("id", Ty::Text), opt("list_id", Ty::Text)],
    )
    .say("add_to", &["person"])
    .names(&[("list_id", &["to", "from"])]),
    act(
        "person",
        "merge",
        "person.merge",
        &[req("from", Ty::Text), req("into", Ty::Text)],
    )
    .irreversible()
    .outlined()
    .hand(Handoff::Destructive),
    act(
        "person",
        "import_vcf",
        "person.import_vcf",
        &[
            opt("arrived_label", Ty::Text),
            opt(
                "arrived_via",
                Ty::OneOf(&[
                    "picker", "vcard", "markdown", "csv", "scan", "upload", "share", "ics",
                ]),
            ),
            req("cards", Ty::Text),
            opt("dry_run", Ty::Bool),
            opt("merge", Ty::Bool),
        ],
    )
    .pair("entity.trash")
    .hand(Handoff::PickFile),
    act(
        "person",
        "import_csv",
        "person.import_csv",
        &[
            opt("arrived_label", Ty::Text),
            opt(
                "arrived_via",
                Ty::OneOf(&[
                    "picker", "vcard", "markdown", "csv", "scan", "upload", "share", "ics",
                ]),
            ),
            req("csv", Ty::Text),
            opt("dry_run", Ty::Bool),
            opt("merge", Ty::Bool),
        ],
    )
    .pair("entity.trash")
    .hand(Handoff::PickFile),
    act(
        "person",
        "export_vcf",
        "person.export_vcf",
        &[opt("list_id", Ty::Text), opt("person_id", Ty::Text)],
    )
    .irreversible()
    .owner()
    .hand(Handoff::OwnerCheck),
    act(
        "person",
        "export_csv",
        "person.export_csv",
        &[opt("list_id", Ty::Text), opt("person_id", Ty::Text)],
    )
    .irreversible()
    .owner()
    .hand(Handoff::OwnerCheck),
    act(
        "touch",
        "log",
        "touch.log",
        &[
            opt("ends", Ty::Text),
            mint("id"),
            req("kind", Ty::Text),
            opt("notes", Ty::Text),
            req("people", Ty::List),
            opt("place_id", Ty::Text),
            opt("starts", Ty::Text),
        ],
    )
    .here(&[Scope::Person, Scope::Day])
    .with(&["edge.add"])
    .pair("entity.trash")
    .say("log", &["person"]),
    act(
        "touch",
        "edit",
        "touch.edit",
        &[
            opt("ends", Ty::Text),
            opt("expected_rev", Ty::Int),
            req("id", Ty::Text),
            opt("kind", Ty::Text),
            opt("notes", Ty::Text),
            opt("people", Ty::List),
            opt("place_id", Ty::Text),
            opt("starts", Ty::Text),
        ],
    )
    .hand(Handoff::Open),
    act(
        "workout",
        "log",
        "workout.log",
        &[
            opt("climb_m", Ty::Num),
            opt("distance_m", Ty::Num),
            opt("ends", Ty::Text),
            opt("energy_kcal", Ty::Num),
            opt("heart_bpm", Ty::Int),
            mint("id"),
            opt("moving_s", Ty::Int),
            opt("notes", Ty::Text),
            opt("place_id", Ty::Text),
            opt("recorded_by", Ty::Text),
            req("starts", Ty::Text),
            opt("title", Ty::Text),
            opt("type", Ty::Text),
            opt("with", Ty::List),
        ],
    )
    .here(&[Scope::Person, Scope::Day])
    .with(&["edge.add"])
    .pair("entity.trash")
    .say("create", &["workout"])
    .names(&[
        ("climb_m", &["climb"]),
        ("distance_m", &["distance"]),
        ("ends", &["end"]),
        ("energy_kcal", &["energy"]),
        ("heart_bpm", &["heart_rate"]),
        ("moving_s", &["moving"]),
        ("starts", &["date", "start"]),
        ("title", &["name"]),
        ("type", &["type"]),
    ]),
    act(
        "workout",
        "edit",
        "workout.edit",
        &[
            opt("climb_m", Ty::Num),
            opt("distance_m", Ty::Num),
            opt("ends", Ty::Text),
            opt("energy_kcal", Ty::Num),
            opt("expected_rev", Ty::Int),
            opt("heart_bpm", Ty::Int),
            req("id", Ty::Text),
            opt("moving_s", Ty::Int),
            opt("notes", Ty::Text),
            opt("place_id", Ty::Text),
            opt("recorded_by", Ty::Text),
            opt("starts", Ty::Text),
            opt("title", Ty::Text),
            opt("type", Ty::Text),
            opt("with", Ty::List),
        ],
    )
    .say("edit", &["workout"])
    .names(&[
        ("climb_m", &["climb"]),
        ("distance_m", &["distance"]),
        ("ends", &["end"]),
        ("energy_kcal", &["energy"]),
        ("heart_bpm", &["heart_rate"]),
        ("moving_s", &["moving"]),
        ("starts", &["date", "start"]),
        ("title", &["name"]),
        ("type", &["type"]),
    ]),
    act(
        "reading",
        "add",
        "reading.add",
        &[
            req("at", Ty::Text),
            opt("context", Ty::Text),
            mint("id"),
            req("metric", Ty::Text),
            opt("person_id", Ty::Text),
            req("value", Ty::Num),
            opt("value2", Ty::Num),
        ],
    )
    .here(&[Scope::Day])
    .pair("entity.trash")
    .hand(Handoff::Open),
    act(
        "reading",
        "edit",
        "reading.edit",
        &[
            opt("at", Ty::Text),
            opt("context", Ty::Text),
            opt("expected_rev", Ty::Int),
            req("id", Ty::Text),
            opt("value", Ty::Num),
            opt("value2", Ty::Num),
        ],
    )
    .hand(Handoff::Open),
    act(
        "measurement",
        "log",
        "measurement.log",
        &[
            opt("day", Ty::Text),
            mint("id"),
            opt("metric", Ty::Text),
            opt("person_id", Ty::Text),
            req("value", Ty::Num),
        ],
    )
    .here(&[Scope::Day])
    .pair("measurement.clear")
    .say("create", &["daily_figure"])
    .names(&[
        ("day", &["date", "day"]),
        ("metric", &["name", "metric"]),
        ("value", &["value"]),
    ]),
    act(
        "measurement",
        "clear",
        "measurement.clear",
        &[
            opt("day", Ty::Text),
            opt("id", Ty::Text),
            opt("metric", Ty::Text),
            opt("person_id", Ty::Text),
        ],
    )
    .pair("measurement.log")
    .say("delete", &["daily_figure"]),
    act(
        "health",
        "export_csv",
        "health.export_csv",
        &[
            opt("id", Ty::Text),
            opt("metric", Ty::Text),
            req("what", Ty::OneOf(&["measurements", "readings", "workouts"])),
        ],
    )
    .irreversible()
    .owner()
    .hand(Handoff::OwnerCheck),
    act(
        "locker",
        "add_item",
        "locker.add_item",
        &[
            opt("arrived_label", Ty::Text),
            opt(
                "arrived_via",
                Ty::OneOf(&[
                    "picker", "vcard", "markdown", "csv", "scan", "upload", "share", "ics",
                ]),
            ),
            opt("compromised", Ty::Bool),
            opt("fields", Ty::List),
            mint_req("item_id"),
            req("title", Ty::Text),
            req(
                "type",
                Ty::OneOf(&[
                    "login",
                    "card",
                    "note",
                    "identity",
                    "wifi",
                    "password",
                    "ssh_key",
                    "api_credential",
                    "passport",
                    "bank_account",
                    "driving_licence",
                    "software_licence",
                    "crypto_wallet",
                    "membership",
                    "document",
                ]),
            ),
        ],
    )
    .pair("entity.trash")
    .say("create", &["locker_item"])
    .names(&[("title", &["name"]), ("type", &["type"])]),
    act(
        "locker",
        "edit_item",
        "locker.edit_item",
        &[
            opt("compromised", Ty::Bool),
            opt("expected_rev", Ty::Int),
            opt("fields", Ty::List),
            req("item_id", Ty::Text),
            opt("remove", Ty::List),
            opt("title", Ty::Text),
            opt(
                "type",
                Ty::OneOf(&[
                    "login",
                    "card",
                    "note",
                    "identity",
                    "wifi",
                    "password",
                    "ssh_key",
                    "api_credential",
                    "passport",
                    "bank_account",
                    "driving_licence",
                    "software_licence",
                    "crypto_wallet",
                    "membership",
                    "document",
                ]),
            ),
        ],
    )
    .owner()
    .say("edit", &["locker_item"])
    .names(&[("title", &["name"])]),
    act(
        "locker",
        "duplicate_item",
        "locker.duplicate_item",
        &[
            opt("fields", Ty::List),
            req("item_id", Ty::Text),
            mint_req("new_item_id"),
        ],
    )
    .pair("entity.trash")
    .hand(Handoff::Open),
    act(
        "locker",
        "set_field",
        "locker.set_field",
        &[
            opt("blob", Ty::Text),
            opt("changed", Ty::Bool),
            opt("field_id", Ty::Text),
            opt("field_key", Ty::Text),
            req("item_id", Ty::Text),
            opt("key_id", Ty::Text),
            opt(
                "kind",
                Ty::OneOf(&["text", "sealed", "url", "date", "otp", "file"]),
            ),
            opt("label", Ty::Text),
            opt("position", Ty::Num),
            opt("section", Ty::Text),
            opt("value", Ty::Text),
        ],
    )
    .owner()
    .say_q("edit", &["locker_item"], "field"),
    act(
        "locker",
        "remove_field",
        "locker.remove_field",
        &[req("field_id", Ty::Text), req("item_id", Ty::Text)],
    )
    .say_q("delete", &["locker_item"], "field"),
    act(
        "locker",
        "set_passkey",
        "locker.set_passkey",
        &[
            opt("algorithm", Ty::Text),
            opt("credential_id", Ty::Text),
            opt("display_name", Ty::Text),
            req("item_id", Ty::Text),
            opt("key_id", Ty::Text),
            opt("passkey_id", Ty::Text),
            opt("private_key", Ty::Text),
            req("rp_id", Ty::Text),
            opt("user_handle", Ty::Text),
        ],
    )
    .owner()
    .hand(Handoff::Open),
    act(
        "locker",
        "remove_passkey",
        "locker.remove_passkey",
        &[req("item_id", Ty::Text), req("passkey_id", Ty::Text)],
    )
    .hand(Handoff::Open),
    act(
        "locker",
        "totp_code",
        "locker.totp_code",
        &[opt("field_id", Ty::Text), req("item_id", Ty::Text)],
    )
    .irreversible()
    .owner()
    .card(Handoff::Reveal, "reveal", &["locker_item"]),
    act(
        "locker",
        "export",
        "locker.export",
        &[
            req("confirm", Ty::Bool),
            req("device_passcode", Ty::Bool),
            opt("include_trashed", Ty::Bool),
        ],
    )
    .irreversible()
    .owner()
    .hand(Handoff::OwnerCheck),
    act(
        "follow",
        "stop",
        "follow.stop",
        &[req("ref", Ty::Text), req("system", Ty::Text)],
    )
    .irreversible()
    .outlined()
    .hand(Handoff::Open),
    act(
        "follow",
        "take_stated",
        "follow.take_stated",
        &[
            req("entity", Ty::Text),
            req("field", Ty::Text),
            opt("item_key", Ty::Text),
            opt("origin", Ty::Text),
        ],
    )
    .hand(Handoff::Open),
    act("thread", "clear", "thread.clear", &[])
        .irreversible()
        .outlined()
        .hand(Handoff::Destructive),
];
