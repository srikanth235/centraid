//! PEOPLE'S EXPORT (`people.export`, #1185), the kit's one export screen over
//! `person.export_vcf`: the rows are "Everyone" and each list, and the vCard file the command
//! answers goes to the OS save sheet once the owner check passed.

use centraid_api_proto::core_v1 as wire;
use wire::app_query_response::Answer;

use crate::catalog::{act, load};
use crate::kit::act as kit_act;
use crate::kit::export::{self, Choice, ExportSpec};
use crate::kit::owner::NoPasscode;
use crate::kit::read::{self, Reading};
use crate::screen::{Ctx, Screen};
use crate::strings::people as words;

/// The row that exports everyone.
const ALL: &str = "all";

static SPEC: ExportSpec = ExportSpec {
    app: "people",
    title: words::transfer_export_title,
    lede: words::transfer_export_lede,
    back_label: words::app_title,
    denied: super::denied,
    choices,
    export,
    no_passcode: NoPasscode::Warn,
};

#[must_use]
pub fn build(route: &wire::Route) -> Option<Box<dyn Screen>> {
    export::build(&SPEC, route)
}

fn choices(ctx: &Ctx) -> Reading<Vec<Choice>> {
    let roster = read::read(
        ctx,
        load::people::People {
            filter: Some("all".to_owned()),
            limit: 20,
            sort: Some("name".to_owned()),
        },
        |answer| match answer {
            Answer::PeopleRoster(roster) => Some(roster),
            _ => None,
        },
    );
    match roster {
        Reading::Data(roster) => {
            let mut rows = vec![Choice {
                key: ALL.to_owned(),
                label: words::transfer_export_all(ctx.locale()),
                value: String::new(),
            }];
            rows.extend(roster.lists.iter().map(|list| Choice {
                key: list.list_id.clone(),
                label: list.name.clone(),
                value: String::new(),
            }));
            Reading::Data(rows)
        }
        Reading::Denied(denial) => Reading::Denied(denial),
        Reading::Failed => Reading::Failed,
    }
}

fn export(ctx: &Ctx, key: &str) -> Result<export::ExportFile, String> {
    let settled = kit_act::act(
        ctx,
        act::people::ExportVcf {
            list_id: (key != ALL).then(|| key.to_owned()),
        },
        &kit_act::key(&["person.export_vcf", key], kit_act::fresh()),
    );
    export::file_of(&settled, "text/vcard", "People.vcf")
}
