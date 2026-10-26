import Foundation
import SwiftProtobuf

/// THE STAGE DOOR, STREAMED (#1025 S5; #1080 ruling 6; #1135): bytes go in,
/// the core names them.
///
/// Three frames: `begin` declares the media type, the length (0 when the
/// platform does not know it before the read) and where the bytes live;
/// `chunk` is numbered from zero and sized by the core's own ceiling
/// (`StageBegun.chunk_bytes`, never this shell's guess); `end` answers the
/// handle. A BLAKE3 is the vault's identity and no Apple API computes one, so
/// the shell never names its own bytes. A refusal ends the stage where it
/// happened; there is no resume, and the core's `already_held` makes a retry
/// cheap. On the front core a stage goes to the vault in front.
enum StageDoor {
    /// A finished stage, or the core's typed refusal (nil when it gave none).
    enum Outcome {
        case staged(Centraid_Core_V1_StageHandle)
        case refused(Centraid_Core_V1_Error?)
    }

    /// Where the bytes live, and what they are a rendering of.
    struct Begin {
        var mediaType: String
        var byteSize: UInt64 = 0
        /// A PhotoKit local identifier with its role suffix, for bytes the
        /// operating system's library holds: no second copy is kept.
        var osRef = ""
        /// A derivative: the original's content hash (64 hex) and the tier.
        var forHash = ""
        var tier = ""
    }

    /// Stream into `core`. `read` answers the next slice of at most `max`
    /// bytes, empty at the end, or throws when the source broke: a callback,
    /// so a 900 MB video never exists in memory at once.
    static func stage(
        _ core: any ScreenCore,
        _ begin: Begin,
        read: (Int) async throws -> Data
    ) async -> Outcome {
        var frame = Centraid_Core_V1_StageBegin()
        frame.mediaType = begin.mediaType.isEmpty ? "application/octet-stream" : begin.mediaType
        frame.byteSize = begin.byteSize
        frame.source = begin.osRef.isEmpty ? .owned : .osLibrary
        frame.osRef = begin.osRef
        frame.forHash = raw(begin.forHash)
        frame.tier = begin.tier
        let begun: Centraid_Core_V1_StageBegun
        switch await send(core, .begin(frame)) {
        case let .success(.begun(answer)?): begun = answer
        case let .failure(error): return .refused(error)
        default: return .refused(nil)
        }
        let chunkBytes = max(Int(begun.chunkBytes), 1)
        var seq: UInt64 = 0
        while true {
            let slice: Data
            do {
                slice = try await read(chunkBytes)
            } catch {
                return .refused(nil)
            }
            if slice.isEmpty { break }
            var chunk = Centraid_Core_V1_StageChunk()
            chunk.stagingID = begun.stagingID
            chunk.seq = seq
            chunk.payload = slice
            if case let .failure(error) = await send(core, .chunk(chunk)) { return .refused(error) }
            seq += 1
        }
        var end = Centraid_Core_V1_StageEnd()
        end.stagingID = begun.stagingID
        switch await send(core, .end(end)) {
        case let .success(.handle(handle)?): return .staged(handle)
        case let .failure(error): return .refused(error)
        default: return .refused(nil)
        }
    }

    /// A file this app owns, streamed from its path. `progress` hears the bytes sent so far.
    static func stage(
        _ core: any ScreenCore,
        file path: String,
        mediaType: String,
        progress: ((UInt64, UInt64) -> Void)? = nil
    ) async -> Outcome {
        guard let handle = FileHandle(forReadingAtPath: path) else { return .refused(nil) }
        defer { try? handle.close() }
        let size = ((try? FileManager.default.attributesOfItem(atPath: path)[.size]) as? NSNumber)?.uint64Value ?? 0
        var sent: UInt64 = 0
        return await stage(core, Begin(mediaType: mediaType, byteSize: size)) { max in
            let slice = try handle.read(upToCount: max) ?? Data()
            sent += UInt64(slice.count)
            progress?(sent, size)
            return slice
        }
    }

    /// Bytes already in memory (a rendered derivative), in the core's slices.
    static func stage(_ core: any ScreenCore, bytes: Data, _ begin: Begin) async -> Outcome {
        var begin = begin
        begin.byteSize = UInt64(bytes.count)
        var offset = 0
        return await stage(core, begin) { max in
            let end = min(offset + max, bytes.count)
            defer { offset = end }
            return bytes.subdata(in: offset ..< end)
        }
    }

    private static func send(
        _ core: any ScreenCore,
        _ kind: Centraid_Core_V1_StageRequest.OneOf_Kind
    ) async -> Result<Centraid_Core_V1_StageResponse.OneOf_Kind?, Centraid_Core_V1_Error?> {
        var stage = Centraid_Core_V1_StageRequest()
        stage.kind = kind
        var request = Centraid_Core_V1_Request()
        request.kind = .stage(stage)
        do {
            let response = try await core.call(request, lane: .bulk)
            guard case let .stage(answer)? = response.kind else { return .failure(nil) }
            return .success(answer.kind)
        } catch let Core.Failure.refused(error) {
            return .failure(error)
        } catch {
            return .failure(nil)
        }
    }

    /// 64 hex characters as the 32 raw bytes the wire carries; empty for anything else.
    static func raw(_ hex: String) -> Data {
        guard hex.count == 64 else { return Data() }
        var bytes = Data(capacity: 32)
        var index = hex.startIndex
        while index < hex.endIndex {
            let next = hex.index(index, offsetBy: 2)
            guard let byte = UInt8(hex[index ..< next], radix: 16) else { return Data() }
            bytes.append(byte)
            index = next
        }
        return bytes
    }
}
