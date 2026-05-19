export interface NativeRuntimeStatus {
  available: boolean;
  libraryName: string;
  abiVersion: number | null;
  error: string | null;
}

export interface HostHealthResponse {
  service: string;
  status: string;
  timestampUtc: string;
  nativeRuntime: NativeRuntimeStatus;
}

export interface PeerStatus {
  peerId: string;
  online: boolean;
  lastSeenUtc: string;
  frontierCount: number;
}

export interface PeerLink {
  fromPeerId: string;
  toPeerId: string;
  replicationLagMs: number;
}

export interface ReplicationTopologyResponse {
  sessionId: string;
  updatedAtUtc: string;
  peers: PeerStatus[];
  activeLinks: PeerLink[];
}

export interface ReplayEventItem {
  timestampUtc: string;
  stream: string;
  type: string;
  peerId: string | null;
  message: string;
  payloadJson: string | null;
}

export interface ReplayEventsResponse {
  sessionId: string;
  updatedAtUtc: string;
  events: ReplayEventItem[];
}

export interface PeerActionResponse {
  ok: boolean;
  message: string;
}

export interface DemoScenarioRunResponse {
  ok: boolean;
  scenarioId: string;
  mode: string;
  message: string;
  assertions: DemoScenarioAssertion[];
  completedAtUtc: string;
}

export interface DemoScenarioAssertion {
  name: string;
  passed: boolean;
  expected: string;
  actual: string;
}

export interface TacticalToken {
  id: string;
  name: string;
  team: "blue" | "red";
  x: number;
  y: number;
  hp: number;
}

export interface TacticalPing {
  id: string;
  x: number;
  y: number;
  label: string;
}

export interface TacticalTriggerLink {
  id: string;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  label: string;
}

export interface TacticalBoardState {
  rows: number;
  cols: number;
  terrain: string[][];
  fog: boolean[][];
  tokens: TacticalToken[];
  pings: TacticalPing[];
  triggerLinks: TacticalTriggerLink[];
  turn: number;
  partitionedPeers: string[];
  queuedOps: Array<{
    peerId: string;
    count: number;
  }>;
  updatedAtUtc: string;
}

export interface TacticalCellWrite {
  x: number;
  y: number;
}

export interface TacticalActionRequest {
  action: string;
  x?: number;
  y?: number;
  value?: string;
  tokenId?: string;
  team?: "blue" | "red";
  label?: string;
  actorPeerId?: string;
  targetPeerId?: string;
  cardId?: string;
  targetTeam?: "blue" | "red";
  targetX?: number;
  targetY?: number;
  enabled?: boolean;
  cells?: TacticalCellWrite[];
}

export interface TacticalActionResponse {
  ok: boolean;
  message: string;
  state: TacticalBoardState;
}

export interface CardBattleCard {
  id: string;
  name: string;
  effectType: "damage" | "heal";
  amount: number;
  cost: number;
}

export interface CardBattlePlayerState {
  team: "blue" | "red";
  hp: number;
  energy: number;
  deckCount: number;
  discardCount: number;
  concealedHandCount: number;
  hand: CardBattleCard[];
}

export type CardBattlePerspective = "auto" | "blue" | "red" | "observer";

export interface CardBattleState {
  turn: number;
  activeTeam: "blue" | "red";
  players: CardBattlePlayerState[];
  partitionedPeers: string[];
  queuedOps: Array<{
    peerId: string;
    count: number;
  }>;
  updatedAtUtc: string;
}

export interface CardBattleActionResponse {
  ok: boolean;
  message: string;
  state: CardBattleState;
}

export interface WorkspacePoint {
  x: number;
  y: number;
}

export interface WorkspaceNode {
  id: string;
  x: number;
  y: number;
  label: string;
  color: string;
  updatedAtMs: number;
  updatedBy: string;
}

export interface WorkspaceEdge {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  updatedAtMs: number;
  updatedBy: string;
}

export interface WorkspaceAsset {
  id: string;
  x: number;
  y: number;
  name: string;
  updatedAtMs: number;
  updatedBy: string;
}

export interface WorkspaceAnnotation {
  id: string;
  x: number;
  y: number;
  text: string;
  updatedAtMs: number;
  updatedBy: string;
}

export interface WorkspaceStroke {
  id: string;
  points: WorkspacePoint[];
  color: string;
  width: number;
  updatedAtMs: number;
  updatedBy: string;
}

export interface WorkspaceStateResponse {
  roomId: string;
  updatedAtUtc: string;
  nodes: WorkspaceNode[];
  edges: WorkspaceEdge[];
  assets: WorkspaceAsset[];
  annotations: WorkspaceAnnotation[];
  strokes: WorkspaceStroke[];
  operationCount: number;
}

export interface WorkspaceOperationRequest {
  peerId: string;
  kind: string;
  nodeId?: string;
  fromNodeId?: string;
  toNodeId?: string;
  x?: number;
  y?: number;
  label?: string;
  text?: string;
  assetName?: string;
  color?: string;
  width?: number;
  points?: WorkspacePoint[];
  updatedAtMs?: number;
}

export interface WorkspaceEventItem {
  updatedAtMs: number;
  peerId: string;
  kind: string;
  message: string;
}

export interface WorkspaceEventsResponse {
  roomId: string;
  updatedAtUtc: string;
  events: WorkspaceEventItem[];
}
