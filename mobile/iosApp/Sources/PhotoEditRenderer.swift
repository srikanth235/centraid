import Foundation
import ImageIO

#if canImport(UIKit)
import CoreImage
import UIKit

import CentraidShared

/// THE iOS HALF OF v0's `photo-edit-save.ts`: decode, draw, encode (#1029,
/// photos port).
///
/// On the platform because decoding a photograph is platform I/O. What happens
/// to the JPEG afterwards — staging it and committing `media.add_asset` over it
/// — is `PhotoEditorBridge`'s, and it is the camera roll's own path.
///
/// **FROM DATA, NOT FROM THE PATH**, for `ContentImage`'s reason: a
/// content-addressed file is named by its digest and has no extension, and
/// ImageIO's sniffing of the bytes is the only thing that can be right.
enum PhotoEditRenderer {
    /// What `render` made, or why it could not.
    enum Rendered {
        case made(path: String, width: Int, height: Int)
        case refused(String)
    }

    /// A stage-sized decode, ORIENTED. Never the full original: that is Save's.
    static func preview(path: String) -> UIImage? {
        guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil)
        else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            // THE CAMERA'S OWN TURN, applied before anything the member did,
            // exactly as the renderer applies it below.
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: Int(PhotoEditorMachine.shared.PREVIEW_EDGE),
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
        else { return nil }
        return UIImage(cgImage: image)
    }

    /// FLIP, ROTATE, THEN CROP — the crop is in fractions of the ROTATED frame
    /// (v0's `renderEdit`), and the order is the stage's, so what is saved is
    /// what was on screen.
    ///
    /// Core Image's y axis points UP and the stage's points down, so a
    /// clockwise turn on screen is a NEGATIVE angle here, and the crop's top is
    /// measured from the extent's maximum y. JPEG at 0.92, v0's quality and the
    /// web editor's.
    static func render(sourcePath: String, plan: Centraid_Screen_V1_PhotoEditPlan) -> Rendered {
        guard let bytes = try? Data(contentsOf: URL(fileURLWithPath: sourcePath)),
              let decoded = CIImage(data: bytes, options: [.applyOrientationProperty: true])
        else { return .refused(PhotosCopy.shared.PHOTOS_EDIT_CANNOT_OPEN) }

        var image = decoded.transformed(
            by: CGAffineTransform(translationX: -decoded.extent.minX, y: -decoded.extent.minY)
        )
        let centre = CGPoint(x: image.extent.midX, y: image.extent.midY)
        func about(_ transform: CGAffineTransform) -> CGAffineTransform {
            CGAffineTransform(translationX: -centre.x, y: -centre.y)
                .concatenating(transform)
                .concatenating(CGAffineTransform(translationX: centre.x, y: centre.y))
        }
        switch plan.flip {
        case .horizontal: image = image.transformed(by: about(CGAffineTransform(scaleX: -1, y: 1)))
        case .vertical: image = image.transformed(by: about(CGAffineTransform(scaleX: 1, y: -1)))
        default: break
        }
        let degrees = Int(plan.quarters % 4) * 90 + Int(plan.straighten)
        if degrees != 0 {
            let radians = -CGFloat(degrees) * .pi / 180
            image = image.transformed(by: about(CGAffineTransform(rotationAngle: radians)))
        }
        // THE ROTATED FRAME, whole pixels. A quarter turn lands a hair off the
        // pixel grid from floating-point trig; ROUNDED and not `integral`,
        // which would grow the frame by a transparent pixel on each side and
        // put the crop's rectangle one pixel off `PhotoEditorMachine.cropPixels`.
        let extent = image.extent
        let frame = CGRect(
            x: extent.minX.rounded(),
            y: extent.minY.rounded(),
            width: extent.width.rounded(),
            height: extent.height.rounded()
        )
        image = image.cropped(to: frame)

        // WHERE THE CROP LANDS, from the shared machine: its clamp and its
        // half-up round, so one crop is one rectangle on both shells.
        let pixels = PhotoEditorMachine.shared.cropRect(
            hasCrop: plan.hasCrop,
            x: plan.crop.x,
            y: plan.crop.y,
            w: plan.crop.w,
            h: plan.crop.h,
            width: Int32(frame.width),
            height: Int32(frame.height)
        )
        image = image.cropped(
            to: CGRect(
                x: frame.minX + CGFloat(pixels.x),
                y: frame.maxY - CGFloat(pixels.y + pixels.h),
                width: CGFloat(pixels.w),
                height: CGFloat(pixels.h)
            )
        )

        let context = CIContext()
        let space = image.colorSpace ?? CGColorSpace(name: CGColorSpace.sRGB)!
        guard let jpeg = context.jpegRepresentation(
            of: image,
            colorSpace: space,
            options: [
                CIImageRepresentationOption(
                    rawValue: kCGImageDestinationLossyCompressionQuality as String
                ): Double(PhotoEditorMachine.shared.JPEG_QUALITY_PERCENT) / 100,
            ]
        ) else { return .refused(couldNotDraw) }
        let file = FileManager.default.temporaryDirectory
            .appendingPathComponent("edit-\(UUID().uuidString).jpg")
        do {
            try jpeg.write(to: file, options: .atomic)
        } catch {
            return .refused(couldNotDraw)
        }
        return .made(path: file.path, width: Int(image.extent.width), height: Int(image.extent.height))
    }

    private static let couldNotDraw = PhotosCopy.shared.PHOTOS_EDIT_CANNOT_DRAW
}
#endif
