import Foundation
import SwiftUI
import UIKit

/// AN ANSWER'S MARKDOWN, DRAWN AS TEXT AND NEVER AS ITS MARKERS.
///
/// A small model writes `**bold**`, `*italic*`, `` `code` `` and `-` or `1.`
/// lists whether or not anyone asked, and a view that prints them verbatim shows
/// the member asterisks. `Text(AttributedString)` renders the INLINE half
/// (strong, emphasis, code) but has no idea what a list is — parsing a whole
/// document with `.full` flattens its items into one run — so the block
/// structure is read here, line by line, and each block's own text goes through
/// the system's inline parser:
///
/// * a line that starts `-`, `*`, `+`, `•` or `1.` / `1)` is a list item, drawn
///   with a marker in its own column and a hanging indent;
/// * a line that starts `#` is a heading, drawn in the strong weight (the
///   system has two weights and a heading is not a third);
/// * everything else is a paragraph; a blank line ends one.
///
/// **A parse that fails never shows its markers.** The inline parser can refuse
/// text; the fallback is the same text with the markers taken out, not the text
/// as written. And **nothing is a link**: a model can write `[x](https://…)`,
/// and a tappable address in an answer is a way out of the device the member
/// did not ask for, so the link attribute is dropped and the words stay.
///
/// While an answer is still streaming, a marker that has not closed yet
/// (`**bol`) would flash as raw asterisks; [`Block`]s built with `streaming`
/// leave the unclosed one out until its partner arrives.
enum ChatMarkdown {
    enum Block: Equatable {
        case paragraph(AttributedString)
        case item(marker: String, text: AttributedString)
        case heading(AttributedString)
    }

    static func blocks(_ text: String, streaming: Bool = false) -> [Block] {
        var out: [Block] = []
        var paragraph: [String] = []

        func flush() {
            guard !paragraph.isEmpty else { return }
            out.append(.paragraph(inline(paragraph.joined(separator: "\n"), streaming: streaming)))
            paragraph = []
        }

        for raw in text.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n") {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.isEmpty {
                flush()
            } else if let item = listItem(line) {
                flush()
                out.append(.item(marker: item.marker, text: inline(item.text, streaming: streaming)))
            } else if let heading = headingText(line) {
                flush()
                out.append(.heading(strong(inline(heading, streaming: streaming))))
            } else {
                paragraph.append(line)
            }
        }
        flush()
        return out
    }

    /// One run of text with its inline Markdown applied, links removed, and
    /// markers never shown.
    static func inline(_ text: String, streaming: Bool = false) -> AttributedString {
        let prepared = streaming ? withoutUnclosedMarkers(text) : text
        let options = AttributedString.MarkdownParsingOptions(
            allowsExtendedAttributes: false,
            interpretedSyntax: .inlineOnlyPreservingWhitespace,
            failurePolicy: .returnPartiallyParsedIfPossible
        )
        guard var parsed = try? AttributedString(markdown: prepared, options: options) else {
            return AttributedString(withoutMarkers(prepared))
        }
        for run in parsed.runs where run.link != nil {
            parsed[run.range].link = nil
        }
        return parsed
    }

    /// The words alone, for a screen reader: no asterisks, backticks or hashes.
    static func plain(_ text: String) -> String {
        blocks(text).map { block -> String in
            switch block {
            case let .paragraph(content), let .heading(content):
                return String(content.characters)
            case let .item(marker, content):
                return marker + " " + String(content.characters)
            }
        }
        .joined(separator: ". ")
    }

    // MARK: Reading one line

    private static func listItem(_ line: String) -> (marker: String, text: String)? {
        let characters = Array(line)
        guard let first = characters.first else { return nil }
        if "-*+•".contains(first), characters.count > 1, characters[1] == " " {
            let rest = String(characters.dropFirst(2)).trimmingCharacters(in: .whitespaces)
            // `**bold**` starts with a star and no space: not an item.
            return rest.isEmpty ? nil : ("•", rest)
        }
        var digits = ""
        var index = 0
        while index < characters.count, characters[index].isNumber, digits.count < 3 {
            digits.append(characters[index])
            index += 1
        }
        guard !digits.isEmpty, index + 1 < characters.count,
              characters[index] == "." || characters[index] == ")",
              characters[index + 1] == " "
        else { return nil }
        let rest = String(characters.dropFirst(index + 2)).trimmingCharacters(in: .whitespaces)
        return rest.isEmpty ? nil : (digits + ".", rest)
    }

    private static func headingText(_ line: String) -> String? {
        let hashes = line.prefix(while: { $0 == "#" })
        guard (1 ... 6).contains(hashes.count) else { return nil }
        let rest = line.dropFirst(hashes.count)
        guard rest.first == " " else { return nil }
        let text = rest.trimmingCharacters(in: .whitespaces)
        return text.isEmpty ? nil : text
    }

    private static func strong(_ text: AttributedString) -> AttributedString {
        var out = text
        for run in out.runs {
            var intent = run.inlinePresentationIntent ?? []
            intent.insert(.stronglyEmphasized)
            out[run.range].inlinePresentationIntent = intent
        }
        return out
    }

    // MARK: Markers

    /// `**bol` and `` `co `` are an answer half-written: drop the opener until
    /// its partner arrives, so no marker flashes.
    private static func withoutUnclosedMarkers(_ text: String) -> String {
        var out = text
        for marker in ["**", "__", "`"] {
            let count = out.components(separatedBy: marker).count - 1
            if count % 2 == 1, let range = out.range(of: marker, options: .backwards) {
                out.removeSubrange(range)
            }
        }
        return out
    }

    /// Markers out, words kept: the fallback when the parser refuses.
    static func withoutMarkers(_ text: String) -> String {
        var out = text
        for marker in ["**", "__", "`"] {
            out = out.replacingOccurrences(of: marker, with: "")
        }
        return out
    }
}

/// THE ANSWER'S TEXT as its blocks, in the chat's body type: paragraphs, list
/// items with a marker column and a hanging indent, headings in the strong
/// weight. One accessibility element carrying the words and no markers.
struct ChatMarkdownText: View {
    let text: String
    var streaming: Bool = false
    /// The label a screen reader speaks, `Centraid said: …`, built from the
    /// words and not the markers.
    let spoken: String

    @Environment(\.colorScheme) private var scheme
    @Environment(\.dynamicTypeSize) private var size

    /// THE TWO WEIGHTS THE SYSTEM HAS, applied to the runs the parser marked.
    /// `Text` draws strong and emphasis by asking the font for a bold or an
    /// italic, and a bundled face that is neither answers with itself — so the
    /// markers vanished and so did the meaning. Strong takes the semibold face
    /// at the body's scaled size; emphasis takes the platform's slant of the
    /// regular one, because the family ships no italic.
    private func styled(_ text: AttributedString) -> AttributedString {
        let body = Theme.uiFont("body", scheme)
        let traits = UITraitCollection(preferredContentSizeCategory: ChatTypeScale.category(size))
        let pointSize = UIFontMetrics(forTextStyle: .body).scaledFont(for: body, compatibleWith: traits).pointSize
        let strong = Theme.uiFont("smallStrong", scheme).withSize(pointSize)
        var out = text
        for run in out.runs {
            let intent = run.inlinePresentationIntent ?? []
            if intent.contains(.stronglyEmphasized) {
                out[run.range].font = Font(strong)
            }
            if intent.contains(.emphasized) {
                out[run.range].font = intent.contains(.stronglyEmphasized)
                    ? Font(strong).italic()
                    : Font(body.withSize(pointSize)).italic()
            }
        }
        return out
    }

    var body: some View {
        let blocks = ChatMarkdown.blocks(text, streaming: streaming)
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                switch block {
                case let .paragraph(content):
                    Text(styled(content))
                        .chatType("body")
                        .foregroundStyle(Theme.color("text", scheme))
                        .frame(maxWidth: .infinity, alignment: .leading)
                case let .heading(content):
                    Text(styled(content))
                        .chatType("body")
                        .foregroundStyle(Theme.color("text", scheme))
                        .frame(maxWidth: .infinity, alignment: .leading)
                case let .item(marker, content):
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(marker)
                            .chatType("body")
                            .foregroundStyle(Theme.color("textSoft", scheme))
                            .frame(minWidth: 16, alignment: .trailing)
                        Text(styled(content))
                            .chatType("body")
                            .foregroundStyle(Theme.color("text", scheme))
                            .frame(maxWidth: .infinity, alignment: .leading)
                        }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(spoken)
    }
}
