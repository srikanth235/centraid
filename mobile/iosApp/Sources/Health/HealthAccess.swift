import Foundation
import HealthKit

/// WHAT THIS PHONE LETS HEALTH READ, AND THE ONE PLACE IT IS ASKED (#1129, #1135).
///
/// **The chosen set is the phone's, never the vault's** (R-1129-6), and it is Rust's to keep:
/// the screen keeps it in the keychain as a per-device habit and sends it with each
/// `HealthRead`. HealthKit hides a read grant — a refused or revoked type answers "no data", never
/// "not allowed" — so nothing here can say what was granted; the member's choice is what Rust
/// holds.
///
/// **THE OS IS ASKED ONLY AT THE MEMBER'S CONNECT TAP** (`request`, when the effect says
/// `ask_permission`), for read types only: `toShare` is empty, always (R-1129-7). Never at
/// launch, never from a pass (R-1127-15).
enum HealthAccess {
    /// One store for the life of the process, as HealthKit asks.
    static let store = HKHealthStore()

    /// The type keys Rust names (`HealthRead.chosen`).
    enum Key {
        static let steps = "steps"
        static let sleep = "sleep_min"
        static let energy = "active_energy_kcal"
        static let exercise = "exercise_min"
        static let restingHr = "resting_hr_bpm"
        static let weight = "weight_kg"
        static let workouts = "workouts"
    }

    /// The HealthKit types behind each chosen key. Workouts read the workout type and the
    /// quantities its figures come from.
    static func types(for keys: [String]) -> Set<HKObjectType> {
        var types = Set<HKObjectType>()
        for key in keys {
            switch key {
            case Key.steps: types.insert(HKQuantityType(.stepCount))
            case Key.sleep: types.insert(HKCategoryType(.sleepAnalysis))
            case Key.energy: types.insert(HKQuantityType(.activeEnergyBurned))
            case Key.exercise: types.insert(HKQuantityType(.appleExerciseTime))
            case Key.restingHr: types.insert(HKQuantityType(.restingHeartRate))
            case Key.weight: types.insert(HKQuantityType(.bodyMass))
            case Key.workouts:
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
    /// HealthKit or the request failed.
    @MainActor
    static func request(_ keys: [String]) async -> Bool {
        guard HKHealthStore.isHealthDataAvailable() else { return false }
        do {
            try await store.requestAuthorization(toShare: [], read: types(for: keys))
        } catch {
            return false
        }
        return true
    }
}
