import Foundation

/// The Swift face of the core (#1020, D-1020-E2).
///
/// It wraps `CentraidShared`'s `CentraidCore`, which itself wraps the five C
/// symbols through cinterop. **This file holds no pointer**: the Kotlin binding
/// copies every answer out of the library's buffer and frees it in the same
/// breath (`CONTRACT.md` clause 1), so there is nothing here for a
/// `Data(bytesNoCopy:)` deallocator to get wrong — which clause 1 names as the
/// mistake to avoid, since Rust's allocator is not the C one.
///
/// ## The one rule a Swift call site must keep
///
/// **Never call this from the main thread.** `call` is synchronous and holds a
/// SQLite read transaction; on a device that is the freeze. The Kotlin binding
/// asserts `NSThread.isMainThread` in its iOS actual, so a `.task { }` that
/// forgot will crash in debug rather than hang in release — and this wrapper's
/// API is `async` throughout so the natural call site is already off the main
/// actor.
///
/// ## What is NOT here
///
/// A retry, a cache and a queue. The core owns the vault, the outbox and the
/// event stream; a Swift-side cache would be a second answer to "what is in the
/// vault" and the census's seam 3 is what happens when two answers disagree.
enum CentraidCoreFacade {
    /// Open the core, on a background executor, with the digest this build
    /// recorded.
    ///
    /// `expectedDigest` comes from the Xcode build settings that
    /// `lane-prebuilt-core.yml` stamps, and a mismatch is a REFUSAL: a stale
    /// core starts, answers, and answers from a schema the shell stopped
    /// speaking (#1020 Artifacts).
    static func open(databasePath: String, expectedDigest: String) async throws {
        throw CentraidCoreError.unwired
    }

    /// One request, one answer. `async` so the call site cannot be the main
    /// thread by accident.
    static func call(_ request: Data) async throws -> Data {
        throw CentraidCoreError.unwired
    }
}

enum CentraidCoreError: Error {
    /// The framework is not linked yet. See `mobile/README.md`.
    case unwired
}
