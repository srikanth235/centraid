// The CLI.
//
//   afm-spike --map <grammar/map.json> --mode teacher|free --out <jsonl>
//             [--limit N] [--corpus suite|blind|holdout|all]
//             [--renderer render_frames.py] [--python python3]
//
// One line per turn, written BEFORE anything renders or parses it:
//
//   { corpus, session, turn, mode, model, os, availability, request,
//     prev_used, stageA, stageB, error, ms_a, ms_b, canonical: "" }
//
// `canonical` is left empty on purpose. `render_frames.py` fills it, on the
// same machine or on any other, from `stageB` — so the model's raw output is
// on disk untouched and the rendering is reproducible without the model.
//
// THE ONE EXCEPTION, and it is not an exception to that rule. `--mode free`
// has to thread the harness's OWN previous canonical into the next prompt,
// and only Python can render one. So free mode opens `render_frames.py
// --serve` as a co-process and asks it, per turn, what the frame it just got
// renders to. The answer goes into the NEXT prompt and into `prev_used`; the
// row's own `canonical` still stays empty and is still filled by the batch
// pass afterwards, from the same `stageB` bytes.

import Foundation

// MARK: - arguments

var mapPath = ""
var modeRaw = ""
var outPath = ""
var limit: Int?
var corpusName = "all"
var rendererPath = "render_frames.py"
var pythonPath = "python3"

var arguments = Array(CommandLine.arguments.dropFirst())
var index = 0
while index < arguments.count {
    let flag = arguments[index]
    let value = index + 1 < arguments.count ? arguments[index + 1] : ""
    switch flag {
    case "--map": mapPath = value; index += 1
    case "--mode": modeRaw = value; index += 1
    case "--out": outPath = value; index += 1
    case "--limit": limit = Int(value); index += 1
    case "--corpus": corpusName = value; index += 1
    case "--renderer": rendererPath = value; index += 1
    case "--python": pythonPath = value; index += 1
    default:
        FileHandle.standardError.write(Data("unknown argument \(flag)\n".utf8))
        exit(2)
    }
    index += 1
}

guard !mapPath.isEmpty, !outPath.isEmpty, let mode = Mode(rawValue: modeRaw) else {
    FileHandle.standardError.write(Data(
        "usage: afm-spike --map <map.json> --mode teacher|free --out <jsonl>"
        + " [--limit N] [--corpus suite|blind|holdout|all]\n".utf8))
    exit(2)
}

let corpora: Set<String>
switch corpusName {
case "all": corpora = ["suite", "blind", "holdout"]
case "suite", "blind", "holdout": corpora = [corpusName]
default:
    FileHandle.standardError.write(Data("--corpus must be suite, blind, holdout or all\n".utf8))
    exit(2)
}

// MARK: - the renderer co-process (free mode only)

/// `render_frames.py --serve`: one flat frame in, one canonical out.
/// It is the SAME code path the batch render uses, so free mode's threaded
/// context cannot differ from what the scored file says the harness produced.
final class Renderer {
    private let process = Process()
    private let toPython = Pipe()
    private let fromPython = Pipe()
    private var buffer = Data()

    init(python: String, script: String) throws {
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = [python, script, "--serve"]
        process.standardInput = toPython
        process.standardOutput = fromPython
        try process.run()
    }

    /// Returns the canonical, or "" when the frame does not render.
    func render(stageB: String, request: String, previous: String) -> String {
        let payload = AFMClient.json([
            "stageB": stageB, "request": request, "prev_used": previous,
        ])
        guard let line = (payload + "\n").data(using: .utf8) else { return "" }
        toPython.fileHandleForWriting.write(line)
        while true {
            if let at = buffer.firstIndex(of: 0x0A) {
                let slice = buffer[buffer.startIndex..<at]
                buffer.removeSubrange(buffer.startIndex...at)
                guard let text = String(data: slice, encoding: .utf8),
                      let data = text.data(using: .utf8),
                      let object = try? JSONSerialization.jsonObject(with: data)
                        as? [String: Any] else { return "" }
                return object["canonical"] as? String ?? ""
            }
            let chunk = fromPython.fileHandleForReading.availableData
            if chunk.isEmpty { return "" }
            buffer.append(chunk)
        }
    }

    func finish() {
        toPython.fileHandleForWriting.closeFile()
        process.waitUntilExit()
    }
}

// MARK: - the run

let availability: String
do {
    availability = try AFMClient.requireAvailable()
} catch {
    FileHandle.standardError.write(Data("\(error)\n".utf8))
    FileHandle.standardError.write(Data(
        "Apple Intelligence must be ON and the model downloaded: System "
        + "Settings > Apple Intelligence & Siri.\n".utf8))
    exit(1)
}
let osBuild = AFMClient.osBuild()
FileHandle.standardError.write(Data(
    "model \(availability) on \(osBuild)\n".utf8))

let turns: [Turn]
do {
    turns = try Corpus.load(mapPath: mapPath, corpora: corpora, limit: limit)
} catch {
    FileHandle.standardError.write(Data("\(error)\n".utf8))
    exit(1)
}
FileHandle.standardError.write(Data("\(turns.count) turns\n".utf8))

FileManager.default.createFile(atPath: outPath, contents: nil)
guard let out = FileHandle(forWritingAtPath: outPath) else {
    FileHandle.standardError.write(Data("cannot write \(outPath)\n".utf8))
    exit(1)
}

let renderer: Renderer? = mode == .free
    ? try? Renderer(python: pythonPath, script: rendererPath) : nil
if mode == .free && renderer == nil {
    FileHandle.standardError.write(Data(
        "free mode needs \(rendererPath); pass --renderer\n".utf8))
    exit(1)
}

let client = AFMClient()
var previousGold: [String: String] = [:]
var previousOwn: [String: String] = [:]
var lastSessionKey = ""
let started = Date()

for (at, turn) in turns.enumerated() {
    if turn.sessionKey != lastSessionKey {
        client.endSession()
        lastSessionKey = turn.sessionKey
    }
    let previous: String
    if turn.turn == 0 {
        previous = "NONE"
    } else if mode == .teacher {
        previous = previousGold[turn.sessionKey] ?? "NONE"
    } else {
        previous = previousOwn[turn.sessionKey] ?? "NONE"
    }

    let result = await client.run(sessionKey: turn.sessionKey,
                                  previous: previous, request: turn.request)

    previousGold[turn.sessionKey] = turn.canonical.isEmpty ? "NONE" : turn.canonical
    if mode == .free {
        let rendered = renderer?.render(stageB: result.stageB,
                                        request: turn.request,
                                        previous: previous) ?? ""
        previousOwn[turn.sessionKey] = rendered.isEmpty ? "NONE" : rendered
    }

    let row: [String: Any] = [
        "corpus": turn.corpus, "session": turn.session, "turn": turn.turn,
        "mode": mode.rawValue, "model": "apple-foundation-models",
        "os": osBuild, "availability": availability,
        "request": turn.request, "prev_used": previous,
        "stageA": result.stageA, "stageB": result.stageB,
        "error": result.error, "ms_a": result.msA, "ms_b": result.msB,
        "canonical": "",
    ]
    out.write(Data((AFMClient.json(row) + "\n").utf8))
    if at % 25 == 0 {
        FileHandle.standardError.write(Data(
            "\(at)/\(turns.count)  \(Int(-started.timeIntervalSinceNow))s\n".utf8))
    }
}

renderer?.finish()
out.closeFile()
FileHandle.standardError.write(Data(
    "wrote \(outPath) in \(Int(-started.timeIntervalSinceNow))s\n".utf8))
