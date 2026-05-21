import { createActiveSyncSdk, type ActiveSyncSdk } from "activesync-sdk-js";

function getDefaultHostWsBase(): string {
  const hostname = typeof window !== "undefined" ? window.location.hostname : "localhost";
  const scheme = typeof window !== "undefined" && window.location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${hostname}:5074`;
}

function getHostWsBase(): string {
  const configured = import.meta.env.VITE_HOST_BASE_URL as string | undefined;
  if (!configured) {
    return getDefaultHostWsBase();
  }

  return configured.replace(/^http:\/\//i, "ws://").replace(/^https:\/\//i, "wss://");
}

export async function createDemoRoomSdk(roomId: string): Promise<ActiveSyncSdk> {
  return createActiveSyncSdk({
    wsUrl: `${getHostWsBase()}/ws/runtime`,
    roomId
  });
}

export async function createDemoRoomSdkWithTransport(
  roomId: string,
  mode: "auto" | "ws-only"
): Promise<ActiveSyncSdk> {
  return (createActiveSyncSdk as unknown as (options: unknown) => Promise<ActiveSyncSdk>)({
    wsUrl: `${getHostWsBase()}/ws/runtime`,
    roomId,
    transport: {
      mode
    }
  });
}
