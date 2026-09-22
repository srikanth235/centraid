// The FLAT FRAME — the shape the model fills, described in pure Swift.
//
// This file holds NO FoundationModels symbols. It is the description of the
// Stage-B schema: which slots exist, what each one draws on, and which of
// them apply to the kind Stage A picked. `AFMClient.swift` turns this
// description into a `DynamicGenerationSchema`; if an API spelling there is
// wrong, nothing in this file has to change.
//
// The slot ladder is the postfix order the corpus uses, and it is PROVEN:
// `python3 frame.py` rebuilds all 434 gold canonicals through exactly these
// slots, tree-equal. The Python side (`frame.py#from_flat`) is the only
// thing that reads the model's JSON back, so the two must agree by name.
//
//     { move, head, aggField, set, set2, cmds[], refuseReason }
//     set { source, kind, ref, ordinal,
//           called, filtersA, window, walk1, called2, filtersB, window2,
//           walk2, filtersC, orderField, orderDir, limit,
//           combineOp, combineRight }
//     pred { join, atoms[] }
//     atom { type, field, cmp, valueKind, value, num, what, negated,
//            window, lits[], set, kind }
//     window { how, value, n, unit }
//     cmd  { verb, args[{ name, valueKind, value }], on }

import Foundation

/// One property of a generated object, and where its values come from.
public struct Slot: Sendable {
    public enum Source: Sendable {
        /// A free string the model must COPY out of the member's sentence.
        case span(String)
        /// A closed vocabulary.
        case anyOf([String])
        case integer
        case boolean
        /// A nested object described by name.
        case object(String)
        /// An array of a nested object, bounded.
        case array(String, max: Int)
    }

    public let name: String
    public let source: Source
    public let guidance: String
    public let optional: Bool

    public init(_ name: String, _ source: Source, _ guidance: String,
                optional: Bool = true) {
        self.name = name
        self.source = source
        self.guidance = guidance
        self.optional = optional
    }
}

/// A named object in the Stage-B schema.
public struct ObjectSpec: Sendable {
    public let name: String
    public let slots: [Slot]
}

public enum StageASlots {
    public static let moves = ["new", "refine", "substitute", "act", "undo"]
    public static let heads = ["show", "count", "sum", "min", "max", "project",
                               "balance", "same", "write", "nothing", "refuse"]
}

/// The Stage-B schema, built for ONE kind so it carries only that kind's
/// fields, that kind's walk targets and that kind's enum values.
public enum FrameSchema {

    public static let copyGuidance =
        "Copy the member's own words EXACTLY, character for character. If the "
        + "sentence does not contain the words, leave this out rather than "
        + "writing something close."

    public static func objects(kind: String, head: String) -> [ObjectSpec] {
        let fields = Vocab.fields(for: kind)
        let walks = Vocab.walks(from: kind)
        var specs: [ObjectSpec] = []

        specs.append(ObjectSpec(name: "Window", slots: [
            Slot("how", .anyOf(["phrase", "date", "datetime", "month",
                                "daterange", "rolling"]),
                 "phrase for a named period, date for 2026-06-19, month for "
                 + "2026-05, daterange for 2026-06-04..2026-06-06, rolling "
                 + "for \"the next three weeks\".", optional: false),
            Slot("value", .anyOf(Vocab.windowPhrases),
                 "The named period, when how is phrase."),
            Slot("literal", .span("An exact date, date-time, month or range."),
                 copyGuidance),
            Slot("n", .integer, "How many, when how is rolling."),
            Slot("unit", .anyOf(Vocab.rollingUnits),
                 "days, weeks or months, when how is rolling."),
        ]))

        specs.append(ObjectSpec(name: "Atom", slots: [
            Slot("type", .anyOf(["cmp", "contains", "is", "pwindow", "band",
                                 "oneof", "countwalk"]),
                 "cmp compares a field to a value; contains is a substring of "
                 + "a text field; is checks null or me; pwindow puts a date "
                 + "field inside a period; band is \"about N\"; oneof is one "
                 + "of several values; countwalk counts linked rows.",
                 optional: false),
            Slot("field", .anyOf(fields),
                 "Which column of \(kind) this is about."),
            Slot("cmp", .anyOf(Vocab.comparators), "The comparison."),
            Slot("valueKind", .anyOf(["literal", "number", "date", "datetime",
                                      "month", "keyword", "bool", "null",
                                      "me"]),
                 "What sort of value the right-hand side is."),
            Slot("value", .span("The value compared against."), copyGuidance),
            Slot("num", .integer, "The number, for band and countwalk."),
            Slot("what", .anyOf(["null", "me"]), "For type is."),
            Slot("negated", .boolean, "true for \"is not null\"."),
            Slot("window", .object("Window"), "The period, for type pwindow."),
            Slot("kind", .anyOf(Vocab.kinds), "The board, for countwalk."),
        ]))

        specs.append(ObjectSpec(name: "Pred", slots: [
            Slot("join", .anyOf(["and", "or", "none"]),
                 "none for one condition; and/or joins them.", optional: false),
            Slot("atoms", .array("Atom", max: 3), "The conditions.",
                 optional: false),
        ]))

        specs.append(ObjectSpec(name: "OtherSet", slots: [
            Slot("source", .anyOf(["kind", "ref"]),
                 "kind names a board; ref points at the previous answer.",
                 optional: false),
            Slot("kind", .anyOf(Vocab.kinds), "Which board."),
            Slot("ref", .anyOf(Vocab.refs), "Which previous rows."),
            Slot("called", .span("A name the member said."), copyGuidance),
        ]))

        specs.append(ObjectSpec(name: "Set", slots: [
            Slot("source", .anyOf(["kind", "ref"]),
                 "kind names a board; ref points at the rows the last turn "
                 + "answered.", optional: false),
            Slot("kind", .anyOf(Vocab.kinds), "Which board."),
            Slot("ref", .anyOf(Vocab.refs), "Which previous rows."),
            Slot("ordinal", .integer, "For \"the 2nd one\"."),
            Slot("called", .span("A name or title the member said."),
                 copyGuidance),
            Slot("filtersA", .object("Pred"), "Conditions on \(kind)."),
            Slot("window", .object("Window"), "A period the rows fall in."),
            Slot("walk1", .anyOf(walks),
                 "Follow a link from \(kind) to this board."),
            Slot("filtersB", .object("Pred"),
                 "Conditions on the rows AFTER walk1."),
            Slot("walk2", .anyOf(Vocab.kinds), "A second link to follow."),
            Slot("orderField", .anyOf(fields), "Sort by this column."),
            Slot("orderDir", .anyOf(["asc", "desc"]), "Sort direction."),
            Slot("limit", .integer, "Keep only the first N."),
            Slot("combineOp", .anyOf(["and", "except"]),
                 "Union with, or subtract, a second set."),
            Slot("combineRight", .object("OtherSet"), "The second set."),
        ]))

        specs.append(ObjectSpec(name: "Arg", slots: [
            Slot("name", .anyOf(argNames(kind: kind)),
                 "The command's argument.", optional: false),
            Slot("valueKind", .anyOf(["literal", "number", "date", "datetime",
                                      "month", "duration", "keyword", "bool",
                                      "null", "me"]),
                 "What sort of value it is.", optional: false),
            Slot("value", .span("The value."), copyGuidance, optional: false),
        ]))

        specs.append(ObjectSpec(name: "Cmd", slots: [
            Slot("verb", .anyOf(verbs(kind: kind)),
                 "The vault command, or a verb class.", optional: false),
            Slot("args", .array("Arg", max: 4), "Its arguments."),
            Slot("on", .object("Set"), "The rows it runs on."),
        ]))

        var top: [Slot] = [
            Slot("head", .anyOf(StageASlots.heads), "What the turn asks for.",
                 optional: false)
        ]
        if head == "write" {
            top.append(Slot("cmds", .array("Cmd", max: 2),
                            "The writes, in the order the sentence says them.",
                            optional: false))
        } else if head == "refuse" {
            top.append(Slot("refuseReason", .anyOf(Vocab.declineReasons),
                            "Why the vault cannot answer.", optional: false))
        } else if head != "nothing" {
            top.append(Slot("set", .object("Set"), "The rows the turn is about.",
                            optional: false))
            if head == "balance" || head == "same" {
                top.append(Slot("set2", .object("Set"), "The second set.",
                                optional: false))
            }
            if ["sum", "min", "max", "project"].contains(head) {
                top.append(Slot("aggField", .anyOf(Vocab.fields(for: kind)),
                                "Which column is folded or projected.",
                                optional: false))
            }
        }
        specs.append(ObjectSpec(name: "Frame", slots: top))
        return specs
    }

    /// The argument names the verbs plausible for this kind accept. Both
    /// lists are GENERATED from the command registry (`gen_vocab.py`), never
    /// guessed from the spelling of a command name.
    static func argNames(kind: String) -> [String] {
        var names = Set<String>()
        for verb in verbs(kind: kind) {
            names.formUnion(Vocab.args(for: verb))
        }
        if names.isEmpty {
            names = ["title", "summary", "description", "status", "to", "by"]
        }
        return names.sorted()
    }

    static func verbs(kind: String) -> [String] {
        Vocab.commands(for: kind)
    }
}
