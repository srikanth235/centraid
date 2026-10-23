//! What every Money test shares: a driver over Money's own runtime, the example
//! scenario's accounts and lines, and the accessors that read a view.

#![allow(dead_code)]

use centraid_api_proto::core_v1 as wire;
use centraid_screens::catalog::load;
use centraid_screens::money::{self, routes};
use centraid_screens::testing::Driver;

pub fn driver() -> Driver {
    let mut d = Driver::with_runtime(money::runtime());
    d.start();
    d
}

/// The open home screen's instance.
pub fn home(d: &Driver) -> u64 {
    d.navigation
        .as_ref()
        .and_then(|nav| nav.tabs.iter().find(|t| t.tab == money::TAB))
        .and_then(|stack| stack.entries.first())
        .map(|entry| entry.instance)
        .expect("Money's home is open")
}

pub fn push(d: &mut Driver, route: wire::Route) -> u64 {
    d.push(money::TAB, route)
}

pub fn event(d: &mut Driver, instance: u64, kind: wire::screen_event::Kind) {
    d.send(instance, kind);
}

pub fn home_state(v: &wire::ViewState) -> &wire::MoneyHomeState {
    match &v.kind {
        Some(wire::view_state::Kind::MoneyHome(s)) => s,
        other => panic!("not Money's home: {other:?}"),
    }
}

pub fn home_data(v: &wire::ViewState) -> &wire::MoneyHomeData {
    match &home_state(v).content {
        Some(wire::money_home_state::Content::Data(d)) => d,
        other => panic!("Money's home has no data: {other:?}"),
    }
}

pub fn home_event(kind: wire::money_home_event::Kind) -> wire::screen_event::Kind {
    wire::screen_event::Kind::MoneyHome(wire::MoneyHomeEvent { kind: Some(kind) })
}

pub fn land_on(d: &mut Driver, destination: wire::MoneyDestination) -> u64 {
    push(d, routes::home(destination))
}

/// One query as the core answers it, straight through the load door.
pub fn load_answer(
    d: &Driver,
    request: impl Into<wire::LoadRequest>,
) -> wire::app_query_response::Answer {
    let mut request: wire::LoadRequest = request.into();
    request.zone = "UTC".to_owned();
    let answer = d
        .handle
        .call(&wire::Request {
            kind: Some(wire::request::Kind::Load(Box::new(request))),
        })
        .expect("the load door answers");
    let Some(wire::response::Kind::Load(load)) = answer.kind else {
        panic!("a load answered something else");
    };
    load.answer.and_then(|a| a.answer).expect("an answer")
}

/// The accounts the example scenario holds: `(id, name)`.
pub fn accounts(d: &Driver) -> Vec<(String, String)> {
    let wire::app_query_response::Answer::MoneyAccounts(accounts) =
        load_answer(d, load::money::Accounts {})
    else {
        panic!("not the accounts");
    };
    accounts
        .on_budget
        .iter()
        .chain(&accounts.off_budget)
        .map(|line| (line.account_id.clone(), line.name.clone()))
        .collect()
}
