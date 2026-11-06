/// Retain the latest scene state while the screen runtime starts. A background
/// launch may have no scene; it must not invent a foreground permission prompt.
@MainActor
final class ScreenLifecycle {
    private var latest: Bool?
    private var receive: (@MainActor (Bool) -> Void)?

    func changed(foreground: Bool) {
        latest = foreground
        receive?(foreground)
    }

    /// Attach after the runtime's initial snapshot has opened its services.
    func attach(_ receive: @escaping @MainActor (Bool) -> Void) {
        self.receive = receive
        if let latest { receive(latest) }
    }
}
