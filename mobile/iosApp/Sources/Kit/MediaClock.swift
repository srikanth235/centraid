import Foundation

/// A PLAYER'S TIME, as `m:ss` (and `h:mm:ss` past the hour): the one format a
/// photo tile's duration badge, the lightbox's scrubber and its spoken position
/// share, so a clip is the same length everywhere it is named. A length of a
/// stream the player has not loaded (NaN, infinite) is nought (#1135). A byte
/// count is the core's to word (`photos_bytes_many`), not a view's.
enum MediaClock {
    /// `1:04`, `12:07`, `1:02:03`; a negative length is `0:00`.
    static func of(seconds: Int64) -> String {
        let total = max(0, seconds)
        let hours = total / 3_600
        let minutes = (total % 3_600) / 60
        let rest = String(format: "%02d", Int(total % 60))
        return hours > 0
            ? "\(hours):" + String(format: "%02d", Int(minutes)) + ":" + rest
            : "\(minutes):" + rest
    }

    /// A player's fractional seconds, truncated; a stream that has not loaded is nought.
    static func of(seconds: Double) -> String {
        of(seconds: seconds.isFinite && seconds > 0 ? Int64(seconds) : 0)
    }
}
