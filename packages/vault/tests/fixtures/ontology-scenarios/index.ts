// The ontology scenarios (#996). Import from another package as
// `@centraid/vault/tests/ontology-scenarios`.

export { buildOntologyScenarios, ONTOLOGY_SCENARIOS } from "./build.js";
export type { BuildOptions, OntologyScenarioFixture } from "./build.js";
export { FIXTURE_EPOCH, installFixtureClock } from "./clock.js";
export type { FixtureClock } from "./clock.js";
export type {
  OntologyScenario,
  ScenarioCheck,
  ScenarioContext,
  ScenarioDefinition,
} from "./types.js";
