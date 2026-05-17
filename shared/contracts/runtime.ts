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
