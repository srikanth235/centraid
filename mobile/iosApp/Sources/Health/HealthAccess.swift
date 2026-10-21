import Foundation
import HealthKit

import CentraidShared

/// WHAT THIS PHONE LETS HEALTH READ, AND THE ONE PLACE IT IS ASKED (#1129).
///
/// **The chosen set is the phone's, never the vault's** (R-1129-6): the type keys the member
/// chose on Connect are kept in this shell's own storage, like a followed folder's access
/// (R-1127-7), and stated to the shared side through `HealthDevices` — at launch, after Connect
/// and when the locale changes (`state()`).
///
/// **Whether the member went through Connect** is kept here too, because HealthKit hides a read
/// grant: a refused or revoked type answers "no data", never "not allowed". The reader delivers
/// nothing until this is set, and Stop clears it.
///
/// **THE OS IS ASKED ONLY AT THE MEMBER'S CONNECT TAP** (`request`), for read types only:
/// `toShare` is empty, always (R-1129-7). Never at launch, never from a pass (R-1127-15).
enum HealthAccess {
    /// One store for the life of the process, as HealthKit asks.
    static let store = HKHealthStore()

    private static let connectedKey = "dev.centraid.health.connected"
    private static let chosenKey = "dev.centraid.health.chosen"

    /// The member went through Connect and has not stopped since.
    static var connected: Bool {
        get { UserDefaults.standard.bool(forKey: connectedKey) }
        set { UserDefaults.standard.set(newValue, forKey: connectedKey) }
    }

    /// The type keys the member chose (`steps`, `sleep_min`, …, `workouts`); empty before Connect.
    static var chosen: [String] {
        get { UserDefaults.standard.stringArray(forKey: chosenKey) ?? [] }
        set { UserDefaults.standard.set(newValue, forKey: chosenKey) }
    }

    /// STATE THE PHONE'S FACTS to every Health screen: this store, the measurement system (display
    /// only) and the chosen set. HealthKit cannot name a refusal, so `refused` is empty.
    static func state() {
        HealthDevices.shared.update(
            store: HealthDevices.shared.APPLE_HEALTH,
            metric: Locale.current.measurementSystem == .metric,
            chosen: chosen,
            refused: []
        )
    }

    /// The HealthKit types behind each chosen key. Workouts read the workout type and the
    /// quantities its figures come from.
    static func types(for keys: [String]) -> Set<HKObjectType> {
        var types = Set<HKObjectType>()
        for key in keys {
            switch key {
            case HealthMetrics.steps.key: types.insert(HKQuantityType(.stepCount))
            case HealthMetrics.sleep.key: types.insert(HKCategoryType(.sleepAnalysis))
            case HealthMetrics.energy.key: types.insert(HKQuantityType(.activeEnergyBurned))
            case HealthMetrics.exercise.key: types.insert(HKQuantityType(.appleExerciseTime))
            case HealthMetrics.restingHr.key: types.insert(HKQuantityType(.restingHeartRate))
            case HealthMetrics.weight.key: types.insert(HKQuantityType(.bodyMass))
            case HealthMetrics.companion.WORKOUTS:
                types.insert(HKObjectType.workoutType())
                types.insert(HKQuantityType(.distanceWalkingRunning))
                types.insert(HKQuantityType(.distanceCycling))
                types.insert(HKQuantityType(.distanceSwimming))
                types.insert(HKQuantityType(.activeEnergyBurned))
                types.insert(HKQuantityType(.heartRate))
            default: break
            }
        }
        return types
    }

    /// ASK THE OS, READ ONLY, for exactly [keys] — the member just tapped Connect. True when the
    /// sheet was answered (HealthKit does not say what was granted); false when this phone has no
    /// HealthKit or the request failed. The keys are kept, and the phone marked connected, only
    /// on true.
    @MainActor
    static func request(_ keys: [String]) async -> Bool {
        guard HKHealthStore.isHealthDataAvailable() else { return false }
        do {
            try await store.requestAuthorization(toShare: [], read: types(for: keys))
        } catch {
            return false
        }
        chosen = keys
        connected = true
        state()
        return true
    }

    /// Health stopped reading the store: nothing more is read until the member connects again.
    /// The choices are kept, so Connect opens on them.
    static func stopped() {
        connected = false
        state()
    }
}
