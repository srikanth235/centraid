import SwiftUI

#if canImport(UIKit)
import UIKit
#endif

/// A PHOTOGRAPH FROM THE VAULT'S OWN FILE STORE (#1020, D-1020-DC1).
///
/// The core answers a byte-door request with a PATH — a file inside this app's
/// own container — rather than with bytes, so range reads and caching stay the
/// platform's and the core never buffers a photograph so a view can buffer it
/// again. This is the view that opens one.
///
/// **Decoded once, kept briefly.** A SwiftUI body runs on every layout pass,
/// and `UIImage(contentsOfFile:)` decodes the file every time it is called — a
/// four-cell mosaic re-decoding four PNGs on each pass is four decodes per
/// frame. `NSCache` is the right shape for this and not a dictionary: it is
/// purged under memory pressure, which is exactly the trade a thumbnail wants.
///
/// **A path that will not open draws the placeholder**, never an error and
/// never a broken-image glyph: a cell the member cannot see is a cell, and the
/// tile already says how many photographs there are.
struct ContentImage: View {
    let path: String

    var body: some View {
        #if canImport(UIKit)
        if let image = ImageCache.shared.image(at: path) {
            Image(uiImage: image)
                .resizable()
                // FILL AND CLIP, never fit. A mosaic cell is a fixed rectangle
                // and a fitted photograph would letterbox inside it — four
                // cells with four different grounds read as a broken grid
                // rather than as a mosaic.
                .scaledToFill()
                .allowsHitTesting(false)
                // HIDDEN FROM ASSISTIVE TECH, and the Compose half says the
                // same. The mosaic is decoration over a count a screen reader
                // already reads ("19 photographs"); four unlabelled images
                // announced one by one would be four rows of nothing.
                .accessibilityHidden(true)
        } else {
            Color.clear
        }
        #else
        Color.clear
        #endif
    }
}

#if canImport(UIKit)
/// Decoded thumbnails, by path.
///
/// Keyed by path rather than by asset id because the path is what was opened:
/// two assets over one sha share a file and should share one decode, which
/// keying on the asset would miss.
private final class ImageCache {
    static let shared = ImageCache()

    private let cache = NSCache<NSString, UIImage>()

    private init() {
        // A mosaic is four cells and a grid is a screenful; a hundred decoded
        // thumbnails is the working set of a scroll, and `NSCache` gives them
        // all back the moment the system asks.
        cache.countLimit = 100
    }

    func image(at path: String) -> UIImage? {
        let key = path as NSString
        if let cached = cache.object(forKey: key) { return cached }
        // FROM DATA, NOT FROM THE PATH. `UIImage(contentsOfFile:)` leans on the
        // path EXTENSION to choose a decoder, and a content-addressed file is
        // named by its digest and has none — so it returns nil for every
        // photograph in the store, silently, and the mosaic draws four empty
        // cells over bytes that are sitting right there. `UIImage(data:)`
        // sniffs the bytes, which is the only thing that can be right when the
        // name is a hash.
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
              let image = UIImage(data: data)
        else { return nil }
        cache.setObject(image, forKey: key)
        return image
    }
}
#endif
