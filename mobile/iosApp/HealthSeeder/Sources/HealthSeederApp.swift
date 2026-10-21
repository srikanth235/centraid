import HealthKit
import SwiftUI

/// A YEAR OF TEST HEALTH, WRITTEN INTO A SIMULATOR (#1129). A debug tool: never in Centraid's
/// project, never on a member's phone.
///
/// **DETERMINISTIC.** Every value comes from the day's distance from today through a fixed
/// formula, and every object carries a sync identifier (`seed-<what>-<day>`), so running the
/// seeder again REPLACES what it wrote instead of doubling it.
///
/// - 365 days of steps and active energy (today: so far), resting heart rate and weight.
///   Exercise minutes are Apple's own (`appleExerciseTime` cannot be written by an app), so the
///   seeder leaves them out and Health's exercise line reads nothing.
/// - 90 nights of sleep in stages, each night with an overlapping unstaged "asleep" interval as
///   a phone would add beside a watch — Centraid merges the two and counts the night once.
/// - Ten workouts over the last 60 days: runs, walks and a ride, with distance, energy, heart
///   rate and (the runs) elevation gained.
///
/// Launched with `-extra`, it instead adds 2,000 steps and a walk to TODAY — a second foreground
/// of Centraid then shows them, through its seven-day re-read.
@main
struct HealthSeederApp: App {
    @StateObject private var seeder = Seeder()

    var body: some Scene {
        WindowGroup {
            VStack(spacing: 16) {
                Text("Health Seeder").font(.title2.bold())
                Text(seeder.status)
                    .multilineTextAlignment(.center)
                    .accessibilityIdentifier("seeder-status")
            }
            .padding(24)
            .task { await seeder.run(extra: CommandLine.arguments.contains("-extra")) }
        }
    }
}

@MainActor
final class Seeder: ObservableObject {
    @Published var status = "Asking for access…"

    private let store = HKHealthStore()
    private var calendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .current
        return calendar
    }()

    private let steps = HKQuantityType(.stepCount)
    private let energy = HKQuantityType(.activeEnergyBurned)
    private let resting = HKQuantityType(.restingHeartRate)
    private let weight = HKQuantityType(.bodyMass)
    private let heart = HKQuantityType(.heartRate)
    private let walkRun = HKQuantityType(.distanceWalkingRunning)
    private let cycling = HKQuantityType(.distanceCycling)
    private let sleep = HKCategoryType(.sleepAnalysis)

    func run(extra: Bool) async {
        let types: Set<HKSampleType> = [steps, energy, resting, weight, heart, walkRun, cycling, sleep, HKObjectType.workoutType()]
        do {
            try await store.requestAuthorization(toShare: types, read: types)
            status = "Writing…"
            if extra {
                try await addToday()
                status = "Added 2,000 steps and a walk to today."
            } else {
                let counts = try await seed()
                status = "Seeded \(counts.days) days, \(counts.nights) nights and \(counts.workouts) workouts."
            }
        } catch {
            status = "Failed: \(error.localizedDescription)"
        }
    }

    // MARK: - The year

    private func seed() async throws -> (days: Int, nights: Int, workouts: Int) {
        let now = Date()
        let today = calendar.startOfDay(for: now)
        var samples: [HKSample] = []
        for back in 0..<365 {
            guard let day = calendar.date(byAdding: .day, value: -back, to: today) else { continue }
            let key = Self.key(day)
            let wave = Double((back * 37) % 11) / 10 // 0.0 … 1.0, the same every run
            let weekend = calendar.isDateInWeekend(day)
            // A past day's movement runs 07:00–21:00; today's runs from midnight to now.
            let from = back == 0 ? day : day.addingTimeInterval(7 * 3600)
            let to = back == 0 ? max(now, day.addingTimeInterval(1)) : day.addingTimeInterval(21 * 3600)
            let stepCount = (weekend ? 9_500 : 6_800) + wave * 3_200 - Double(back % 3) * 400
            let fraction = back == 0 ? min(max(now.timeIntervalSince(day) / 64_800, 0.05), 1) : 1
            samples.append(quantity(steps, HKUnit.count(), (stepCount * fraction).rounded(), from, to, "steps-\(key)"))
            samples.append(quantity(energy, .kilocalorie(), ((320 + wave * 180) * fraction).rounded(), from, to, "energy-\(key)"))
            let morning = day.addingTimeInterval(6 * 3600)
            if morning <= now {
                let bpm = 56 + Double((back * 5) % 7)
                samples.append(quantity(resting, HKUnit.count().unitDivided(by: .minute()), bpm, morning, morning, "resting-\(key)"))
                if back % 3 == 0 {
                    let kg = 72.4 - Double(back) * 0.004 + Double((back * 3) % 5) * 0.1
                    samples.append(quantity(weight, .gramUnit(with: .kilo), (kg * 10).rounded() / 10, morning, morning, "weight-\(key)"))
                }
            }
            if back < 90 { samples += night(endingOn: day, back: back, now: now) }
        }
        for chunk in stride(from: 0, to: samples.count, by: 500) {
            try await store.save(Array(samples[chunk..<min(chunk + 500, samples.count)]))
        }
        let plans: [(back: Int, type: HKWorkoutActivityType, hour: Int, minutes: Int, km: Double)] = [
            (1, .running, 7, 31, 5.2), (3, .walking, 18, 45, 3.4), (6, .running, 7, 28, 4.8),
            (9, .cycling, 10, 62, 21.5), (13, .running, 7, 35, 6.1), (17, .walking, 12, 50, 3.9),
            (24, .running, 8, 33, 5.5), (31, .cycling, 9, 75, 26.0), (45, .walking, 19, 40, 3.1),
            (58, .running, 7, 30, 5.0),
        ]
        for plan in plans {
            guard let day = calendar.date(byAdding: .day, value: -plan.back, to: today) else { continue }
            let start = day.addingTimeInterval(Double(plan.hour) * 3600 + 600)
            try await workout(plan.type, start: start, minutes: plan.minutes, km: plan.km, id: "workout-\(Self.key(day))")
        }
        return (365, 90, plans.count)
    }

    /// One night ending on [day]'s morning: core, deep and REM stages from the "watch", and a
    /// longer unstaged "asleep" interval overlapping them.
    private func night(endingOn day: Date, back: Int, now: Date) -> [HKSample] {
        let key = Self.key(day)
        let bed = day.addingTimeInterval(-Double(60 + (back * 13) % 50) * 60) // 23:10 … 23:59 the evening before
        let wake = day.addingTimeInterval(Double(6 * 60 + 20 + (back * 17) % 70) * 60) // 06:20 … 07:29
        guard wake <= now else { return [] }
        let third = wake.timeIntervalSince(bed) / 3
        let stages: [(HKCategoryValueSleepAnalysis, Date, Date)] = [
            (.asleepCore, bed, bed.addingTimeInterval(third)),
            (.asleepDeep, bed.addingTimeInterval(third), bed.addingTimeInterval(third * 2)),
            (.asleepREM, bed.addingTimeInterval(third * 2), wake),
        ]
        var out: [HKSample] = stages.enumerated().map { index, stage in
            HKCategorySample(type: sleep, value: stage.0.rawValue, start: stage.1, end: stage.2, metadata: Self.sync("sleep-\(key)-\(index)"))
        }
        out.append(HKCategorySample(
            type: sleep,
            value: HKCategoryValueSleepAnalysis.asleepUnspecified.rawValue,
            start: bed.addingTimeInterval(600),
            end: wake.addingTimeInterval(-600),
            metadata: Self.sync("sleep-\(key)-phone")
        ))
        return out
    }

    private func workout(_ type: HKWorkoutActivityType, start: Date, minutes: Int, km: Double, id: String) async throws {
        let end = start.addingTimeInterval(Double(minutes) * 60)
        guard end <= Date() else { return }
        let configuration = HKWorkoutConfiguration()
        configuration.activityType = type
        configuration.locationType = .outdoor
        let builder = HKWorkoutBuilder(healthStore: store, configuration: configuration, device: .local())
        try await builder.beginCollection(at: start)
        let distanceType = type == .cycling ? cycling : walkRun
        let kcal = (type == .cycling ? 9.0 : type == .running ? 11.0 : 4.5) * Double(minutes)
        // THE WORKOUT'S OWN SAMPLES CARRY SYNC IDENTIFIERS TOO: without them a second run replaced
        // the workout and left its energy beside the new one's, and the day's total doubled.
        var samples: [HKSample] = [
            quantity(distanceType, .meter(), km * 1000, start, end, "\(id)-distance"),
            quantity(energy, .kilocalorie(), kcal.rounded(), start, end, "\(id)-energy"),
        ]
        let bpm = type == .running ? 152.0 : type == .cycling ? 138.0 : 104.0
        for minute in stride(from: 0, to: minutes, by: 5) {
            let at = start.addingTimeInterval(Double(minute) * 60)
            samples.append(quantity(heart, HKUnit.count().unitDivided(by: .minute()), bpm + Double(minute % 3), at, at, "\(id)-heart-\(minute)"))
        }
        try await builder.addSamples(samples)
        var metadata = Self.sync(id)
        if type == .running {
            metadata[HKMetadataKeyElevationAscended] = HKQuantity(unit: .meter(), doubleValue: 40 + km * 4)
        }
        try await builder.addMetadata(metadata)
        try await builder.endCollection(at: end)
        _ = try await builder.finishWorkout()
    }

    // MARK: - A day added

    private func addToday() async throws {
        // AT A FIXED MOMENT OF TODAY, so a second run replaces the first: a walk moved to another
        // start would be another workout (Centraid keeps one gone from the phone, R-1129-14).
        let now = Date()
        let start = calendar.startOfDay(for: now).addingTimeInterval(60)
        let key = Self.key(now)
        try await store.save(quantity(steps, HKUnit.count(), 2_000, start, max(now, start.addingTimeInterval(1)), "steps-extra-\(key)"))
        let minutes = min(25, Int(now.timeIntervalSince(start) / 60) - 1)
        if minutes > 0 {
            try await workout(.walking, start: start, minutes: minutes, km: 2.1, id: "workout-extra-\(key)")
        }
    }

    // MARK: - Parts

    private func quantity(_ type: HKQuantityType, _ unit: HKUnit, _ value: Double, _ start: Date, _ end: Date, _ id: String) -> HKQuantitySample {
        HKQuantitySample(type: type, quantity: HKQuantity(unit: unit, doubleValue: value), start: start, end: end, metadata: Self.sync(id))
    }

    /// The sync identifier that makes a second run replace the first.
    private static func sync(_ id: String) -> [String: Any] {
        [HKMetadataKeySyncIdentifier: "seed-\(id)", HKMetadataKeySyncVersion: 1]
    }

    private static func key(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: date)
    }
}
