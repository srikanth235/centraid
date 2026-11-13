#if os(iOS)
import Foundation
import XCTest
import os

@testable import CentraidApp

@MainActor
final class NotificationReadinessTests: XCTestCase {
    func testColdStoreIsPublishedOnlyAfterOneSuccessfulSnapshot() async {
        let oldStore = BackgroundPasses.store
        let oldWatcher = LibraryWatcher.shared.onChange
        defer {
            BackgroundPasses.store = oldStore
            LibraryWatcher.shared.onChange = oldWatcher
        }
        BackgroundPasses.store = nil
        let core = NotificationTestCore(holdSnapshot: true)
        let store = ScreenStore(core: core)
        let start = Task { await BackgroundPasses.start(store: store) }
        var calls = core.calls.makeAsyncIterator()
        let first = await calls.next()
        XCTAssertEqual(first, "snapshot")
        XCTAssertNil(BackgroundPasses.store)
        let secondStart = Task { await store.start() }
        let installed = Task { await BackgroundPasses.installed(within: 20) }
        await core.releaseSnapshot()
        let started = await start.value
        let startedAgain = await secondStart.value
        let ready = await installed.value
        XCTAssertTrue(started)
        XCTAssertTrue(startedAgain)
        XCTAssertTrue(ready === store)
        XCTAssertTrue(BackgroundPasses.store === store)
        let snapshots = await core.snapshotCount
        XCTAssertEqual(snapshots, 1)
        XCTAssertEqual(core.readerCount, 1)
        core.finish()
    }

    func testFailedSnapshotDoesNotPublishColdStore() async {
        let oldStore = BackgroundPasses.store
        let oldWatcher = LibraryWatcher.shared.onChange
        defer {
            BackgroundPasses.store = oldStore
            LibraryWatcher.shared.onChange = oldWatcher
        }
        BackgroundPasses.store = nil
        let core = NotificationTestCore(failSnapshot: true)
        let store = ScreenStore(core: core)
        let started = await BackgroundPasses.start(store: store)
        XCTAssertFalse(started)
        XCTAssertNil(BackgroundPasses.store)
        XCTAssertEqual(core.readerCount, 1)
        core.finish()
    }

    func testOnlyExactPerformedAnswerCompletesCallback() async {
        let oldWatcher = LibraryWatcher.shared.onChange
        defer { LibraryWatcher.shared.onChange = oldWatcher }
        let core = NotificationTestCore()
        let performer = NotificationTestPerformer(heldCalls: [3])
        let store = ScreenStore(core: core, scheduleNotifications: performer.perform)
        await store.start()
        var calls = core.calls.makeAsyncIterator()
        _ = await calls.next() // Snapshot.
        let answer = Task {
            let matched = await store.answerNotification(id: "public-task-A", verb: .done)
            performer.events.append("callback A")
            return matched
        }
        let fact = await calls.next()
        XCTAssertEqual(fact, "answer:public-task-A:2")
        var performed = performer.started.makeAsyncIterator()
        // Startup, then the same notification with a different verb, are not this answer.
        core.emit(schedule: .init(), effectID: 1)
        _ = await performed.next()
        _ = await calls.next() // Actual performed effect acknowledged to Rust.
        core.emit(schedule: schedule(id: "public-task-A", verb: .open), effectID: 2)
        _ = await performed.next()
        _ = await calls.next()
        core.emit(schedule: schedule(id: "public-task-A", verb: .done), effectID: 3)
        _ = await performed.next()
        XCTAssertFalse(performer.events.contains("callback A"))
        performer.release(3)
        let matched = await answer.value
        XCTAssertTrue(matched)
        XCTAssertEqual(performer.events, ["begin 1", "end 1", "begin 2", "end 2", "begin 3", "end 3", "callback A"])
        core.finish()
    }

    func testConcurrentCallbacksDoNotReleaseEachOtherAndDuplicateAcknowledgementIsSafe() async {
        let oldWatcher = LibraryWatcher.shared.onChange
        defer { LibraryWatcher.shared.onChange = oldWatcher }
        let core = NotificationTestCore()
        let performer = NotificationTestPerformer(heldCalls: [1, 2])
        let store = ScreenStore(core: core, scheduleNotifications: performer.perform)
        await store.start()
        var calls = core.calls.makeAsyncIterator()
        _ = await calls.next()
        let first = Task {
            let matched = await store.answerNotification(id: "public-task-A", verb: .done)
            performer.events.append("callback A")
            return matched
        }
        _ = await calls.next()
        let second = Task {
            let matched = await store.answerNotification(id: "public-task-B", verb: .done)
            performer.events.append("callback B")
            return matched
        }
        _ = await calls.next()
        var performed = performer.started.makeAsyncIterator()
        core.emit(schedule: schedule(id: "public-task-A", verb: .done), effectID: 1)
        _ = await performed.next()
        XCTAssertFalse(performer.events.contains("callback A"))
        XCTAssertFalse(performer.events.contains("callback B"))
        performer.release(1)
        let firstMatched = await first.value
        XCTAssertTrue(firstMatched)
        XCTAssertFalse(performer.events.contains("callback B"))
        var secondSchedule = schedule(id: "public-task-B", verb: .done)
        secondSchedule.completedAnswers += schedule(id: "public-task-A", verb: .done).completedAnswers
        core.emit(schedule: secondSchedule, effectID: 2)
        _ = await performed.next()
        XCTAssertFalse(performer.events.contains("callback B"))
        performer.release(2)
        let secondMatched = await second.value
        XCTAssertTrue(secondMatched)
        XCTAssertEqual(performer.events.filter { $0 == "callback A" }.count, 1)
        XCTAssertEqual(performer.events.filter { $0 == "callback B" }.count, 1)
        core.finish()
    }

    private func schedule(id: String, verb: Centraid_Core_V1_NotificationVerb) -> Centraid_Core_V1_ScheduleNotifications {
        .with { $0.completedAnswers = [.with { $0.notificationID = id; $0.verb = verb }] }
    }
}

/// No vault, Keychain, permission request or real notification scheduler participates.
private actor NotificationTestCore: ScreenCore {
    nonisolated private let pushed: AsyncStream<Centraid_Core_V1_ScreenUpdate>
    nonisolated private let push: AsyncStream<Centraid_Core_V1_ScreenUpdate>.Continuation
    nonisolated let calls: AsyncStream<String>
    private let callEvents: AsyncStream<String>.Continuation
    nonisolated private let readers = OSAllocatedUnfairLock(initialState: 0)
    nonisolated var updates: AsyncStream<Centraid_Core_V1_ScreenUpdate> {
        readers.withLock { $0 += 1 }
        return pushed
    }
    nonisolated var readerCount: Int { readers.withLock { $0 } }
    private let holdSnapshot: Bool
    private let failSnapshot: Bool
    private var snapshotRelease: CheckedContinuation<Void, Never>?
    private(set) var snapshotCount = 0

    init(holdSnapshot: Bool = false, failSnapshot: Bool = false) {
        (pushed, push) = AsyncStream.makeStream()
        (calls, callEvents) = AsyncStream.makeStream()
        self.holdSnapshot = holdSnapshot
        self.failSnapshot = failSnapshot
    }

    func call(_ request: Centraid_Core_V1_Request) async throws -> Centraid_Core_V1_Response {
        if case .screen(let screen)? = request.kind {
            switch screen.kind {
            case .snapshot?:
                snapshotCount += 1
                if holdSnapshot {
                    await withCheckedContinuation { continuation in
                        snapshotRelease = continuation
                        callEvents.yield("snapshot")
                    }
                } else { callEvents.yield("snapshot") }
                if failSnapshot { throw SnapshotRefused() }
            case .shellFact(let fact)?:
                if case .notificationAnswered(let answer)? = fact.fact {
                    callEvents.yield("answer:\(answer.notificationID):\(answer.verb.rawValue)")
                }
            case .send?: callEvents.yield("performed")
            default: break
            }
        }
        return .with { $0.kind = .screen(.init()) }
    }

    func call(_ request: Centraid_Core_V1_Request, lane: Core.Lane) async throws -> Centraid_Core_V1_Response {
        try await call(request)
    }

    func releaseSnapshot() { snapshotRelease?.resume(); snapshotRelease = nil }

    nonisolated func emit(schedule: Centraid_Core_V1_ScheduleNotifications, effectID: UInt64) {
        push.yield(.with {
            $0.effects = [.with {
                $0.instance = 900
                $0.effectID = effectID
                $0.effect = .with { $0.kind = .scheduleNotifications(schedule) }
            }]
        })
    }

    nonisolated func finish() { push.finish() }
    private struct SnapshotRefused: Error {}
}

@MainActor
private final class NotificationTestPerformer {
    let started: AsyncStream<Int>
    private let begin: AsyncStream<Int>.Continuation
    private let heldCalls: Set<Int>
    private var releases: [Int: CheckedContinuation<Void, Never>] = [:]
    private var count = 0
    var events: [String] = []

    init(heldCalls: Set<Int>) {
        (started, begin) = AsyncStream.makeStream()
        self.heldCalls = heldCalls
    }

    func perform(_ schedule: Centraid_Core_V1_ScheduleNotifications) async -> Centraid_Core_V1_NotificationsScheduled {
        count += 1
        let index = count
        events.append("begin \(index)")
        if heldCalls.contains(index) {
            await withCheckedContinuation { continuation in
                releases[index] = continuation
                begin.yield(index)
            }
        } else { begin.yield(index) }
        events.append("end \(index)")
        return .init()
    }

    func release(_ index: Int) { releases.removeValue(forKey: index)?.resume() }
}
#endif
