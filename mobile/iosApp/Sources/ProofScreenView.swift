import SwiftUI

#if os(iOS)
/// THE PROOF SCREEN, DRAWN (#1135, lane C2): `proof.counter`, minimal.
///
/// Every string below comes out of the view state; this file writes no copy. It
/// draws the stack Rust holds for a tab with `NavigationStack` and reports a
/// back-swipe as an event. A ported screen follows this shape: `docs/screens.md`.
struct ProofStackView: View {
    @ObservedObject var store: ScreenStore
    let tab: String

    var body: some View {
        let entries = store.entries(of: tab)
        NavigationStack(
            path: Binding(
                get: { entries.dropFirst().map(\.instance) },
                set: { path in
                    // A back-swipe shortened the path: tell Rust which screen went.
                    guard path.count < entries.count - 1 else { return }
                    var popped = Centraid_Core_V1_NavPopped()
                    popped.tab = tab
                    popped.instance = entries[path.count + 1].instance
                    store.navigate(.popped(popped))
                })
        ) {
            if let root = entries.first {
                ProofScreenView(store: store, instance: root.instance)
                    .navigationDestination(for: UInt64.self) { instance in
                        ProofScreenView(store: store, instance: instance)
                    }
            }
        }
    }
}

struct ProofScreenView: View {
    @ObservedObject var store: ScreenStore
    let instance: UInt64

    var body: some View {
        if case .counter(let view)? = store.views[instance]?.kind {
            VStack(spacing: 16) {
                Text(view.title).font(.headline)
                content(view)
            }
            .padding()
        }
    }

    @ViewBuilder
    private func content(_ view: Centraid_Core_V1_CounterView) -> some View {
        switch view.content {
        case .loading(let loading)?:
            Text(loading.label)
        case .failed(let failure)?:
            VStack {
                Text(failure.sentence)
                Button(failure.remedy) {
                    var tap = Centraid_Core_V1_CounterEvent()
                    tap.kind = .retryTapped(Centraid_Core_V1_CounterRetryTapped())
                    store.send(instance, .counter(tap))
                }
            }
        case .data(let data)?:
            VStack {
                Text(data.countLabel).font(.largeTitle)
                Button(data.copyLabel) {
                    var tap = Centraid_Core_V1_CounterEvent()
                    tap.kind = .copyTapped(Centraid_Core_V1_CounterCopyTapped())
                    store.send(instance, .counter(tap))
                }
                if !data.notice.isEmpty { Text(data.notice).font(.footnote) }
            }
        case nil:
            EmptyView()
        }
    }
}
#endif
