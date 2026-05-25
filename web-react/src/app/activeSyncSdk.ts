import {
  createActiveSyncSdk,
  type ActiveSyncSdk,
  type ActiveSyncSdkOptions,
  type TopologySnapshot
} from "activesync-sdk-js";
import bridgeWasmUrl from "activesync-bridge/activesync_bridge_bg.wasm?url";

export type DemoTransportPreference = "auto" | "ws-only";

type DemoSdkOptions = {
  transportMode?: DemoTransportPreference;
  offlinePersistenceKey?: string;
};

type BridgeWasmInitInput = {
  module_or_path: string;
};

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
  return createDemoRoomSdkWithOptions(roomId);
}

export async function createDemoRoomSdkWithTransport(
  roomId: string,
  mode: DemoTransportPreference
): Promise<ActiveSyncSdk> {
  return createDemoRoomSdkWithOptions(roomId, {
    transportMode: mode
  });
}

export function readActiveTransportMode(sdk: ActiveSyncSdk): TopologySnapshot["activeTransport"] {
  return sdk.topology.snapshot().activeTransport;
}

async function createDemoRoomSdkWithOptions(roomId: string, options: DemoSdkOptions = {}): Promise<ActiveSyncSdk> {
  const wasmInitInput: BridgeWasmInitInput = {
    module_or_path: bridgeWasmUrl
  };

  const sdkOptions: ActiveSyncSdkOptions = {
    wsUrl: `${getHostWsBase()}/ws/runtime`,
    roomId,
    wasmModule: wasmInitInput as unknown as ActiveSyncSdkOptions["wasmModule"],
    transport: {
      mode: options.transportMode ?? "auto"
    }
  };

  if (options.offlinePersistenceKey) {
    sdkOptions.offline = {
      persistenceKey: options.offlinePersistenceKey
    };
  }

  return createActiveSyncSdk(sdkOptions);
}
