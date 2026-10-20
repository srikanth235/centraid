import Foundation
import HealthKit

import CentraidShared

/// HEALTHKIT, READ ONLY (#1129; R-1129-7): the iOS half of `HealthReader`.
///
/// **NOTHING IS EVER WRITTEN.** Authorization is `toShare: []` (`HealthAccess.request`), the
/// entitlement's access list is empty, the bundle declares no `NSHealthUpdateUsageDescription`,
/// and nothing under `Sources/` saves or deletes a HealthKit object — `HealthKitReadOnlySpec`
/// reads all four.
///
/// **NEVER ASKS.** A pass reads over what the member granted at Connect; it never asks for
/// authorization (R-1127-15). HealthKit hides whether a READ was granted — a refused type simply
/// answers nothing — so whether the member went through Connect at all is kept by the shell
/// (`HealthAccess.connected`), and `nil` is delivered when they did not.
///
/// What a pass reads, for the types the member chose only (R-1129-6):
/// - **Daily totals** from one `HKStatisticsCollectionQuery` per quantity type, anchored at the
///   phone's local midnight with a one-day interval, over `totalsFrom`…now: the store's own
///   statistics, so a watch and a phone counting the same steps count once. Steps, active energy
///   and exercise minutes are `.cumulativeSum`, resting heart rate `.discreteAverage`, weight
///   `.mostRecent` (kg).
/// - **Sleep** from `sleepAnalysis` samples: the asleep values only, every source's intervals
///   MERGED (a union, so the watch and the phone are not counted twice), each merged run's
///   minutes keyed to the local day it ENDS on — the day the member woke.
/// - **Workouts** started at or after `workoutsSince`: the store's own id, the
///   `HKWorkoutActivityType` case's name (`HealthKinds.TABLE`'s iOS keys; any other kind is
///   `other`), UTC instants, moving seconds, and the figures the workout's own statistics hold.
///   A failed query makes the read incomplete, which removes nothing (R-1129-5).
///
/// Off the main thread; `deliver` is called exactly once.
final class HealthKitReader: NSObject, HealthReader {
    func read(window: HealthWindow, deliver: @escaping (HealthRead?) -> Void) {
        guard HKHealthStore.isHealthDataAvailable(), HealthAccess.connected else {
            deliver(nil)
            return
        }
        let chosen = HealthAccess.chosen
        let store = HealthAccess.store
        Task.detached(priority: .utility) {
            deliver(await Self.read(store: store, window: window, chosen: chosen))
        }
    }

    // MARK: - One pass

    private static func read(store: HKHealthStore, window: HealthWindow, chosen: [String]) async -> HealthRead {
        let days = HealthCalendarDays()
        var totals: [HealthDayTotal] = []
        if let from = days.start(of: window.totalsFrom) {
            for metric in DailyMetric.all where chosen.contains(metric.key) {
                totals += await statistics(store: store, metric: metric, from: from, days: days)
            }
            if chosen.contains(HealthMetrics.sleep.key) {
                totals += await sleep(store: store, from: from, through: window.today, days: days)
            }
        }
        var workouts: [PhoneWorkout] = []
        var complete = true
        if chosen.contains(HealthMetrics.companion.WORKOUTS) {
            let since = Date(timeIntervalSince1970: TimeInterval(window.workoutsSince) / 1000)
            if let read = await workoutsSince(store: store, since: since) {
                workouts = read
            } else {
                complete = false
            }
        }
        return HealthRead(
            store: .appleHealth,
            days: totals,
            workouts: workouts,
            chosen: chosen,
            refused: [],
            workoutsComplete: complete,
            storePresent: true
        )
    }

    // MARK: - Daily totals

    /// One daily quantity: its key, its type, how a day folds and the unit its value is stated in.
    struct DailyMetric {
        let key: String
        let type: HKQuantityTypeIdentifier
        let option: HKStatisticsOptions
        let unit: HKUnit

        static let all: [DailyMetric] = [
            DailyMetric(key: HealthMetrics.steps.key, type: .stepCount, option: .cumulativeSum, unit: .count()),
            DailyMetric(key: HealthMetrics.energy.key, type: .activeEnergyBurned, option: .cumulativeSum, unit: .kilocalorie()),
            DailyMetric(key: HealthMetrics.exercise.key, type: .appleExerciseTime, option: .cumulativeSum, unit: .minute()),
            DailyMetric(
                key: HealthMetrics.restingHr.key,
                type: .restingHeartRate,
                option: .discreteAverage,
                unit: HKUnit.count().unitDivided(by: .minute())
            ),
            DailyMetric(key: HealthMetrics.weight.key, type: .bodyMass, option: .mostRecent, unit: .gramUnit(with: .kilo)),
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
    private static func statistics(store: HKHealthStore, metric: DailyMetric, from: Date, days: HealthCalendarDays) async -> [HealthDayTotal] {
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
                var out: [HealthDayTotal] = []
                collection?.enumerateStatistics(from: from, to: now) { statistics, _ in
                    guard let value = metric.value(statistics), value.isFinite else { return }
                    out.append(HealthDayTotal(day: days.key(statistics.startDate), metric: metric.key, value: value))
                }
                continuation.resume(returning: out)
            }
            store.execute(query)
        }
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
    private static func sleep(store: HKHealthStore, from: Date, through: String, days: HealthCalendarDays) async -> [HealthDayTotal] {
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
        return minutes.keys.sorted().map { HealthDayTotal(day: $0, metric: HealthMetrics.sleep.key, value: minutes[$0] ?? 0) }
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
    private static func workoutsSince(store: HKHealthStore, since: Date) async -> [PhoneWorkout]? {
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

    private static func workout(_ workout: HKWorkout) -> PhoneWorkout {
        let distance = distances.lazy
            .compactMap { workout.statistics(for: HKQuantityType($0))?.sumQuantity()?.doubleValue(for: .meter()) }
            .first
        let energy = workout.statistics(for: HKQuantityType(.activeEnergyBurned))?.sumQuantity()?.doubleValue(for: .kilocalorie())
        let heart = workout.statistics(for: HKQuantityType(.heartRate))?
            .averageQuantity()?
            .doubleValue(for: HKUnit.count().unitDivided(by: .minute()))
        let elevation = (workout.metadata?[HKMetadataKeyElevationAscended] as? HKQuantity)?.doubleValue(for: .meter())
        return PhoneWorkout(
            id: workout.uuid.uuidString,
            kind: kind(workout.workoutActivityType),
            startedAt: HealthInstant.utc(workout.startDate),
            endedAt: HealthInstant.utc(workout.endDate),
            movingSec: workout.duration > 0 ? KotlinLong(value: Int64(workout.duration.rounded())) : nil,
            distanceM: distance.map { KotlinDouble(value: $0) },
            energyKcal: energy.map { KotlinDouble(value: $0) },
            avgHrBpm: heart.map { KotlinLong(value: Int64($0.rounded())) },
            elevationGainM: elevation.map { KotlinDouble(value: $0) },
            recordedBy: workout.sourceRevision.source.name
        )
    }

    /// THE KIND'S SWIFT CASE NAME, the word `HealthKinds.TABLE` keys on. Its names ARE the
    /// table's iOS keys (`HealthKitReadOnlySpec` compares them); a kind the table does not name is
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
/// falls on — Gregorian, in the device's zone, as `LocalDays` places them on the shared side.
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
