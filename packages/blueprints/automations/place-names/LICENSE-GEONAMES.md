# Bundled settlement data — attribution and licence

The `place-names` automation ships with a copy of a third-party dataset compiled into its `handler.js`. This file is the attribution that copy requires, and it travels with the automation wherever the automation is installed.

## Attribution

This product includes data created by **GeoNames** — <https://www.geonames.org/>

## Licence

The data is licensed under a **Creative Commons Attribution 3.0 Unported License** (CC-BY 3.0): <https://creativecommons.org/licenses/by/3.0/>

## What exactly is bundled

|  |  |
| --- | --- |
| Dataset | GeoNames `cities15000` — every settlement with a population over 15,000 |
| Snapshot date | **2017-02-27** |
| Obtained from | the npm package `cities15000@0.0.1` on registry.npmjs.org, which vendors that snapshot together with the CC-BY 3.0 legal code |
| Rows shipped | 23,527 |
| Fields kept | name, latitude, longitude, US state code, ISO country code, population (in thousands) |

Current GeoNames releases are published under CC-BY **4.0**. This snapshot predates that change and ships under the 3.0 terms declared by the package it came from. Refreshing the snapshot means re-deriving the bundled table from a newer dump and restating the licence version here and in `packages/model-runtime/LICENSES.md`.

The derivation from the upstream columns — which fields are kept, what is rounded, and why — is documented in `packages/model-runtime/src/gazetteer-data.ts`.

## What it is used for, and what it is not

The table is read **on the member's own device**, by arithmetic, to find the settlement nearest a coordinate the vault already holds. No coordinate is sent anywhere: this automation performs no network request of any kind, which is the reason the data is bundled rather than queried from a geocoding service.
