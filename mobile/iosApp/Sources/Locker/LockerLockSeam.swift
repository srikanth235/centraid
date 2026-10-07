import LocalAuthentication
import SwiftUI

#if canImport(CentraidShared)
import CentraidShared
#endif

/// THE LOCK'S PLATFORM SEAM (#1047, D-5; `LockerGate.kt`'s `LockerLockBridge`
/// header, R-1047-L1): what the shell does that the machine cannot, and
/// nothing else.
///
/// 1. **The capability.** On entering Locker and on every return to the
///    foreground, `Attached(available, biometry)` from
///    `LAContext.canEvaluatePolicy(.deviceOwnerAuthentication)` and
///    `biometryType`.
/// 2. **The prompt.** When the wall's state carries a `prompt` whose token
///    has not been raised, ONE `evaluatePolicy(.deviceOwnerAuthentication,
///    localizedReason: prompt.reason)`, answered with `PromptAnswered(token,
///    outcome)`.
/// 3. **The lifecycle.** `.background` is `backgrounded()` — never
///    `.inactive`, which the prompt itself causes — and the way back is
///    `foregrounded()` and a fresh capability read.
///
/// Drawn at the app's root (`AppScreens.global`), so a prompt is raised
/// wherever the member is and a background relocks whatever was on screen.
struct LockerLockSeam: View {
    @ObservedObject var shell: ShellModel

    @Environment(\.scenePhase) private var scenePhase
    /// The last token this shell raised a prompt for: one prompt per token.
    @State private var raised: UInt64 = 0
    /// The scene reached `.background`, so the next `.active` is a return.
    @State private var wentBackground = false
    /// The wall's last `clipboardClear` acted on: once per new value.
    @State private var cleared: UInt64?

    private var state: Centraid_Screen_V1_LockerLockState {
        (try? Centraid_Screen_V1_LockerLockState(serializedBytes: shell.state(LockerScreens.lock))) ?? .init()
    }

    var body: some View {
        let state = state
        let token = state.hasPrompt ? state.prompt.token : 0
        Color.clear
            .onAppear {
                if cleared == nil { cleared = state.clipboardClear }
                raise(state)
            }
            .onChange(of: token) { _, _ in raise(state) }
            // THE MEMBER LOCKED: Locker's own copy comes off the pasteboard.
            .onChange(of: state.clipboardClear) { _, next in
                guard next > (cleared ?? 0) else { return }
                cleared = next
                LockerClipboardSeam.clearOwn()
            }
            .onChange(of: scenePhase) { _, phase in
                switch phase {
                case .background:
                    wentBackground = true
                    #if canImport(CentraidShared)
                    LockerScreens.lockBridge.backgrounded()
                    #endif
                case .active:
                    guard wentBackground else { return }
                    wentBackground = false
                    #if canImport(CentraidShared)
                    LockerScreens.lockBridge.foregrounded()
                    #endif
                    Self.attached(shell)
                case .inactive:
                    break
                @unknown default:
                    break
                }
            }
    }

    private func raise(_ state: Centraid_Screen_V1_LockerLockState) {
        guard state.hasPrompt, state.prompt.token != 0, state.prompt.token > raised else { return }
        let token = state.prompt.token
        raised = token
        LAContext().evaluatePolicy(.deviceOwnerAuthentication, localizedReason: state.prompt.reason) { ok, error in
            let outcome = ok ? Centraid_Screen_V1_LockerLockEvent.PromptAnswered.Outcome.succeeded : Self.outcome(error)
            DispatchQueue.main.async {
                shell.send(screen: LockerScreens.lock, event: Self.event {
                    $0.answered = .with { $0.token = token; $0.outcome = outcome }
                })
            }
        }
    }

    /// THE OUTCOME MAP (`LockerGate.kt`): a dismissal is not a failure.
    static func outcome(_ error: Swift.Error?) -> Centraid_Screen_V1_LockerLockEvent.PromptAnswered.Outcome {
        guard let error = error as? LAError else { return .failed }
        switch error.code {
        case .userCancel, .systemCancel, .appCancel: return .cancelled
        case .passcodeNotSet: return .unavailable
        case .biometryLockout: return .lockedOut
        default: return .failed
        }
    }

    /// WHAT THIS PHONE CAN DO, told to the gate: a passcode is set, and which
    /// biometric stands in front of it.
    @MainActor
    static func attached(_ shell: ShellModel) {
        let context = LAContext()
        var error: NSError?
        let available = context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error)
        let biometry: Centraid_Screen_V1_LockerBiometry
        switch context.biometryType {
        case .faceID: biometry = .face
        case .touchID: biometry = .touch
        case .opticID: biometry = .optic
        default: biometry = .passcode
        }
        shell.send(screen: LockerScreens.lock, event: event {
            $0.attached = .with { $0.available = available; $0.biometry = biometry }
        })
    }

    static func event(_ build: (inout Centraid_Screen_V1_LockerLockEvent) -> Void) -> Data {
        var event = Centraid_Screen_V1_LockerLockEvent()
        build(&event)
        return event.encoded
    }
}
