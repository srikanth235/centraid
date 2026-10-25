//! The phone imports in the runtime a shell attaches (#1135): three hidden tab roots, so a shell
//! finds each service by its tab id, sends it events and reads its view, and the band never
//! draws them.

use centraid_api_proto::core_v1 as wire;
use centraid_screens::imports;
use centraid_screens::testing::Driver;

#[test]
fn the_shell_finds_the_three_imports_by_tab_and_the_band_leaves_them_out() {
    let mut driver = Driver::with_runtime(centraid_screens::standard());
    driver.start();
    let navigation = driver.navigation.clone().expect("a navigation");
    let tabs: Vec<&str> = navigation.tabs.iter().map(|tab| tab.tab.as_str()).collect();
    assert_eq!(
        tabs,
        [
            "home",
            "chat",
            "backup",
            "imports-camera-roll",
            "imports-files",
            "imports-made"
        ]
    );
    for (tab, route) in imports::roots() {
        let stack = navigation
            .tabs
            .iter()
            .find(|stack| stack.tab == tab)
            .expect("the import's tab");
        let root = stack.entries.first().expect("a root");
        assert_eq!(
            root.route.as_ref().map(|r| r.screen.as_str()),
            Some(route.screen.as_str())
        );
        // ITS VIEW REACHES THE SHELL, which forwards it (a service's never would).
        let drawn = driver
            .views
            .get(&root.instance)
            .and_then(|view| view.kind.as_ref());
        let expected = match tab.as_str() {
            "imports-camera-roll" => {
                matches!(drawn, Some(wire::view_state::Kind::ImportsCameraRoll(_)))
            }
            "imports-files" => matches!(drawn, Some(wire::view_state::Kind::ImportsFiles(_))),
            _ => matches!(drawn, Some(wire::view_state::Kind::ImportsMade(_))),
        };
        assert!(expected, "{tab} draws {drawn:?}");
    }
    let band: Vec<&str> = navigation
        .band
        .as_ref()
        .expect("a band")
        .tabs
        .iter()
        .map(|tab| tab.tab.as_str())
        .collect();
    assert_eq!(band, ["home", "chat", "backup"]);
}
