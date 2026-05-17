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
