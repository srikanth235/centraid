import Foundation


/// WHAT IS LEFT OF THE CHAT'S ROUTING ON iOS (#1135).
///
/// A chat card's tap is Rust's (`ChatEvent.card_tapped`; the page opens through an `OpenRoute`
/// effect, from `shell/row_routes.rs`), and a search hit is Rust's too. What remains is the app id
/// a pushed route names, so the Chat tab can scope itself to the app the member last had open.
enum ChatRouting {
    /// The app id an opened route names, or nil. Rust keeps the ids that are scopes and drops the
    /// rest (`chat::scope_of`).
    static func app(of route: ShellModel.Route) -> String? {
        switch route {
        case let .screen(identifier, _):
            let app = identifier.split(separator: ".").first.map(String.init) ?? ""
            return app.isEmpty ? nil : app
        case let .rust(entry):
            return RustScreens.tab(for: entry.route)
        }
    }
}
