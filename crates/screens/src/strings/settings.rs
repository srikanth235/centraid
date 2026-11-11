//! SETTINGS' OWN SENTENCES (#1173): the appearance choice, the section names and
//! the rows that open the Backup and recovery key pages. The backup line and the
//! recovery key's sentence are Backup's, read from there, not restated.

catalog! {
    plain settings_title = ("Settings", "Settings");
    plain settings_appearance = ("Appearance", "Appearance");
    plain settings_appearance_system = ("System", "System");
    plain settings_appearance_light = ("Light", "Light");
    plain settings_appearance_dark = ("Dark", "Dark");
    plain settings_appearance_note = ("System follows your phone. Text follows your phone's text size.", "System follows your phone. Text follows your phone's text size.");
    plain settings_units = ("Units", "Units");
    plain settings_units_phone = ("Phone's setting", "Phone's setting");
    plain settings_units_refused = ("Couldn't save your units. Try again.", "Couldn't save your units. Try again.");
    plain settings_rule_refused = ("Couldn't save your download settings. Try again.", "Couldn't save your download settings. Try again.");
    plain settings_appearance_refused = ("Couldn't save your appearance. Try again.", "Couldn't save your appearance. Try again.");
    plain settings_units_metric = ("Metric", "Metric");
    plain settings_units_imperial = ("Imperial", "Imperial");
    plain settings_units_note = ("Distances, weights and temperatures. Phone's setting follows your region.", "Distances, weights and temperatures. Phone's setting follows your region.");
    plain settings_vault = ("Vault", "Vault");
    plain settings_vaults_row = ("Vaults", "Vaults");
    counted settings_vaults_held = ("This phone has one vault.", "This phone has {n} vaults.");
    plain settings_make_vault = ("Make a vault", "Make a vault");
    plain settings_download_settings = ("Download settings", "Download settings");
    plain settings_reconnect = ("Reconnect phone data", "Reconnect phone data");
    plain settings_export = ("Export everything", "Export everything");
    plain settings_export_title = ("Export everything", "Export everything");
    plain settings_export_lede = (
        "One archive, a folder per app. Locker exports on its own.",
        "One archive, a folder per app. Locker exports on its own."
    );
    plain settings_export_all = ("Everything on this phone", "Everything on this phone");
    plain settings_export_all_value = ("8 apps; Locker exports on its own", "8 apps; Locker exports on its own");
    plain settings_backup = ("Backup", "Backup");
    plain settings_recovery_key = ("Recovery key", "Recovery key");
    plain settings_show_recovery_key = ("Show recovery key", "Show recovery key");
    plain settings_about = ("About", "About");
    plain settings_version = ("Version", "Version");
}
