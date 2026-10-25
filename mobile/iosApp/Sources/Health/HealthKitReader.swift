import Foundation
import HealthKit

/// HEALTHKIT, READ ONLY (#1129, #1135; R-1129-7): the iOS half of the `HealthRead` effect,
/// answered with a `HealthSnapshot`.
///
/// **NOTHING IS EVER WRITTEN.** Authorization is `toShare: []` (`HealthAccess.request`), the
/// entitlement's access list is empty, the bundle declares no `NSHealthUpdateUsageDescription`,
/// and nothing under `Sources/` saves or deletes a HealthKit object — `healthkit-read-only` (`cargo xtask rules`)
/// reads all four.
///
/// **ASKS ONLY WHEN THE EFFECT SAYS SO.** `ask_permission` is the member's Connect tap; a pass
/// reads over what the member granted and never asks for authorization (R-1127-15). HealthKit
/// hides whether a READ was granted — a refused type simply answers nothing — so whether the
/// member went through Connect at all is Rust's to keep (a keychain habit), and it only sends a
/// pass to a phone that did.
///
/// What a read covers, for the types the member chose only (R-1129-6):
/// - **Daily totals** from one `HKStatisticsCollectionQuery` per quantity type, anchored at the
///   phone's local midnight with a one-day interval, over `totals_from`…now: the store's own
///   statistics, so a watch and a phone counting the same steps count once. Steps, active energy
///   and exercise minutes are `.cumulativeSum`, resting heart rate `.discreteAverage`, weight
///   `.mostRecent` (kg).
/// - **Sleep** from `sleepAnalysis` samples: the asleep values only, every source's intervals
///   MERGED (a union, so the watch and the phone are not counted twice), each merged run's
///   minutes keyed to the local day it ENDS on — the day the member woke.
/// - **Workouts** started at or after `workouts_since_ms`: the store's own id, the
///   `HKWorkoutActivityType` case's name (`kinds.rs`' iOS keys; any other kind is `other`), UTC
///   instants, moving seconds, and the figures the workout's own statistics hold. A failed query
///   makes the read incomplete, which removes nothing (R-1129-5).
///
/// This reads and decides nothing else: Rust diffs the days, maps the kind and judges
/// completeness.
enum HealthKitReader {
    /// The effect's answer: a snapshot, or a refusal by value when HealthKit is not on this phone
    /// or the member's Connect sheet failed.
    static func snapshot(_ read: Centraid_Core_V1_HealthRead) async -> Centraid_Core_V1_EffectResult.OneOf_Outcome {
        guard HKHealthStore.isHealthDataAvailable() else { return .failed(denied("health data is not available")) }
        if read.askPermission {
            guard await HealthAccess.request(read.chosen) else { return .failed(denied("health access not given")) }
        }
        let store = HealthAccess.store
        return await Task.detached(priority: .utility) {
            .health(await Self.read(store: store, read: read))
        }.value
    }

    private static func denied(_ reason: String) -> Centraid_Core_V1_EffectFailed {
        var failed = Centraid_Core_V1_EffectFailed()
        failed.reason = reason
        failed.denied = true
        return failed
    }

    /// This install's id, minted once and kept off the vault (R-1127-10): the same one the calendar
    /// stamps, so a followed workout's `local:` link names this phone.
    private static var deviceID: String {
        let key = "dev.centraid.install-id"
        if let known = UserDefaults.standard.string(forKey: key) { return known }
        let minted = UUID().uuidString
        UserDefaults.standard.set(minted, forKey: key)
        return minted
    }

    // MARK: - One read

    private static func read(store: HKHealthStore, read: Centraid_Core_V1_HealthRead) async -> Centraid_Core_V1_HealthSnapshot {
        let chosen = read.chosen
        let days = HealthCalendarDays()
        var totals: [Centraid_Core_V1_HealthDayTotal] = []
        if let from = days.start(of: read.totalsFrom) {
            for metric in DailyMetric.all where chosen.contains(metric.key) {
                totals += await statistics(store: store, metric: metric, from: from, days: days)
            }
            if chosen.contains(HealthAccess.Key.sleep) {
                totals += await sleep(store: store, from: from, through: read.today, days: days)
            }
        }
        var workouts: [Centraid_Core_V1_HealthPhoneWorkout] = []
        var complete = true
        if chosen.contains(HealthAccess.Key.workouts) {
            let since = Date(timeIntervalSince1970: TimeInterval(read.workoutsSinceMs) / 1000)
            if let found = await workoutsSince(store: store, since: since) {
                workouts = found
            } else {
                complete = false
            }
        }
        var out = Centraid_Core_V1_HealthSnapshot()
        out.store = .appleHealth
        out.storePresent = true
        out.days = totals
        out.workouts = workouts
        out.workoutsComplete = complete
        out.deviceID = deviceID
        return out
    }

    // MARK: - Daily totals

    /// One daily quantity: its key, its type, how a day folds and the unit its value is stated in.
    struct DailyMetric {
        let key: String
        let type: HKQuantityTypeIdentifier
        let option: HKStatisticsOptions
        let unit: HKUnit

        static let all: [DailyMetric] = [
            DailyMetric(key: HealthAccess.Key.steps, type: .stepCount, option: .cumulativeSum, unit: .count()),
            DailyMetric(key: HealthAccess.Key.energy, type: .activeEnergyBurned, option: .cumulativeSum, unit: .kilocalorie()),
            DailyMetric(key: HealthAccess.Key.exercise, type: .appleExerciseTime, option: .cumulativeSum, unit: .minute()),
            DailyMetric(
                key: HealthAccess.Key.restingHr,
                type: .restingHeartRate,
                option: .discreteAverage,
                unit: HKUnit.count().unitDivided(by: .minute())
            ),
            DailyMetric(key: HealthAccess.Key.weight, type: .bodyMass, option: .mostRecent, unit: .gramUnit(with: .kilo)),
        ]

        func value(_ statistics: HKStatistics) -> Double? {
            let quantity: HKQuantity?
            switch option {
            case .cumulativeSum: quantity = statistics.sumQuantity()
            case .discreteAverage: quantity = statistics.averageQuantity()
            default: quantity = statistics.mostRecentQuantity()
            }
            return quantity?.doubleValue(for: unit)
        }
    }

    /// The store's statistics for [metric], one bucket a local day from [from] to now. A day the
    /// store has nothing for is absent, never a zero; a query that fails reads nothing.
    private static func statistics(store: HKHealthStore, metric: DailyMetric, from: Date, days: HealthCalendarDays) async -> [Centraid_Core_V1_HealthDayTotal] {
        let type = HKQuantityType(metric.type)
        let now = Date()
        let predicate = HKQuery.predicateForSamples(withStart: from, end: now, options: [])
        return await withCheckedContinuation { continuation in
            let query = HKStatisticsCollectionQuery(
                quantityType: type,
                quantitySamplePredicate: predicate,
                options: metric.option,
                anchorDate: from,
                intervalComponents: DateComponents(day: 1)
            )
            query.initialResultsHandler = { _, collection, _ in
                var out: [Centraid_Core_V1_HealthDayTotal] = []
                collection?.enumerateStatistics(from: from, to: now) { statistics, _ in
                    guard let value = metric.value(statistics), value.isFinite else { return }
                    out.append(dayTotal(days.key(statistics.startDate), metric.key, value))
                }
                continuation.resume(returning: out)
            }
            store.execute(query)
        }
    }

    private static func dayTotal(_ day: String, _ metric: String, _ value: Double) -> Centraid_Core_V1_HealthDayTotal {
        var total = Centraid_Core_V1_HealthDayTotal()
        total.day = day
        total.metric = metric
        total.value = value
        return total
    }

    // MARK: - Sleep

    /// The asleep values: every stage a watch reports and the phone's unstaged "asleep".
    private static let asleep: Set<Int> = [
        HKCategoryValueSleepAnalysis.asleepUnspecified.rawValue,
        HKCategoryValueSleepAnalysis.asleepCore.rawValue,
        HKCategoryValueSleepAnalysis.asleepDeep.rawValue,
        HKCategoryValueSleepAnalysis.asleepREM.rawValue,
    ]

    /// Minutes asleep per day woken, for the nights that end on [from]'s day through [through].
    /// The samples are read from a day earlier, so the first night's start is not cut off.
    private static func sleep(store: HKHealthStore, from: Date, through: String, days: HealthCalendarDays) async -> [Centraid_Core_V1_HealthDayTotal] {
        let type = HKCategoryType(.sleepAnalysis)
        let start = days.calendar.date(byAdding: .day, value: -1, to: from) ?? from
        let predicate = HKQuery.predicateForSamples(withStart: start, end: Date(), options: [])
        let samples: [HKCategorySample] = await withCheckedContinuation { continuation in
            let query = HKSampleQuery(
                sampleType: type,
                predicate: predicate,
                limit: HKObjectQueryNoLimit,
                sortDescriptors: [NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: true)]
            ) { _, results, _ in
                continuation.resume(returning: (results as? [HKCategorySample]) ?? [])
            }
            store.execute(query)
        }
        let runs = merged(samples.filter { asleep.contains($0.value) }.map { ($0.startDate, $0.endDate) })
        let first = days.key(from)
        var minutes: [String: Double] = [:]
        for run in runs {
            let day = days.key(run.1)
            guard day >= first, day <= through else { continue }
            minutes[day, default: 0] += run.1.timeIntervalSince(run.0) / 60
        }
        return minutes.keys.sorted().map { dayTotal($0, HealthAccess.Key.sleep, minutes[$0] ?? 0) }
    }

    /// THE UNION of [intervals]: overlapping or touching intervals from any source become one run,
    /// so a night the watch and the phone both recorded is counted once.
    static func merged(_ intervals: [(Date, Date)]) -> [(Date, Date)] {
        var out: [(Date, Date)] = []
        for interval in intervals.filter({ $0.1 > $0.0 }).sorted(by: { $0.0 < $1.0 }) {
            if let last = out.last, interval.0 <= last.1 {
                out[out.count - 1].1 = max(last.1, interval.1)
            } else {
                out.append(interval)
            }
        }
        return out
    }

    // MARK: - Workouts

    /// Every workout that started at or after [since], or nil when the query failed.
    private static func workoutsSince(store: HKHealthStore, since: Date) async -> [Centraid_Core_V1_HealthPhoneWorkout]? {
        let predicate = HKQuery.predicateForSamples(withStart: since, end: nil, options: [.strictStartDate])
        let found: [HKWorkout]? = await withCheckedContinuation { continuation in
            let query = HKSampleQuery(
                sampleType: HKObjectType.workoutType(),
                predicate: predicate,
                limit: HKObjectQueryNoLimit,
                sortDescriptors: [NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: true)]
            ) { _, results, error in
                continuation.resume(returning: error == nil ? ((results as? [HKWorkout]) ?? []) : nil)
            }
            store.execute(query)
        }
        return found?.map(workout)
    }

    /// The distance types a workout's statistics may hold, by the kinds that record them.
    private static let distances: [HKQuantityTypeIdentifier] = [
        .distanceWalkingRunning, .distanceCycling, .distanceSwimming, .distanceWheelchair, .distanceDownhillSnowSports,
    ]

    private static func workout(_ workout: HKWorkout) -> Centraid_Core_V1_HealthPhoneWorkout {
        let distance = distances.lazy
            .compactMap { workout.statistics(for: HKQuantityType($0))?.sumQuantity()?.doubleValue(for: .meter()) }
            .first
        let energy = workout.statistics(for: HKQuantityType(.activeEnergyBurned))?.sumQuantity()?.doubleValue(for: .kilocalorie())
        let heart = workout.statistics(for: HKQuantityType(.heartRate))?
            .averageQuantity()?
            .doubleValue(for: HKUnit.count().unitDivided(by: .minute()))
        let elevation = (workout.metadata?[HKMetadataKeyElevationAscended] as? HKQuantity)?.doubleValue(for: .meter())
        var out = Centraid_Core_V1_HealthPhoneWorkout()
        out.id = workout.uuid.uuidString
        out.kind = kind(workout.workoutActivityType)
        out.startedAt = HealthInstant.utc(workout.startDate)
        out.endedAt = HealthInstant.utc(workout.endDate)
        if workout.duration > 0 { out.movingSec = Int64(workout.duration.rounded()) }
        if let distance { out.distanceM = distance }
        if let energy { out.energyKcal = energy }
        if let heart { out.avgHrBpm = Int64(heart.rounded()) }
        if let elevation { out.elevationGainM = elevation }
        out.recordedBy = workout.sourceRevision.source.name
        return out
    }

    /// THE KIND'S SWIFT CASE NAME, the word `crates/screens/src/health/kinds.rs` keys on. Its names ARE the
    /// table's iOS keys (the `healthkit-read-only` rule compares them); a kind the table does not name is
    /// `other`.
    static func kind(_ type: HKWorkoutActivityType) -> String {
        switch type {
        case .running: return "running"
        case .walking: return "walking"
        case .cycling: return "cycling"
        case .handCycling: return "handCycling"
        case .traditionalStrengthTraining: return "traditionalStrengthTraining"
        case .functionalStrengthTraining: return "functionalStrengthTraining"
        case .swimming: return "swimming"
        case .hiking: return "hiking"
        case .yoga: return "yoga"
        default: return "other"
        }
    }
}

/// THE PHONE'S CALENDAR DAYS: local midnight for a `YYYY-MM-DD`, and the `YYYY-MM-DD` a moment
/// falls on — Gregorian, in the device's zone, the zone the core places Health's window in.
struct HealthCalendarDays {
    let calendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .current
        return calendar
    }()

    private var formatter: DateFormatter {
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = calendar.timeZone
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }

    func key(_ date: Date) -> String { formatter.string(from: date) }

    func start(of day: String) -> Date? { formatter.date(from: day).map { calendar.startOfDay(for: $0) } }
}

/// AN INSTANT AS THE VAULT SPELLS IT: UTC, milliseconds, `Z`.
enum HealthInstant {
    static func utc(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        formatter.timeZone = TimeZone(identifier: "UTC")
        return formatter.string(from: date)
    }
}
