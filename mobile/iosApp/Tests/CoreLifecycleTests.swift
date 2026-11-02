import Foundation
import XCTest
import SwiftProtobuf

@testable import CentraidApp

/// Real ABI ownership coverage. Every iteration opens an empty temporary shelf;
/// no personal vault, seed, network service, or platform permission is needed.
final class CoreLifecycleTests: XCTestCase {
    func testCloseDrainsConcurrentCallsAndEndsTheEventStream() async throws {
        let finished = expectation(description: "all cores closed and event streams ended")
        let exercise = Task {
            defer { finished.fulfill() }
            for _ in 0..<12 {
                let directory = FileManager.default.temporaryDirectory
                    .appendingPathComponent("core-lifecycle-\(UUID().uuidString)", isDirectory: true)
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                defer { try? FileManager.default.removeItem(at: directory) }
                let configuration = Core.Configuration(shelf: directory.path, devSeed: nil)
                let core = try await Task.detached { try Core.open(configuration) }.value
                let events = Task {
                    for await _ in core.updates {}
                }
                let request = Centraid_Core_V1_Request.with {
                    $0.kind = .hello(Centraid_Core_V1_Hello())
                }
                _ = try await core.call(request)
                await withTaskGroup(of: Bool.self) { group in
                    for index in 0..<32 {
                        group.addTask {
                            do {
                                _ = try await core.call(request, lane: index.isMultiple(of: 2) ? .screens : .bulk)
                                return true
                            } catch Core.Failure.closed {
                                return true
                            } catch {
                                return false
                            }
                        }
                    }
                    let closing = Task { await core.close() }
                    for await valid in group {
                        XCTAssertTrue(valid, "a concurrent call must answer or report closed")
                    }
                    await closing.value
                }
                await events.value
                do {
                    _ = try await core.call(request)
                    XCTFail("a closed core accepted a request")
                } catch Core.Failure.closed {
                    // A closed handle must be rejected before reaching the ABI.
                }
                await core.close()
            }
        }
        let result = await XCTWaiter.fulfillment(of: [finished], timeout: 30)
        XCTAssertEqual(result, .completed, "close or the event stream failed to finish")
        guard result == .completed else {
            exercise.cancel()
            return
        }
        try await exercise.value
    }
}
