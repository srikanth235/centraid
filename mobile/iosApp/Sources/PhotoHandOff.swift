import Foundation
import ImageIO

/// WHAT THE LIGHTBOX NEEDS OF THE ORIGINAL'S FILE THAT ONLY THE PLATFORM CAN READ
/// (#1135): its camera. The hand-offs this file used to carry (send a copy, save to
/// Photos, copy a location) are Rust's now: `photos.lightbox` asks for
/// `ExportOriginals` and `ClipboardSet`, and the shell performs them.
enum PhotoHandOff {
    /// THE CAMERA, OUT OF THE ORIGINAL'S OWN HEADER. The vault's row cannot
    /// say, and a camera writes its make and model
    /// into the file it makes. Nil for a file with neither.
    static func camera(atPath path: String) -> String? {
        guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let tiff = properties[kCGImagePropertyTIFFDictionary] as? [CFString: Any]
        else { return nil }
        let make = (tiff[kCGImagePropertyTIFFMake] as? String ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let model = (tiff[kCGImagePropertyTIFFModel] as? String ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        // "Apple iPhone 15 Pro", never "Apple Apple iPhone…".
        let name: String
        if model.isEmpty {
            name = make
        } else if make.isEmpty || model.lowercased().hasPrefix(make.lowercased()) {
            name = model
        } else {
            name = "\(make) \(model)"
        }
        return name.isEmpty ? nil : name
    }
}
