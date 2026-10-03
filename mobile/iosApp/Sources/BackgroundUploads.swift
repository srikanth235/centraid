#if os(iOS)
import Foundation
import Security
import UIKit

#if canImport(CentraidShared)
import CentraidShared
#endif

// THE BACKGROUND MOVER (#1080 rulings 1, 2, 7; seam contract §2, A6, A10).
//
// iOS continues exactly one kind of transfer while an app is suspended: a file
// upload or download handed to a background `URLSession`. That is why the
// carrier is HTTPS to the member's own gateway (ruling 2): the core prepares
// sealed parts in the spool while the app is alive, Kotlin asks the core for a
// `handoff` batch and hands it here, the OS moves the files with the app
// suspended, and every finished task is reported back through `UploadEvents`
// so the core can `settle` it. Android does all of this in-process and has no
// twin of this file.
//
// Four rules this file keeps, each with its reason:
//
// 1. **ONE SESSION, ONE IDENTIFIER** (`dev.centraid.uploads`). A background
//    session is reconnected to its outstanding tasks by identifier after a
//    relaunch, and two live sessions with one identifier are undefined
//    behaviour. `isDiscretionary` is false on the session and that is enough
//    for both kinds of batch: iOS treats every transfer an app starts while it
//    is in the background as discretionary regardless, so a scheduled batch
//    enqueued from the processing task waits for good conditions and a batch
//    enqueued in the foreground ("Back up now") starts at once.
// 2. **THE PIN IS EXACT DER EQUALITY** (ruling 1). The gateway mints its own
//    certificate; the pairing QR carried its BLAKE3 fingerprint and the core
//    kept the certificate's DER. The leaf the server presents is accepted only
//    when its bytes equal the DER pinned for THAT task's gateway — no
//    certificate authority, no hostname rule, no trust-on-first-use, and a
//    plain `http` URL is refused before a task exists.
// 3. **EACH PART CARRIES THE MEMBER'S RULE** (#1080 A10, R-1080-E11). The core
//    marks every part it hands off `allows_cellular`, from the rule and the
//    part's kind: a photograph's original under `WIFI_AND_CELLULAR_PHOTOS`,
//    thumbnails and previews always, a video's original never. The request's
//    cellular and expensive-network flags are that verdict, so the rule holds
//    for the uploads iOS runs with the app suspended. The session allows both,
//    because a request can only narrow its session: a session that refused
//    cellular would refuse every part's allowance. Low Data Mode is refused
//    on the session and on every request, and a part from a core that never
//    set the flag stays on Wi-Fi. A changed rule cancels what iOS holds
//    (`ShellModel.setTransferRule`); the core requeues each part, and the
//    next handoff carries the new verdict.
// 4. **A SETTLE THAT CANNOT BE DELIVERED IS HELD, NEVER DROPPED, AND NEVER THE
//    TRUTH.** The OS may relaunch the app to report a task before the vaults
//    are open; reports wait in order until the core's sink is attached. And a
//    report that is lost anyway costs nothing: the ledger is a cache of the
//    gateway's own `exists` answer and `reconcile` repairs it (ruling 7).

/// One upload the OS says is finished, as the core's `settle` reads it (#1080 A6).
struct SettledUpload: Equatable {
    let name: String
    /// The gateway's HTTP status, or 0 when no response arrived.
    let httpStatus: Int
    /// Nil when the gateway stored the part. Otherwise a CODE, never a sentence:
    /// the gateway's own refusal code, `PIN_MISMATCH`, `CANCELLED`,
    /// `TRANSPORT_<n>`, `HTTP_<status>`, or one of [UploadOrder.Refusal].
    let error: String?
    let gateway: String
    /// The vault the part belongs to, hex — what routes the settle to that
    /// vault's core (A6).
    let vault: String
}

/// What a task is FOR, kept on the task itself (`taskDescription`) so a
/// relaunch that reconnects the session can still say which part, which
/// gateway and which vault a finished upload was (A6).
struct UploadTag: Codable, Equatable {
    let name: String
    let gateway: String
    let vault: String

    /// The de-duplication key: one part, to one gateway, at a time.
    var key: String { "\(gateway)/\(vault)/\(name)" }

    var encoded: String {
        guard let data = try? JSONEncoder().encode(self) else { return "" }
        return String(decoding: data, as: UTF8.self)
    }

    static func decode(_ text: String?) -> UploadTag? {
        guard let text, let data = text.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(UploadTag.self, from: data)
    }

    /// THE FALLBACK WHEN THE TAG IS GONE: the request's own path,
    /// `/v2/v/{vault}/o/{name}` (#1080 protocol table, A6). Both segments must
    /// be 64 lowercase hex — a vault id is an Ed25519 public key and a name is
    /// a keyed BLAKE3 — so a path this file did not build names nothing.
    static func parse(url: URL?) -> (vault: String, name: String)? {
        guard let url else { return nil }
        let segments = url.pathComponents
        guard segments.count == 6,
              segments[0] == "/", segments[1] == "v2", segments[2] == "v", segments[4] == "o",
              isHex64(segments[3]), isHex64(segments[5])
        else { return nil }
        return (segments[3], segments[5])
    }

    static func isHex64(_ text: String) -> Bool {
        text.utf8.count == 64 && text.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }

    /// A finished task's tag: its own description first, else its URL, with
    /// the gateway recovered from the pinned addresses.
    static func recover(_ task: URLSessionTask, pins: UploadPins) -> UploadTag? {
        if let tag = decode(task.taskDescription) { return tag }
        let url = task.originalRequest?.url ?? task.currentRequest?.url
        guard let (vault, name) = parse(url: url) else { return nil }
        let gateway = url?.host(percentEncoded: false).flatMap { pins.gateway(serving: $0) } ?? ""
        return UploadTag(name: name, gateway: gateway, vault: vault)
    }
}

/// One part the core handed off, in this file's own terms — so the delegate
/// and its tests never need the Kotlin types.
struct UploadOrder: Equatable {
    let name: String
    let path: String
    let url: String
    let method: String
    let headers: [Header]
    let size: UInt64
    let gateway: String
    let vault: String
    /// RULE 3: whether this part may cross cellular, as the core decided it.
    /// False unless the core said so — a part from a core that never set the
    /// flag stays on Wi-Fi.
    var allowsCellular = false

    struct Header: Equatable {
        let name: String
        let value: String
    }

    var tag: UploadTag { UploadTag(name: name, gateway: gateway, vault: vault) }

    /// Why an order never became a task. Codes, for the core's log.
    enum Refusal: String, Error {
        /// Not `https`, or not a URL at all: an upload outside TLS would skip the pin.
        case notHTTPS = "HANDOFF_NOT_HTTPS"
        /// The spool file the core named is not on disk.
        case noFile = "SPOOL_FILE_MISSING"
    }

    /// The request the core presigned: its method, URL and headers, verbatim.
    func request() -> Result<URLRequest, Refusal> {
        guard let target = URL(string: url), target.scheme?.lowercased() == "https" else {
            return .failure(.notHTTPS)
        }
        var request = URLRequest(url: target)
        request.httpMethod = method.isEmpty ? "PUT" : method
        for header in headers {
            request.setValue(header.value, forHTTPHeaderField: header.name)
        }
        // RULE 3: the part's own verdict. An expensive link (cellular, a
        // personal hotspot) follows it too: a request that allowed cellular
        // and refused expensive links would still never cross cellular. Low
        // Data Mode is the member asking the phone itself to save data, and
        // no part overrides it.
        request.allowsCellularAccess = allowsCellular
        request.allowsExpensiveNetworkAccess = allowsCellular
        request.allowsConstrainedNetworkAccess = false
        return .success(request)
    }
}

/// THE PIN, AS A PURE FUNCTION (#1080 ruling 1), so a test can show it refuse.
enum UploadPinning {
    enum Verdict: Equatable {
        case trust
        case refuse
    }

    /// Trust only when the presented leaf's DER is byte-for-byte the pinned
    /// one. No pin, an empty pin, or no leaf is a refusal — never a fallback
    /// to the system's own evaluation, which a self-signed gateway fails anyway
    /// and which would mean "any certificate a CA vouched for" if it did not.
    static func verdict(presented: Data?, pinned: Data?) -> Verdict {
        guard let presented, let pinned, !pinned.isEmpty, presented == pinned else { return .refuse }
        return .trust
    }

    /// The leaf certificate's DER from a server trust, or nil.
    static func leaf(of trust: SecTrust) -> Data? {
        guard let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate],
              let leaf = chain.first
        else { return nil }
        return SecCertificateCopyData(leaf) as Data
    }
}

/// What a finished task reports as its `error` (see [SettledUpload.error]).
enum UploadOutcome {
    static func reason(status: Int, error: Error?, reply: Data, pinRefused: Bool) -> String? {
        if pinRefused { return "PIN_MISMATCH" }
        if let error {
            let failure = error as NSError
            if failure.domain == NSURLErrorDomain && failure.code == NSURLErrorCancelled { return "CANCELLED" }
            return "TRANSPORT_\(failure.code)"
        }
        if (200..<300).contains(status) { return nil }
        return code(in: reply) ?? "HTTP_\(status)"
    }

    /// The gateway's refusal body is `{"code": "...", "time_ms": n, ...}`; the
    /// code travels, and only when it is shaped like one (A-Z, 0-9, `_`).
    static func code(in reply: Data) -> String? {
        guard let object = try? JSONSerialization.jsonObject(with: reply) as? [String: Any],
              let code = object["code"] as? String,
              !code.isEmpty, code.utf8.count <= 64,
              code.utf8.allSatisfy({ (65...90).contains($0) || (48...57).contains($0) || $0 == 95 })
        else { return nil }
        return code
    }
}

/// THE PINNED CERTIFICATES, KEPT WHERE A COLD BACKGROUND LAUNCH CAN READ THEM.
///
/// The OS relaunches the app to answer a task's server-trust challenge, and it
/// may do so before any vault is open — so the DERs the core answered in
/// `pins` cannot live only in the core's memory. They are public certificates,
/// not secrets, and they are kept in one property list beside the vaults:
/// under `Documents`, which `VaultFileProtection.secure` sweeps out of iCloud
/// backup and into `completeUntilFirstUserAuthentication` (R-1029-8). A file
/// at that level is not a vault (`Shelf` lists `<dir>/*/vault.db`).
final class UploadPins: @unchecked Sendable {
    struct Pin: Codable, Equatable {
        /// The gateway certificate's DER, as the core kept it at `pair`.
        let certificate: Data
        /// The hosts this gateway was last reached at, ports stripped — what a
        /// relaunch maps a task back to a gateway by when its tag is gone.
        let hosts: [String]
    }

    static var defaultLocation: URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent(".centraid-upload-pins.plist", isDirectory: false)
    }

    private let location: URL
    private let lock = NSLock()
    private var table: [String: Pin]

    init(at location: URL) {
        self.location = location
        self.table = Self.load(location)
    }

    /// Replace the whole table with what the core answered, and keep it.
    func replace(with fresh: [String: Pin]) {
        lock.lock()
        table = fresh
        lock.unlock()
        persist(fresh)
    }

    func certificate(of gateway: String) -> Data? {
        lock.lock()
        defer { lock.unlock() }
        return table[gateway]?.certificate
    }

    func gateway(serving host: String) -> String? {
        let wanted = Self.host(of: host)
        lock.lock()
        defer { lock.unlock() }
        return table.first { $0.value.hosts.contains(wanted) }?.key
    }

    /// `192.168.1.4:8443` → `192.168.1.4`; `[fe80::1]:8443` → `fe80::1`;
    /// `nas.local` stays. What a challenge's `protectionSpace.host` names.
    static func host(of address: String) -> String {
        let trimmed = address.trimmingCharacters(in: .whitespaces).lowercased()
        if trimmed.hasPrefix("["), let close = trimmed.firstIndex(of: "]") {
            return String(trimmed[trimmed.index(after: trimmed.startIndex)..<close])
        }
        let colons = trimmed.filter { $0 == ":" }.count
        if colons == 1, let colon = trimmed.firstIndex(of: ":") {
            return String(trimmed[..<colon])
        }
        return trimmed
    }

    private static func load(_ location: URL) -> [String: Pin] {
        guard let data = try? Data(contentsOf: location),
              let table = try? PropertyListDecoder().decode([String: Pin].self, from: data)
        else { return [:] }
        return table
    }

    private func persist(_ table: [String: Pin]) {
        do {
            let data = try PropertyListEncoder().encode(table)
            try data.write(to: location, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            var item = location
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            try item.setResourceValues(values)
        } catch {
            NSLog("centraid: the upload pins were not kept: %@", "\(error)")
        }
    }
}

/// THE ONE BACKGROUND SESSION.
///
/// Non-isolated and locked, because Kotlin may call [enqueue] from any thread;
/// the session's delegate queue is the MAIN queue, so every callback below is
/// on the main thread — which is what lets a report cross into Kotlin, whose
/// suspend functions are callable from Swift on the main thread only.
final class BackgroundUploader: NSObject, @unchecked Sendable {
    /// Not a `BGTaskScheduler` identifier: a background session needs no
    /// `Info.plist` key, and `BackgroundIdentifierSpec` does not list it.
    static let identifier = "dev.centraid.uploads"

    static let shared = BackgroundUploader(pins: UploadPins(at: UploadPins.defaultLocation))

    /// A day. A task to a laptop that is off waits rather than failing at
    /// once; past this it fails, the core requeues the part and the next
    /// handoff carries it again.
    static let resourceTimeoutSeconds: TimeInterval = 24 * 60 * 60

    /// How much of a refusal body is kept: a code fits in far less.
    static let replyCap = 4096

    let pins: UploadPins

    private let lock = NSLock()
    private var made: URLSession?
    private var inFlight: [Int: UploadTag] = [:]
    private var keys: Set<String> = []
    private var replies: [Int: Data] = [:]
    private var pinRefused: Set<Int> = []

    init(pins: UploadPins) {
        self.pins = pins
        super.init()
    }

    /// The session, made once. Making it IS the reconnect: after a relaunch,
    /// a session created with this identifier is handed every outstanding task.
    var session: URLSession {
        lock.lock()
        defer { lock.unlock() }
        if let made { return made }
        let fresh = URLSession(configuration: Self.configuration(), delegate: self, delegateQueue: .main)
        made = fresh
        return fresh
    }

    static func configuration() -> URLSessionConfiguration {
        let configuration = URLSessionConfiguration.background(withIdentifier: identifier)
        configuration.sessionSendsLaunchEvents = true
        configuration.isDiscretionary = false
        // RULE 3: what any part may be allowed; each request narrows it to its
        // own part. Low Data Mode stays refused here as on every request.
        configuration.allowsCellularAccess = true
        configuration.allowsExpensiveNetworkAccess = true
        configuration.allowsConstrainedNetworkAccess = false
        configuration.timeoutIntervalForResource = resourceTimeoutSeconds
        configuration.httpMaximumConnectionsPerHost = 2
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.urlCache = nil
        configuration.httpShouldSetCookies = false
        configuration.httpCookieStorage = nil
        return configuration
    }

    /// Reconnect at launch, and learn what is already in flight so [pending]
    /// and the de-duplication in [enqueue] are true after a relaunch.
    func reconnect() {
        session.getAllTasks { [weak self] tasks in
            guard let self else { return }
            for task in tasks where task.state == .running || task.state == .suspended {
                guard let tag = UploadTag.recover(task, pins: self.pins) else { continue }
                self.track(task.taskIdentifier, tag)
            }
        }
    }

    /// Hand each order to the OS as a file upload. An order already in flight
    /// is skipped: the core hands a part off again only after it was settled
    /// or requeued, and a duplicate here would race its own twin.
    func enqueue(_ orders: [UploadOrder]) {
        let uploads = self.session
        for order in orders {
            if isInFlight(order.tag) { continue }
            let request: URLRequest
            switch order.request() {
            case let .success(made): request = made
            case let .failure(refusal):
                refuse(order, refusal)
                continue
            }
            guard FileManager.default.fileExists(atPath: order.path) else {
                refuse(order, .noFile)
                continue
            }
            let task = uploads.uploadTask(with: request, fromFile: URL(fileURLWithPath: order.path))
            task.taskDescription = order.tag.encoded
            task.countOfBytesClientExpectsToSend = Int64(clamping: order.size)
            task.countOfBytesClientExpectsToReceive = 1024
            track(task.taskIdentifier, order.tag)
            task.resume()
        }
    }

    /// How many uploads the OS is holding for this app.
    var pendingCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return inFlight.count
    }

    /// Cancel every task. Each one still finishes — as `CANCELLED` — and is
    /// settled, so the core requeues it rather than believing it moved.
    func cancelEverything() {
        session.getAllTasks { tasks in tasks.forEach { $0.cancel() } }
    }

    private func refuse(_ order: UploadOrder, _ refusal: UploadOrder.Refusal) {
        let settled = SettledUpload(
            name: order.name, httpStatus: 0, error: refusal.rawValue,
            gateway: order.gateway, vault: order.vault
        )
        Task { @MainActor in UploadSettlement.shared.report(settled) }
    }

    private func track(_ identifier: Int, _ tag: UploadTag) {
        lock.lock()
        inFlight[identifier] = tag
        keys.insert(tag.key)
        lock.unlock()
    }

    private func isInFlight(_ tag: UploadTag) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return keys.contains(tag.key)
    }

    private func tag(of task: URLSessionTask) -> UploadTag? {
        lock.lock()
        let known = inFlight[task.taskIdentifier]
        lock.unlock()
        return known ?? UploadTag.recover(task, pins: pins)
    }

    /// Forget a finished task, answering what it left behind.
    private func finish(_ identifier: Int) -> (tag: UploadTag?, reply: Data, pinRefused: Bool) {
        lock.lock()
        defer { lock.unlock() }
        let tag = inFlight.removeValue(forKey: identifier)
        if let tag { keys.remove(tag.key) }
        let reply = replies.removeValue(forKey: identifier) ?? Data()
        let refused = pinRefused.remove(identifier) != nil
        return (tag, reply, refused)
    }
}

extension BackgroundUploader: URLSessionDataDelegate {
    /// RULE 2. Task-level and not session-level, so the pin is the one for
    /// THIS task's gateway: a session-level challenge carries no task.
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping @Sendable (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust
        else {
            completionHandler(.performDefaultHandling, nil)
            return
        }
        let gateway = tag(of: task)?.gateway ?? pins.gateway(serving: challenge.protectionSpace.host)
        let pinned = gateway.flatMap { pins.certificate(of: $0) }
        switch UploadPinning.verdict(presented: UploadPinning.leaf(of: trust), pinned: pinned) {
        case .trust:
            completionHandler(.useCredential, URLCredential(trust: trust))
        case .refuse:
            lock.lock()
            pinRefused.insert(task.taskIdentifier)
            lock.unlock()
            completionHandler(.cancelAuthenticationChallenge, nil)
        }
    }

    /// A refusal's body, so its code can travel with the settle.
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        lock.lock()
        defer { lock.unlock() }
        var reply = replies[dataTask.taskIdentifier] ?? Data()
        guard reply.count < Self.replyCap else { return }
        reply.append(data.prefix(Self.replyCap - reply.count))
        replies[dataTask.taskIdentifier] = reply
    }

    /// ONE TASK FINISHED: report it, in order, to the core's `settle`.
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: (any Error)?) {
        let left = finish(task.taskIdentifier)
        guard let tag = left.tag ?? UploadTag.recover(task, pins: pins) else {
            NSLog("centraid: an upload finished that names no part")
            return
        }
        let status = (task.response as? HTTPURLResponse)?.statusCode ?? 0
        let settled = SettledUpload(
            name: tag.name,
            httpStatus: status,
            error: UploadOutcome.reason(status: status, error: error, reply: left.reply, pinRefused: left.pinRefused),
            gateway: tag.gateway,
            vault: tag.vault
        )
        // THE DELEGATE QUEUE IS MAIN (see `session`), so this is synchronous
        // and the reports keep the order the OS finished the tasks in.
        MainActor.assumeIsolated { UploadSettlement.shared.report(settled) }
    }

    /// Every event of a relaunch has been delivered: settle, chain the next
    /// batch, then hand iOS back its completion handler.
    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        MainActor.assumeIsolated { UploadSettlement.shared.eventsFinished() }
    }
}

#if canImport(CentraidShared)
/// THE KOTLIN-VISIBLE HALF (seam contract §2): `BackgroundUploads` is
/// `commonMain`'s interface and this is its iOS implementation.
extension BackgroundUploader: BackgroundUploads {
    func enqueue(batch: [HandoffPart]) {
        enqueue(batch.map { part in
            UploadOrder(
                name: part.name,
                path: part.path,
                url: part.url,
                method: part.method,
                // `value_`: Wire spells the proto's `value` with a trailing
                // underscore, and Kotlin/Native exports it as Wire spells it.
                headers: part.headers.map { UploadOrder.Header(name: $0.name, value: $0.value_) },
                size: UInt64(bitPattern: part.size),
                gateway: part.gateway_id,
                vault: part.vault_id,
                allowsCellular: part.allows_cellular
            )
        })
    }

    func pending() -> Int32 { Int32(clamping: pendingCount) }

    func cancelAll() { cancelEverything() }
}
#endif

/// Where finished uploads go: the core's `UploadEvents`, or a hold until it
/// is attached.
protocol UploadSink: AnyObject {
    @MainActor func settled(_ upload: SettledUpload) async
    @MainActor func drained() async
}

/// THE ORDERED, MAIN-ACTOR ROAD FROM THE OS TO THE CORE.
///
/// Every report is chained behind the one before it, because a Kotlin
/// suspend call is awaited and two awaited calls started together would land
/// in either order. iOS's completion handler for a relaunch is held here and
/// called once the core has settled and chained the next batch — or after
/// [finishWithinSeconds], whichever is first, because iOS suspends an app
/// that keeps it longer and stops relaunching one that never answers.
@MainActor
final class UploadSettlement {
    static let shared = UploadSettlement()

    /// A relaunch gets about thirty seconds; this leaves the handler margin.
    static let finishWithinSeconds: TimeInterval = 25

    private var sink: UploadSink?
    private var held: [SettledUpload] = []
    private var finish: (() -> Void)?
    private var tail: Task<Void, Never>?

    /// The core's sink is ready: deliver what waited, in order.
    func attach(_ sink: UploadSink) {
        self.sink = sink
        let waiting = held
        held.removeAll()
        for upload in waiting {
            chain { await sink.settled(upload) }
        }
        if finish != nil { drain(sink) }
    }

    func report(_ upload: SettledUpload) {
        guard let sink else {
            held.append(upload)
            return
        }
        chain { await sink.settled(upload) }
    }

    /// iOS's handler from `handleEventsForBackgroundURLSession`.
    func awaitingFinish(_ completion: @escaping () -> Void) {
        finish = completion
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.finishWithinSeconds) { [weak self] in
            MainActor.assumeIsolated { self?.callFinish() }
        }
    }

    func eventsFinished() {
        guard let sink else { return }
        drain(sink)
    }

    private func drain(_ sink: UploadSink) {
        // HELD AGAINST SUSPENSION while the core settles and hands off the
        // next batch: a relaunched app is otherwise suspended as soon as the
        // handler returns, mid-call.
        let grace = ForegroundGrace(name: "dev.centraid.uploads.settle")
        chain { [weak self] in
            await sink.drained()
            self?.callFinish()
            grace.end()
        }
    }

    private func callFinish() {
        let completion = finish
        finish = nil
        completion?()
    }

    private func chain(_ work: @escaping @MainActor () async -> Void) {
        let previous = tail
        tail = Task { @MainActor in
            await previous?.value
            await work()
        }
    }
}

#if canImport(CentraidShared)
/// The core's `UploadEvents`, as a sink. `@MainActor` because a Kotlin suspend
/// function is callable from Swift on the main thread only.
@MainActor
final class CoreUploadSink: UploadSink {
    private let events: UploadEvents

    init(_ events: UploadEvents) {
        self.events = events
    }

    func settled(_ upload: SettledUpload) async {
        do {
            try await events.settled(
                name: upload.name,
                httpStatus: Int32(clamping: upload.httpStatus),
                error: upload.error,
                gatewayId: upload.gateway,
                vaultId: upload.vault
            )
        } catch {
            NSLog("centraid: a settle did not reach the core: %@", "\(error)")
        }
    }

    func drained() async {
        do {
            try await events.sessionDrained()
        } catch {
            NSLog("centraid: the uploads' drain did not reach the core: %@", "\(error)")
        }
    }
}
#endif

/// A UIKIT BACKGROUND TASK, held while a pass finishes its current part
/// (#1080, the shells: "a foreground pass survives backgrounding by finishing
/// its current part under the platform's grace").
///
/// iOS gives an app that leaves the foreground a few seconds unless it holds
/// one of these, and then about thirty. Expiration is iOS taking it back:
/// `endBackgroundTask` is owed on that path too, or iOS kills the app.
@MainActor
final class ForegroundGrace {
    private var identifier: UIBackgroundTaskIdentifier = .invalid

    init(name: String) {
        identifier = UIApplication.shared.beginBackgroundTask(withName: name) { [weak self] in
            MainActor.assumeIsolated { self?.end() }
        }
    }

    /// Idempotent: the pass's answer and the expiration may both arrive.
    func end() {
        guard identifier != .invalid else { return }
        UIApplication.shared.endBackgroundTask(identifier)
        identifier = .invalid
    }
}
#endif
