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
        guard let handle = await stage(bytes, mediaType: "image/jpeg", core: core) else {
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

    /// THE STAGE DOOR, in three frames: begin, the chunks the core's ceiling
    /// allows, end. The core hashes and stores; the screen's `upload` claims.
    private static func stage(
        _ bytes: Data,
        mediaType: String,
        core: any ScreenCore
    ) async -> Centraid_Core_V1_StageHandle? {
        func send(_ kind: Centraid_Core_V1_StageRequest.OneOf_Kind) async -> Centraid_Core_V1_StageResponse? {
            var stage = Centraid_Core_V1_StageRequest()
            stage.kind = kind
            var request = Centraid_Core_V1_Request()
            request.kind = .stage(stage)
            guard let response = try? await core.call(request), case let .stage(answer)? = response.kind
            else { return nil }
            return answer
        }
        var begin = Centraid_Core_V1_StageBegin()
        begin.mediaType = mediaType
        begin.byteSize = UInt64(bytes.count)
        begin.source = .owned
        guard let begun = await send(.begin(begin)), case let .begun(opened)? = begun.kind else { return nil }
        let ceiling = max(1, Int(opened.chunkBytes))
        var sequence: UInt64 = 0
        var offset = 0
        while offset < bytes.count {
            let end = min(bytes.count, offset + ceiling)
            var chunk = Centraid_Core_V1_StageChunk()
            chunk.stagingID = opened.stagingID
            chunk.seq = sequence
            chunk.payload = bytes.subdata(in: offset..<end)
            guard await send(.chunk(chunk)) != nil else { return nil }
            sequence += 1
            offset = end
        }
        var finish = Centraid_Core_V1_StageEnd()
        finish.stagingID = opened.stagingID
        guard let ended = await send(.end(finish)), case let .handle(handle)? = ended.kind else { return nil }
        return handle
    }

    private static func failed(_ reason: String) -> Centraid_Core_V1_EffectResult.OneOf_Outcome {
        var failure = Centraid_Core_V1_EffectFailed()
        failure.reason = reason
        return .failed(failure)
    }
    #endif
}
