import Combine
import Foundation
import SwiftUI
import LocalAuthentication
#if os(iOS)
import AVFoundation
import Contacts
import EventKit
import Photos
import UIKit
import UniformTypeIdentifiers
import UserNotifications
@preconcurrency import HealthKit
#endif

private final class RoomDirectoryEnumerationStatus: @unchecked Sendable {
    private let lock = NSLock()
    private var failed = false
    private var partial = false
    var complete: Bool {
        lock.lock()
        defer { lock.unlock() }
        return !failed && !partial
    }
    var canCommit: Bool {
        lock.lock()
        defer { lock.unlock() }
        return !failed
    }
    func fail() {
        lock.lock()
        failed = true
        lock.unlock()
    }
    func markPartial() {
        lock.lock()
        partial = true
        lock.unlock()
    }
}

#if os(iOS)
private final class RoomFileWatch: NSObject, NSFilePresenter {
    let presentedItemOperationQueue: OperationQueue
    let presentedItemURL: URL?
    private let root: URL

    init(root: URL, onChange: @escaping () -> Void) {
        self.root = root
        presentedItemURL = root
        presentedItemOperationQueue = OperationQueue()
        presentedItemOperationQueue.maxConcurrentOperationCount = 1
        self.onChange = onChange
        super.init()
    }

    private let onChange: () -> Void

    func presentedItemDidChange() { onChange() }
    func presentedSubitemDidChange(at url: URL) { onChange() }
    func presentedSubitemDidAppear(at url: URL) { onChange() }
    func presentedSubitem(at url: URL, didGain version: NSFileVersion) { onChange() }
    func presentedSubitem(at url: URL, didLose version: NSFileVersion) { onChange() }

    func cancel() {
        NSFileCoordinator.removeFilePresenter(self)
        root.stopAccessingSecurityScopedResource()
    }
}

private final class RoomPhotoLibraryWatch: NSObject, PHPhotoLibraryChangeObserver {
    private let onChange: () -> Void

    init(onChange: @escaping () -> Void) {
        self.onChange = onChange
        super.init()
    }

    func photoLibraryDidChange(_ changeInstance: PHChange) {
        onChange()
    }
}
#endif

@MainActor
final class RoomStore: ObservableObject {
    typealias ShellEffectPerformer = @MainActor (Centraid_Core_V1_ShellEffect) async -> Centraid_Core_V1_ShellEffectResult.OneOf_Outcome
    typealias NativeFollowReader = @MainActor (Centraid_Core_V1_ShellStoreRead) async -> (Centraid_Core_V1_FollowGrant, String)
    @Published private(set) var activeTab: String = RustScreens.homeTab
    @Published private(set) var stacks: [String: [Centraid_Core_V1_RoomShown]] = [:]
    @Published private(set) var sheet: Centraid_Core_V1_RoomShown?
    @Published private(set) var stage: Centraid_Core_V1_RoomShown?
    @Published private(set) var lastTransition: Centraid_Core_V1_RoomTransition = .unspecified
    @Published private(set) var errorSentence: String?
    @Published private(set) var followSentence: String?
    @Published private(set) var shareInNotice: String?

    var onAppearanceChanged: ((ColorScheme?) -> Void)?

    private let core: any ScreenCore
    private let shellEffectPerformer: ShellEffectPerformer?
    private let nativeFollowReader: NativeFollowReader?
    private var claimedEffectIDs: Set<UInt64> = []
    private var answeredEffectIDs: Set<UInt64> = []
    private var pumpTask: Task<Void, Never>?
    private var effectTask: Task<Void, Never>?
    private var changeTask: Task<Void, Never>?
    private var started = false
    private var ownerContext: LAContext?
    private var secureEpochFloor: UInt64 = 0
    private var backgrounded = false
    private var phoneWatchTokens: [String: NSObjectProtocol] = [:]
    #if os(iOS)
    private var cameraRollWatcher: RoomPhotoLibraryWatch?
    #endif
    private var healthWatchQueries: [HKObserverQuery] = []
    private var filesWatchers: [String: RoomFileWatch] = [:]
    private var fileTriggerScheduled = false
    private var cameraRollTriggerScheduled = false

    init(core: any ScreenCore, shellEffectPerformer: ShellEffectPerformer? = nil, nativeFollowReader: NativeFollowReader? = nil) {
        self.core = core
        self.shellEffectPerformer = shellEffectPerformer
        self.nativeFollowReader = nativeFollowReader
    }

    var currentStack: [Centraid_Core_V1_RoomShown] {
        stacks[activeTab] ?? []
    }

    var topRoom: Centraid_Core_V1_RoomShown? {
        currentStack.last
    }

    func start() async {
        guard !started else { return }
        started = true
        let stream = core.roomUpdates
        pumpTask = Task { [weak self] in
            for await shown in stream {
                if Task.isCancelled { break }
                self?.apply(shown)
            }
        }
        let effects = core.effects
        effectTask = Task { [weak self] in
            for await effect in effects {
                if Task.isCancelled { break }
                await self?.answerCoreEffect(effect)
            }
        }
        let changes = core.changes
        changeTask = Task { [weak self] in
            for await change in changes {
                if Task.isCancelled { break }
                if change.table == "appearance" { await self?.refreshAppearance() }
            }
        }
        await refreshAppearance()
        await TodayGlanceWriter.sync(rooms: self)
        await open(key: "home", tab: RustScreens.homeTab, root: true)
        await drainShareInbox()
    }

    func stop() {
        pumpTask?.cancel()
        pumpTask = nil
        effectTask?.cancel()
        effectTask = nil
        changeTask?.cancel()
        changeTask = nil
        phoneWatchTokens.values.forEach(NotificationCenter.default.removeObserver)
        phoneWatchTokens.removeAll()
        healthWatchQueries.forEach(HKHealthStore().stop)
        healthWatchQueries.removeAll()
        filesWatchers.values.forEach { $0.cancel() }
        filesWatchers.removeAll()
    }

    func open(key: String, tab: String = RustScreens.homeTab, root: Bool = false) async {
        var open = Centraid_Core_V1_RoomOpen()
        open.key = key
        open.tab = tab
        open.root = root
        open.platform = "ios"
        open.timeZone = TimeZone.current.identifier
        var roomReq = Centraid_Core_V1_RoomRequest()
        roomReq.kind = .open(open)
        await sendRoomRequest(roomReq)
    }

    func open(deepLink: URL) async {
        var open = Centraid_Core_V1_RoomOpen()
        open.deepLink = deepLink.absoluteString
        open.platform = "ios"
        open.timeZone = TimeZone.current.identifier
        var roomReq = Centraid_Core_V1_RoomRequest()
        roomReq.kind = .open(open)
        await sendRoomRequest(roomReq)
    }

    func lifecycle(foreground: Bool) {
        if !foreground {
            if !backgrounded {
                secureEpochFloor &+= 1
                backgrounded = true
            }
            ownerContext?.invalidate()
            ownerContext = nil
            errorSentence = nil
            for tab in Array(stacks.keys) {
                stacks[tab] = stacks[tab]?.map { $0.room.secure ? Self.maskSecureRoom($0) : $0 }
            }
            if let secureSheet = sheet, secureSheet.room.secure { sheet = Self.maskSecureRoom(secureSheet) }
            if let secureStage = stage, secureStage.room.secure { stage = Self.maskSecureRoom(secureStage) }
        } else {
            backgrounded = false
        }
        if foreground, !filesWatchers.isEmpty { scheduleFilesTrigger() }
        var lifecycle = Centraid_Core_V1_RoomLifecycle()
        lifecycle.phase = foreground ? .foreground : .background
        var roomReq = Centraid_Core_V1_RoomRequest()
        roomReq.kind = .lifecycle(lifecycle)
        Task { [weak self] in await self?.sendRoomRequest(roomReq) }
    }

    private static func maskSecureRoom(_ shown: Centraid_Core_V1_RoomShown) -> Centraid_Core_V1_RoomShown {
        var masked = shown
        var room = Centraid_Core_V1_Room()
        room.secure = true
        room.state = .loading(Centraid_Core_V1_RoomLoading())
        masked.room = room
        return masked
    }

    func send(instance: UInt64, event: Centraid_Core_V1_RoomEvent.OneOf_Kind) {
        var roomEvent = Centraid_Core_V1_RoomEvent()
        roomEvent.kind = event
        var send = Centraid_Core_V1_RoomSend()
        send.instance = instance
        send.event = roomEvent
        var roomReq = Centraid_Core_V1_RoomRequest()
        roomReq.kind = .send(send)
        Task { [weak self] in
            await self?.sendRoomRequest(roomReq, instance: send.instance)
        }
    }

    func tap(instance: UInt64, selectorID: String) {
        guard !selectorID.isEmpty else { return }
        var tap = Centraid_Core_V1_RoomTap()
        tap.selectorID = selectorID
        send(instance: instance, event: .tap(tap))
    }

    func change(
        instance: UInt64,
        selectorID: String,
        seq: UInt64,
        value: Centraid_Core_V1_RoomChange.OneOf_Value
    ) {
        guard !selectorID.isEmpty else { return }
        var change = Centraid_Core_V1_RoomChange()
        change.selectorID = selectorID
        change.seq = seq
        change.value = value
        send(instance: instance, event: .change(change))
    }

    func scrolled(instance: UInt64, anchorSelectorID: String, anchorFractionMilli: UInt32) {
        guard !anchorSelectorID.isEmpty else { return }
        var scrolled = Centraid_Core_V1_RoomScrolled()
        scrolled.anchorSelectorID = anchorSelectorID
        scrolled.anchorFractionMilli = min(anchorFractionMilli, 999)
        send(instance: instance, event: .scrolled(scrolled))
    }

    func sendCanvas(instance: UInt64, event: Centraid_Core_V1_RoomCanvasEvent) {
        guard !event.selectorID.isEmpty else { return }
        send(instance: instance, event: .canvas(event))
    }

    func canvas(instance: UInt64, selectorID: String, kind: Centraid_Core_V1_RoomCanvasEvent.OneOf_Kind) {
        var canvasEvent = Centraid_Core_V1_RoomCanvasEvent()
        canvasEvent.selectorID = selectorID
        canvasEvent.kind = kind
        sendCanvas(instance: instance, event: canvasEvent)
    }

    func dismissSheet() {
        guard let openSheet = sheet else { return }
        if openSheet.room.header.hasBack, !openSheet.room.header.back.selectorID.isEmpty {
            tap(instance: openSheet.instance, selectorID: openSheet.room.header.back.selectorID)
        }
        sheet = nil
    }

    func dismissStage() {
        guard let openStage = stage else { return }
        if openStage.room.header.hasBack, !openStage.room.header.back.selectorID.isEmpty {
            tap(instance: openStage.instance, selectorID: openStage.room.header.back.selectorID)
        }
        stage = nil
    }

    func deviceGet(_ key: String) async -> String? {
        var get = Centraid_Core_V1_DeviceGet()
        get.key = key
        var device = Centraid_Core_V1_DeviceRequest()
        device.kind = .get(get)
        var request = Centraid_Core_V1_Request()
        request.kind = .device(device)
        guard let response = try? await core.call(request),
              case .device(let answer)? = response.kind,
              answer.found
        else { return nil }
        return answer.value
    }

    @discardableResult
    func devicePut(_ key: String, value: String) async -> Bool {
        var put = Centraid_Core_V1_DevicePut()
        put.key = key
        put.value = value
        var device = Centraid_Core_V1_DeviceRequest()
        device.kind = .put(put)
        var request = Centraid_Core_V1_Request()
        request.kind = .device(device)
        guard let response = try? await core.call(request),
              case .device? = response.kind
        else { return false }
        return true
    }

    @discardableResult
    func deviceDelete(_ key: String) async -> Bool {
        var del = Centraid_Core_V1_DeviceDelete()
        del.key = key
        var device = Centraid_Core_V1_DeviceRequest()
        device.kind = .delete(del)
        var request = Centraid_Core_V1_Request()
        request.kind = .device(device)
        guard let response = try? await core.call(request),
              case .device? = response.kind
        else { return false }
        return true
    }

    func refreshAppearance() async {
        var get = Centraid_Core_V1_DeviceGet()
        get.key = "settings.appearance"
        var device = Centraid_Core_V1_DeviceRequest()
        device.kind = .get(get)
        var request = Centraid_Core_V1_Request()
        request.kind = .device(device)
        do {
            let response = try await core.call(request)
            guard case .device(let answer)? = response.kind else { return }
            onAppearanceChanged?(answer.found ? Self.parseAppearance(answer.value) : nil)
        } catch let Core.Failure.refused(error) {
            errorSentence = error.sentence
        } catch let Core.Failure.poisoned(_, sentence) {
            errorSentence = sentence
        } catch {
            errorSentence = Self.coreFailureSentence(error)
        }
    }

    @discardableResult
    func drainShareInbox(inboxURL: URL? = ShareInboxWriter.inboxDirectoryURL()) async -> [Centraid_Core_V1_ShareInItem] {
        guard let inboxURL, ShareInboxWriter.hasPendingItems(in: inboxURL) else { return [] }
        errorSentence = nil
        var shareIn = Centraid_Core_V1_ShareInRequest()
        shareIn.inboxDir = inboxURL.path
        var request = Centraid_Core_V1_Request()
        request.kind = .shareIn(shareIn)
        do {
            let response = try await core.call(request)
            guard case .shareIn(let answer)? = response.kind else {
                errorSentence = KitWords.CORE_REQUEST_FAILED
                return []
            }
            shareInNotice = Self.shareInNotice(answer.items)
            return answer.items
        } catch {
            errorSentence = Self.coreFailureSentence(error)
        }
        return []
    }

    static func coreFailureSentence(_ error: Error) -> String {
        switch error {
        case let Core.Failure.refused(refusal): return refusal.sentence
        case let Core.Failure.poisoned(_, sentence): return sentence
        default: return KitWords.CORE_REQUEST_FAILED
        }
    }

    static func shareInNotice(_ items: [Centraid_Core_V1_ShareInItem]) -> String? {
        let kept = items.filter { $0.fate == .kept }
        let details = kept.map(\.detail).filter { !$0.isEmpty }
        return details.isEmpty ? nil : details.joined(separator: "\n")
    }

    static func parseAppearance(_ raw: String) -> ColorScheme? {
        guard let data = raw.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let value = object["value"] as? String
        else { return nil }
        switch value {
        case "light": return .light
        case "dark": return .dark
        default: return nil
        }
    }

    private func sendRoomRequest(_ roomReq: Centraid_Core_V1_RoomRequest, instance: UInt64? = nil) async {
        errorSentence = nil
        var request = Centraid_Core_V1_Request()
        request.kind = .room(roomReq)
        let response: Centraid_Core_V1_Response
        do {
            response = try await core.call(request)
        } catch {
            errorSentence = Self.coreFailureSentence(error)
            return
        }
        guard case .room(let answer)? = response.kind else {
            errorSentence = KitWords.CORE_REQUEST_FAILED
            return
        }
        let responseEpoch = answer.secureEpoch
        secureEpochFloor = max(secureEpochFloor, responseEpoch)
        for shown in answer.shown {
            apply(shown)
        }
        let effects = answer.effects.filter {
            Self.allows(effect: $0, responseEpoch: responseEpoch, secureEpochFloor: secureEpochFloor)
        }
        answerEffects(
            effects,
            instance: instance ?? answer.shown.last?.instance,
            responseEpoch: responseEpoch
        )
    }

    func answerCoreEffect(_ effect: Centraid_Core_V1_ShellEffect) async {
        switch effect.kind {
        case .storeRead(let read)?:
            let result: (Centraid_Core_V1_FollowGrant, String)
            if let nativeFollowReader {
                result = await nativeFollowReader(read)
            } else {
                result = await nativeSnapshot(read: read)
            }
            let grant = result.0
            let inputJSON = result.1
            guard let request = Self.followAnswer(effect, grant: grant, inputJSON: inputJSON) else { return }
            do {
                let response = try await core.call(request)
                if case .follow(let answer)? = response.kind, !answer.sentence.isEmpty {
                    followSentence = answer.sentence
                }
            } catch let Core.Failure.refused(error) {
                errorSentence = error.sentence
            } catch let Core.Failure.poisoned(_, sentence) {
                errorSentence = sentence
            } catch {
                errorSentence = Self.coreFailureSentence(error)
            }
        case .phoneWatch(let watch)?:
            _ = await setPhoneWatch(watch.system, on: watch.on, folderRefs: watch.folderRefs)
        case .releaseGrant(let release)?:
            _ = await deviceDelete("grant.\(release.ref)")
        default:
            break
        }
    }

    private func nativeSnapshot(read: Centraid_Core_V1_ShellStoreRead) async -> (Centraid_Core_V1_FollowGrant, String) {
        switch read.system {
        case "camera_roll": return await cameraRollSnapshot(read: read)
        case "contacts":
            let result = await Self.contactsSnapshot(askPermission: read.askPermission)
            return (result.grant, result.inputJSON)
        case "calendar":
            let result = await Self.calendarSnapshot(askPermission: read.askPermission, daysBack: Int(read.daysBack), daysOn: Int(read.daysOn))
            return (result.grant, result.inputJSON)
        case "reminders":
            let result = await Self.remindersSnapshot(askPermission: read.askPermission)
            return (result.grant, result.inputJSON)
        case "files": return await filesSnapshot(read: read)
        case "health":
            return await Self.healthSnapshot(
                askPermission: read.askPermission,
                chosen: read.chosen,
                cursor: read.cursor,
                workoutsSinceMs: read.workoutsSinceMs,
                daysBack: Int(read.daysBack)
            )
        default: return (.unavailable, "")
        }
    }

    @discardableResult
    private func setPhoneWatch(_ system: String, on: Bool, folderRefs: [String] = []) async -> Bool {
        if system == "camera_roll" {
            if !on {
                if let watcher = cameraRollWatcher {
                    PHPhotoLibrary.shared().unregisterChangeObserver(watcher)
                    cameraRollWatcher = nil
                }
                return true
            }
            guard cameraRollWatcher == nil else { return true }
            let watcher = RoomPhotoLibraryWatch { [weak self] in
                Task { @MainActor in _ = self?.scheduleCameraRollTrigger() }
            }
            cameraRollWatcher = watcher
            PHPhotoLibrary.shared().register(watcher)
            return true
        }
        if system == "files" {
            if !on {
                filesWatchers.values.forEach { $0.cancel() }
                filesWatchers.removeAll()
                return true
            }
            var replacements: [String: RoomFileWatch] = [:]
            for ref in Set(folderRefs).sorted() {
                guard let value = await deviceGet("grant.\(ref)"),
                      let grant = FileGrantStore.decode(ref: ref, value: value) else { continue }
                var stale = false
                guard let root = try? URL(resolvingBookmarkData: grant.bookmark, options: [], relativeTo: nil, bookmarkDataIsStale: &stale),
                      !stale, root.startAccessingSecurityScopedResource() else {
                    replacements.values.forEach { $0.cancel() }
                    return false
                }
                let watcher = RoomFileWatch(root: root, onChange: { [weak self] in
                    Task { @MainActor in self?.scheduleFilesTrigger() }
                })
                NSFileCoordinator.addFilePresenter(watcher)
                replacements[ref] = watcher
            }
            guard replacements.count == Set(folderRefs).count else {
                replacements.values.forEach { $0.cancel() }
                return folderRefs.isEmpty
            }
            filesWatchers.values.forEach { $0.cancel() }
            filesWatchers = replacements
            return true
        }
        if system == "health" {
            let store = HKHealthStore()
            guard HKHealthStore.isHealthDataAvailable() else { return false }
            if !on {
                healthWatchQueries.forEach(store.stop)
                healthWatchQueries.removeAll()
                let types = Self.healthWatchTypes()
                for type in types { store.disableBackgroundDelivery(for: type) { _, _ in } }
                return true
            }
            guard healthWatchQueries.isEmpty else { return true }
            let types = Self.healthWatchTypes()
            guard !types.isEmpty else { return false }
            for type in types {
                let query = HKObserverQuery(sampleType: type, predicate: nil) { [weak self] _, completion, error in
                    completion()
                    guard error == nil else { return }
                    Task { @MainActor in await self?.triggerFollow("health") }
                }
                store.execute(query)
                healthWatchQueries.append(query)
                store.enableBackgroundDelivery(for: type, frequency: .hourly) { _, _ in }
            }
            return true
        }
        guard ["contacts", "calendar", "reminders"].contains(system) else { return false }
        if !on {
            if let token = phoneWatchTokens.removeValue(forKey: system) {
                NotificationCenter.default.removeObserver(token)
            }
            return true
        }
        guard phoneWatchTokens[system] == nil else { return true }
        let name: Notification.Name
        switch system {
        case "contacts": name = .CNContactStoreDidChange
        case "calendar", "reminders": name = .EKEventStoreChanged
        default: return false
        }
        phoneWatchTokens[system] = NotificationCenter.default.addObserver(
            forName: name,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in await self?.triggerFollow(system) }
        }
        return true
    }

    private static func healthWatchTypes() -> [HKSampleType] {
        let identifiers: [HKQuantityTypeIdentifier] = [
            .stepCount, .activeEnergyBurned, .appleExerciseTime, .bodyMass,
            .restingHeartRate
        ]
        let quantities: [HKSampleType] = identifiers.compactMap { HKObjectType.quantityType(forIdentifier: $0) }
        let sleep: [HKSampleType] = HKObjectType.categoryType(forIdentifier: .sleepAnalysis).map { [$0] } ?? []
        return quantities + sleep + [HKObjectType.workoutType()]
    }

    private func triggerFollow(_ system: String) async {
        var follow = Centraid_Core_V1_FollowRequest()
        follow.verb = .trigger
        follow.system = system
        var request = Centraid_Core_V1_Request()
        request.kind = .follow(follow)
        do {
            let response = try await core.call(request)
            if case .follow(let answer)? = response.kind, !answer.sentence.isEmpty {
                followSentence = answer.sentence
            }
        } catch let Core.Failure.refused(error) {
            errorSentence = error.sentence
        } catch let Core.Failure.poisoned(_, sentence) {
            errorSentence = sentence
        } catch {
            return
        }
    }

    @discardableResult
    func scheduleFilesTrigger() -> Bool {
        guard !fileTriggerScheduled else { return false }
        fileTriggerScheduled = true
        Task { @MainActor in
            await Task.yield()
            fileTriggerScheduled = false
            await triggerFollow("files")
        }
        return true
    }

    @discardableResult
    private func scheduleCameraRollTrigger() -> Bool {
        guard !cameraRollTriggerScheduled else { return false }
        cameraRollTriggerScheduled = true
        Task { @MainActor in
            await Task.yield()
            cameraRollTriggerScheduled = false
            await triggerFollow("camera_roll")
        }
        return true
    }

    static func followAnswer(
        _ effect: Centraid_Core_V1_ShellEffect,
        grant: Centraid_Core_V1_FollowGrant,
        inputJSON: String = ""
    ) -> Centraid_Core_V1_Request? {
        guard case .storeRead(let read)? = effect.kind else { return nil }
        var pass = Centraid_Core_V1_FollowRequest()
        pass.verb = .pass
        pass.system = read.system
        pass.askID = effect.effectID
        pass.grant = grant
        pass.inputJson = inputJSON
        var request = Centraid_Core_V1_Request()
        request.kind = .follow(pass)
        return request
    }

    #if os(iOS)
    private func cameraRollSnapshot(
        read: Centraid_Core_V1_ShellStoreRead
    ) async -> (Centraid_Core_V1_FollowGrant, String) {
        let status: PHAuthorizationStatus
        if read.askPermission {
            status = await PHPhotoLibrary.requestAuthorization(for: .readWrite)
        } else {
            status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        }
        let grant = Self.followGrant(status)
        guard grant == .granted || grant == .limited else { return (grant, "") }

        // A room PASS is one bounded page. Core will ask again with the cursor we return until
        // PhotoKit's keyset/change-token walker is exhausted. Staging is streamed one resource at
        // a time, so the page never retains photo bytes in memory.
        // Keep a PhotoKit pass below the shared stage-budget ceiling even when the offered
        // assets are large videos. The core follows incomplete cursors until exhausted.
        let page = await PhoneLibrary.page(cursor: read.cursor, limit: 1)
        var records: [[String: Any]] = []
        records.reserveCapacity(page.assets.count)
        let perAssetStageLimit = UInt64(448 * 1024 * 1024)
        for asset in page.assets {
            guard let original = asset.resources.first(where: { if case .original = $0.role { return true }; return false }) else {
                return (.unavailable, "")
            }
            let primary = await stageRollResource(original.ref)
            guard case .ready = primary.outcome, let handle = primary.handle,
                  primary.byteSize <= perAssetStageLimit else { return (.unavailable, "") }
            var fields: [String: Any] = [
                "blob": primary.contentHash,
                "media_type": primary.mediaType,
            ]
            if !asset.capturedAt.isEmpty { fields["taken_at"] = asset.capturedAt }
            if asset.width > 0 { fields["width"] = asset.width }
            if asset.height > 0 { fields["height"] = asset.height }
            if asset.video { fields["duration_s"] = asset.durationSeconds }
            if asset.offsetMinutes != 0 { fields["offset_min"] = asset.offsetMinutes }
            if let latitude = asset.latitude, let longitude = asset.longitude {
                fields["lat"] = latitude
                fields["lon"] = longitude
            }
            if !asset.captureGroup.isEmpty { fields["burst"] = asset.captureGroup }

            if let motion = asset.resources.first(where: { if case .pairedVideo = $0.role { return true }; return false }) {
                let staged = await stageRollResource(motion.ref)
                let (combinedBytes, overflow) = primary.byteSize.addingReportingOverflow(staged.byteSize)
                guard case .ready = staged.outcome, let motionHandle = staged.handle,
                      !overflow, combinedBytes <= perAssetStageLimit else { return (.unavailable, "") }
                fields["motion_blob"] = staged.contentHash
                fields["motion_size"] = motionHandle.byteSize
            }
            records.append([
                "external_id": asset.localIdentifier,
                "size": handle.byteSize,
                "fields": fields,
            ])
        }
        guard let inputJSON = Self.cameraRollInputJSON(
            cursor: page.nextCursor,
            records: records,
            complete: page.exhausted
        ) else { return (.unavailable, "") }
        return (grant, inputJSON)
    }

    private func stageRollResource(_ ref: String) async -> LibraryStageOutcome {
        let asked = Centraid_Core_V1_LibraryStage.with {
            $0.ref = ref
            $0.allowNetwork = false
        }
        return await PhoneLibrary.stage(asked, core: core)
    }

    static func cameraRollInputJSON(
        cursor: String,
        records: [[String: Any]],
        complete: Bool
    ) -> String? {
        guard records.allSatisfy({
            guard let externalID = $0["external_id"] as? String, !externalID.isEmpty,
                  let size = $0["size"] as? NSNumber, size.int64Value >= 0,
                  let fields = $0["fields"] as? [String: Any],
                  let blob = fields["blob"] as? String, blob.count == 64,
                  let mediaType = fields["media_type"] as? String, !mediaType.isEmpty
            else { return false }
            return true
        }) else { return nil }
        let payload: [String: Any] = [
            "origin": ["ref": "camera-roll", "label": "Camera roll", "cursor": cursor],
            "records": records,
            "complete": complete,
        ]
        guard JSONSerialization.isValidJSONObject(payload),
              let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
        else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private static func contactsSnapshot(askPermission: Bool) async -> (grant: Centraid_Core_V1_FollowGrant, inputJSON: String) {
        let store = CNContactStore()
        var status = CNContactStore.authorizationStatus(for: .contacts)
        if askPermission && status == .notDetermined {
            let granted = await withCheckedContinuation { continuation in
                store.requestAccess(for: .contacts) { accepted, _ in continuation.resume(returning: accepted) }
            }
            status = granted ? .authorized : .denied
        }
        let limited: Bool
        if #available(iOS 18.0, *) {
            limited = status == .limited
        } else {
            limited = false
        }
        guard status == .authorized || limited else { return (followGrant(status), "") }
        let keys: [CNKeyDescriptor] = [
            CNContactIdentifierKey as CNKeyDescriptor,
            CNContactTypeKey as CNKeyDescriptor,
            CNContactNamePrefixKey as CNKeyDescriptor,
            CNContactGivenNameKey as CNKeyDescriptor,
            CNContactMiddleNameKey as CNKeyDescriptor,
            CNContactFamilyNameKey as CNKeyDescriptor,
            CNContactNameSuffixKey as CNKeyDescriptor,
            CNContactPhoneticGivenNameKey as CNKeyDescriptor,
            CNContactPhoneticMiddleNameKey as CNKeyDescriptor,
            CNContactPhoneticFamilyNameKey as CNKeyDescriptor,
            CNContactNicknameKey as CNKeyDescriptor,
            CNContactOrganizationNameKey as CNKeyDescriptor,
            CNContactJobTitleKey as CNKeyDescriptor,
            CNContactPhoneNumbersKey as CNKeyDescriptor,
            CNContactEmailAddressesKey as CNKeyDescriptor,
            CNContactUrlAddressesKey as CNKeyDescriptor,
            CNContactPostalAddressesKey as CNKeyDescriptor,
            CNContactBirthdayKey as CNKeyDescriptor,
        ]
        var records: [[String: Any]] = []
        let request = CNContactFetchRequest(keysToFetch: keys)
        do {
            try store.enumerateContacts(with: request) { contact, _ in
                if let record = Self.contactRecord(contact) { records.append(record) }
            }
        } catch {
            return (.unavailable, "")
        }
        let payload: [String: Any] = [
            "origin": ["ref": "contacts", "label": "Contacts"],
            "records": records,
            "complete": !limited,
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]),
              let inputJSON = String(data: data, encoding: .utf8)
        else { return (.unavailable, "") }
        return (limited ? .limited : .granted, inputJSON)
    }

    private static func calendarSnapshot(askPermission: Bool, daysBack: Int, daysOn: Int) async -> (grant: Centraid_Core_V1_FollowGrant, inputJSON: String) {
        let store = EKEventStore()
        var status = EKEventStore.authorizationStatus(for: .event)
        if askPermission && status == .notDetermined {
            if #available(iOS 17.0, *) {
                do { _ = try await store.requestFullAccessToEvents() } catch { return (.unavailable, "") }
            } else {
                let granted = await withCheckedContinuation { continuation in
                    store.requestAccess(to: .event) { accepted, _ in continuation.resume(returning: accepted) }
                }
                if !granted { return (.refused, "") }
            }
            status = EKEventStore.authorizationStatus(for: .event)
        }
        guard status == .fullAccess || status == .authorized else { return (followGrant(status), "") }
        let calendars = store.calendars(for: .event)
        let iso = ISO8601DateFormatter()
        let day = DateFormatter()
        day.calendar = Calendar(identifier: .gregorian)
        day.locale = Locale(identifier: "en_US_POSIX")
        day.timeZone = TimeZone.current
        day.dateFormat = "yyyy-MM-dd"
        let floating = DateFormatter()
        floating.calendar = Calendar(identifier: .gregorian)
        floating.locale = Locale(identifier: "en_US_POSIX")
        floating.timeZone = TimeZone.current
        floating.dateFormat = "yyyy-MM-dd'T'HH:mm:ss"
        let calendarClock = Calendar.autoupdatingCurrent
        let today = calendarClock.startOfDay(for: Date())
        let from = calendarClock.date(byAdding: .day, value: -max(daysBack, 0), to: today) ?? today
        let until = calendarClock.date(byAdding: .day, value: max(daysOn, 1), to: today) ?? today
        var snapshots: [[String: Any]] = []
        for calendar in calendars {
            let predicate = store.predicateForEvents(withStart: from, end: until, calendars: [calendar])
            let events = store.events(matching: predicate)
            var seen = Set<String>()
            let records: [[String: Any]] = events.compactMap { event in
                let itemID = event.calendarItemIdentifier
                let recurring = !(event.recurrenceRules ?? []).isEmpty || event.isDetached
                let externalID = recurring
                    ? Self.calendarOccurrenceID(itemID: itemID, occurrenceDate: event.occurrenceDate ?? event.startDate)
                    : (event.eventIdentifier ?? itemID)
                guard !itemID.isEmpty, seen.insert(externalID).inserted else { return nil }
                let timing = event.isAllDay ? "all-day" : (event.timeZone == nil ? "floating" : "zoned")
                let starts: String
                let ends: String
                switch timing {
                case "all-day": starts = day.string(from: event.startDate); ends = day.string(from: event.endDate)
                case "floating": starts = floating.string(from: event.startDate); ends = floating.string(from: event.endDate)
                default:
                    starts = iso.string(from: event.startDate)
                    ends = iso.string(from: event.endDate)
                }
                let alarms = (event.alarms ?? []).compactMap { alarm -> Int? in
                    guard alarm.relativeOffset <= 0 else { return nil }
                    return Int((-alarm.relativeOffset / 60).rounded())
                }
                let attendees = (event.attendees ?? []).map { participant -> [String: Any] in
                    ["name": participant.name, "email": participant.url.absoluteString, "state": Self.participantState(participant.participantStatus)]
                }
                let fields: [String: Any] = [
                    "title": event.title ?? "", "starts": starts, "ends": ends,
                    "timing": timing, "zone": event.timeZone?.identifier as Any? ?? NSNull(),
                    "description": event.notes as Any? ?? NSNull(), "url": event.url?.absoluteString as Any? ?? NSNull(),
                    // EventKit returns expanded occurrences from events(matching:). Persist each
                    // occurrence as a one-off row in this bounded read window, with a stable
                    // per-occurrence external ID. A partial snapshot avoids treating the window
                    // as the entire calendar and avoids inventing a recurrence rule. An instance
                    // moved outside this query may not be returned; never use this window to infer
                    // cancellations or a complete series override set.
                    "location": event.location as Any? ?? NSNull(), "rule": NSNull(),
                    "busy": event.availability == .free ? 0 : 1, "overrides": NSNull(),
                    "reminders": alarms, "attendees": attendees,
                ]
                return ["external_id": externalID, "fields": fields]
            }
            let color = calendar.cgColor.components?.map { String(format: "%.4f", $0) }.joined(separator: ",") ?? ""
            snapshots.append([
                "origin": ["ref": "calendar:\(calendar.calendarIdentifier)", "label": calendar.title, "color": color],
                "records": records, "complete": false,
            ])
        }
        return encodeSnapshots(snapshots)
    }

    private static func remindersSnapshot(askPermission: Bool) async -> (grant: Centraid_Core_V1_FollowGrant, inputJSON: String) {
        let store = EKEventStore()
        var status = EKEventStore.authorizationStatus(for: .reminder)
        if askPermission && status == .notDetermined {
            if #available(iOS 17.0, *) {
                do { _ = try await store.requestFullAccessToReminders() } catch { return (.unavailable, "") }
            } else {
                let granted = await withCheckedContinuation { continuation in
                    store.requestAccess(to: .reminder) { accepted, _ in continuation.resume(returning: accepted) }
                }
                if !granted { return (.refused, "") }
            }
            status = EKEventStore.authorizationStatus(for: .reminder)
        }
        guard status == .fullAccess || status == .authorized else { return (followGrant(status), "") }
        let lists = store.calendars(for: .reminder)
        var snapshots: [[String: Any]] = []
        for list in lists {
            guard let recordsData = await reminderTasks(in: store, list: list),
                  let records = (try? JSONSerialization.jsonObject(with: recordsData)) as? [[String: Any]] else {
                return (.unavailable, "")
            }
            snapshots.append([
                "origin": ["ref": "list:\(list.calendarIdentifier)", "label": list.title],
                "records": records,
                "complete": true,
            ])
        }
        return encodeSnapshots(snapshots)
    }

    private func filesSnapshot(read: Centraid_Core_V1_ShellStoreRead) async -> (grant: Centraid_Core_V1_FollowGrant, inputJSON: String) {
        var added: [FileGrantStore.Grant] = []
        if read.askPermission {
            let picked = await withCheckedContinuation { continuation in
                FilePerformer.pickFolders { continuation.resume(returning: $0) }
            }
            if picked.isEmpty { return (.cancelled, "") }
            for url in picked {
                let scoped = url.startAccessingSecurityScopedResource()
                defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                guard let grant = try? FileGrantStore.make(url: url),
                      let stored = FileGrantStore.encode(grant),
                      await devicePut("grant.\(grant.ref)", value: stored)
                else { return (.unavailable, "") }
                added.append(grant)
            }
        }
        let refs = Array(Set(read.folderRefs + added.map(\.ref))).sorted()
        guard !refs.isEmpty else { return (.unavailable, "") }
        var grants = added
        for ref in refs where !grants.contains(where: { $0.ref == ref }) {
            guard let value = await deviceGet("grant.\(ref)"),
                  let grant = FileGrantStore.decode(ref: ref, value: value) else { return (.unavailable, "") }
            grants.append(grant)
        }
        guard !grants.isEmpty else { return (.unavailable, "") }
        var snapshots: [[String: Any]] = []
        for grant in grants {
            var stale = false
            guard let root = try? URL(resolvingBookmarkData: grant.bookmark, options: [], relativeTo: nil, bookmarkDataIsStale: &stale), !stale else {
                _ = await deviceDelete("grant.\(grant.ref)")
                return (.unavailable, "")
            }
            let scoped = root.startAccessingSecurityScopedResource()
            guard scoped else { return (.unavailable, "") }
            defer { root.stopAccessingSecurityScopedResource() }
            let enumerationStatus = RoomDirectoryEnumerationStatus()
            guard let paths = await Task.detached(priority: .utility, operation: {
                Self.enumerateRoomFiles(at: root, status: enumerationStatus)
            }).value else { return (.unavailable, "") }
            guard enumerationStatus.canCommit else { return (.unavailable, "") }
            var records: [[String: Any]] = []
            for url in paths {
                let values: URLResourceValues
                do { values = try url.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey]) }
                catch { return (.unavailable, "") }
                guard let size = values.fileSize, size >= 0 else { return (.unavailable, "") }
                let mediaType = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
                guard case .staged(let handle) = await StageDoor.stage(core, file: url.path, mediaType: mediaType) else { return (.unavailable, "") }
                let digest = handle.contentHash.lowercased()
                guard digest.utf8.count == 64,
                      digest.utf8.allSatisfy({ ($0 >= 48 && $0 <= 57) || ($0 >= 97 && $0 <= 102) }),
                      handle.byteSize == UInt64(size) else { return (.unavailable, "") }
                let relative = String(url.path.dropFirst(root.path.count)).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
                let stat = values.contentModificationDate.map { ISO8601DateFormatter().string(from: $0) } ?? ""
                records.append([
                    "external_id": relative,
                    "size": handle.byteSize,
                    "fields": ["title": url.lastPathComponent, "blob": digest, "media_type": mediaType, "stat": stat],
                ])
            }
            snapshots.append(["origin": ["ref": grant.ref, "label": grant.label], "records": records, "complete": enumerationStatus.complete])
        }
        return Self.encodeSnapshots(snapshots)
    }

    private static func reminderTasks(in store: EKEventStore, list: EKCalendar) async -> Data? {
        await withCheckedContinuation { continuation in
            store.fetchReminders(matching: store.predicateForReminders(in: [list])) { reminders in
                continuation.resume(returning: reminders.flatMap(Self.reminderRecordsData))
            }
        }
    }

    private nonisolated static func reminderRecordsData(_ reminders: [EKReminder]) -> Data? {
        let records: [[String: Any]] = reminders.compactMap { task in
            let externalID = task.calendarItemIdentifier
            guard !externalID.isEmpty else { return nil }
            var fields: [String: Any] = ["title": task.title ?? "", "status": task.isCompleted ? "done" : "open"]
            if let due = task.dueDateComponents, let date = Calendar.current.date(from: due) {
                if due.hour == nil, let year = due.year, let month = due.month, let day = due.day {
                    fields["due"] = String(format: "%04d-%02d-%02d", year, month, day)
                } else {
                    let formatter = ISO8601DateFormatter()
                    formatter.timeZone = due.timeZone ?? TimeZone.current
                    fields["due"] = formatter.string(from: date)
                }
                fields["due_timing"] = due.hour == nil ? "all-day" : (due.timeZone == nil ? "floating" : "zoned")
                fields["zone"] = due.timeZone?.identifier as Any? ?? NSNull()
            } else { fields["due"] = NSNull() }
            fields["priority"] = task.priority
            fields["description"] = task.notes as Any? ?? NSNull()
            fields["url"] = task.url?.absoluteString as Any? ?? NSNull()
            fields["done_at"] = task.completionDate.map { ISO8601DateFormatter().string(from: $0) } as Any? ?? NSNull()
            fields["rule"] = task.recurrenceRules?.first.map {
                Self.recurrenceRule(
                    $0,
                    timing: task.dueDateComponents.map { $0.hour == nil ? "all-day" : ($0.timeZone == nil ? "floating" : "zoned") },
                    zone: task.dueDateComponents?.timeZone
                )
            } as Any? ?? NSNull()
            fields["reminders"] = (task.alarms ?? []).compactMap { alarm -> Int? in
                guard alarm.relativeOffset <= 0 else { return nil }
                return Int((-alarm.relativeOffset / 60).rounded())
            }
            return ["external_id": externalID, "fields": fields]
        }
        return try? JSONSerialization.data(withJSONObject: records, options: [.sortedKeys])
    }

    static func encodeSnapshots(_ snapshots: [[String: Any]]) -> (grant: Centraid_Core_V1_FollowGrant, inputJSON: String) {
        guard let data = try? JSONSerialization.data(withJSONObject: ["snapshots": snapshots], options: [.sortedKeys]),
              let json = String(data: data, encoding: .utf8) else { return (.unavailable, "") }
        return (.granted, json)
    }

    private nonisolated static func enumerateRoomFiles(at root: URL, status: RoomDirectoryEnumerationStatus) -> [URL]? {
        guard let enumerator = FileManager.default.enumerator(
            at: root,
            includingPropertiesForKeys: [.isRegularFileKey, .isSymbolicLinkKey, .isHiddenKey, .isPackageKey, .fileSizeKey, .contentModificationDateKey],
            options: [],
            errorHandler: { _, _ in status.fail(); return false }
        ) else { return nil }
        var paths: [URL] = []
        var visited = 0
        for case let url as URL in enumerator {
            guard visited < 50_000 else { status.fail(); break }
            visited += 1
            let values: URLResourceValues
            do { values = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .isHiddenKey, .isPackageKey]) }
            catch { status.fail(); break }
            if values.isHidden == true || values.isSymbolicLink == true {
                status.markPartial()
                continue
            }
            if values.isPackage == true {
                status.markPartial()
                enumerator.skipDescendants()
                continue
            }
            if values.isRegularFile == true { paths.append(url) }
        }
        return paths
    }

    static func encodeSnapshot(origin: [String: Any], records: [[String: Any]], complete: Bool) -> (grant: Centraid_Core_V1_FollowGrant, inputJSON: String) {
        guard let data = try? JSONSerialization.data(withJSONObject: ["origin": origin, "records": records, "complete": complete], options: [.sortedKeys]),
              let json = String(data: data, encoding: .utf8) else { return (.unavailable, "") }
        return (.granted, json)
    }

    private static func participantState(_ status: EKParticipantStatus) -> String {
        switch status {
        case .accepted: return "accepted"
        case .declined: return "declined"
        case .tentative: return "tentative"
        case .pending: return "pending"
        default: return "unknown"
        }
    }

    static func calendarOccurrenceID(itemID: String, occurrenceDate: Date) -> String {
        let millis = Int64((occurrenceDate.timeIntervalSince1970 * 1000).rounded(.down))
        return "\(itemID)#\(millis)"
    }

    nonisolated static func recurrenceRule(_ rule: EKRecurrenceRule, timing: String? = nil, zone: TimeZone? = nil) -> String {
        let frequency: String
        switch rule.frequency {
        case .daily: frequency = "DAILY"
        case .weekly: frequency = "WEEKLY"
        case .monthly: frequency = "MONTHLY"
        case .yearly: frequency = "YEARLY"
        @unknown default: frequency = "DAILY"
        }
        var parts = ["FREQ=\(frequency)"]
        if rule.interval > 1 { parts.append("INTERVAL=\(rule.interval)") }
        if let days = rule.daysOfTheWeek, !days.isEmpty {
            let names: [EKWeekday: String] = [
                .sunday: "SU", .monday: "MO", .tuesday: "TU", .wednesday: "WE",
                .thursday: "TH", .friday: "FR", .saturday: "SA",
            ]
            let values = days.compactMap { day -> String? in
                guard let name = names[day.dayOfTheWeek] else { return nil }
                return day.weekNumber == 0 ? name : "\(day.weekNumber)\(name)"
            }
            if !values.isEmpty { parts.append("BYDAY=\(values.joined(separator: ","))") }
        }
        func append(_ key: String, _ values: [NSNumber]?) {
            guard let values, !values.isEmpty else { return }
            parts.append("\(key)=\(values.map(\.stringValue).joined(separator: ","))")
        }
        append("BYMONTHDAY", rule.daysOfTheMonth)
        append("BYYEARDAY", rule.daysOfTheYear)
        append("BYWEEKNO", rule.weeksOfTheYear)
        append("BYMONTH", rule.monthsOfTheYear)
        append("BYSETPOS", rule.setPositions)
        if let end = rule.recurrenceEnd {
            if end.occurrenceCount > 0 {
                parts.append("COUNT=\(end.occurrenceCount)")
            } else if let date = end.endDate {
                let formatter = DateFormatter()
                formatter.calendar = Calendar(identifier: .gregorian)
                formatter.locale = Locale(identifier: "en_US_POSIX")
                switch timing {
                case "all-day":
                    formatter.timeZone = zone ?? TimeZone.current
                    formatter.dateFormat = "yyyyMMdd"
                case "floating":
                    formatter.timeZone = TimeZone.current
                    formatter.dateFormat = "yyyyMMdd'T'HHmmss"
                default:
                    formatter.timeZone = TimeZone(secondsFromGMT: 0)
                    formatter.dateFormat = "yyyyMMdd'T'HHmmss'Z'"
                }
                parts.append("UNTIL=\(formatter.string(from: date))")
            }
        }
        return parts.joined(separator: ";")
    }

    static func contactRecord(_ contact: CNContact) -> [String: Any]? {
        let points = contactPoints(contact)
        let displayName = CNContactFormatter.string(from: contact, style: .fullName)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let firstReachable = points.first { ($0["value"] as? String)?.isEmpty == false }?["value"] as? String
        let title = [displayName, contact.organizationName, firstReachable]
            .compactMap { $0?.isEmpty == false ? $0 : nil }
            .first
        guard let title else { return nil }
        var fields: [String: Any] = [
            "title": title,
            "form": contactForm(contact.contactType),
            "points": points,
            "dates": contactDates(contact),
        ]
        let phonetic = [contact.phoneticGivenName, contact.phoneticMiddleName, contact.phoneticFamilyName]
            .filter { !$0.isEmpty }.joined(separator: " ")
        for (key, value) in [
            ("sort_name", displayName), ("given", contact.givenName), ("family", contact.familyName),
            ("phonetic", phonetic), ("nickname", contact.nickname), ("org", contact.organizationName),
            ("role", contact.jobTitle),
        ] {
            fields[key] = value.isEmpty ? NSNull() : value as Any
        }
        return ["external_id": contact.identifier, "fields": fields]
    }

    static func contactForm(_ type: CNContactType) -> String {
        type == .organization ? "org" : "person"
    }

    private static func contactPoints(_ contact: CNContact) -> [[String: Any]] {
        var points: [[String: Any]] = []
        for value in contact.phoneNumbers {
            let label = value.label.map(CNLabeledValue<NSString>.localizedString(forLabel:))
            var point: [String: Any] = ["kind": "phone", "value": value.value.stringValue]
            if let label, !label.isEmpty { point["label"] = label }
            points.append(point)
        }
        for value in contact.emailAddresses {
            let label = value.label.map(CNLabeledValue<NSString>.localizedString(forLabel:))
            var point: [String: Any] = ["kind": "email", "value": String(value.value)]
            if let label, !label.isEmpty { point["label"] = label }
            points.append(point)
        }
        for value in contact.urlAddresses {
            let label = value.label.map(CNLabeledValue<NSString>.localizedString(forLabel:))
            var point: [String: Any] = ["kind": "handle", "value": String(value.value)]
            if let label, !label.isEmpty { point["label"] = label }
            points.append(point)
        }
        for value in contact.postalAddresses {
            let label = value.label.map(CNLabeledValue<CNPostalAddress>.localizedString(forLabel:))
            var point: [String: Any] = ["kind": "address", "value": CNPostalAddressFormatter.string(from: value.value, style: .mailingAddress)]
            if let label, !label.isEmpty { point["label"] = label }
            points.append(point)
        }
        return points
    }

    private static func contactDates(_ contact: CNContact) -> [[String: Any]] {
        guard let birthday = contact.birthday,
              let month = birthday.month,
              let day = birthday.day,
              month > 0,
              day > 0
        else { return [] }
        let date: String
        if let year = birthday.year, year > 0 {
            date = String(format: "%04d-%02d-%02d", year, month, day)
        } else {
            date = String(format: "--%02d-%02d", month, day)
        }
        return [["kind": "birthday", "date": date]]
    }
    #endif

    func answerEffects(
        _ effects: [Centraid_Core_V1_ShellEffect],
        instance: UInt64?,
        responseEpoch: UInt64? = nil
    ) {
        guard let instance else { return }
        let epoch = responseEpoch ?? secureEpochFloor
        Task { [weak self] in
            await self?.performResponseEffects(effects, instance: instance, responseEpoch: epoch)
        }
    }

    func performResponseEffects(
        _ effects: [Centraid_Core_V1_ShellEffect],
        instance: UInt64,
        responseEpoch: UInt64
    ) async {
        for effect in effects {
            guard Self.allows(effect: effect, responseEpoch: responseEpoch, secureEpochFloor: secureEpochFloor) else { continue }
            await perform(effect, instance: instance, responseEpoch: responseEpoch)
        }
    }

    private func perform(
        _ effect: Centraid_Core_V1_ShellEffect,
        instance: UInt64,
        responseEpoch: UInt64
    ) async {
        guard Self.allows(effect: effect, responseEpoch: responseEpoch, secureEpochFloor: secureEpochFloor) else { return }
        guard claimedEffectIDs.insert(effect.effectID).inserted else { return }
        if let shellEffectPerformer {
            let outcome = await shellEffectPerformer(effect)
            guard Self.allows(effect: effect, responseEpoch: responseEpoch, secureEpochFloor: secureEpochFloor) else { return }
            answer(effect, instance: instance, outcome: outcome)
            return
        }
        switch effect.kind {
        case .openSettings?:
            guard let url = URL(string: UIApplication.openSettingsURLString) else {
                answer(effect, instance: instance, failed: EffectReason.unsupported)
                return
            }
            UIApplication.shared.open(url, options: [:]) { [weak self] opened in
                self?.answer(effect, instance: instance, done: opened)
            }
        case .share(let share)?:
            var items: [Any] = []
            for item in share.items {
                if !item.text.isEmpty { items.append(item.text) }
                if !item.path.isEmpty {
                    guard FileManager.default.fileExists(atPath: item.path) else {
                        answer(effect, instance: instance, failed: EffectReason.unreadable)
                        return
                    }
                    items.append(URL(fileURLWithPath: item.path))
                }
            }
            guard !items.isEmpty, let controller = Self.frontController() else {
                answer(effect, instance: instance, failed: EffectReason.unavailable)
                return
            }
            let sheet = UIActivityViewController(activityItems: items, applicationActivities: nil)
            if !share.subject.isEmpty { sheet.setValue(share.subject, forKey: "subject") }
            sheet.popoverPresentationController?.sourceView = controller.view
            controller.present(sheet, animated: true) { [weak self] in
                self?.answer(effect, instance: instance, done: true)
            }
        case .clipboardCopy(let copy)?:
            if copy.clearOwned_p {
                Self.clearOwnedClipboard(vaultID: copy.ownerVaultID)
                answer(effect, instance: instance, done: true)
                return
            }
            var item: [String: Any] = ["public.utf8-plain-text": copy.text]
            if copy.leaseS > 0 {
                let expiresAt = Date(timeIntervalSinceNow: TimeInterval(copy.leaseS))
                if copy.sealed, !copy.ownerVaultID.isEmpty {
                    let token = UUID().uuidString
                    do {
                        try LockerClipboardLeaseStore.record(
                            vaultID: copy.ownerVaultID,
                            token: token,
                            text: copy.text,
                            expiresAt: expiresAt
                        )
                    } catch {
                        answer(effect, instance: instance, failed: EffectReason.unwritable)
                        return
                    }
                    item[LockerClipboardLeaseStore.markerType] = Data(token.utf8)
                } else {
                    LockerClipboardLeaseStore.remove()
                }
                UIPasteboard.general.setItems(
                    [item],
                    options: copy.sealed ? [.expirationDate: expiresAt, .localOnly: true] : [.expirationDate: expiresAt]
                )
                answer(effect, instance: instance, done: true)
                return
            }
            if copy.sealed {
                answer(effect, instance: instance, failed: EffectReason.unsupported)
                return
            } else {
                LockerClipboardLeaseStore.remove()
                UIPasteboard.general.string = copy.text
            }
            answer(effect, instance: instance, done: true)
        case .ownerCheck(let check)?:
            guard Self.allows(effect: effect, responseEpoch: responseEpoch, secureEpochFloor: secureEpochFloor) else { return }
            if check.cancel {
                ownerContext?.invalidate()
                ownerContext = nil
                answer(effect, instance: instance, done: true)
                return
            }
            let context = LAContext()
            ownerContext?.invalidate()
            ownerContext = context
            var policyError: NSError?
            let available = context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &policyError)
            guard available else {
                ownerContext = nil
                answer(effect, instance: instance, outcome: Self.ownerCheckOutcome(
                    available: false, errorCode: policyError?.code, passed: false
                ))
                return
            }
            context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: check.reason) { [weak self] passed, error in
                Task { @MainActor in
                    guard let self,
                          Self.allows(effect: effect, responseEpoch: responseEpoch, secureEpochFloor: self.secureEpochFloor)
                    else { return }
                    if self.ownerContext === context { self.ownerContext = nil }
                    self.answer(effect, instance: instance, outcome: Self.ownerCheckOutcome(
                        available: true, errorCode: (error as? LAError)?.code.rawValue, passed: passed
                    ))
                }
            }
        case .permissionStatus(let permission)?:
            var grant = Centraid_Core_V1_ShellGrant()
            switch permission.kind {
            case "photos":
                grant.grant = Self.followGrant(PHPhotoLibrary.authorizationStatus(for: .readWrite))
            case "camera":
                grant.grant = Self.followGrant(AVCaptureDevice.authorizationStatus(for: .video))
            case "contacts":
                grant.grant = Self.followGrant(CNContactStore.authorizationStatus(for: .contacts))
            case "calendar":
                grant.grant = Self.followGrant(EKEventStore.authorizationStatus(for: .event))
            case "reminders":
                grant.grant = Self.followGrant(EKEventStore.authorizationStatus(for: .reminder))
            case "health":
                grant.grant = HKHealthStore.isHealthDataAvailable() ? .limited : .unavailable
            case "notifications":
                let settings = await UNUserNotificationCenter.current().notificationSettings()
                grant.grant = Self.followGrant(settings.authorizationStatus)
            default:
                answer(effect, instance: instance, failed: EffectReason.unavailable)
                return
            }
            answer(effect, instance: instance, grant: grant)
        case .phoneWatch(let watch)?:
            if !(await setPhoneWatch(watch.system, on: watch.on, folderRefs: watch.folderRefs)) {
                answer(effect, instance: instance, failed: EffectReason.unavailable)
                return
            }
            answer(effect, instance: instance, done: true)
        case .releaseGrant(let release)?:
            let removed = await deviceDelete("grant.\(release.ref)")
            answer(effect, instance: instance, done: removed, failed: removed ? nil : EffectReason.failed)
        case .storeRead?:
            answer(effect, instance: instance, failed: EffectReason.unavailable)
        case .saveFile(let file)?:
            var save = Centraid_Core_V1_SaveFilePath()
            save.path = file.path
            save.name = file.name
            FilePerformer.savePath(save) { [weak self] outcome in
                self?.answer(effect, instance: instance, outcome: outcome)
            }
        case .pickFile(let pick)?:
            FilePerformer.pickPaths(pick) { [weak self] result in
                Task { @MainActor in
                    switch result {
                    case .success(let items):
                        guard let staged = await self?.stagePickedItems(items) else {
                            self?.answer(effect, instance: instance, failed: EffectReason.unreadable)
                            return
                        }
                        var picked = Centraid_Core_V1_ShellPicked()
                        picked.items = staged
                        self?.answer(effect, instance: instance, picked: picked)
                    case .failure(let failure):
                        self?.answer(effect, instance: instance, failed: failure.effectReason)
                    }
                }
            }
        case .pickPhoto(let pick)?:
            FilePerformer.pickPhotos(pick) { [weak self] result in
                Task { @MainActor in
                    switch result {
                    case .success(let items):
                        guard let staged = await self?.stagePickedItems(items) else {
                            self?.answer(effect, instance: instance, failed: EffectReason.unreadable)
                            return
                        }
                        var picked = Centraid_Core_V1_ShellPicked()
                        picked.items = staged
                        self?.answer(effect, instance: instance, picked: picked)
                    case .failure(let failure):
                        self?.answer(effect, instance: instance, failed: failure.effectReason)
                    }
                }
            }
        case .scanDocument?:
            FilePerformer.scanDocument { [weak self] result in
                Task { @MainActor in
                    switch result {
                    case .success(let items):
                        guard let staged = await self?.stagePickedItems(items) else {
                            self?.answer(effect, instance: instance, failed: EffectReason.unreadable)
                            return
                        }
                        var picked = Centraid_Core_V1_ShellPicked()
                        picked.items = staged
                        self?.answer(effect, instance: instance, picked: picked)
                    case .failure(let failure):
                        self?.answer(effect, instance: instance, failed: failure.effectReason)
                    }
                }
            }
        case .photoDelete(let deletion)?:
            Task { [weak self] in
                let outcome = await Self.deletePhonePhotos(deletion.ids)
                self?.answer(effect, instance: instance, outcome: outcome)
            }
        case .modelDownload(let download)?:
            guard download.hasTransfer else {
                answer(effect, instance: instance, failed: EffectReason.unsupported)
                return
            }
            let asset = ChatAsset(download.transfer)
            Task { [weak self] in
                let kept = await ChatModelDownloader.shared.startAndWait(asset)
                self?.answer(effect, instance: instance, done: kept, failed: kept ? nil : EffectReason.failed)
            }
        default:
            answer(effect, instance: instance, failed: EffectReason.unavailable)
        }
    }

    func stagePickedItems(_ items: [Centraid_Core_V1_ShellPickedItem]) async -> [Centraid_Core_V1_ShellPickedItem]? {
        guard !items.isEmpty else { return nil }
        var staged: [Centraid_Core_V1_ShellPickedItem] = []
        staged.reserveCapacity(items.count)
        for var item in items {
            guard !item.path.isEmpty,
                  case .staged(let handle) = await StageDoor.stage(core, file: item.path, mediaType: item.mediaType) else { return nil }
            item.stageHandle = handle
            item.size = handle.byteSize
            staged.append(item)
        }
        return staged
    }

    private func answer(
        _ effect: Centraid_Core_V1_ShellEffect,
        instance: UInt64,
        done: Bool = false,
        failed reason: String? = nil,
        owner: Centraid_Core_V1_ShellOwner? = nil,
        grant: Centraid_Core_V1_ShellGrant? = nil
    ) {
        guard answeredEffectIDs.insert(effect.effectID).inserted else { return }
        var result = Centraid_Core_V1_ShellEffectResult()
        result.effectID = effect.effectID
        if done {
            result.outcome = .done(Centraid_Core_V1_ShellDone())
        } else if let reason {
            var failed = Centraid_Core_V1_ShellFailed()
            failed.grant = Self.followGrant(reason)
            failed.reason = reason
            failed.cancelled = reason == EffectReason.cancelled
            result.outcome = .failed(failed)
        } else if let owner {
            result.outcome = .owner(owner)
        } else if let grant {
            result.outcome = .grant(grant)
        } else {
            var failed = Centraid_Core_V1_ShellFailed()
            failed.reason = EffectReason.failed
            result.outcome = .failed(failed)
        }
        send(instance: instance, event: .effectResult(result))
    }

    private func answer(
        _ effect: Centraid_Core_V1_ShellEffect,
        instance: UInt64,
        outcome: Centraid_Core_V1_EffectResult.OneOf_Outcome
    ) {
        guard answeredEffectIDs.insert(effect.effectID).inserted else { return }
        var result = Centraid_Core_V1_ShellEffectResult()
        result.effectID = effect.effectID
        switch outcome {
        case .done:
            result.outcome = .done(Centraid_Core_V1_ShellDone())
        case .failed(let failed):
            var roomFailure = Centraid_Core_V1_ShellFailed()
            roomFailure.grant = Self.followGrant(failed)
            roomFailure.reason = failed.reason
            roomFailure.cancelled = failed.cancelled || failed.reason == EffectReason.cancelled
            result.outcome = .failed(roomFailure)
        default:
            var failure = Centraid_Core_V1_ShellFailed()
            failure.grant = .unavailable
            failure.reason = EffectReason.unsupported
            result.outcome = .failed(failure)
        }
        send(instance: instance, event: .effectResult(result))
    }

    private func answer(
        _ effect: Centraid_Core_V1_ShellEffect,
        instance: UInt64,
        outcome: Centraid_Core_V1_ShellEffectResult.OneOf_Outcome
    ) {
        guard answeredEffectIDs.insert(effect.effectID).inserted else { return }
        var result = Centraid_Core_V1_ShellEffectResult()
        result.effectID = effect.effectID
        result.outcome = outcome
        send(instance: instance, event: .effectResult(result))
    }

    private static func followGrant(_ reason: String) -> Centraid_Core_V1_FollowGrant {
        switch reason {
        case EffectReason.denied: return .refused
        case EffectReason.cancelled: return .cancelled
        case EffectReason.unavailable, EffectReason.unsupported: return .unavailable
        default: return .unspecified
        }
    }

    private static func followGrant(_ failure: Centraid_Core_V1_EffectFailed) -> Centraid_Core_V1_FollowGrant {
        if failure.cancelled { return .cancelled }
        if failure.denied { return .refused }
        if failure.restricted { return .restricted }
        if failure.limited { return .limited }
        return followGrant(failure.reason)
    }

    private func answer(
        _ effect: Centraid_Core_V1_ShellEffect,
        instance: UInt64,
        picked: Centraid_Core_V1_ShellPicked
    ) {
        guard answeredEffectIDs.insert(effect.effectID).inserted else { return }
        var result = Centraid_Core_V1_ShellEffectResult()
        result.effectID = effect.effectID
        result.outcome = .picked(picked)
        send(instance: instance, event: .effectResult(result))
    }

    #if os(iOS)
    private static func healthSnapshot(
        askPermission: Bool,
        chosen: [String],
        cursor: String,
        workoutsSinceMs: Int64,
        daysBack: Int
    ) async -> (grant: Centraid_Core_V1_FollowGrant, inputJSON: String) {
        guard HKHealthStore.isHealthDataAvailable() else { return (.unavailable, "") }
        let health = HKHealthStore()
        let workoutType = HKObjectType.workoutType()
        let metrics: [(String, HKQuantityTypeIdentifier, HKUnit, HKStatisticsOptions)] = [
            ("steps", .stepCount, .count(), .cumulativeSum),
            ("active_energy_kcal", .activeEnergyBurned, .kilocalorie(), .cumulativeSum),
            ("exercise_min", .appleExerciseTime, .minute(), .cumulativeSum),
            ("resting_hr_bpm", .restingHeartRate, HKUnit.count().unitDivided(by: .minute()), .discreteAverage),
        ]
        let allowed = chosen.isEmpty ? Set(metrics.map(\.0) + ["weight_kg"]) : Set(chosen)
        let selectedMetrics = metrics.filter { allowed.contains($0.0) }
        let weightType = allowed.contains("weight_kg") ? HKObjectType.quantityType(forIdentifier: .bodyMass) : nil
        let quantityTypes = selectedMetrics.compactMap { HKObjectType.quantityType(forIdentifier: $0.1) } + [weightType].compactMap { $0 }
        var readTypes = Set<HKObjectType>([workoutType] + quantityTypes)
        if allowed.contains("sleep_min"), let sleep = HKObjectType.categoryType(forIdentifier: .sleepAnalysis) { readTypes.insert(sleep) }
        if askPermission {
            let authorized: Bool = await withCheckedContinuation { continuation in
                health.requestAuthorization(toShare: [], read: readTypes) { success, error in
                    continuation.resume(returning: success && error == nil)
                }
            }
            guard authorized else { return (.unavailable, "") }
        }

        let previousAnchor: HKQueryAnchor?
        if let data = Data(base64Encoded: cursor), !cursor.isEmpty {
            previousAnchor = try? NSKeyedUnarchiver.unarchivedObject(ofClass: HKQueryAnchor.self, from: data)
        } else {
            previousAnchor = nil
        }
        let start = workoutsSinceMs > 0
            ? Date(timeIntervalSince1970: TimeInterval(workoutsSinceMs) / 1000)
            : Calendar.current.date(byAdding: .day, value: -90, to: Date()) ?? .distantPast
        let predicate = HKQuery.predicateForSamples(withStart: start, end: nil, options: .strictStartDate)
        let delta = await withCheckedContinuation { continuation in
            let query = HKAnchoredObjectQuery(
                type: workoutType,
                predicate: predicate,
                anchor: previousAnchor,
                limit: HKObjectQueryNoLimit
            ) { _, samples, deleted, newAnchor, error in
                continuation.resume(returning: (samples, deleted, newAnchor, error))
            }
            health.execute(query)
        }
        if delta.3 != nil { return (.unavailable, "") }
        guard let newAnchor = delta.2,
              let anchorData = try? NSKeyedArchiver.archivedData(withRootObject: newAnchor, requiringSecureCoding: true)
        else { return (.unavailable, "") }
        let iso = ISO8601DateFormatter()
        let workouts: [[String: Any]] = (delta.0 as? [HKWorkout] ?? []).map { workout in
            var fields: [String: Any] = [
                "kind": Self.workoutKind(workout.workoutActivityType),
                "starts": iso.string(from: workout.startDate),
                "ends": iso.string(from: workout.endDate),
                "recorded_by": workout.sourceRevision.source.name,
                "moving_s": Int(workout.duration.rounded()),
            ]
            if let distance = workout.totalDistance { fields["distance_m"] = distance.doubleValue(for: .meter()) }
            if let energy = workout.totalEnergyBurned { fields["energy_kcal"] = energy.doubleValue(for: .kilocalorie()) }
            return ["external_id": workout.uuid.uuidString, "fields": fields]
        }
        let gone = (delta.1 ?? []).map { $0.uuid.uuidString }
        let origin = ["ref": "healthkit", "label": "Health", "cursor": anchorData.base64EncodedString()]
        let workoutSnapshot: [String: Any] = [
            "origin": origin, "records": workouts,
            "complete": false, "gone": gone,
        ]
        guard let healthData = await healthReadings(
            health,
            metrics: selectedMetrics,
            includeSleep: allowed.contains("sleep_min"),
            includeWeight: allowed.contains("weight_kg"),
            daysBack: max(daysBack, 1)
        ) else {
            return (.unavailable, "")
        }
        let readings = healthData.readings
        let totals: [String: Any] = [
            "origin": ["system": "health", "ref": "healthkit", "cursor": anchorData.base64EncodedString()],
            "days": healthData.days,
        ]
        guard let json = healthInputJSON(
            workouts: workoutSnapshot,
            readings: ["origin": ["ref": "healthkit-readings", "label": "Health"], "records": readings, "complete": false],
            totals: totals
        ) else { return (.unavailable, "") }
        // HealthKit intentionally does not disclose per-type read permission. An incomplete pass
        // merges observed rows without claiming that an empty query means the member refused access.
        return (.limited, json)
    }

    static func healthInputJSON(workouts: [String: Any], readings: [String: Any], totals: [String: Any] = [:]) -> String? {
        guard let data = try? JSONSerialization.data(withJSONObject: ["workouts": workouts, "readings": readings, "totals": totals], options: [.sortedKeys]) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private static func healthReadings(
        _ health: HKHealthStore,
        metrics: [(String, HKQuantityTypeIdentifier, HKUnit, HKStatisticsOptions)],
        includeSleep: Bool,
        includeWeight: Bool,
        daysBack: Int
    ) async -> (days: [[String: Any]], readings: [[String: Any]])? {
        var days: [[String: Any]] = []
        var records: [[String: Any]] = []
        let calendar = Calendar.autoupdatingCurrent
        let today = calendar.startOfDay(for: Date())
        let start = calendar.date(byAdding: .day, value: -daysBack, to: today) ?? today
        var interval = DateComponents()
        interval.day = 1
        let anchor = calendar.startOfDay(for: Date(timeIntervalSince1970: 0))
        let dateFormatter = DateFormatter()
        dateFormatter.calendar = calendar
        dateFormatter.locale = Locale(identifier: "en_US_POSIX")
        dateFormatter.timeZone = calendar.timeZone
        dateFormatter.dateFormat = "yyyy-MM-dd"
        for (metric, identifier, unit, option) in metrics {
            guard let type = HKObjectType.quantityType(forIdentifier: identifier) else { continue }
            let predicate = HKQuery.predicateForSamples(withStart: start, end: nil, options: .strictStartDate)
            let values: [HKStatistics]? = await withCheckedContinuation { continuation in
                let query = HKStatisticsCollectionQuery(
                    quantityType: type,
                    quantitySamplePredicate: predicate,
                    options: option,
                    anchorDate: anchor,
                    intervalComponents: interval
                )
                query.initialResultsHandler = { _, collection, error in
                    continuation.resume(returning: error == nil ? collection.map { Array($0.statistics()) } : nil)
                }
                health.execute(query)
            }
            guard let values else { return nil }
            for statistic in values {
                let quantity = option == .cumulativeSum ? statistic.sumQuantity() : statistic.averageQuantity()
                guard let quantity else { continue }
                days.append(["day": dateFormatter.string(from: statistic.startDate), "metric": metric, "value": quantity.doubleValue(for: unit)])
            }
        }
        if includeSleep, let sleepType = HKObjectType.categoryType(forIdentifier: .sleepAnalysis) {
            let predicate = HKQuery.predicateForSamples(withStart: start, end: nil, options: .strictStartDate)
            let samples: [HKCategorySample]? = await withCheckedContinuation { continuation in
                let query = HKSampleQuery(sampleType: sleepType, predicate: predicate, limit: HKObjectQueryNoLimit, sortDescriptors: nil) { _, samples, error in
                    continuation.resume(returning: error == nil ? samples as? [HKCategorySample] : nil)
                }
                health.execute(query)
            }
            guard let samples else { return nil }
            var totals: [String: TimeInterval] = [:]
            for sample in samples where [
                HKCategoryValueSleepAnalysis.asleep.rawValue,
                HKCategoryValueSleepAnalysis.asleepUnspecified.rawValue,
                HKCategoryValueSleepAnalysis.asleepCore.rawValue,
                HKCategoryValueSleepAnalysis.asleepDeep.rawValue,
                HKCategoryValueSleepAnalysis.asleepREM.rawValue,
            ].contains(sample.value) {
                let day = dateFormatter.string(from: sample.endDate)
                totals[day, default: 0] += sample.endDate.timeIntervalSince(sample.startDate)
            }
            for (day, seconds) in totals {
                days.append(["day": day, "metric": "sleep_min", "value": seconds / 60])
            }
        }
        if includeWeight, let weightType = HKObjectType.quantityType(forIdentifier: .bodyMass) {
            let predicate = HKQuery.predicateForSamples(withStart: start, end: nil, options: .strictStartDate)
            let samples: [HKQuantitySample]? = await withCheckedContinuation { continuation in
                let query = HKSampleQuery(sampleType: weightType, predicate: predicate, limit: HKObjectQueryNoLimit, sortDescriptors: nil) { _, samples, error in
                    continuation.resume(returning: error == nil ? samples as? [HKQuantitySample] : nil)
                }
                health.execute(query)
            }
            guard let samples else { return nil }
            for sample in samples {
                records.append([
                    "external_id": sample.uuid.uuidString,
                    "fields": ["metric": "weight_kg", "at": ISO8601DateFormatter().string(from: sample.startDate), "value": sample.quantity.doubleValue(for: .gramUnit(with: .kilo))],
                ])
            }
        }
        return (days, records)
    }

    private static func workoutKind(_ type: HKWorkoutActivityType) -> String {
        switch type {
        case .walking: return "walking"
        case .running: return "running"
        case .cycling: return "cycling"
        case .swimming: return "swimming"
        case .hiking: return "hiking"
        case .yoga: return "yoga"
        case .traditionalStrengthTraining, .functionalStrengthTraining: return "strength"
        default: return "workout-\(type.rawValue)"
        }
    }

    private static func followGrant(_ status: PHAuthorizationStatus) -> Centraid_Core_V1_FollowGrant {
        switch status {
        case .authorized: return .granted
        case .limited: return .limited
        case .denied: return .refused
        case .restricted: return .restricted
        case .notDetermined: return .unspecified
        @unknown default: return .unspecified
        }
    }

    static func ownerCheckOutcome(available: Bool, errorCode: Int?, passed: Bool) -> Centraid_Core_V1_ShellEffectResult.OneOf_Outcome {
        var owner = Centraid_Core_V1_ShellOwner()
        if !available {
            if errorCode == LAError.passcodeNotSet.rawValue {
                owner.noPasscode = true
                return .owner(owner)
            }
            var failed = Centraid_Core_V1_ShellFailed()
            failed.grant = .unavailable
            failed.reason = EffectReason.unavailable
            return .failed(failed)
        }
        if passed {
            owner.passed = true
            return .owner(owner)
        }
        if let errorCode, [LAError.userCancel.rawValue, LAError.systemCancel.rawValue, LAError.appCancel.rawValue].contains(errorCode) {
            owner.cancelled = true
            return .owner(owner)
        }
        if errorCode == LAError.passcodeNotSet.rawValue {
            owner.noPasscode = true
            return .owner(owner)
        }
        if errorCode == LAError.authenticationFailed.rawValue {
            return .owner(owner) // The OS denied the owner's check.
        }
        var failed = Centraid_Core_V1_ShellFailed()
        failed.grant = .unavailable
        failed.reason = EffectReason.unavailable
        return .failed(failed)
    }

    private static func followGrant(_ status: AVAuthorizationStatus) -> Centraid_Core_V1_FollowGrant {
        switch status {
        case .authorized: return .granted
        case .denied: return .refused
        case .restricted: return .restricted
        case .notDetermined: return .unspecified
        @unknown default: return .unspecified
        }
    }

    private static func followGrant(_ status: CNAuthorizationStatus) -> Centraid_Core_V1_FollowGrant {
        if #available(iOS 18.0, *), status == .limited { return .limited }
        switch status {
        case .authorized: return .granted
        case .denied: return .refused
        case .restricted: return .restricted
        case .notDetermined: return .unspecified
        @unknown default: return .unspecified
        }
    }

    private static func followGrant(_ status: EKAuthorizationStatus) -> Centraid_Core_V1_FollowGrant {
        switch status {
        case .fullAccess, .authorized: return .granted
        case .denied: return .refused
        case .restricted: return .restricted
        case .writeOnly: return .restricted
        case .notDetermined: return .unspecified
        @unknown default: return .unspecified
        }
    }

    private static func followGrant(_ status: UNAuthorizationStatus) -> Centraid_Core_V1_FollowGrant {
        switch status {
        case .authorized, .provisional, .ephemeral: return .granted
        case .denied: return .refused
        case .notDetermined: return .unspecified
        @unknown default: return .unspecified
        }
    }

    private static func deletePhonePhotos(_ ids: [String]) async -> Centraid_Core_V1_EffectResult.OneOf_Outcome {
        let status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        guard status == .authorized || status == .limited else {
            return .failed(ScreenStore.failure(EffectReason.denied, denied: true))
        }
        guard !ids.isEmpty else { return .done(Centraid_Core_V1_EffectDone()) }
        let assets = PHAsset.fetchAssets(withLocalIdentifiers: ids, options: nil)
        guard assets.count == ids.count else {
            return .failed(ScreenStore.failure(EffectReason.unreadable))
        }
        return await withCheckedContinuation { continuation in
            PHPhotoLibrary.shared().performChanges({
                PHAssetChangeRequest.deleteAssets(assets)
            }) { success, error in
                if success {
                    continuation.resume(returning: .done(Centraid_Core_V1_EffectDone()))
                } else {
                    continuation.resume(returning: .failed(ScreenStore.failure(
                        EffectReason.ofWrite(error ?? NSError(domain: "Photos", code: 0), otherwise: EffectReason.failed)
                    )))
                }
            }
        }
    }
    #endif

    private static func frontController() -> UIViewController? {
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            .first { $0.activationState == .foregroundActive }
        var controller = scene?.windows.first(where: \.isKeyWindow)?.rootViewController
        while let next = controller?.presentedViewController { controller = next }
        return controller
    }

    #if os(iOS)
    private static func clearOwnedClipboard(vaultID: String) {
        let pasteboard = UIPasteboard.general
        _ = LockerClipboardLeaseStore.clearOwned(
            vaultID: vaultID,
            markerPresent: { pasteboard.contains(pasteboardTypes: [LockerClipboardLeaseStore.markerType]) },
            readMarkerToken: {
                pasteboard.data(forPasteboardType: LockerClipboardLeaseStore.markerType)
                    .flatMap { String(data: $0, encoding: .utf8) }
            },
            readContentDigest: { pasteboard.string.map(LockerClipboardLeaseStore.digest) },
            clearPasteboard: { pasteboard.items = [] }
        )
    }
    #endif

    func apply(_ shown: Centraid_Core_V1_RoomShown) {
        guard !shown.room.secure || shown.secureEpoch >= secureEpochFloor else { return }
        secureEpochFloor = max(secureEpochFloor, shown.secureEpoch)
        let tab = shown.tab.isEmpty ? activeTab : shown.tab
        lastTransition = shown.transition

        switch shown.transition {
        case .reload:
            if sheet?.instance == shown.instance {
                sheet = shown
            } else if stage?.instance == shown.instance {
                stage = shown
            } else if var stack = stacks[tab],
                      stack.contains(where: { $0.instance == shown.instance }) || Int(shown.depth) <= stack.count + 1 {
                let depth = max(Int(shown.depth), 1)
                stack = Array(stack.prefix(depth - 1)) + [shown]
                stacks[tab] = stack
            }
        case .push:
            activeTab = tab
            if shown.room.kind == .sheet {
                sheet = shown
            } else if shown.room.kind == .stage {
                stage = shown
            } else {
                var stack = stacks[tab] ?? []
                if let idx = stack.lastIndex(where: { $0.instance == shown.instance }) {
                    stack[idx] = shown
                } else {
                    stack.append(shown)
                }
                stacks[tab] = stack
            }

        case .pop:
            activeTab = tab
            if sheet != nil && shown.room.kind != .sheet {
                sheet = nil
            }
            if stage != nil && shown.room.kind != .stage {
                stage = nil
            }
            var stack = stacks[tab] ?? []
            let targetDepth = max(Int(shown.depth), 1)
            if stack.count > targetDepth {
                stack = Array(stack.prefix(targetDepth))
            }
            if stack.isEmpty {
                stack = [shown]
            } else {
                stack[stack.count - 1] = shown
            }
            stacks[tab] = stack

        case .replace, .unspecified, .UNRECOGNIZED:
            activeTab = tab
            sheet = nil
            stage = nil
            stacks[tab] = [shown]
        }
    }

    static func allows(
        effect: Centraid_Core_V1_ShellEffect,
        responseEpoch: UInt64,
        secureEpochFloor: UInt64
    ) -> Bool {
        guard responseEpoch < secureEpochFloor else { return true }
        switch effect.kind {
        case .ownerCheck?, .clipboardCopy?: return false
        default: return true
        }
    }
}
