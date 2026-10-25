import Foundation

/// THE PLATFORM WORK OF PHOTOS' ONE-PHOTOGRAPH PAGES (#1135), performed for
/// `ScreenStore`: the camera the original's header names, and the editor's pixel
/// work. Rust asks and decides what the answer means; this only does.
enum PhotoEffects {
    /// `ReadCamera`: the file's EXIF make and model. An unreadable header is an
    /// empty camera and never a failure.
    static func camera(_ read: Centraid_Core_V1_ReadCamera) async -> Centraid_Core_V1_EffectResult.OneOf_Outcome {
        let path = read.path
        let named = await Task.detached(priority: .utility) { PhotoHandOff.camera(atPath: path) ?? "" }.value
        var answer = Centraid_Core_V1_CameraRead()
        answer.camera = named
        return .cameraRead(answer)
    }

    #if canImport(UIKit)
    /// `RenderEdit`: decode the original, apply the plan, encode a JPEG, stream it
    /// through the stage door and answer the staged hash. A failure is
    /// `EffectFailed`, never silence.
    static func renderEdit(
        _ render: Centraid_Core_V1_RenderEdit,
        core: any ScreenCore
    ) async -> Centraid_Core_V1_EffectResult.OneOf_Outcome {
        let made = await Task.detached(priority: .userInitiated) {
            PhotoEditRenderer.render(
                sourcePath: render.sourcePath,
                plan: render.plan,
                quality: Int(render.jpegQualityPercent)
            )
        }.value
        guard case let .made(path, width, height) = made else {
            return failed("the edit could not be drawn")
        }
        defer { try? FileManager.default.removeItem(atPath: path) }
        guard let bytes = try? Data(contentsOf: URL(fileURLWithPath: path)) else {
            return failed("the edited photo could not be read")
        }
        guard case let .staged(handle) = await StageDoor.stage(core, bytes: bytes, StageDoor.Begin(mediaType: "image/jpeg")) else {
            return failed("the edited photo could not be staged")
        }
        var done = Centraid_Core_V1_EditRendered()
        done.contentHash = handle.contentHash
        done.mediaType = "image/jpeg"
        done.width = UInt32(width)
        done.height = UInt32(height)
        done.byteSize = handle.byteSize
        return .editRendered(done)
    }

    private static func failed(_ reason: String) -> Centraid_Core_V1_EffectResult.OneOf_Outcome {
        var failure = Centraid_Core_V1_EffectFailed()
        failure.reason = reason
        return .failed(failure)
    }
    #endif
}
