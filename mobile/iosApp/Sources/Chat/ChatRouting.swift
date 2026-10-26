import Foundation

/// WHICH APP A PAGE BELONGS TO, for the chat's scope (#1135): the app id a route's
/// screen name begins with (`notes.editor` is Notes'). Rust keeps the ids that are
/// scopes and drops the rest (`chat::scope_of`), so this names, and never filters.
enum ChatRouting {
    /// The app id an opened route names, or nil.
    static func app(of route: ShellModel.Route) -> String? {
        switch route {
        case let .rust(entry):
            let app = entry.route.screen.split(separator: ".").first.map(String.init) ?? ""
            return app.isEmpty ? nil : app
        }
    }
}
