//! HEALTH'S EXPORT (`health.export`, #1185), the kit's one export screen over `health.export_csv`:
//! the rows are "All daily totals", "All workouts" and each metric, and the spreadsheet file the
//! command answers goes to the OS save sheet once the owner check passed.

use centraid_api_proto::core_v1 as wire;

use super::{Metric, figures};
use crate::catalog::act;
use crate::catalog::act::health as options;
use crate::field::Field;
use crate::kit::act as kit_act;
use crate::kit::export::{self, Choice, ExportSpec};
use crate::kit::owner::NoPasscode;
use crate::kit::read::Reading;
use crate::screen::{Ctx, Screen};
use crate::strings::{Locale, health as words};

/// The row that exports every daily total.
const TOTALS: &str = "totals";
/// The row that exports every workout.
const WORKOUTS: &str = "workouts";

static SPEC: ExportSpec = ExportSpec {
    app: "health",
    title: words::export_title,
    lede: words::export_lede,
    back_label: words::app_title,
    denied,
    choices,
    export,
    no_passcode: NoPasscode::Warn,
};

#[must_use]
pub fn build(route: &wire::Route) -> Option<Box<dyn Screen>> {
    export::build(&SPEC, route)
}

/// The gate drawn when the vault will not let Health read.
fn denied(locale: Locale, denial: &wire::AppQueryDenial) -> wire::Denied {
    super::denied(locale, denial)
}

/// The rows need no read: the two files, then one per metric (a metric's file holds its days).
fn choices(ctx: &Ctx) -> Reading<Vec<Choice>> {
    let locale = ctx.locale();
    let row = |key: &str, label: String| Choice {
        key: key.to_owned(),
        label,
        value: String::new(),
    };
    let mut rows = vec![
        row(TOTALS, words::export_totals(locale)),
        row(WORKOUTS, words::export_workouts(locale)),
    ];
    rows.extend(
        Metric::ALL
            .iter()
            .map(|metric| row(metric.key(), figures::label(locale, *metric))),
    );
    Reading::Data(rows)
}

fn metric_of(key: &str) -> Option<options::ExportCsvMetric> {
    use options::ExportCsvMetric as M;
    Some(match Metric::of_key(key)? {
        Metric::Steps => M::Steps,
        Metric::Sleep => M::SleepMin,
        Metric::Energy => M::ActiveEnergyKcal,
        Metric::Exercise => M::ExerciseMin,
        Metric::RestingHr => M::RestingHrBpm,
        Metric::Weight => M::WeightKg,
    })
}

/// The spreadsheet file of every workout, or of one (`workout_id`, what a workout page shares),
/// through the same command the export screen calls.
pub fn workouts_file(ctx: &Ctx, workout_id: Option<&str>) -> Result<export::ExportFile, String> {
    file(ctx, options::ExportCsvWhat::Workouts, None, workout_id)
}

fn file(
    ctx: &Ctx,
    what: options::ExportCsvWhat,
    metric: Option<options::ExportCsvMetric>,
    workout_id: Option<&str>,
) -> Result<export::ExportFile, String> {
    let which = format!("{what:?}{metric:?}");
    // undo-exempt: an export writes nothing (`writes_nothing` in the manifest), so there is nothing to take back.
    let settled = kit_act::act(
        ctx,
        act::health::ExportCsv {
            what,
            workout_id: workout_id.map_or(Field::Keep, |id| Field::Is(id.to_owned())),
            metric,
        },
        &kit_act::key(
            &["health.export_csv", &which, workout_id.unwrap_or_default()],
            kit_act::fresh(),
        ),
    );
    if workout_id.is_some()
        && settled.committed
        && crate::kit::transfer::count(&settled.output, "count") == 0
    {
        return Err(String::new());
    }
    export::file_of(&settled, "text/csv", "Health.csv")
}

fn export(ctx: &Ctx, key: &str) -> Result<export::ExportFile, String> {
    use options::ExportCsvWhat as What;
    match key {
        WORKOUTS => workouts_file(ctx, None),
        TOTALS => file(ctx, What::Measurements, None, None),
        other => match metric_of(other) {
            Some(metric) => file(ctx, What::Measurements, Some(metric), None),
            None => Err(String::new()),
        },
    }
}
