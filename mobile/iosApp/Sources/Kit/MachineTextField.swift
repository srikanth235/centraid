import SwiftUI

#if canImport(CentraidShared)
import CentraidShared
#endif

/// A TEXT FIELD WHOSE WORDS THE MACHINE HOLDS, WITHOUT A ROUND TRIP PER KEY.
///
/// Binding a `TextField` straight to the state (`get: { state.x }`, `set:
/// send`) makes every keystroke wait for the machine's answer before the
/// field shows it, and a fast typist loses letters ("Plant tulip buls"). The
/// keystrokes live here, in `@State`, and each change goes over as the
/// screen's edit event. The field FOLLOWS the machine only when the machine
/// says something new while the member is not typing — a seed (Notes' "Send
/// to Tasks") — or clears it (a submitted add), and never when what it says is
/// an echo of the typing (the shared `TypedText`: an emptied field's late echo
/// once took back the letters typed after it).
struct MachineTextField: View {
    let placeholder: String
    /// The machine's text.
    let value: String
    var axis: Axis = .horizontal
    var focusOnAppear: Bool = false
    let onEdit: (String) -> Void
    var onSubmit: (() -> Void)? = nil

    @State private var typed = ""
    @State private var echoes = TypedText(initial: "")
    @FocusState private var focused: Bool

    var body: some View {
        TextField(placeholder, text: $typed, axis: axis)
            .focused($focused)
            .onSubmit { onSubmit?() }
            .onAppear {
                echoes = TypedText(initial: value)
                typed = value
                if focusOnAppear { focused = true }
            }
            .onChange(of: typed) { _, text in
                if echoes.edited(next: text) { onEdit(text) }
            }
            .onChange(of: value) { _, text in
                let open = text.isEmpty || !focused
                if let adopted = echoes.answer(value: text, shown: typed, open: open) { typed = adopted }
            }
            .onChange(of: focusOnAppear) { _, now in if now { focused = true } }
    }
}
