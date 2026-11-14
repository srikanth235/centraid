import AVFoundation
import Speech
import SwiftUI

/// DICTATION, ON THIS PHONE ONLY (#1188 NC6). The recogniser is the system's own, asked to work
/// without a network (`requiresOnDeviceRecognition`): a phone or a language that cannot do that
/// has no key, so a dictated word is never sent anywhere. The permissions are asked at the first
/// tap on the key and never at launch.
@MainActor
final class ChatDictation: ObservableObject {
    enum Phase { case idle, listening, refused }

    @Published private(set) var phase: Phase = .idle

    private let recognizer = SFSpeechRecognizer(locale: Locale.current)
    private let engine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?

    /// Whether this phone can recognise speech in the member's language without a network.
    var available: Bool { recognizer?.supportsOnDeviceRecognition == true }

    /// Start listening; `onWords` gets everything heard so far each time it grows.
    func start(onWords: @escaping @MainActor @Sendable (String) -> Void) {
        guard available, phase != .listening else { return }
        SFSpeechRecognizer.requestAuthorization { [weak self] status in
            Task { @MainActor in
                guard let self else { return }
                guard status == .authorized else { self.phase = .refused; return }
                AVAudioApplication.requestRecordPermission { granted in
                    Task { @MainActor in
                        guard granted else { self.phase = .refused; return }
                        self.listen(onWords)
                    }
                }
            }
        }
    }

    func stop() {
        engine.stop()
        engine.inputNode.removeTap(onBus: 0)
        request?.endAudio()
        task?.cancel()
        request = nil
        task = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        if phase == .listening { phase = .idle }
    }

    private func listen(_ onWords: @escaping @MainActor @Sendable (String) -> Void) {
        guard let recognizer, recognizer.isAvailable else { phase = .refused; return }
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.requiresOnDeviceRecognition = true
        request.shouldReportPartialResults = true
        self.request = request
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .measurement, options: .duckOthers)
            try session.setActive(true, options: .notifyOthersOnDeactivation)
            let input = engine.inputNode
            input.installTap(onBus: 0, bufferSize: 1024, format: input.outputFormat(forBus: 0)) { buffer, _ in
                request.append(buffer)
            }
            engine.prepare()
            try engine.start()
        } catch {
            stop()
            phase = .refused
            return
        }
        phase = .listening
        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            // Only immutable values cross from the recognizer callback to the UI actor.
            let words = result?.bestTranscription.formattedString
            let finished = error != nil || result?.isFinal == true
            Task { @MainActor in
                if let words { onWords(words) }
                if finished { self?.stop() }
            }
        }
    }
}
