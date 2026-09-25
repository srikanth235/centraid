import Foundation

/// THE READ LAW, AS A SWIFT ENUM — FOUR CASES, NEVER TWO (K5).
///
/// Loading, a failure with its sentence and remedy, a denial with its receipt,
/// or data. Swift's `Optional` would collapse two of these, exactly as Kotlin's
/// nullable would, so every screen decoder maps its state's `content` oneof onto
/// this and every view switches over it through `ReadStateView` — the one place
/// the four shapes are drawn.
///
/// `.denied` is the kit's `Denied` (title, body, receipt), the arm
/// `ReadContent.Denied` carries on the Kotlin side. A screen whose proto has no
/// denied arm simply never produces it.
enum ScreenContent<Value> {
    case loading(Bool)
    case failure(String, String)
    case denied(Centraid_Screen_V1_Denied)
    case data(Value)
}

extension ScreenContent {
    var isFailure: Bool {
        if case .failure = self { return true }
        return false
    }

    /// A DENIED ROOM DRAWS NO BAND — `AppPlace` reads this.
    var isDenied: Bool {
        if case .denied = self { return true }
        return false
    }

    /// The same read, with its data transformed; the other three cases pass
    /// through untouched.
    func map<Other>(_ transform: (Value) -> Other) -> ScreenContent<Other> {
        switch self {
        case let .loading(first): return .loading(first)
        case let .failure(sentence, remedy): return .failure(sentence, remedy)
        case let .denied(denied): return .denied(denied)
        case let .data(value): return .data(transform(value))
        }
    }

    /// A failure message, as the decoders spell it.
    static func failed(_ failure: Centraid_Screen_V1_ReadFailure) -> ScreenContent<Value> {
        .failure(failure.sentence, failure.remedy)
    }
}
