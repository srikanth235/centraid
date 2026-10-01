# train_v3 stats

|                                                 |    count |
| ----------------------------------------------- | -------: |
| train_v3.jsonl rows                             |     6731 |
| of which v3 paraphrase rows                     |     5731 |
| of which v2 replay rows                         |     1000 |
| heldout_v3.jsonl rows                           |      447 |
| unique targets (train)                          |     2161 |
| unique skeletons (train, literals masked)       |     1577 |
| unique skeletons (v3 rows only)                 |      984 |
| unique skeletons (held-out)                     |      147 |
| held-out skeletons also in train (incl. replay) |        1 |
| Sonnet calls used                               | 60 of 70 |

## Build log

| step                                        | count |
| ------------------------------------------- | ----: |
| called literal shortened to the words said  |    91 |
| canon.jsonl: canonicals                     |  2008 |
| canon.jsonl: canonicals paraphrased         |  2008 |
| heldout_canon.jsonl: canonicals             |   150 |
| heldout_canon.jsonl: canonicals paraphrased |   150 |
| paraphrases seen                            |  6474 |
| reject: called literal absent               |    93 |
| reject: dialect syntax                      |     2 |
| reject: explicit date contradicts target    |     8 |
| reject: near-duplicate                      |   185 |
| reject: write literal not verbatim          |     8 |
| replay filtered                             |   369 |
| replay pool                                 | 47502 |
| v3 rows                                     |  5731 |

The 4-gram strip was NOT applied: `canon-model/distill/strip_grams.py` reads `crates/evalsuite/suite.json` and `blind.json`, which this build may not open. Run it separately (it only deletes rows) before training if the leakage gate is wanted.

## turn type (whole train set)

| value        | rows | share |
| ------------ | ---: | ----: |
| show         | 2693 | 40.0% |
| cmd          | 1429 | 21.2% |
| field-of     |  558 |  8.3% |
| sum          |  388 |  5.8% |
| count        |  386 |  5.7% |
| refuse       |  305 |  4.5% |
| min          |  228 |  3.4% |
| max          |  219 |  3.3% |
| cmd then cmd |  160 |  2.4% |
| same?        |  136 |  2.0% |
| nothing      |  103 |  1.5% |
| clarify      |   83 |  1.2% |
| balance      |   43 |  0.6% |

## depth, check.depth, 4 = 4+ (whole train set)

| value | rows | share |
| ----- | ---: | ----: |
| 2     | 2834 | 42.1% |
| 1     | 2185 | 32.5% |
| 3     |  832 | 12.4% |
| 0     |  592 |  8.8% |
| 4     |  288 |  4.3% |

## depth (v3 rows only)

| value | rows | share |
| ----- | ---: | ----: |
| 2     | 2547 | 44.4% |
| 1     | 2137 | 37.3% |
| 0     |  474 |  8.3% |
| 3     |  474 |  8.3% |
| 4     |   99 |  1.7% |

## previous turn (whole train set)

| value | rows | share |
| ----- | ---: | ----: |
| prev  | 3436 | 51.0% |
| NONE  | 3295 | 49.0% |

## uses a ref (whole train set)

| value  | rows | share |
| ------ | ---: | ----: |
| no ref | 3779 | 56.1% |
| ref    | 2952 | 43.9% |

## uses a ref (v3 rows only)

| value  | rows | share |
| ------ | ---: | ----: |
| no ref | 3156 | 55.1% |
| ref    | 2575 | 44.9% |

## ref terminal (whole train set, rows can count twice)

| value                  | rows | share |
| ---------------------- | ---: | ----: |
| them                   | 1413 | 47.9% |
| it                     |  607 | 20.6% |
| the Nth one            |  292 |  9.9% |
| the other one          |  285 |  9.7% |
| that one               |  150 |  5.1% |
| the last thing I added |  113 |  3.8% |
| the earlier one        |   92 |  3.1% |

## utterance words (v3 rows)

| value | rows | share |
| ----- | ---: | ----: |
| 6     | 1450 | 25.3% |
| 3     | 1312 | 22.9% |
| 9     | 1181 | 20.6% |
| 12    |  773 | 13.5% |
| 0     |  401 |  7.0% |
| 15    |  360 |  6.3% |
| 18    |  153 |  2.7% |
| 21    |   69 |  1.2% |
| 24    |   22 |  0.4% |
| 27    |    5 |  0.1% |
| 30    |    5 |  0.1% |

v3 utterance length: median 8 words, p90 15, max 40 (gold profile: 6 / 12 / 31).
