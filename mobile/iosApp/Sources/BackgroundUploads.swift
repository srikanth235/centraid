#if os(iOS)
import Foundation
import Security
import UIKit

// THE BACKGROUND MOVER (#1080 rulings 1, 2; #1209 R7; backup spec §6.5).
//
// iOS continues exactly one kind of transfer while an app is suspended: a file
// upload handed to a background `URLSession`. That is why the carrier is HTTPS
// to the member's own gateway: the core writes bundle files into staging while
// the app is alive and a pass answers them as `os_bundles`, each a whole
// `POST bundle` request (file path, URL, method, headers). The pass conductor
// (`crates/screens/src/passes`) asks this file how many upload tasks it holds
// (`UploadsOp.pending`) and sends `UploadsOp.enqueue` only when it holds none;
// the OS moves the files with the app suspended. A finished, failed or lost
// task is reported to Rust as a `ShellFact` (`UploadSettled`, `UploadsDrained`)
// and that only WAKES a pass: the pass re-reads the gateway's head and diffs.
// Nothing this file hears from the OS is recorded as stored. Android does all
// of this in-process and has no twin of this file.
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
//    when its bytes equal the DER pinned for THAT task's gateway: no
//    certificate authority, no hostname rule, no trust-on-first-use, and a
//    plain `http` URL is refused before a task exists.
// 3. **EACH PART CARRIES THE MEMBER'S RULE** (R-1080-E11). The core marks every
//    part `allows_cellular`, from the rule and the part's kind: a photograph's
//    original under `WIFI_AND_CELLULAR_PHOTOS`, thumbnails always, a video's
//    original never. The request's cellular and expensive-network flags are
//    that verdict, so the rule holds for the uploads iOS runs with the app
//    suspended. The session allows both, because a request can only narrow its
//    session: a session that refused cellular would refuse every part's
//    allowance. Low Data Mode is refused on the session and on every request,
//    and a part from a core that never set the flag stays on Wi-Fi. A changed
//    rule cancels what iOS holds (`ShellModel.setTransferRule`); the next pass
//    writes the files again with the new verdict.
// 4. **A REPORT IS A WAKE, HELD UNTIL THERE IS SOMEONE TO WAKE, AND NEVER THE
//    TRUTH.** The OS may relaunch the app to report a task before the vaults
//    are open; wakes wait in order until the core's sink is attached. A wake
//    that is lost anyway costs nothing: the next pass diffs the head.

/// One upload the OS says is finished, as the wake fact carries it. It only wakes a pass.
struct SettledUpload: Equatable {
    let name: String
    /// The gateway's HTTP status, or 0 when no response arrived.
    let httpStatus: Int
    /// Nil when the gateway stored the part. Otherwise a CODE, never a sentence:
    /// the gateway's own refusal code, `PIN_MISMATCH`, `CANCELLED`,
    /// `TRANSPORT_<n>`, `HTTP_<status>`, or one of [UploadOrder.Refusal].
    let error: String?
    let gateway: String
    /// The vault the part belongs to, hex.
    let vault: String
}

/// What a task is FOR, kept on the task itself (`taskDescription`) so a
/// relaunch that reconnects the session can still say which gateway's pin
/// answers its challenge, and de-duplicate against it.
struct UploadTag: Codable, Equatable {
    let name: String
    let gateway: String
    let vault: String

    /// A task whose description is gone: it still counts as held and its finish still wakes a
    /// pass, and its pin is found by the host the challenge names.
    static let unknown = UploadTag(name: "", gateway: "", vault: "")

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
}

/// One bundle file the core named in `os_bundles`, in this file's own terms — so the delegate
/// and its tests never need the wire types.
struct UploadOrder: Equatable {
    let name: String
    let path: String
    let url: String
    let method: String
    let headers: [Header]
    let size: UInt64
    let gateway: String
    let vault: String
    /// RULE 3: whether this bundle may cross cellular, as the core decided it.
    /// False unless the core said so — a part from a core that never set the
    /// flag stays on Wi-Fi.
    var allowsCellular = false

    struct Header: Equatable {
        let name: String
        let value: String
    }

    var tag: UploadTag { UploadTag(name: name, gateway: gateway, vault: vault) }

    /// Why an order never became a task. Codes, for the core's log.
    enum Refusal: String, Swift.Error {
        /// Not `https`, or not a URL at all: an upload outside TLS would skip the pin.
        case notHTTPS = "HANDOFF_NOT_HTTPS"
        /// The staging file the core named is not on disk.
        case noFile = "STAGING_FILE_MISSING"
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
    static func reason(status: Int, error: Swift.Error?, reply: Data, pinRefused: Bool) -> String? {
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
/// at that level is not a vault (the Rust shelf lists `<dir>/*/vault.db`).
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
        defer { lock.unlock() }
        table = fresh
        // Serialize disk writes with the in-memory replacement: an older
        // caller must never overwrite newer pins after releasing the lock.
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
/// Non-isolated and locked, because [enqueue] may be called from any thread;
/// the session's delegate queue is the MAIN queue, so every callback below is
/// on the main thread, where the store that reports it to Rust lives.
final class BackgroundUploader: NSObject, @unchecked Sendable {
    /// Not a `BGTaskScheduler` identifier: a background session needs no
    /// `Info.plist` key, and `project.yml` does not list it.
    static let identifier = "dev.centraid.uploads"

    static let shared = BackgroundUploader(pins: UploadPins(at: UploadPins.defaultLocation))

    /// A day. A task to a laptop that is off waits rather than failing at
    /// once; past this it fails, the core requeues the part and the next
    /// next pass writes its file again.
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
                self.track(task.taskIdentifier, UploadTag.decode(task.taskDescription) ?? .unknown)
            }
        }
    }

    /// Hand each order to the OS as a file upload. An order already in flight
    /// is skipped: a duplicate would race its own twin.
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

    /// Cancel every task. Each one still finishes, as `CANCELLED`, and wakes a
    /// pass; the pass diffs the head and writes what is owed again.
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
        return known ?? UploadTag.decode(task.taskDescription)
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

    /// A refusal's body, so its code can travel with the wake.
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        lock.lock()
        defer { lock.unlock() }
        var reply = replies[dataTask.taskIdentifier] ?? Data()
        guard reply.count < Self.replyCap else { return }
        reply.append(data.prefix(Self.replyCap - reply.count))
        replies[dataTask.taskIdentifier] = reply
    }

    /// ONE TASK FINISHED, FAILED OR LOST: wake a pass, in order. Nothing is marked stored.
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: (any Swift.Error)?) {
        let left = finish(task.taskIdentifier)
        let tag = left.tag ?? UploadTag.decode(task.taskDescription) ?? .unknown
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

    /// Every event of a relaunch has been delivered: wake a pass, which writes
    /// the next bundle files, then hand iOS back its completion handler.
    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        MainActor.assumeIsolated { UploadSettlement.shared.eventsFinished() }
    }
}

/// THE HAND-OFF, AS RUST ASKS FOR IT (`UploadsOp.enqueue`): the bundle requests `os_bundles` named,
/// in this file's own terms. Rust decides whether to send them (only when [pendingCount] is 0);
/// this only gives the OS what it was handed.
extension BackgroundUploader {
    func enqueue(parts: [Centraid_Core_V1_HandoffPart]) {
        enqueue(Self.orders(from: parts))
    }

    static func orders(from parts: [Centraid_Core_V1_HandoffPart]) -> [UploadOrder] {
        parts.map { part in
            UploadOrder(
                name: part.name,
                path: part.path,
                url: part.url,
                method: part.method,
                headers: part.headers.map { UploadOrder.Header(name: $0.name, value: $0.value) },
                size: part.size,
                gateway: part.gatewayID,
                vault: part.vaultID,
                allowsCellular: part.allowsCellular
            )
        }
    }
}

/// Where wakes go: the pass scheduler, or a hold until it is attached.
protocol UploadSink: AnyObject {
    @MainActor func settled(_ upload: SettledUpload) async
    @MainActor func drained() async
}

/// THE ORDERED, MAIN-ACTOR ROAD FROM THE OS TO THE CORE.
///
/// Every report is chained behind the one before it, because a report to
/// Rust is awaited and two awaited calls started together would land in
/// either order. iOS's completion handler for a relaunch is held here and
/// called once the core has been woken and the pass has run — or after
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

    /// The core's sink is ready: deliver the wakes that waited, in order.
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
        // HELD AGAINST SUSPENSION while the core runs the pass the wake asked
        // for: a relaunched app is otherwise suspended as soon as the
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

/// The pass scheduler's sink: what the OS reports goes to Rust as facts (`UploadSettled`,
/// `UploadsDrained`), in order. Each only wakes a pass. `@MainActor` because the store is.
@MainActor
final class ScreenUploadSink: UploadSink {
    private let store: ScreenStore

    init(_ store: ScreenStore) {
        self.store = store
    }

    func settled(_ upload: SettledUpload) async {
        var fact = Centraid_Core_V1_UploadSettled()
        fact.name = upload.name
        fact.httpStatus = UInt32(clamping: upload.httpStatus)
        fact.error = upload.error ?? ""
        fact.gatewayID = upload.gateway
        fact.vaultID = upload.vault
        store.report(.settled(fact))
    }

    func drained() async {
        store.report(.drained(Centraid_Core_V1_UploadsDrained()))
    }
}

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
