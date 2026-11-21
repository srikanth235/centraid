import SwiftUI

/// RETURN MOVES TO THE NEXT FIELD (#1202, S13): in an editor of several fields the key says "next" and
/// focuses the field after it; only the last says "done" and puts the keyboard away. Android's IME
/// action is the same (`ImeAction.Next` on every field but the last).
///
/// The editor owns one `@FocusState<Int?>` and hands each field its index and the last one's:
/// `.focusChain(FocusChain(focus: $field, index: 0, last: 3))`.
struct FocusChain {
    let focus: FocusState<Int?>.Binding
    let index: Int
    let last: Int

    /// The index Return moves to: the next field, or none after the last (the keyboard goes).
    static func next(after index: Int, last: Int) -> Int? {
        index < last ? index + 1 : nil
    }

    /// Whether Return on this field says "next" (every field but the last).
    static func saysNext(index: Int, last: Int) -> Bool { index < last }

    /// The Return key's label: "next" on every field but the last.
    static func submitLabel(index: Int, last: Int) -> SubmitLabel {
        saysNext(index: index, last: last) ? .next : .done
    }
}

extension View {
    /// Make this field one of a chain: focus by index, Return to the next.
    @ViewBuilder
    func focusChain(_ chain: FocusChain?) -> some View {
        if let chain {
            self
                .focused(chain.focus, equals: chain.index)
                .submitLabel(FocusChain.submitLabel(index: chain.index, last: chain.last))
                .onSubmit { chain.focus.wrappedValue = FocusChain.next(after: chain.index, last: chain.last) }
        } else {
            self
        }
    }
}
