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
  targetX?: number;
  targetY?: number;
  enabled?: boolean;
}

export interface TacticalActionResponse {
  ok: boolean;
  message: string;
  state: TacticalBoardState;
}
