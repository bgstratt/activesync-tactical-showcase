import type {
  CardBattleActionResponse,
  CardBattlePerspective,
  CardBattleState,
  HostHealthResponse,
  PeerActionResponse,
  ReplayEventsResponse,
  ReplicationTopologyResponse,
  TacticalActionRequest,
  TacticalActionResponse,
  TacticalBoardState
} from "../../../shared/contracts/runtime";

const defaultBaseUrl = "http://localhost:5074";

function getBaseUrl(): string {
  return import.meta.env.VITE_HOST_BASE_URL ?? defaultBaseUrl;
}

async function parseResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new Error(`Host request failed (${response.status})`);
  }

  return (await response.json()) as T;
}

export async function fetchHostHealth(): Promise<HostHealthResponse> {
  const response = await fetch(`${getBaseUrl()}/api/host/health`);
  return parseResponse<HostHealthResponse>(response);
}

export async function fetchReplicationTopology(): Promise<ReplicationTopologyResponse> {
  const response = await fetch(`${getBaseUrl()}/api/replication/topology`);
  return parseResponse<ReplicationTopologyResponse>(response);
}

export async function fetchReplicationEvents(take = 60): Promise<ReplayEventsResponse> {
  const response = await fetch(`${getBaseUrl()}/api/replication/events?take=${take}`);
  return parseResponse<ReplayEventsResponse>(response);
}

export async function connectPeer(peerId: string): Promise<PeerActionResponse> {
  const response = await fetch(`${getBaseUrl()}/api/runtime/peers/connect`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ peerId })
  });
  return parseResponse<PeerActionResponse>(response);
}

export async function disconnectPeer(peerId: string): Promise<PeerActionResponse> {
  const response = await fetch(`${getBaseUrl()}/api/runtime/peers/disconnect`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ peerId })
  });
  return parseResponse<PeerActionResponse>(response);
}

export async function fetchTacticalState(): Promise<TacticalBoardState> {
  const response = await fetch(`${getBaseUrl()}/api/tactical/state`);
  return parseResponse<TacticalBoardState>(response);
}

export async function applyTacticalAction(action: TacticalActionRequest): Promise<TacticalActionResponse> {
  const response = await fetch(`${getBaseUrl()}/api/tactical/action`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(action)
  });

  return parseResponse<TacticalActionResponse>(response);
}

export async function fetchCardBattleState(viewerPeerId?: string, perspective?: CardBattlePerspective): Promise<CardBattleState> {
  const search = new URLSearchParams();
  if (viewerPeerId) {
    search.set("viewerPeerId", viewerPeerId);
  }

  if (perspective && perspective !== "auto") {
    search.set("perspective", perspective);
  }

  const suffix = search.size > 0 ? `?${search.toString()}` : "";
  const response = await fetch(`${getBaseUrl()}/api/card-battle/state${suffix}`);
  return parseResponse<CardBattleState>(response);
}

export async function applyCardBattleAction(action: TacticalActionRequest): Promise<CardBattleActionResponse> {
  const response = await fetch(`${getBaseUrl()}/api/card-battle/action`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(action)
  });

  return parseResponse<CardBattleActionResponse>(response);
}
