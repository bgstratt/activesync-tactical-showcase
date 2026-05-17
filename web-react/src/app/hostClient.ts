import type {
  HostHealthResponse,
  PeerActionResponse,
  ReplayEventsResponse,
  ReplicationTopologyResponse
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
