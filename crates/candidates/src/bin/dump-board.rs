//! # `dump-board` — what a door actually hands back
//!
//! A debugging aid for the executor: it opens one app's board over a freshly
//! dealt world and prints every row's id, entity, label, date and extras. It
//! scores nothing and is not part of the ratchet.
//!
//! ```text
//! cargo run -p centraid-candidates --bin dump-board -- people [second]
//! ```

use std::process::ExitCode;

use centraid_evalsuite::{App, Candidate, CandidateRuntime, Context, Plan, Session, Suite};

fn main() -> ExitCode {
    let which = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "people".to_owned());
    let second = std::env::args().nth(2).is_some();
    let corpus = if second { "holdout" } else { "suite" };
    let mut suite = match Suite::read(&centraid_candidates::corpus_path(corpus)) {
        Ok(suite) => suite,
        Err(why) => {
            eprintln!("{why}");
            return ExitCode::FAILURE;
        }
    };
    suite.sessions.truncate(1);
    suite.sessions[0].turns.truncate(1);
    let template = if second {
        centraid_evalsuite::WorldTemplate::build_scenario(centraid_evalworld::Scenario::Second)
    } else {
        centraid_evalsuite::WorldTemplate::build()
    };
    let Ok(template) = template else {
        eprintln!("the world does not build");
        return ExitCode::FAILURE;
    };
    let _ = centraid_evalsuite::run(&suite, &template, &Dump { which });
    ExitCode::SUCCESS
}

struct Dump {
    which: String,
}

impl CandidateRuntime for Dump {
    fn name(&self) -> &str {
        "dump-board"
    }
    fn session(&self, _session: &Session) -> Box<dyn Candidate> {
        Box::new(DumpSession {
            which: self.which.clone(),
        })
    }
}

struct DumpSession {
    which: String,
}

impl Candidate for DumpSession {
    fn turn(&mut self, _request: &str, ctx: &mut Context<'_>) -> Plan {
        println!("me = {}   now = {}", ctx.me(), ctx.now());
        if let Some(query) = self.which.strip_prefix("search:") {
            let (entity, needle) = query.split_once('=').unwrap_or(("core.party", query));
            for row in ctx.search(entity, needle, 50).unwrap_or_default() {
                println!(
                    "hit {:<22} live={} {}",
                    row.entity,
                    u8::from(row.live),
                    row.label
                );
            }
            return Plan::Ids(Vec::new());
        }
        for app in App::all() {
            if self.which != "all" && app.id() != self.which {
                continue;
            }
            for row in ctx.open(app).unwrap_or_default() {
                println!(
                    "{:<8} {:<22} live={} {:<40} {:?} {:?}",
                    app.id(),
                    row.entity,
                    u8::from(row.live),
                    row.label,
                    row.date,
                    row.extra
                );
            }
        }
        Plan::Ids(Vec::new())
    }
}
