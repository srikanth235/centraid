# Review

- Review every report against the issue and the [product](../product/SKILL.md) skill.
- Verify commit authors and subjects yourself.
- Spot-check claims in the code.
- A claim that was not run is listed as unverified.
- Ask of every schema change: does the database accept what the command refuses? A rule a command states in a sentence is also a constraint or a trigger, and a test writes the bad row with raw SQL.
- A session that is told to fix code a later lane deletes is told to leave it ([brief](brief.md)).
- Read the gate on the newest head and get failures fixed in the code ([land/gate.md](../land/gate.md)).
