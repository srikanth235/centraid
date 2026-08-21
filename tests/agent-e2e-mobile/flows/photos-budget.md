# Photos journey budget

The five `photos-*.mjs` journeys share one gateway process and one paired simulator profile. `run-photos-suite.mjs` pairs during the denied-permission empty-vault journey, then the library journey loads the deterministic Photos scenario and the remaining journeys reuse that paired profile. The runner fails when aggregate wall time is **eight minutes or more**, measured from the first flow process start through the fifth verdict. Every journey still writes an independent verdict, including after an earlier failure.

If two consecutive nightly runs exceed eight minutes, first combine adjacent Maestro chunks and remove duplicate arrival assertions. If that is insufficient, merge viewer entry into search while preserving both claims. Do not add retries or weaken structural assertions to buy time.
