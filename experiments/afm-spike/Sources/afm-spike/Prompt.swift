// Prompt assembly. Pure Swift, no FoundationModels.
//
// STATE IS CODE. The session's memory is one string — the previous turn's
// canonical — threaded by the harness exactly as `infer.py` threads it:
// gold in `--mode teacher`, the harness's OWN rendered output in `--mode
// free`. A `LanguageModelSession` is reset per session and its transcript is
// never relied on for correctness; the context window is 4 096 tokens and a
// twelve-turn session would not fit, let alone the instructions beside it.
//
// The prompt is deliberately small: the instructions block carries the
// ontology, so a turn carries only the previous canonical and the sentence.

import Foundation

public enum Mode: String, Sendable {
    case teacher
    case free
}

public enum Prompt {
    /// Stage A: which move, what the turn asks for, and which board.
    public static func stageA(previous: String, request: String) -> String {
        """
        Previous turn: \(previous)
        The person says: \(request)

        Say which MOVE this is, what the turn ASKS FOR, which BOARD it is \
        about, and whether it depends on the previous turn.
        """
    }

    /// Stage B: fill the frame for the kind Stage A named.
    public static func stageB(previous: String, request: String,
                              head: String, kind: String) -> String {
        """
        Previous turn: \(previous)
        The person says: \(request)

        This turn is a \(head) about \(kind). Fill in the form. Use only the \
        options offered. Copy any name, title or value WORD FOR WORD out of \
        the sentence above, or out of the previous turn when the person is \
        refining it. Leave a slot out when the sentence does not say it.
        """
    }
}
