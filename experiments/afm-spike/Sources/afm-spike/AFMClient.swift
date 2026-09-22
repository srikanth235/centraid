// EVERY FoundationModels SYMBOL IN THE SPIKE LIVES IN THIS FILE.
//
// That is deliberate. The harness was written on Linux against no SDK, so a
// handful of API spellings are recalled rather than checked. Isolating them
// means a compile error is fixed in one place and nothing else moves. Each
// spot the author is unsure of carries an `API?` comment naming the two most
// likely spellings; `HANDOFF.md` §"If it fails to compile" lists them all.
//
// What this file does, and nothing more:
//
//   * reports `SystemLanguageModel.default.availability`;
//   * opens one `LanguageModelSession` per CORPUS SESSION, with the generated
//     instructions, and throws it away at the session boundary;
//   * Stage A — a static `@Generable` `Intent`: move, head, kind, and whether
//     the turn leans on the previous one;
//   * Stage B — a `DynamicGenerationSchema` built for THAT kind alone, so the
//     4 096-token context carries one board's fields and not all 172;
//   * returns both stages' RAW output as JSON strings. Nothing here renders,
//     parses or repairs a canonical: `render_frames.py` does that, after the
//     raw output has already been written to disk.

import Foundation
import FoundationModels

// MARK: - Stage A

/// What the turn is, before any board-specific slot exists.
@Generable
struct Intent {
    @Guide(description: "new, refine, substitute, act or undo. refine and "
           + "substitute and act all lean on the previous turn.")
    var move: String

    @Guide(description: "show for a list; count/sum/min/max/project for a "
           + "number or one field; balance for who owes whom; same for an "
           + "identity question; write for a command; nothing when the "
           + "person withdrew; refuse when the vault cannot hold it.")
    var head: String

    @Guide(description: "Which board the turn is about. Use things only when "
           + "the person names no board at all.")
    var kind: String

    @Guide(description: "true when the turn only makes sense against the "
           + "previous turn.")
    var needsPrevious: Bool
}

// MARK: - the client

public struct StageResult: Sendable {
    public var stageA: String = ""
    public var stageB: String = ""
    public var error: String = ""
    public var msA: Int = 0
    public var msB: Int = 0
}

public final class AFMClient {
    private var session: LanguageModelSession?
    private var openSessionKey: String?

    /// Greedy so a re-run of the same corpus gives the same JSONL.
    // API? `GenerationOptions(sampling: .greedy)`. If the label moved, the
    // other spelling seen in the SDK is
    // `GenerationOptions(sampling: .greedy, temperature: 0)`.
    private let options = GenerationOptions(sampling: .greedy)

    public init() {}

    // MARK: availability

    /// A short machine-readable string for the JSONL header, or throws.
    public static func requireAvailable() throws -> String {
        let model = SystemLanguageModel.default
        switch model.availability {
        case .available:
            return "available"
        case .unavailable(let reason):
            // API? the reason cases are
            // `.deviceNotEligible`, `.appleIntelligenceNotEnabled`,
            // `.modelNotReady`. They are matched by their DESCRIPTION here
            // rather than by case, so a renamed or added case still prints
            // something useful instead of failing to compile.
            throw HarnessError.modelUnavailable("\(reason)")
        @unknown default:
            throw HarnessError.modelUnavailable("unknown availability")
        }
    }

    public static func osBuild() -> String {
        let version = ProcessInfo.processInfo.operatingSystemVersionString
        return version
    }

    // MARK: sessions

    /// One session per CORPUS session, reset at the boundary. The transcript
    /// is never relied on: the previous canonical is threaded in the prompt.
    private func session(for key: String) -> LanguageModelSession {
        if let session, openSessionKey == key {
            return session
        }
        // API? `LanguageModelSession(instructions:)` takes an
        // `@InstructionsBuilder` closure; a bare String literal satisfies it.
        // If it does not, the other spelling is
        // `LanguageModelSession(instructions: Instructions(Doctrine.text))`.
        let fresh = LanguageModelSession(instructions: { Doctrine.text })
        session = fresh
        openSessionKey = key
        return fresh
    }

    public func endSession() {
        session = nil
        openSessionKey = nil
    }

    // MARK: the two stages

    public func run(sessionKey: String, previous: String,
                    request: String) async -> StageResult {
        var result = StageResult()
        let model = session(for: sessionKey)

        // ---- Stage A
        let startA = DispatchTime.now()
        var intent: Intent
        do {
            let response = try await model.respond(
                to: Prompt.stageA(previous: previous, request: request),
                generating: Intent.self,
                options: options)
            intent = response.content
            result.msA = Self.elapsed(since: startA)
            result.stageA = Self.json([
                "move": intent.move, "head": intent.head,
                "kind": intent.kind, "needsPrevious": intent.needsPrevious,
            ])
        } catch {
            result.msA = Self.elapsed(since: startA)
            result.error = Self.describe(error, stage: "A")
            return result
        }

        let head = Self.normaliseHead(intent.head)
        let kind = Vocab.kinds.contains(intent.kind) ? intent.kind : "things"

        // A turn that asks for nothing at all has no Stage B: the frame is
        // complete already. Writing it here keeps the two files' shapes equal.
        if head == "nothing" {
            result.stageB = Self.json(["head": "nothing", "move": intent.move])
            return result
        }

        // ---- Stage B
        let startB = DispatchTime.now()
        do {
            let schema = try Self.schema(kind: kind, head: head)
            let response = try await model.respond(
                to: Prompt.stageB(previous: previous, request: request,
                                  head: head, kind: kind),
                schema: schema,
                options: options)
            result.msB = Self.elapsed(since: startB)
            // API? `GeneratedContent.jsonString`. If that property is spelled
            // differently the other candidate is `String(describing:)` over
            // the content, which is NOT JSON — prefer fixing the spelling.
            result.stageB = response.content.jsonString
        } catch {
            result.msB = Self.elapsed(since: startB)
            result.error = Self.describe(error, stage: "B")
        }
        return result
    }

    // MARK: schema construction

    /// Build the Stage-B schema for one kind from `FrameSchema`'s pure-Swift
    /// description. Every enum in it came out of the ontology through
    /// `gen_vocab.py`, so an invented field or command name is impossible.
    static func schema(kind: String, head: String) throws -> GenerationSchema {
        let specs = FrameSchema.objects(kind: kind, head: head)
        var built: [DynamicGenerationSchema] = []
        for spec in specs {
            var properties: [DynamicGenerationSchema.Property] = []
            for slot in spec.slots {
                let inner: DynamicGenerationSchema
                switch slot.source {
                case .span:
                    inner = DynamicGenerationSchema(type: String.self)
                case .anyOf(let choices):
                    // API? `DynamicGenerationSchema(name:anyOf:)` where the
                    // array is `[String]`. The other spelling seen is
                    // `DynamicGenerationSchema(name:description:anyOf:)`.
                    inner = DynamicGenerationSchema(
                        name: "\(spec.name)_\(slot.name)", anyOf: choices)
                case .integer:
                    inner = DynamicGenerationSchema(type: Int.self)
                case .boolean:
                    inner = DynamicGenerationSchema(type: Bool.self)
                case .object(let name):
                    // A reference to another named schema in `dependencies`.
                    // API? `DynamicGenerationSchema(referenceTo:)`. The other
                    // spelling is `DynamicGenerationSchema(name:)`.
                    inner = DynamicGenerationSchema(referenceTo: name)
                case .array(let name, let max):
                    inner = DynamicGenerationSchema(
                        arrayOf: DynamicGenerationSchema(referenceTo: name),
                        minimumElements: 1, maximumElements: max)
                }
                properties.append(DynamicGenerationSchema.Property(
                    name: slot.name, description: slot.guidance,
                    schema: inner, isOptional: slot.optional))
            }
            built.append(DynamicGenerationSchema(
                name: spec.name,
                description: "One part of the form.",
                properties: properties))
        }
        guard let root = built.last else {
            throw HarnessError.usage("no root schema for \(kind)")
        }
        // API? `GenerationSchema(root:dependencies:)`, throwing.
        return try GenerationSchema(root: root,
                                    dependencies: Array(built.dropLast()))
    }

    // MARK: plumbing

    static func normaliseHead(_ raw: String) -> String {
        let head = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        return StageASlots.heads.contains(head) ? head : "show"
    }

    static func elapsed(since start: DispatchTime) -> Int {
        Int((DispatchTime.now().uptimeNanoseconds
             - start.uptimeNanoseconds) / 1_000_000)
    }

    /// The error's own words, classified so `summarise.py` can count them.
    /// NOTHING is retried and nothing is repaired: an error is a failed turn.
    static func describe(_ error: Error, stage: String) -> String {
        if let generation = error as? LanguageModelSession.GenerationError {
            switch generation {
            case .guardrailViolation:
                return "\(stage):guardrailViolation"
            case .exceededContextWindowSize:
                return "\(stage):exceededContextWindowSize"
            case .unsupportedLanguageOrLocale:
                return "\(stage):unsupportedLanguageOrLocale"
            case .decodingFailure:
                return "\(stage):decodingFailure"
            case .assetsUnavailable:
                return "\(stage):assetsUnavailable"
            case .unsupportedGuide:
                return "\(stage):unsupportedGuide"
            case .rateLimited:
                return "\(stage):rateLimited"
            case .concurrentRequests:
                return "\(stage):concurrentRequests"
            @unknown default:
                return "\(stage):generationError(\(generation))"
            }
        }
        return "\(stage):\(type(of: error))(\(error))"
    }

    static func json(_ object: [String: Any]) -> String {
        guard let data = try? JSONSerialization.data(
            withJSONObject: object, options: [.sortedKeys]),
            let text = String(data: data, encoding: .utf8) else {
            return "{}"
        }
        return text
    }
}
