//! Sentences of `backup.check`, "Check my backup" (#1188, B6, ruling 18). One line per device
//! says what was found; a second says how; a failure says what is wrong in words a member can
//! act on, and no sentence names a command.

catalog! {
    plain check_back = ("Backup", "Backup");
    plain check_title = ("Check my backup", "Check my backup");
    plain check_intro = ("Opens each backup in a spare copy and reads a sample of its files. Your vault isn't touched.", "Opens each backup in a spare copy and reads a sample of its files. Your vault isn't touched.");
    plain check_heading_result = ("Result", "Result");
    plain check_heading_running = ("Checking", "Checking");
    // HOW THE BACKUP IS CHECKED, at a stated rate (#1191, E10): what was read and what opened,
    // never "verified", and only the average (a random draw promises no coverage). `{s}` is the pieces the last check read, `{n}` the pieces stored and `{m}`
    // how many checks it takes to read each about once.
    plain check_rate_body = ("Each check reads {s} of the {n} stored pieces, chosen at random. On average a piece is read once in {m} checks.", "Each check reads {s} of the {n} stored pieces, chosen at random. On average a piece is read once in {m} checks.");
    plain check_rate_all_body = ("Each check reads all {n} stored pieces.", "Each check reads all {n} stored pieces.");

    // WHAT A BACKUP THAT WAS CHECKED SAYS. `{when}` is the backup's own date, in the member's
    // zone: "Tuesday 10 November, 21:40".
    plain check_opens = ("{when} opens.", "{when} opens.");
    plain check_wont_open = ("{when} won't open.", "{when} won't open.");
    plain check_missing_one = ("{when} is missing 1 file.", "{when} is missing 1 file.");
    plain check_missing_many = ("{when} is missing {n} files.", "{when} is missing {n} files.");
    plain check_damaged = ("{when} has a damaged file.", "{when} has a damaged file.");
    plain check_older_opens = ("Its backup from {when} opens.", "Its backup from {when} opens.");
    plain check_held_one = ("1 file held, {opened} opened to check.", "1 file held, {opened} opened to check.");
    plain check_held_many = ("{held} files held, {opened} opened to check.", "{held} files held, {opened} opened to check.");

    // NOT RUN IS NOT A PASS AND NOT A FAILURE.
    plain check_not_run = ("Not checked.", "Not checked.");
    plain check_no_answer = ("It didn't answer.", "It didn't answer.");
    plain check_wifi = ("Waiting for Wi-Fi.", "Waiting for Wi-Fi.");
    plain check_space = ("This phone needs more free space.", "This phone needs more free space.");
    plain check_stopped = ("It was stopped before it finished.", "It was stopped before it finished.");
    plain check_pass_running = ("A backup is running. Check when it finishes.", "A backup is running. Check when it finishes.");
    plain check_nothing_yet = ("Nothing is backed up here yet.", "Nothing is backed up here yet.");

    // WHILE IT RUNS: the bar's words and the foot's.
    plain check_parts = ("{done} of {total} parts", "{done} of {total} parts");
    plain check_running_foot = ("Checking {name}", "Checking {name}");
    plain check_foot_done = ("Checked {when}", "Checked {when}");
    plain check_foot_never = ("Not checked", "Not checked");
    plain check_foot_nothing = ("Nothing was checked.", "Nothing was checked.");
    plain check_foot_unpaired = ("No backup device is paired.", "No backup device is paired.");
    plain check_failed = ("The check didn't finish. Try again.", "The check didn't finish. Try again.");
    plain check_retry = ("Retry", "Retry");
    plain check_foot_problem = ("Found a problem {when}", "Found a problem {when}");
    plain check_row_never = ("Never checked", "Never checked");
    plain check_start = ("Check my backup", "Check my backup");
    plain check_again = ("Check again", "Check again");
    plain check_stop = ("Stop", "Stop");
    // THE ROW ON BACKUP that opens the page.
    plain check_row = ("Check my backup", "Check my backup");

    // THE STALE NOTICE (`backup::stale`), written before the day comes: no reason is claimed.
    plain stale_title = ("Backup is {n} days old", "Backup is {n} days old");
    plain stale_body = ("Nothing has reached {device} since {since}. Open Centraid to see why.", "Nothing has reached {device} since {since}. Open Centraid to see why.");
    plain stale_backlog_title = ("Some files are not backed up", "Some files are not backed up");
    plain stale_backlog_body = ("Items added {since} still haven't reached a backup device. Open Centraid to see why.", "Items added {since} still haven't reached a backup device. Open Centraid to see why.");
    plain stale_never_title = ("Not backed up yet", "Not backed up yet");
    plain stale_never_body = ("Nothing has reached {device} since it was paired on {since}. Open Centraid to see why.", "Nothing has reached {device} since it was paired on {since}. Open Centraid to see why.");
}
