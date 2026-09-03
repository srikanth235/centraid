import type * as THREE from "three";

export type ThreeNamespace = typeof import("three");

// oxlint-disable-next-line typescript/no-explicit-any -- (#704) open kit option bags are the documented landmark boundary.
export type KitOptions = Record<string, any>;

export interface Point {
  x: number;
  z: number;
}

export interface CityMeta {
  title: string;
  subtitle: string;
  legal: string;
  loadingMessages: string[];
}

export interface Palette {
  requests: string;
  harness: string;
  wal: string;
  dirty: string;
  consent: string;
  sync: string;
  blob: string;
  automation: string;
}

export interface BuildingSize {
  w: number;
  h: number;
  d: number;
}

export interface CityBuilding {
  id: string;
  name: string;
  kind: string;
  pos: Point;
  size: BuildingSize;
  blurb: string;
  detail: string;
  codeRef: string;
  color?: string;
}

export interface DistrictPlate {
  x: number;
  z: number;
  w: number;
  d: number;
}

export interface CityDistrict {
  id: string;
  name: string;
  blurb: string;
  color: string;
  plate: DistrictPlate;
  buildings: CityBuilding[];
}

export interface TourPage {
  body: string;
  buildingId?: string;
  flows?: string[];
}

export interface TourChapter {
  id: string;
  section?: string;
  title: string;
  districtId: string;
  buildingId?: string;
  scenarioId?: string;
  flows?: string[];
  pages?: TourPage[];
  body?: string;
}

export interface Scenario {
  id: string;
  name: string;
  blurb: string;
}

export interface HudStat {
  id: string;
  label: string;
  unit: string;
}

export interface CityContent {
  meta: CityMeta;
  palette: Palette;
  districts: CityDistrict[];
  tour: TourChapter[];
  scenarios: Scenario[];
  hudStats: HudStat[];
}

export interface ScenarioConfig {
  founding?: boolean;
  turns?: number;
  writes?: number;
  blobs?: number;
  harness?: number;
  cronEvery?: number;
  appWork?: number;
  crane?: number;
  parkChance?: number;
  casFill?: number;
  offline?: boolean;
  harnessOff?: boolean;
  direct?: number;
  sync?: number;
  automation?: number;
  approveSlow?: boolean;
}

export interface SimStats {
  turns: number;
  items: number;
  wal: number;
  approvals: number;
  lag: number;
  cas: number;
  cron: number;
  fps: number;
}

export type SimRates = Record<string, number>;

export interface SimPulses {
  crane: number;
  checkpoint: number;
  barge: number;
  cron: number;
  founding: number;
  catchup: number;
}

export type SimActivity = Record<string, number>;

export interface SimEvent {
  type: string;
  id?: string;
}

export interface Sim {
  stats: SimStats;
  rates: SimRates;
  pulses: SimPulses;
  activity: SimActivity;
  tick: (dt: number) => void;
  setScenario: (id: string) => void;
  readonly scenario: string;
  drainEvents: () => SimEvent[];
}

export interface AnimationRecord {
  type:
    | "crane"
    | "clock"
    | "conveyor"
    | "beacon"
    | "gate"
    | "activity"
    | "spin"
    | "bob"
    | "reciprocate";
  obj?: THREE.Object3D;
  hook?: THREE.Object3D;
  hookBase?: number;
  minute?: THREE.Object3D;
  hour?: THREE.Object3D;
  tex?: THREE.Texture;
  mat?: THREE.MeshBasicMaterial;
  phase?: number;
  districtId?: string;
  axis?: "x" | "y" | "z";
  base?: number;
  speed?: number;
  amp?: number;
}

export type MaterialBook = Record<string, THREE.Material>;
export type SurfaceMaterialFactory = (
  hex: string,
  options?: KitOptions
) => THREE.MeshStandardMaterial;
export type GlowMaterialFactory = (
  hex: string,
  base?: number
) => THREE.MeshBasicMaterial;

export type KitObjectBuilder = (...args: unknown[]) => THREE.Object3D;
export type KitMaterialBuilder = (...args: unknown[]) => THREE.Material;

export interface CityKit {
  mat: MaterialBook;
  box: KitObjectBuilder;
  drum: KitObjectBuilder;
  dome: KitObjectBuilder;
  vault: KitObjectBuilder;
  prismShape: KitObjectBuilder;
  wedge: KitObjectBuilder;
  hull: KitObjectBuilder;
  roofGable: KitObjectBuilder;
  roofHipped: KitObjectBuilder;
  roofSawtooth: KitObjectBuilder;
  roofBarrel: KitObjectBuilder;
  roofPyramid: KitObjectBuilder;
  roofStepped: KitObjectBuilder;
  roofMansard: KitObjectBuilder;
  roofParapet: KitObjectBuilder;
  roofCone: KitObjectBuilder;
  roofDomeRibbed: KitObjectBuilder;
  curtainWall: KitObjectBuilder;
  punchedWindows: KitObjectBuilder;
  ribbedFacade: KitObjectBuilder;
  louvers: KitObjectBuilder;
  masonryBands: KitObjectBuilder;
  colonnade: KitObjectBuilder;
  arcade: KitObjectBuilder;
  pilotis: KitObjectBuilder;
  truss: KitObjectBuilder;
  latticeMast: KitObjectBuilder;
  gantry: KitObjectBuilder;
  catwalk: KitObjectBuilder;
  railing: KitObjectBuilder;
  stairFlight: KitObjectBuilder;
  spiralStair: KitObjectBuilder;
  steps: KitObjectBuilder;
  buttress: KitObjectBuilder;
  pipeRun: KitObjectBuilder;
  ductRun: KitObjectBuilder;
  dish: KitObjectBuilder;
  mast: KitObjectBuilder;
  aerial: KitObjectBuilder;
  vent: KitObjectBuilder;
  fan: KitObjectBuilder;
  chimney: KitObjectBuilder;
  tank: KitObjectBuilder;
  silo: KitObjectBuilder;
  crateStack: KitObjectBuilder;
  container: KitObjectBuilder;
  bollards: KitObjectBuilder;
  planter: KitObjectBuilder;
  tree: KitObjectBuilder;
  streetlamp: KitObjectBuilder;
  flagpole: KitObjectBuilder;
  signBand: KitObjectBuilder;
  plaqueWall: KitObjectBuilder;
  gaugeBoard: KitObjectBuilder;
  splitFlapBoard: KitObjectBuilder;
  clockFace: KitObjectBuilder;
  weathervane: KitObjectBuilder;
  solarArray: KitObjectBuilder;
  wheel: KitObjectBuilder;
  piston: KitObjectBuilder;
  beacon: KitObjectBuilder;
  seam: KitObjectBuilder;
  activityLamp: KitObjectBuilder;
  matWindows: KitMaterialBuilder;
  matGlow: KitMaterialBuilder;
  matTint: KitMaterialBuilder;
  spin: KitObjectBuilder;
  bob: KitObjectBuilder;
  group: KitObjectBuilder;
  mesh: KitObjectBuilder;
  merge: (...args: unknown[]) => THREE.BufferGeometry;
  strutGeo: (...args: unknown[]) => THREE.BufferGeometry;
  tubeGeo: (...args: unknown[]) => THREE.BufferGeometry;
  frustumGeo: (...args: unknown[]) => THREE.BufferGeometry;
  windowUVs: (...args: unknown[]) => void;
  toVec3: (...args: unknown[]) => THREE.Vector3;
  [name: string]: unknown;
}

export interface LandmarkContext {
  g: THREE.Group;
  w: number;
  h: number;
  d: number;
  color: string;
  districtId: string;
  data: CityBuilding;
  kit: CityKit;
  THREE: ThreeNamespace;
  animated: AnimationRecord[];
  facadeMat: SurfaceMaterialFactory;
  plainMat: SurfaceMaterialFactory;
  glowMat: GlowMaterialFactory;
  beacon: KitObjectBuilder;
  boxed: KitObjectBuilder;
  roofUnits: (...args: unknown[]) => void;
}

export type LandmarkBuilder = (context: LandmarkContext) => void;

export interface WorldBuilding {
  data: CityBuilding;
  group: THREE.Group;
  box: THREE.Box3;
  center: THREE.Vector3;
  top: THREE.Vector3;
}

export interface WorldDistrict {
  data: CityDistrict;
  group: THREE.Group;
  plate: THREE.Mesh;
  color: string;
  isPit: boolean;
  plateTop: number;
  center: THREE.Vector3;
  anchor: THREE.Vector3;
  buildings: WorldBuilding[];
  label: THREE.Sprite;
  activity: number;
  rimMat: THREE.MeshBasicMaterial;
  focusW: number;
  focusTarget: number;
  parkPoint?: THREE.Vector3;
  parkRing?: THREE.Mesh;
}

export interface FlowParticle {
  t: number;
  speed: number;
  live: boolean;
}

export interface FlowRuntime {
  role: string;
  curve: THREE.QuadraticBezierCurve3;
  mesh: THREE.InstancedMesh;
  mat: THREE.MeshBasicMaterial;
  parts: FlowParticle[];
  capacity: number;
  acc: number;
  baseColor: THREE.Color;
  dayColor: THREE.Color;
  from: string | null;
  to: string | null;
  dynamic?: string;
  focusW: number;
  focusTarget: number;
}

export interface WorldApi {
  scene: THREE.Scene;
  root: THREE.Group;
  ground: THREE.Mesh;
  districts: WorldDistrict[];
  byId: Map<string, WorldDistrict>;
  flows: FlowRuntime[];
  palette: Palette;
  sun: THREE.DirectionalLight;
  labels: THREE.Sprite[];
  hoverOutline: THREE.LineSegments;
  selectOutline: THREE.LineSegments;
  frameOutline: (outline: THREE.LineSegments, box: THREE.Box3 | null) => void;
  update: (dt: number, elapsed: number, sim?: Sim) => void;
  applyNight: (night: number) => void;
  setFlowFocus: (roles: string[] | string | null) => void;
  readonly night: number;
  islandPoint: THREE.Vector3 | null;
  parkPoint: THREE.Vector3 | null;
}

export interface BuildingBuildContext {
  facadeMat: SurfaceMaterialFactory;
  plainMat: SurfaceMaterialFactory;
  glowMat: GlowMaterialFactory;
  convTex: THREE.Texture;
  districtId: string;
  animated: AnimationRecord[];
  activity: THREE.Material[];
  palette: Palette;
  kit: CityKit;
}

export interface InspectorRef {
  districtId: string;
  buildingId?: string | null;
}

export type InspectorState = Array<[string, string]>;

export interface InspectorDetails {
  title: string;
  subtitle?: string;
  color?: string;
  lede?: string;
  detail?: string;
  codeRef?: string;
  state?: InspectorState;
  chips?: Array<{ label: string; ref: InspectorRef }>;
}

export interface InspectorApi {
  show: (details: InspectorDetails) => void;
  close: () => void;
  current: InspectorRef | null;
  readonly isOpen: boolean;
  refreshState: (state: InspectorState) => void;
}

export interface HudApi {
  update: (stats: SimStats) => void;
}

export interface HoverTipApi {
  show: (title: string, subtitle: string, x: number, y: number) => void;
  move: (x: number, y: number) => void;
  hide: () => void;
}

export interface TourPosition {
  page: TourPage;
  pageIndex: number;
  pageCount: number;
  chapterChanged: boolean;
  buildingId?: string;
  flows: string[] | null;
}

export interface TourApi {
  start: () => void;
  stop: () => void;
  next: () => void;
  prev: () => void;
  nextInChapter: () => void;
  prevInChapter: () => void;
  goTo: (index: number, page?: number) => void;
  openPanel: () => void;
  closePanel: () => void;
  togglePanel: () => void;
  applyHash: () => void;
  readonly panelOpen: boolean;
  readonly active: boolean;
  readonly count: number;
}

export interface CityDebugHandle {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: object;
  world: WorldApi;
  sim: Sim;
}

declare global {
  interface Window {
    __city?: CityDebugHandle;
  }
}
