// The corpus reader. Pure Swift, no FoundationModels.
//
// `grammar/map.json` is read for THREE fields only — `corpus`/`session`/`turn`,
// `request` (the member's own words) and, in `--mode teacher` alone, the gold
// `canonical` as the previous turn's CONTEXT. Gold never reaches a prompt as
// the answer to the turn being asked, and the harness never reads `tree`.
//
// This mirrors `experiments/canon-model/infer.py` exactly, including the sort
// order, so the two lanes' JSONL files line up row for row.

import Foundation

public struct Turn: Sendable {
    public let corpus: String
    public let session: String
    public let turn: Int
    public let request: String
    /// Gold. Used ONLY as `--mode teacher`'s previous-turn context.
    public let canonical: String

    public var sessionKey: String { "\(corpus)/\(session)" }
}

public enum Corpus {
    public static func load(mapPath: String, corpora: Set<String>,
                            limit: Int?) throws -> [Turn] {
        let data = try Data(contentsOf: URL(fileURLWithPath: mapPath))
        guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let rows = root["turns"] as? [[String: Any]] else {
            throw HarnessError.badMap(mapPath)
        }
        var turns: [Turn] = []
        for row in rows {
            guard let corpus = row["corpus"] as? String,
                  let session = row["session"] as? String,
                  let turn = row["turn"] as? Int,
                  let request = row["request"] as? String else {
                throw HarnessError.badMap(mapPath)
            }
            guard corpora.contains(corpus) else { continue }
            turns.append(Turn(corpus: corpus, session: session, turn: turn,
                              request: request,
                              canonical: row["canonical"] as? String ?? ""))
        }
        turns.sort {
            ($0.corpus, $0.session, $0.turn) < ($1.corpus, $1.session, $1.turn)
        }
        if let limit, limit < turns.count {
            turns = Array(turns.prefix(limit))
        }
        return turns
    }
}

public enum HarnessError: Error, CustomStringConvertible {
    case badMap(String)
    case modelUnavailable(String)
    case usage(String)

    public var description: String {
        switch self {
        case .badMap(let path): "could not read \(path) as grammar/map.json"
        case .modelUnavailable(let why): "the on-device model is unavailable: \(why)"
        case .usage(let message): message
        }
    }
}
