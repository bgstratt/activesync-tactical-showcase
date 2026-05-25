import type { ChangeEvent, PointerEvent as ReactPointerEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { ActiveSyncSdk } from "activesync-sdk-js";
import {
  applyWorkspaceRoomOperation,
  connectWorkspaceRoomOperationStream,
  fetchWorkspaceRoomEvents,
  fetchWorkspaceRoomOperations,
  fetchWorkspaceRoomState
} from "../app/hostClient";
import { createDemoRoomSdkWithTransport, readActiveTransportMode } from "../app/activeSyncSdk";
import type {
  WorkspaceEventItem,
  WorkspaceOperationItem,
  WorkspaceOperationRequest,
  WorkspacePoint,
  WorkspaceStateResponse
} from "../../../shared/contracts/runtime";

type PeerId = "alpha" | "bravo" | "charlie";
type WorkspaceTool = "select" | "draw" | "annotate";
type TransportPreference = "auto" | "ws-only";
type OfflineQueueByPeer = Record<PeerId, WorkspaceOperationItem[]>;
type PendingOnlineQueueByPeer = Record<PeerId, WorkspaceOperationItem[]>;
type PendingLocalMoveByNode = Record<string, { x: number; y: number; peerId: string; updatedAtMs: number }>;
type RtcDiagnosticsKey = "offersSent" | "offersReceived" | "answersSent" | "answersReceived" | "iceSent" | "iceReceived";
type RtcPeerStatus = {
  peerId: string;
  connectionState: RTCPeerConnectionState | "none";
  channelState: RTCDataChannelState | "none";
};

const peers: PeerId[] = ["alpha", "bravo", "charlie"];
const disableRuntimeSdkSignaling = (import.meta.env.VITE_DISABLE_RUNTIME_SDK_SIGNALING as string | undefined) === "1";

const peerColor: Record<PeerId, string> = {
  alpha: "#2563eb",
  bravo: "#16a34a",
  charlie: "#dc2626"
};

const workspaceWidth = 2200;
const workspaceHeight = 1400;
const dragPresenceIntervalMs = 33;
const dragPresenceFallbackRelayIntervalMs = 90;
const dragPresenceFallbackDedupWindowMs = 240;
const optimisticRelayDedupWindowMs = 2000;
const dragAuthoritativeFallbackIntervalMs = 120;
const offlineQueueStoragePrefix = "room-workspace:offline-queue:";
const rtcConfig: RTCConfiguration = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
};

const emptyState: WorkspaceStateResponse = {
  roomId: "",
  updatedAtUtc: new Date().toISOString(),
  nodes: [],
  edges: [],
  assets: [],
  annotations: [],
  strokes: [],
  operationCount: 0
};

function makeId(prefix: string): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}-${crypto.randomUUID()}`;
  }

  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
}

function generateRoomId(): string {
  const token = Math.random().toString(36).slice(2, 8);
  return `demo-${token}`;
}

function parsePeerId(value: string | null): PeerId {
  if (value === "alpha" || value === "bravo" || value === "charlie") {
    return value;
  }

  return "alpha";
}

function parseTransportPreference(value: string | null): TransportPreference {
  if (value === "ws-only") {
    return value;
  }

  return "auto";
}

function replayRoomState(operations: WorkspaceOperationItem[], count: number, roomId: string): WorkspaceStateResponse {
  const capped = Math.max(0, Math.min(count, operations.length));
  const nodes = new Map<string, WorkspaceStateResponse["nodes"][number]>();
  const edges = new Map<string, WorkspaceStateResponse["edges"][number]>();
  const assets = new Map<string, WorkspaceStateResponse["assets"][number]>();
  const annotations = new Map<string, WorkspaceStateResponse["annotations"][number]>();
  const strokes = new Map<string, WorkspaceStateResponse["strokes"][number]>();

  for (let i = 0; i < capped; i += 1) {
    const op = operations[i];

    if (op.kind === "add-node" && op.nodeId) {
      const existing = nodes.get(op.nodeId);
      if (!existing || op.updatedAtMs >= existing.updatedAtMs) {
        nodes.set(op.nodeId, {
          id: op.nodeId,
          x: op.x ?? 320,
          y: op.y ?? 260,
          label: op.label ?? "Node",
          color: op.color ?? "#2563eb",
          updatedAtMs: op.updatedAtMs,
          updatedBy: op.peerId
        });
      }
      continue;
    }

    if (op.kind === "move-node" && op.nodeId) {
      const existing = nodes.get(op.nodeId);
      if (existing && op.updatedAtMs >= existing.updatedAtMs) {
        nodes.set(op.nodeId, {
          ...existing,
          x: op.x ?? existing.x,
          y: op.y ?? existing.y,
          updatedAtMs: op.updatedAtMs,
          updatedBy: op.peerId
        });
      }
      continue;
    }

    if (op.kind === "add-edge" && op.fromNodeId && op.toNodeId) {
      const edgeId = `edge:${op.fromNodeId}:${op.toNodeId}`;
      const existing = edges.get(edgeId);
      if (!existing || op.updatedAtMs >= existing.updatedAtMs) {
        edges.set(edgeId, {
          id: edgeId,
          fromNodeId: op.fromNodeId,
          toNodeId: op.toNodeId,
          updatedAtMs: op.updatedAtMs,
          updatedBy: op.peerId
        });
      }
      continue;
    }

    if (op.kind === "add-asset" && op.nodeId) {
      const existing = assets.get(op.nodeId);
      if (!existing || op.updatedAtMs >= existing.updatedAtMs) {
        assets.set(op.nodeId, {
          id: op.nodeId,
          x: op.x ?? 360,
          y: op.y ?? 300,
          name: op.assetName ?? "asset.bin",
          updatedAtMs: op.updatedAtMs,
          updatedBy: op.peerId
        });
      }
      continue;
    }

    if (op.kind === "add-annotation" && op.nodeId) {
      const existing = annotations.get(op.nodeId);
      if (!existing || op.updatedAtMs >= existing.updatedAtMs) {
        annotations.set(op.nodeId, {
          id: op.nodeId,
          x: op.x ?? 300,
          y: op.y ?? 300,
          text: op.text ?? "Untitled note",
          updatedAtMs: op.updatedAtMs,
          updatedBy: op.peerId
        });
      }
      continue;
    }

    if (op.kind === "add-stroke" && op.nodeId && op.points && op.points.length > 1) {
      const existing = strokes.get(op.nodeId);
      if (!existing || op.updatedAtMs >= existing.updatedAtMs) {
        strokes.set(op.nodeId, {
          id: op.nodeId,
          points: op.points,
          color: op.color ?? "#2563eb",
          width: op.width ?? 3,
          updatedAtMs: op.updatedAtMs,
          updatedBy: op.peerId
        });
      }
    }

    if (op.kind === "delete-edge" && op.nodeId) {
      edges.delete(op.nodeId);
      continue;
    }

    if (op.kind === "delete-node" && op.nodeId) {
      nodes.delete(op.nodeId);
      for (const [edgeId, edge] of edges.entries()) {
        if (edge.fromNodeId === op.nodeId || edge.toNodeId === op.nodeId) {
          edges.delete(edgeId);
        }
      }
      continue;
    }

    if (op.kind === "delete-annotation" && op.nodeId) {
      annotations.delete(op.nodeId);
      continue;
    }

    if (op.kind === "delete-stroke" && op.nodeId) {
      strokes.delete(op.nodeId);
    }
  }

  return {
    roomId,
    updatedAtUtc: new Date().toISOString(),
    nodes: Array.from(nodes.values()),
    edges: Array.from(edges.values()),
    assets: Array.from(assets.values()),
    annotations: Array.from(annotations.values()),
    strokes: Array.from(strokes.values()),
    operationCount: capped
  };
}

function toOperationItem(operation: WorkspaceOperationRequest): WorkspaceOperationItem {
  return {
    id: makeId("local-op"),
    updatedAtMs: operation.updatedAtMs ?? Date.now(),
    peerId: operation.peerId,
    kind: operation.kind,
    nodeId: operation.nodeId ?? null,
    fromNodeId: operation.fromNodeId ?? null,
    toNodeId: operation.toNodeId ?? null,
    x: operation.x ?? null,
    y: operation.y ?? null,
    label: operation.label ?? null,
    text: operation.text ?? null,
    assetName: operation.assetName ?? null,
    color: operation.color ?? null,
    width: operation.width ?? null,
    points: operation.points ?? null
  };
}

function toOperationRequest(item: WorkspaceOperationItem): WorkspaceOperationRequest {
  return {
    peerId: item.peerId,
    kind: item.kind,
    nodeId: item.nodeId ?? undefined,
    fromNodeId: item.fromNodeId ?? undefined,
    toNodeId: item.toNodeId ?? undefined,
    x: item.x ?? undefined,
    y: item.y ?? undefined,
    label: item.label ?? undefined,
    text: item.text ?? undefined,
    assetName: item.assetName ?? undefined,
    color: item.color ?? undefined,
    width: item.width ?? undefined,
    points: item.points ?? undefined,
    updatedAtMs: item.updatedAtMs
  };
}

function enqueueOfflineOperation(queue: WorkspaceOperationItem[], next: WorkspaceOperationItem): WorkspaceOperationItem[] {
  if (next.kind === "move-node" && next.nodeId) {
    const filtered = queue.filter((entry) => !(entry.kind === "move-node" && entry.nodeId === next.nodeId && entry.peerId === next.peerId));
    return [...filtered, next];
  }

  return [...queue, next];
}

function createEmptyOfflineQueue(): OfflineQueueByPeer {
  return {
    alpha: [],
    bravo: [],
    charlie: []
  };
}

function createEmptyPendingOnlineQueue(): PendingOnlineQueueByPeer {
  return {
    alpha: [],
    bravo: [],
    charlie: []
  };
}

function enqueuePendingOnlineOperation(queue: WorkspaceOperationItem[], next: WorkspaceOperationItem): WorkspaceOperationItem[] {
  return [...queue, next];
}

function flattenOfflineQueue(queueByPeer: OfflineQueueByPeer): WorkspaceOperationItem[] {
  return [...queueByPeer.alpha, ...queueByPeer.bravo, ...queueByPeer.charlie].sort((a, b) => a.updatedAtMs - b.updatedAtMs);
}

function countOfflineQueue(queueByPeer: OfflineQueueByPeer): number {
  return queueByPeer.alpha.length + queueByPeer.bravo.length + queueByPeer.charlie.length;
}

function appendOperationUnique(
  operations: WorkspaceOperationItem[],
  nextOperation: WorkspaceOperationItem
): WorkspaceOperationItem[] {
  if (operations.some((operation) => operation.id === nextOperation.id)) {
    return operations;
  }

  const next = [...operations, nextOperation];
  if (next.length > 4000) {
    return next.slice(next.length - 4000);
  }

  return next;
}

function appendRemoteOptimisticUnique(
  operations: WorkspaceOperationItem[],
  nextOperation: WorkspaceOperationItem
): WorkspaceOperationItem[] {
  if (
    operations.some(
      (operation) =>
        operation.kind === nextOperation.kind &&
        operation.peerId === nextOperation.peerId &&
        operation.nodeId === nextOperation.nodeId &&
        operation.updatedAtMs === nextOperation.updatedAtMs
    )
  ) {
    return operations;
  }

  return [...operations, nextOperation];
}

function isPrimaryInteractionPointer(event: ReactPointerEvent<Element>): boolean {
  if (event.pointerType === "mouse") {
    return event.button === 0;
  }

  return event.isPrimary;
}

export function RoomWorkspacePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [roomId, setRoomId] = useState(searchParams.get("room")?.trim() || generateRoomId());
  const [activePeerId, setActivePeerId] = useState<PeerId>(() => parsePeerId(searchParams.get("peer")));
  const [tool, setTool] = useState<WorkspaceTool>("select");
  const [annotationDraft, setAnnotationDraft] = useState("Decision note");
  const [state, setState] = useState<WorkspaceStateResponse>(emptyState);
  const [events, setEvents] = useState<WorkspaceEventItem[]>([]);
  const [operations, setOperations] = useState<WorkspaceOperationItem[]>([]);
  const [remoteOptimisticOperations, setRemoteOptimisticOperations] = useState<WorkspaceOperationItem[]>([]);
  const [offlineQueueByPeer, setOfflineQueueByPeer] = useState<OfflineQueueByPeer>(createEmptyOfflineQueue());
  const [pendingOnlineByPeer, setPendingOnlineByPeer] = useState<PendingOnlineQueueByPeer>(createEmptyPendingOnlineQueue());
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null);
  const [selectedStrokeId, setSelectedStrokeId] = useState<string | null>(null);
  const [activeStrokePoints, setActiveStrokePoints] = useState<WorkspacePoint[]>([]);
  const [pendingStrokes, setPendingStrokes] = useState<{
    id: string;
    points: WorkspacePoint[];
    color: string;
    width: number;
    peerId: string;
  }[]>([]);
  const [dragPreview, setDragPreview] = useState<{ nodeId: string; x: number; y: number } | null>(null);
  const [pendingLocalMoveByNode, setPendingLocalMoveByNode] = useState<PendingLocalMoveByNode>({});
  const [remoteDragByNode, setRemoteDragByNode] = useState<
    Record<string, { x: number; y: number; peerId: string; updatedAtMs: number; holdUntilAck: boolean }>
  >({});
  const [replayCursor, setReplayCursor] = useState(0);
  const [followLiveReplay, setFollowLiveReplay] = useState(true);
  const [isReplayPlaying, setIsReplayPlaying] = useState(false);
  const [replaySpeedOpsPerSecond, setReplaySpeedOpsPerSecond] = useState(30);
  const [cloudConnected, setCloudConnected] = useState(true);
  const [roomStreamReconnectNonce, setRoomStreamReconnectNonce] = useState(0);
  const [isRoomStreamHealthy, setIsRoomStreamHealthy] = useState(false);
  const [transportPreference, setTransportPreference] = useState<TransportPreference>(() =>
    parseTransportPreference(searchParams.get("transport"))
  );
  const [transportMode, setTransportMode] = useState<"ws-only" | "ws+webrtc">("ws-only");
  const [signalSocketState, setSignalSocketState] = useState<"idle" | "connecting" | "open" | "closed" | "error">("idle");
  const [signalReconnectNonce, setSignalReconnectNonce] = useState(0);
  const [knownSignalPeers, setKnownSignalPeers] = useState<string[]>([]);
  const [rtcDiagnostics, setRtcDiagnostics] = useState<Record<RtcDiagnosticsKey, number>>({
    offersSent: 0,
    offersReceived: 0,
    answersSent: 0,
    answersReceived: 0,
    iceSent: 0,
    iceReceived: 0
  });
  const [rtcPeerStatuses, setRtcPeerStatuses] = useState<RtcPeerStatus[]>([]);
  const [isBusy, setIsBusy] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [hostError, setHostError] = useState<string | null>(null);

  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ nodeId: string; offsetX: number; offsetY: number } | null>(null);
  const dragPreviewRef = useRef<{ nodeId: string; x: number; y: number } | null>(null);
  const activePointerIdRef = useRef<number | null>(null);
  const lastDragPresenceSentAtRef = useRef(0);
  const lastDragAuthoritativeSentAtRef = useRef(0);
  const drawRef = useRef<WorkspacePoint[] | null>(null);
  const pendingCreatedNodeIdsRef = useRef<Set<string>>(new Set());
  const deferredFinalMoveByNodeRef = useRef<Map<string, { x: number; y: number; updatedAtMs: number }>>(new Map());
  const lastPresenceRelaySentAtByKeyRef = useRef<Record<string, number>>({});
  const lastPresenceRelayFingerprintByKeyRef = useRef<Record<string, string>>({});
  const runtimeSdkRef = useRef<ActiveSyncSdk | null>(null);
  const runtimePeerIdRef = useRef<string | null>(null);
  const legacySignalSocketRef = useRef<WebSocket | null>(null);
  const legacySignalPeerIdRef = useRef<string | null>(null);
  const rtcPeersRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const rtcChannelsRef = useRef<Map<string, RTCDataChannel>>(new Map());
  const transportPreferenceRef = useRef<TransportPreference>(transportPreference);

  useEffect(() => {
    transportPreferenceRef.current = transportPreference;
  }, [transportPreference]);

  useEffect(() => {
    lastPresenceRelaySentAtByKeyRef.current = {};
    lastPresenceRelayFingerprintByKeyRef.current = {};
  }, [activePeerId, roomId]);

  function bumpRtcDiagnostic(key: RtcDiagnosticsKey) {
    setRtcDiagnostics((previous) => ({
      ...previous,
      [key]: previous[key] + 1
    }));
  }

  function refreshRtcPeerStatuses() {
    const peerIds = new Set<string>([
      ...rtcPeersRef.current.keys(),
      ...rtcChannelsRef.current.keys()
    ]);

    const nextStatuses = Array.from(peerIds)
      .sort((a, b) => a.localeCompare(b))
      .map((peerId) => {
        const peer = rtcPeersRef.current.get(peerId);
        const channel = rtcChannelsRef.current.get(peerId);
        return {
          peerId,
          connectionState: peer?.connectionState ?? "none",
          channelState: channel?.readyState ?? "none"
        } satisfies RtcPeerStatus;
      });

    setRtcPeerStatuses(nextStatuses);
  }

  function sendSignal(payload: Record<string, unknown>) {
    const sdk = runtimeSdkRef.current;
    if (sdk) {
      const type = typeof payload.type === "string" ? payload.type : "";
      if (type === "webrtc-offer" && typeof payload.to === "string" && typeof payload.sdp === "string") {
        sdk.compat.sendWebRtcOffer(payload.to, payload.sdp);
        return;
      }

      if (type === "webrtc-answer" && typeof payload.to === "string" && typeof payload.sdp === "string") {
        sdk.compat.sendWebRtcAnswer(payload.to, payload.sdp);
        return;
      }

      if (type === "webrtc-ice" && typeof payload.to === "string" && typeof payload.candidate === "string") {
        sdk.compat.sendWebRtcIce(
          payload.to,
          payload.candidate,
          typeof payload.sdpMid === "string" ? payload.sdpMid : undefined,
          typeof payload.sdpMLineIndex === "number" ? payload.sdpMLineIndex : undefined
        );
        return;
      }
    }

    const legacySocket = legacySignalSocketRef.current;
    if (legacySocket && legacySocket.readyState === WebSocket.OPEN) {
      legacySocket.send(JSON.stringify(payload));
      return;
    }

    if (!sdk) {
      return;
    }

    const now = Date.now();
    const payloadType = typeof payload.type === "string" ? payload.type : "";
    if (payloadType === "drag-presence") {
      const nodeId = typeof payload.nodeId === "string" ? payload.nodeId : "unknown";
      const x = typeof payload.x === "number" ? payload.x : 0;
      const y = typeof payload.y === "number" ? payload.y : 0;
      const relayKey = `${payloadType}:${nodeId}`;
      const fingerprint = `${payloadType}:${nodeId}:${Math.round(x / 8)}:${Math.round(y / 8)}`;
      const lastSentAt = lastPresenceRelaySentAtByKeyRef.current[relayKey] ?? 0;
      const lastFingerprint = lastPresenceRelayFingerprintByKeyRef.current[relayKey] ?? "";

      if (now - lastSentAt < dragPresenceFallbackRelayIntervalMs) {
        return;
      }

      if (lastFingerprint === fingerprint && now - lastSentAt < dragPresenceFallbackDedupWindowMs) {
        return;
      }

      lastPresenceRelaySentAtByKeyRef.current[relayKey] = now;
      lastPresenceRelayFingerprintByKeyRef.current[relayKey] = fingerprint;
    }

    if (payloadType === "optimistic-op") {
      const operation = payload.operation as { id?: string } | undefined;
      const opId = typeof operation?.id === "string" ? operation.id : "";
      if (opId) {
        const relayKey = `${payloadType}:${opId}`;
        const lastSentAt = lastPresenceRelaySentAtByKeyRef.current[relayKey] ?? 0;
        if (now - lastSentAt < optimisticRelayDedupWindowMs) {
          return;
        }
        lastPresenceRelaySentAtByKeyRef.current[relayKey] = now;
      }
    }

    sdk.presence.set(payload, {
      sessionId: activePeerId,
      ttlMs: 4000,
      nowUnixMs: now
    });
  }

  function disconnectRtc() {
    for (const channel of rtcChannelsRef.current.values()) {
      try {
        channel.close();
      } catch {
        // ignore close race
      }
    }
    rtcChannelsRef.current.clear();

    for (const peer of rtcPeersRef.current.values()) {
      try {
        peer.close();
      } catch {
        // ignore close race
      }
    }
    rtcPeersRef.current.clear();
    setTransportMode("ws-only");
    refreshRtcPeerStatuses();
  }

  function handleRealtimePayload(
    payload: {
      type?: string;
      nodeId?: string;
      x?: number;
      y?: number;
      peerId?: string;
      from?: string;
      updatedAtMs?: number;
      operation?: WorkspaceOperationItem;
    },
    fallbackPeerId?: string
  ): boolean {
    if (payload.type === "optimistic-op" && payload.operation) {
      const operation = payload.operation;
      if ((operation.kind === "add-node" || operation.kind === "add-annotation") && operation.peerId !== activePeerId) {
        setRemoteOptimisticOperations((previous) => appendRemoteOptimisticUnique(previous, operation));
      }
      return true;
    }

    const resolvedPeerId = payload.peerId ?? payload.from ?? fallbackPeerId;

    if (payload.type === "drag-presence" && payload.nodeId && typeof payload.x === "number" && typeof payload.y === "number") {
      const dragX = payload.x;
      const dragY = payload.y;
      const dragNodeId = payload.nodeId;
      const dragUpdatedAtMs = typeof payload.updatedAtMs === "number" ? payload.updatedAtMs : Date.now();
      setRemoteDragByNode((previous) => {
        const existing = previous[dragNodeId];
        if (existing && existing.updatedAtMs >= dragUpdatedAtMs) {
          return previous;
        }

        return {
          ...previous,
          [dragNodeId]: {
            x: dragX,
            y: dragY,
            peerId: resolvedPeerId ?? "unknown",
            updatedAtMs: dragUpdatedAtMs,
            holdUntilAck: false
          }
        };
      });
      return true;
    }

    if (
      payload.type === "drag-presence-end" &&
      payload.nodeId &&
      typeof payload.x === "number" &&
      typeof payload.y === "number"
    ) {
      const dragX = payload.x;
      const dragY = payload.y;
      const dragNodeId = payload.nodeId;
      const dragUpdatedAtMs = typeof payload.updatedAtMs === "number" ? payload.updatedAtMs : Date.now();
      setRemoteDragByNode((previous) => {
        return {
          ...previous,
          [dragNodeId]: {
            x: dragX,
            y: dragY,
            peerId: resolvedPeerId ?? "unknown",
            updatedAtMs: dragUpdatedAtMs,
            holdUntilAck: true
          }
        };
      });
      return true;
    }

    return false;
  }

  function setupDataChannel(peerId: string, channel: RTCDataChannel) {
    channel.onopen = () => {
      if (transportPreferenceRef.current === "ws-only") {
        try {
          channel.close();
        } catch {
          // ignore close race
        }
        return;
      }

      rtcChannelsRef.current.set(peerId, channel);
      setTransportMode("ws+webrtc");
      refreshRtcPeerStatuses();
    };

    channel.onclose = () => {
      rtcChannelsRef.current.delete(peerId);
      if (rtcChannelsRef.current.size === 0) {
        setTransportMode("ws-only");
      }
      refreshRtcPeerStatuses();
      setRemoteDragByNode((previous) => {
        const next = Object.fromEntries(Object.entries(previous).filter(([, value]) => value.peerId !== peerId));
        return next;
      });
    };

    channel.onmessage = (event) => {
      try {
        const payload = JSON.parse(String(event.data)) as {
          type?: string;
          nodeId?: string;
          x?: number;
          y?: number;
          peerId?: string;
          from?: string;
          updatedAtMs?: number;
          operation?: WorkspaceOperationItem;
        };
        handleRealtimePayload(payload, peerId);
      } catch {
        // Ignore invalid peer payloads.
      }
    };
  }

  function ensureRtcPeer(remotePeerId: string, shouldOffer: boolean) {
    if (transportPreferenceRef.current === "ws-only") {
      return undefined;
    }

    if (remotePeerId === activePeerId) {
      return rtcPeersRef.current.get(remotePeerId);
    }

    const existing = rtcPeersRef.current.get(remotePeerId);
    if (existing) {
      return existing;
    }

    const peer = new RTCPeerConnection(rtcConfig);
    rtcPeersRef.current.set(remotePeerId, peer);
    refreshRtcPeerStatuses();

    peer.onconnectionstatechange = () => {
      refreshRtcPeerStatuses();
    };

    peer.onicecandidate = (event) => {
      if (!event.candidate) {
        return;
      }

      bumpRtcDiagnostic("iceSent");

      sendSignal({
        type: "webrtc-ice",
        to: remotePeerId,
        candidate: event.candidate.candidate,
        sdpMid: event.candidate.sdpMid,
        sdpMLineIndex: event.candidate.sdpMLineIndex
      });
    };

    peer.ondatachannel = (event) => {
      setupDataChannel(remotePeerId, event.channel);
    };

    if (shouldOffer) {
      // Keep this channel reliable so optimistic-op and drag-presence stay ordered/coherent.
      const channel = peer.createDataChannel("workspace-presence");
      setupDataChannel(remotePeerId, channel);

      void (async () => {
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        bumpRtcDiagnostic("offersSent");
        sendSignal({
          type: "webrtc-offer",
          to: remotePeerId,
          sdp: offer.sdp
        });
      })();
    }

    return peer;
  }

  useEffect(() => {
    setSearchParams((previous) => {
      const next = new URLSearchParams(previous);
      next.set("room", roomId);
      next.set("peer", activePeerId);
      next.set("transport", transportPreference);
      return next;
    }, { replace: true });
  }, [activePeerId, roomId, setSearchParams, transportPreference]);

  useEffect(() => {
    if (transportPreference !== "ws-only") {
      return;
    }

    disconnectRtc();
  }, [transportPreference]);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(`${offlineQueueStoragePrefix}${roomId}`);
      if (!raw) {
        setOfflineQueueByPeer(createEmptyOfflineQueue());
        setPendingOnlineByPeer(createEmptyPendingOnlineQueue());
        return;
      }

      const parsed = JSON.parse(raw) as Partial<OfflineQueueByPeer>;
      const next = createEmptyOfflineQueue();
      next.alpha = Array.isArray(parsed.alpha) ? parsed.alpha : [];
      next.bravo = Array.isArray(parsed.bravo) ? parsed.bravo : [];
      next.charlie = Array.isArray(parsed.charlie) ? parsed.charlie : [];
      setOfflineQueueByPeer(next);
      setPendingOnlineByPeer(createEmptyPendingOnlineQueue());
    } catch {
      setOfflineQueueByPeer(createEmptyOfflineQueue());
      setPendingOnlineByPeer(createEmptyPendingOnlineQueue());
    }
  }, [roomId]);

  useEffect(() => {
    try {
      window.localStorage.setItem(`${offlineQueueStoragePrefix}${roomId}`, JSON.stringify(offlineQueueByPeer));
    } catch {
      // Non-fatal when storage is unavailable.
    }
  }, [offlineQueueByPeer, roomId]);

  useEffect(() => {
    let isCanceled = false;

    if (!cloudConnected) {
      setIsRoomStreamHealthy(false);
      return () => {
        isCanceled = true;
      };
    }

    async function refresh() {
      try {
        const [snapshot, latestEvents, latestOperations] = await Promise.all([
          fetchWorkspaceRoomState(roomId),
          fetchWorkspaceRoomEvents(roomId, 120),
          fetchWorkspaceRoomOperations(roomId, 2000)
        ]);

        if (!isCanceled) {
          setState(snapshot);
          setEvents(latestEvents.events);
          setOperations(latestOperations.operations);
          setHostError(null);
        }
      } catch (error) {
        if (!isCanceled) {
          setHostError(error instanceof Error ? error.message : "Unable to load room workspace");
        }
      }
    }

    void refresh();

    // Primary synchronization path is websocket streaming; poll only as fallback.
    let intervalId: number | null = null;
    if (!isRoomStreamHealthy) {
      intervalId = window.setInterval(() => {
        void refresh();
      }, 5000);
    }

    return () => {
      isCanceled = true;
      if (intervalId !== null) {
        window.clearInterval(intervalId);
      }
    };
  }, [cloudConnected, roomId, isRoomStreamHealthy]);

  useEffect(() => {
    if (!cloudConnected) {
      return;
    }

    let disposed = false;
    let reconnectTimerId: number | null = null;

    const scheduleReconnect = () => {
      if (disposed || reconnectTimerId !== null || !cloudConnected) {
        return;
      }

      reconnectTimerId = window.setTimeout(() => {
        reconnectTimerId = null;
        if (!disposed) {
          setRoomStreamReconnectNonce((previous) => previous + 1);
        }
      }, 400);
    };

    const disconnect = connectWorkspaceRoomOperationStream(roomId, {
      onOpen: () => {
        setIsRoomStreamHealthy(true);
        setHostError(null);
      },
      onOperation: (operation) => {
        setOperations((previous) => appendOperationUnique(previous, operation));
      },
      onError: (message) => {
        setIsRoomStreamHealthy(false);
        setHostError(message);
        scheduleReconnect();
      },
      onClose: () => {
        setIsRoomStreamHealthy(false);
        if (!disposed) {
          scheduleReconnect();
        }
      }
    });

    return () => {
      disposed = true;
      if (reconnectTimerId !== null) {
        window.clearTimeout(reconnectTimerId);
        reconnectTimerId = null;
      }
      disconnect();
    };
  }, [cloudConnected, roomId, roomStreamReconnectNonce]);

  useEffect(() => {
    let disposed = false;
    let reconnectTimerId: number | null = null;
    let suppressLegacyReconnect = false;
    const allowRtc = transportPreference === "auto";

    const scheduleSignalReconnect = () => {
      if (disposed || reconnectTimerId !== null || !cloudConnected) {
        return;
      }

      reconnectTimerId = window.setTimeout(() => {
        reconnectTimerId = null;
        if (!disposed) {
          setSignalReconnectNonce((previous) => previous + 1);
        }
      }, 450);
    };

    if (!cloudConnected) {
      setSignalSocketState("idle");
      setKnownSignalPeers([]);
      disconnectRtc();
      setSignalReconnectNonce(0);
      if (legacySignalSocketRef.current) {
        try {
          legacySignalSocketRef.current.close();
        } catch {
          // ignore close race
        }
        legacySignalSocketRef.current = null;
      }
      runtimePeerIdRef.current = null;
      const sdk = runtimeSdkRef.current;
      runtimeSdkRef.current = null;
      if (sdk) {
        void sdk.room.disconnect();
      }
      return;
    }

    setSignalSocketState("connecting");
    setKnownSignalPeers([]);
    const cleanupHandlers: Array<() => void> = [];

    const baseUrl = (import.meta.env.VITE_HOST_BASE_URL as string | undefined) ??
      `${window.location.protocol}//${window.location.hostname}:5074`;
    const legacySignalPeerId = `${activePeerId}-${makeId("signal")}`;
    legacySignalPeerIdRef.current = legacySignalPeerId;
    const legacySignalUrl = baseUrl
      .replace(/^http:\/\//i, "ws://")
      .replace(/^https:\/\//i, "wss://") +
      `/api/workspace/rooms/${encodeURIComponent(roomId)}/signal?peerId=${encodeURIComponent(legacySignalPeerId)}`;
    const legacySocket = new WebSocket(legacySignalUrl);
    legacySignalSocketRef.current = legacySocket;

    legacySocket.onopen = () => {
      if (disposed) {
        try {
          legacySocket.close();
        } catch {
          // ignore close race
        }
        return;
      }

      setSignalSocketState("open");
    };

    legacySocket.onmessage = (event) => {
      if (disposed) {
        return;
      }

      try {
        const payload = JSON.parse(String(event.data)) as {
          type?: string;
          peers?: string[];
          peerId?: string;
          from?: string;
          sdp?: string;
          candidate?: string;
          sdpMid?: string | null;
          sdpMLineIndex?: number | null;
          nodeId?: string;
          x?: number;
          y?: number;
          updatedAtMs?: number;
          operation?: WorkspaceOperationItem;
        };

        if (payload.type === "peers") {
          const peers = payload.peers ?? [];
          setKnownSignalPeers(peers);

          if (allowRtc) {
            const localPeerId = legacySignalPeerIdRef.current;
            for (const peerId of peers) {
              if (!peerId || peerId === localPeerId) {
                continue;
              }

              const shouldOffer = localPeerId !== null && localPeerId.localeCompare(peerId) < 0;
              ensureRtcPeer(peerId, shouldOffer);
            }
          }
          return;
        }

        if (payload.type === "peer-joined" && payload.peerId && payload.peerId !== legacySignalPeerIdRef.current) {
          setKnownSignalPeers((previous) => (previous.includes(payload.peerId as string) ? previous : [...previous, payload.peerId as string]));

          if (allowRtc) {
            const localPeerId = legacySignalPeerIdRef.current;
            const shouldOffer = localPeerId !== null && localPeerId.localeCompare(payload.peerId) < 0;
            ensureRtcPeer(payload.peerId, shouldOffer);
          }
        }

        if (payload.type === "peer-left" && payload.peerId) {
          setKnownSignalPeers((previous) => previous.filter((peerId) => peerId !== payload.peerId));
        }

        if (payload.type === "webrtc-offer" && payload.from && payload.sdp) {
          if (!allowRtc) {
            return;
          }

          bumpRtcDiagnostic("offersReceived");
          const peer = ensureRtcPeer(payload.from, false);
          if (!peer) {
            return;
          }

          void (async () => {
            await peer.setRemoteDescription({ type: "offer", sdp: payload.sdp });
            const answer = await peer.createAnswer();
            await peer.setLocalDescription(answer);
            bumpRtcDiagnostic("answersSent");
            sendSignal({
              type: "webrtc-answer",
              to: payload.from,
              sdp: answer.sdp
            });
          })();
          return;
        }

        if (payload.type === "webrtc-answer" && payload.from && payload.sdp) {
          if (!allowRtc) {
            return;
          }

          bumpRtcDiagnostic("answersReceived");
          const peer = ensureRtcPeer(payload.from, false);
          if (!peer) {
            return;
          }

          void peer.setRemoteDescription({ type: "answer", sdp: payload.sdp });
          return;
        }

        if (payload.type === "webrtc-ice" && payload.from && payload.candidate) {
          if (!allowRtc) {
            return;
          }

          bumpRtcDiagnostic("iceReceived");
          const peer = ensureRtcPeer(payload.from, false);
          if (!peer) {
            return;
          }

          void peer.addIceCandidate({
            candidate: payload.candidate,
            sdpMid: payload.sdpMid ?? undefined,
            sdpMLineIndex: payload.sdpMLineIndex ?? undefined
          });
          return;
        }

        handleRealtimePayload(payload, payload.from ?? payload.peerId);
      } catch {
        // Ignore invalid legacy signaling payload.
      }
    };

    legacySocket.onerror = () => {
      if (disposed) {
        return;
      }

      // Legacy WebSocket error can be transient during reconnect; onclose will
      // drive authoritative state transitions.
      if (legacySignalSocketRef.current?.readyState !== WebSocket.OPEN) {
        setSignalSocketState("connecting");
      }
    };

    legacySocket.onclose = () => {
      if (disposed) {
        return;
      }

      if (suppressLegacyReconnect || runtimeSdkRef.current !== null) {
        // SDK signaling took ownership; ignore legacy close transitions.
        return;
      }

      if (legacySignalSocketRef.current === legacySocket) {
        legacySignalSocketRef.current = null;
      }
      setSignalSocketState("closed");
      scheduleSignalReconnect();
    };

    if (!disableRuntimeSdkSignaling) {
      void (async () => {
      try {
        const sdk = await createDemoRoomSdkWithTransport(roomId, transportPreference);
        await sdk.room.connect();
        if (disposed) {
          sdk.room.disconnect();
          return;
        }

        runtimeSdkRef.current = sdk;
        const topology = sdk.topology.snapshot();
        runtimePeerIdRef.current = topology.pubkey;
        setTransportMode(readActiveTransportMode(sdk));

        if (legacySignalSocketRef.current) {
          suppressLegacyReconnect = true;
          try {
            legacySignalSocketRef.current.close();
          } catch {
            // Best-effort handoff to SDK signaling.
          }
          legacySignalSocketRef.current = null;
          legacySignalPeerIdRef.current = null;
        }

        cleanupHandlers.push(
          sdk.on("connected", () => {
            if (disposed) {
              return;
            }
            setSignalSocketState("open");
            setHostError(null);
          })
        );

        cleanupHandlers.push(
          sdk.on("disconnected", () => {
            if (disposed) {
              return;
            }
            setSignalSocketState("closed");
            setTransportMode("ws-only");
            disconnectRtc();
            scheduleSignalReconnect();
          })
        );

        cleanupHandlers.push(
          sdk.on("transport", (payload: unknown) => {
            if (disposed || !payload || typeof payload !== "object") {
              return;
            }

            const active = (payload as { active?: unknown }).active;
            if (active === "ws-only") {
              setTransportMode(active);
              return;
            }

            if (active === "ws+webrtc" && rtcChannelsRef.current.size > 0) {
              setTransportMode(active);
            }
          })
        );

        cleanupHandlers.push(
          sdk.on("runtime-message", (payload: unknown) => {
            if (disposed || !payload || typeof payload !== "object") {
              return;
            }

            const runtimeMessage = payload as {
              type?: string;
              peers?: string[];
              peerId?: string;
            };

            if (runtimeMessage.type === "welcome") {
              const localPeerId = runtimePeerIdRef.current;
              const peers = Array.isArray(runtimeMessage.peers) ? runtimeMessage.peers : [];
              setKnownSignalPeers(peers.filter((peerId) => peerId !== localPeerId));
              return;
            }

            if (runtimeMessage.type === "peer-joined" && runtimeMessage.peerId) {
              const localPeerId = runtimePeerIdRef.current;
              if (runtimeMessage.peerId === localPeerId) {
                return;
              }
              setKnownSignalPeers((previous) =>
                previous.includes(runtimeMessage.peerId as string) ? previous : [...previous, runtimeMessage.peerId as string]
              );
              return;
            }

            if (runtimeMessage.type === "peer-left" && runtimeMessage.peerId) {
              setKnownSignalPeers((previous) => previous.filter((peerId) => peerId !== runtimeMessage.peerId));
            }
          })
        );

        cleanupHandlers.push(
          sdk.on("presence", (payload: unknown) => {
            if (disposed || !payload || typeof payload !== "object") {
              return;
            }

            const presence = payload as {
              type?: string;
              from?: string;
              data?: unknown;
            };

            if (presence.type !== "presence" || !presence.data || typeof presence.data !== "object") {
              return;
            }

            if (presence.from && presence.from === runtimePeerIdRef.current) {
              return;
            }

            handleRealtimePayload(
              presence.data as {
                type?: string;
                nodeId?: string;
                x?: number;
                y?: number;
                peerId?: string;
                from?: string;
                updatedAtMs?: number;
                operation?: WorkspaceOperationItem;
              },
              presence.from
            );
          })
        );

        cleanupHandlers.push(
          sdk.on("signal", (payload: unknown) => {

            if (disposed || !payload || typeof payload !== "object") {
              return;
            }

            const signal = payload as {
              type?: string;
              peerId?: string;
              from?: string;
              sdp?: string;
              candidate?: string;
              sdpMid?: string | null;
              sdpMLineIndex?: number | null;
            };

            const localPeerId = runtimePeerIdRef.current;
            const remotePeerId =
              typeof signal.from === "string"
                ? signal.from
                : typeof signal.peerId === "string"
                  ? signal.peerId
                  : undefined;

            if (signal.type === "peer-joined" && remotePeerId && remotePeerId !== localPeerId) {
              setKnownSignalPeers((previous) => (previous.includes(remotePeerId) ? previous : [...previous, remotePeerId]));
              if (!allowRtc) {
                return;
              }

              const shouldOffer = localPeerId !== null && localPeerId.localeCompare(remotePeerId) < 0;
              ensureRtcPeer(remotePeerId, shouldOffer);
              return;
            }

            if (signal.type === "peer-left" && remotePeerId) {
              setKnownSignalPeers((previous) => previous.filter((peerId) => peerId !== remotePeerId));
              const peer = rtcPeersRef.current.get(remotePeerId);
              if (peer) {
                try {
                  peer.close();
                } catch {
                  // ignore
                }
                rtcPeersRef.current.delete(remotePeerId);
                refreshRtcPeerStatuses();
              }

              rtcChannelsRef.current.delete(remotePeerId);
              if (rtcChannelsRef.current.size === 0) {
                setTransportMode("ws-only");
              }

              setRemoteDragByNode((previous) => {
                const next = Object.fromEntries(Object.entries(previous).filter(([, value]) => value.peerId !== remotePeerId));
                return next;
              });
              return;
            }

            if (signal.type === "webrtc-offer" && remotePeerId && signal.sdp) {
              if (!allowRtc) {
                return;
              }

              bumpRtcDiagnostic("offersReceived");
              const peer = ensureRtcPeer(remotePeerId, false);
              if (!peer) {
                return;
              }

              void (async () => {
                await peer.setRemoteDescription({ type: "offer", sdp: signal.sdp });
                const answer = await peer.createAnswer();
                await peer.setLocalDescription(answer);
                bumpRtcDiagnostic("answersSent");
                sendSignal({
                  type: "webrtc-answer",
                  to: remotePeerId,
                  sdp: answer.sdp
                });
              })();
              return;
            }

            if (signal.type === "webrtc-answer" && remotePeerId && signal.sdp) {
              if (!allowRtc) {
                return;
              }

              bumpRtcDiagnostic("answersReceived");
              const peer = ensureRtcPeer(remotePeerId, false);
              if (!peer) {
                return;
              }

              void peer.setRemoteDescription({ type: "answer", sdp: signal.sdp });
              return;
            }

            if (signal.type === "webrtc-ice" && remotePeerId && signal.candidate) {
              if (!allowRtc) {
                return;
              }

              bumpRtcDiagnostic("iceReceived");
              const peer = ensureRtcPeer(remotePeerId, false);
              if (!peer) {
                return;
              }

              void peer.addIceCandidate({
                candidate: signal.candidate,
                sdpMid: signal.sdpMid ?? undefined,
                sdpMLineIndex: signal.sdpMLineIndex ?? undefined
              });
            }
          })
        );
      } catch {
        if (disposed) {
          return;
        }

        // SDK signaling can fail due transient host restarts; keep legacy relay fallback active.
        if (legacySignalSocketRef.current?.readyState === WebSocket.OPEN) {
          setSignalSocketState("open");
        } else {
          setSignalSocketState("error");
        }
        setTransportMode("ws-only");
        scheduleSignalReconnect();
      }
      })();
    }

    return () => {
      disposed = true;
      if (reconnectTimerId !== null) {
        window.clearTimeout(reconnectTimerId);
        reconnectTimerId = null;
      }

      for (const cleanup of cleanupHandlers) {
        cleanup();
      }

      const sdk = runtimeSdkRef.current;
      runtimeSdkRef.current = null;
      runtimePeerIdRef.current = null;
      legacySignalPeerIdRef.current = null;
      if (sdk) {
        void sdk.room.disconnect();
      }

      if (legacySignalSocketRef.current === legacySocket) {
        legacySignalSocketRef.current = null;
      }

      if (legacySocket.readyState === WebSocket.OPEN) {
        try {
          legacySocket.close();
        } catch {
          // ignore close race
        }
      } else if (legacySocket.readyState === WebSocket.CONNECTING) {
        const closeWhenOpen = () => {
          legacySocket.removeEventListener("open", closeWhenOpen);
          try {
            legacySocket.close();
          } catch {
            // ignore close race
          }
        };

        legacySocket.addEventListener("open", closeWhenOpen);
      }

      setSignalSocketState("idle");
      disconnectRtc();
    };
  }, [activePeerId, cloudConnected, roomId, signalReconnectNonce, transportPreference]);

  useEffect(() => {
    const queued = flattenOfflineQueue(offlineQueueByPeer);
    if (!cloudConnected || queued.length === 0) {
      return;
    }

    let isCanceled = false;

    async function flushOfflineQueue() {
      setIsBusy(true);
      try {
        for (const item of queued) {
          if (isCanceled) {
            return;
          }

          await applyWorkspaceRoomOperation(roomId, toOperationRequest(item));
        }

        if (!isCanceled) {
          const [snapshot, latestEvents, latestOperations] = await Promise.all([
            fetchWorkspaceRoomState(roomId),
            fetchWorkspaceRoomEvents(roomId, 120),
            fetchWorkspaceRoomOperations(roomId, 2000)
          ]);

          setState(snapshot);
          setEvents(latestEvents.events);
          setOperations(latestOperations.operations);
          setOfflineQueueByPeer(createEmptyOfflineQueue());
          setStatusMessage(`Flushed ${queued.length} offline operation(s) to shared room`);
          setHostError(null);
        }
      } catch (error) {
        if (!isCanceled) {
          setHostError(error instanceof Error ? error.message : "Unable to flush offline operations");
          setCloudConnected(false);
        }
      } finally {
        if (!isCanceled) {
          setIsBusy(false);
        }
      }
    }

    void flushOfflineQueue();

    return () => {
      isCanceled = true;
    };
  }, [cloudConnected, offlineQueueByPeer, roomId]);

  useEffect(() => {
    const queuedCount = countOfflineQueue(offlineQueueByPeer);
    if (followLiveReplay) {
      setReplayCursor(operations.length + queuedCount);
    }
  }, [operations.length, offlineQueueByPeer, followLiveReplay]);

  useEffect(() => {
    setPendingStrokes((previous) =>
      previous.filter(
        (pending) =>
          !operations.some((op) => op.kind === "add-stroke" && op.nodeId === pending.id && op.peerId === pending.peerId)
      )
    );

    setPendingOnlineByPeer((previous) => {
      const next: PendingOnlineQueueByPeer = {
        alpha: previous.alpha.filter(
          (pending) =>
            !operations.some(
              (op) =>
                op.kind === pending.kind &&
                op.peerId === pending.peerId &&
                op.nodeId === pending.nodeId &&
                op.updatedAtMs >= pending.updatedAtMs
            )
        ),
        bravo: previous.bravo.filter(
          (pending) =>
            !operations.some(
              (op) =>
                op.kind === pending.kind &&
                op.peerId === pending.peerId &&
                op.nodeId === pending.nodeId &&
                op.updatedAtMs >= pending.updatedAtMs
            )
        ),
        charlie: previous.charlie.filter(
          (pending) =>
            !operations.some(
              (op) =>
                op.kind === pending.kind &&
                op.peerId === pending.peerId &&
                op.nodeId === pending.nodeId &&
                op.updatedAtMs >= pending.updatedAtMs
            )
        )
      };

      return next;
    });

    setRemoteOptimisticOperations((previous) =>
      previous.filter(
        (pending) =>
          !operations.some(
            (op) =>
              op.kind === pending.kind &&
              op.peerId === pending.peerId &&
              op.nodeId === pending.nodeId &&
              op.updatedAtMs >= pending.updatedAtMs
          )
      )
    );

    for (const op of operations) {
      if (op.kind === "add-node" && op.peerId === activePeerId && op.nodeId && pendingCreatedNodeIdsRef.current.has(op.nodeId)) {
        pendingCreatedNodeIdsRef.current.delete(op.nodeId);

        const deferredMove = deferredFinalMoveByNodeRef.current.get(op.nodeId);
        if (deferredMove) {
          deferredFinalMoveByNodeRef.current.delete(op.nodeId);
          void submitOperation(
            {
              peerId: activePeerId,
              kind: "move-node",
              nodeId: op.nodeId,
              x: deferredMove.x,
              y: deferredMove.y,
              updatedAtMs: deferredMove.updatedAtMs
            },
            false
          );
        }
      }
    }

    setPendingLocalMoveByNode((previous) => {
      if (Object.keys(previous).length === 0) {
        return previous;
      }

      let changed = false;
      const next: PendingLocalMoveByNode = {};

      for (const [nodeId, pending] of Object.entries(previous)) {
        const acknowledged = operations.some(
          (op) =>
            op.kind === "move-node" &&
            op.nodeId === nodeId &&
            op.peerId === pending.peerId &&
            op.updatedAtMs >= pending.updatedAtMs &&
            op.x === pending.x &&
            op.y === pending.y
        );

        if (acknowledged) {
          changed = true;
          continue;
        }

        next[nodeId] = pending;
      }

      return changed ? next : previous;
    });

    setRemoteDragByNode((previous) => {
      let changed = false;
      const next: Record<string, { x: number; y: number; peerId: string; updatedAtMs: number; holdUntilAck: boolean }> = {};

      for (const [nodeId, value] of Object.entries(previous)) {
        if (!value.holdUntilAck) {
          next[nodeId] = value;
          continue;
        }

        const acknowledged = operations.some(
          (op) =>
            op.kind === "move-node" &&
            op.nodeId === nodeId &&
            op.peerId === value.peerId &&
            op.updatedAtMs >= value.updatedAtMs &&
            op.x === value.x &&
            op.y === value.y
        );

        if (acknowledged) {
          changed = true;
          continue;
        }

        next[nodeId] = value;
      }

      return changed ? next : previous;
    });
  }, [operations]);

  function clearSelection() {
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
    setSelectedAnnotationId(null);
    setSelectedStrokeId(null);
  }

  const activePeerOfflineOperations = useMemo(() => offlineQueueByPeer[activePeerId], [activePeerId, offlineQueueByPeer]);
  const activePeerPendingOnlineOperations = useMemo(() => pendingOnlineByPeer[activePeerId], [activePeerId, pendingOnlineByPeer]);
  const mergedOperations = useMemo(
    () => [...operations, ...activePeerOfflineOperations, ...activePeerPendingOnlineOperations, ...remoteOptimisticOperations],
    [activePeerOfflineOperations, activePeerPendingOnlineOperations, operations, remoteOptimisticOperations]
  );

  const displayState = useMemo(() => {
    if (followLiveReplay) {
      return replayRoomState(mergedOperations, mergedOperations.length, roomId);
    }

    return replayRoomState(mergedOperations, replayCursor, roomId);
  }, [followLiveReplay, mergedOperations, replayCursor, roomId]);

  useEffect(() => {
    if (followLiveReplay || replayCursor < mergedOperations.length) {
      return;
    }

    setFollowLiveReplay(true);
    setIsReplayPlaying(false);
  }, [followLiveReplay, replayCursor, mergedOperations.length]);

  useEffect(() => {
    if (!isReplayPlaying) {
      return;
    }

    if (mergedOperations.length === 0) {
      setIsReplayPlaying(false);
      return;
    }

    if (followLiveReplay) {
      setFollowLiveReplay(false);
    }

    const clampedSpeed = Math.max(1, replaySpeedOpsPerSecond);
    let rafId = 0;
    let lastTs = performance.now();
    let accumulatedOps = 0;

    const tick = (ts: number) => {
      const elapsedMs = Math.max(0, ts - lastTs);
      lastTs = ts;
      accumulatedOps += (elapsedMs * clampedSpeed) / 1000;

      if (accumulatedOps >= 1) {
        const steps = Math.floor(accumulatedOps);
        accumulatedOps -= steps;

        setReplayCursor((previous) => {
          const next = Math.min(mergedOperations.length, previous + steps);
          if (next >= mergedOperations.length) {
            setIsReplayPlaying(false);
            setFollowLiveReplay(true);
          }

          return next;
        });
      }

      rafId = window.requestAnimationFrame(tick);
    };

    rafId = window.requestAnimationFrame(tick);

    return () => {
      window.cancelAnimationFrame(rafId);
    };
  }, [isReplayPlaying, followLiveReplay, mergedOperations.length, replaySpeedOpsPerSecond]);

  useEffect(() => {
    function onPointerMove(event: PointerEvent) {
      if (activePointerIdRef.current !== null && event.pointerId !== activePointerIdRef.current) {
        return;
      }

      const workspace = workspaceRef.current;
      if (!workspace) {
        return;
      }

      if (event.cancelable && (dragRef.current || drawRef.current)) {
        event.preventDefault();
      }

      const rect = workspace.getBoundingClientRect();
      const x = Math.max(0, Math.min(workspaceWidth, event.clientX - rect.left));
      const y = Math.max(0, Math.min(workspaceHeight, event.clientY - rect.top));

      if (dragRef.current) {
        const nextDrag = {
          nodeId: dragRef.current.nodeId,
          x: x - dragRef.current.offsetX,
          y: y - dragRef.current.offsetY
        };

        dragPreviewRef.current = nextDrag;

        const now = Date.now();
        const hasRtcPresenceChannel = Array.from(rtcChannelsRef.current.values()).some((channel) => channel.readyState === "open");
        const hasSignalRelay =
          legacySignalSocketRef.current?.readyState === WebSocket.OPEN || signalSocketState === "open";
        const hasRealtimeFanout = hasRtcPresenceChannel || (hasSignalRelay && knownSignalPeers.length > 0);
        const forceAuthoritativeInWsOnly = transportMode === "ws-only";
        if (now - lastDragPresenceSentAtRef.current >= dragPresenceIntervalMs) {
          lastDragPresenceSentAtRef.current = now;
          const payload = {
            type: "drag-presence",
            peerId: activePeerId,
            nodeId: dragRef.current.nodeId,
            x: nextDrag.x,
            y: nextDrag.y,
            updatedAtMs: now
          };
          const serializedPayload = JSON.stringify(payload);
          for (const channel of rtcChannelsRef.current.values()) {
            if (channel.readyState === "open") {
              channel.send(serializedPayload);
            }
          }

          if (!hasRtcPresenceChannel) {
            sendSignal(payload);
          }
        }

        const isPendingCreatedNode = pendingCreatedNodeIdsRef.current.has(nextDrag.nodeId);
        if (
          (!hasRealtimeFanout || forceAuthoritativeInWsOnly) &&
          !isPendingCreatedNode &&
          now - lastDragAuthoritativeSentAtRef.current >= dragAuthoritativeFallbackIntervalMs
        ) {
          lastDragAuthoritativeSentAtRef.current = now;
          void submitOperation(
            {
              peerId: activePeerId,
              kind: "move-node",
              nodeId: dragRef.current.nodeId,
              x: nextDrag.x,
              y: nextDrag.y,
              updatedAtMs: now
            },
            false
          );
        }

        setDragPreview(nextDrag);
      }

      if (drawRef.current) {
        const nextPoints = [...drawRef.current, { x, y }];
        drawRef.current = nextPoints;
        setActiveStrokePoints(nextPoints);
      }
    }

    function onPointerUp(event: PointerEvent) {
      if (activePointerIdRef.current !== null && event.pointerId !== activePointerIdRef.current) {
        return;
      }

      const draggedNodeId = dragRef.current?.nodeId;
      const finalDrag = dragPreviewRef.current;
      const commitUpdatedAtMs = Date.now();
      dragRef.current = null;
      activePointerIdRef.current = null;
      setDragPreview(null);
      dragPreviewRef.current = null;
      lastDragPresenceSentAtRef.current = 0;
      lastDragAuthoritativeSentAtRef.current = 0;

      if (draggedNodeId && finalDrag && finalDrag.nodeId === draggedNodeId) {
        setPendingLocalMoveByNode((previous) => ({
          ...previous,
          [draggedNodeId]: {
            x: finalDrag.x,
            y: finalDrag.y,
            peerId: activePeerId,
            updatedAtMs: commitUpdatedAtMs
          }
        }));

        if (pendingCreatedNodeIdsRef.current.has(draggedNodeId)) {
          deferredFinalMoveByNodeRef.current.set(draggedNodeId, {
            x: finalDrag.x,
            y: finalDrag.y,
            updatedAtMs: commitUpdatedAtMs
          });
        } else {
          void submitOperation(
            {
              peerId: activePeerId,
              kind: "move-node",
              nodeId: draggedNodeId,
              x: finalDrag.x,
              y: finalDrag.y,
              updatedAtMs: commitUpdatedAtMs
            },
            false
          );
        }
      }

      if (draggedNodeId) {
        const payload = {
          type: "drag-presence-end",
          peerId: activePeerId,
          nodeId: draggedNodeId,
          x: finalDrag?.x,
          y: finalDrag?.y,
          updatedAtMs: commitUpdatedAtMs
        };
        const serializedPayload = JSON.stringify(payload);
        for (const channel of rtcChannelsRef.current.values()) {
          if (channel.readyState === "open") {
            channel.send(serializedPayload);
          }
        }

        const hasRtcPresenceChannel = Array.from(rtcChannelsRef.current.values()).some((channel) => channel.readyState === "open");
        if (!hasRtcPresenceChannel) {
          sendSignal(payload);
        }
      }

      const points = drawRef.current;
      if (points && points.length > 1) {
        const strokeId = makeId("stroke");
        if (cloudConnected) {
          setPendingStrokes((previous) => [
            ...previous,
            {
              id: strokeId,
              points,
              color: peerColor[activePeerId],
              width: 3,
              peerId: activePeerId
            }
          ]);
        }
        void submitOperation({
          peerId: activePeerId,
          kind: "add-stroke",
          nodeId: strokeId,
          points,
          color: peerColor[activePeerId],
          width: 3,
          updatedAtMs: Date.now()
        });
      }

      drawRef.current = null;
      setActiveStrokePoints([]);
    }

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);

    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
    };
  }, [activePeerId, cloudConnected, knownSignalPeers.length, roomId, signalSocketState]);

  const renderedNodes = useMemo(() => {
    return displayState.nodes.map((node) => {
      if (dragPreview && node.id === dragPreview.nodeId) {
        return {
          ...node,
          x: dragPreview.x,
          y: dragPreview.y
        };
      }

      const pendingLocalMove = pendingLocalMoveByNode[node.id];
      if (pendingLocalMove) {
        return {
          ...node,
          x: pendingLocalMove.x,
          y: pendingLocalMove.y
        };
      }

      const remoteDrag = remoteDragByNode[node.id];
      if (remoteDrag) {
        return {
          ...node,
          x: remoteDrag.x,
          y: remoteDrag.y
        };
      }

      return node;
    });
  }, [displayState.nodes, dragPreview, pendingLocalMoveByNode, remoteDragByNode]);

  const nodeById = useMemo(() => {
    return new Map(renderedNodes.map((node) => [node.id, node]));
  }, [renderedNodes]);

  async function submitOperation(operation: WorkspaceOperationRequest, announce = true) {
    const normalized = {
      ...operation,
      updatedAtMs: operation.updatedAtMs ?? Date.now()
    };
    const shouldOptimisticallyRender = normalized.kind === "add-node" || normalized.kind === "add-annotation";
    let optimisticItem: WorkspaceOperationItem | null = null;

    if (cloudConnected && shouldOptimisticallyRender) {
      const nextOptimisticItem = toOperationItem(normalized);
      optimisticItem = nextOptimisticItem;
      if (nextOptimisticItem.kind === "add-node" && nextOptimisticItem.nodeId) {
        pendingCreatedNodeIdsRef.current.add(nextOptimisticItem.nodeId);
      }
      setPendingOnlineByPeer((previous) => ({
        ...previous,
        [nextOptimisticItem.peerId as PeerId]: enqueuePendingOnlineOperation(
          previous[nextOptimisticItem.peerId as PeerId],
          nextOptimisticItem
        )
      }));

      const payload = JSON.stringify({
        type: "optimistic-op",
        operation: nextOptimisticItem
      });
      for (const channel of rtcChannelsRef.current.values()) {
        if (channel.readyState === "open") {
          channel.send(payload);
        }
      }

      const hasRtcPresenceChannel = Array.from(rtcChannelsRef.current.values()).some((channel) => channel.readyState === "open");
      if (!hasRtcPresenceChannel) {
        sendSignal({
          type: "optimistic-op",
          operation: nextOptimisticItem,
          peerId: activePeerId,
          updatedAtMs: nextOptimisticItem.updatedAtMs
        });
      }
    }

    if (!cloudConnected) {
      const opItem = toOperationItem(normalized);
      setOfflineQueueByPeer((previous) => ({
        ...previous,
        [opItem.peerId as PeerId]: enqueueOfflineOperation(previous[opItem.peerId as PeerId], opItem)
      }));
      if (announce) {
        setStatusMessage(`Queued offline ${operation.kind}`);
      }
      return;
    }

    setIsBusy(true);
    try {
      const nextState = await applyWorkspaceRoomOperation(roomId, normalized);
      setState(nextState);
      if (normalized.kind === "move-node") {
        const confirmedMove = toOperationItem(normalized);
        setOperations((previous) => appendOperationUnique(previous, confirmedMove));
      }
      if (announce) {
        setStatusMessage(`Applied ${operation.kind}`);
      }
    } catch (error) {
      setHostError(error instanceof Error ? error.message : "Operation failed");
      setCloudConnected(false);
      if (optimisticItem) {
        if (optimisticItem.kind === "add-node" && optimisticItem.nodeId) {
          pendingCreatedNodeIdsRef.current.delete(optimisticItem.nodeId);
          deferredFinalMoveByNodeRef.current.delete(optimisticItem.nodeId);
        }
        setPendingOnlineByPeer((previous) => ({
          ...previous,
          [optimisticItem.peerId as PeerId]: previous[optimisticItem.peerId as PeerId].filter((item) => item.id !== optimisticItem?.id)
        }));
      }
      const opItem = toOperationItem(normalized);
      setOfflineQueueByPeer((previous) => ({
        ...previous,
        [opItem.peerId as PeerId]: enqueueOfflineOperation(previous[opItem.peerId as PeerId], opItem)
      }));
      if (announce) {
        setStatusMessage(`Host unavailable. Queued offline ${operation.kind}`);
      }
    } finally {
      setIsBusy(false);
    }
  }

  function handleWorkspacePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (!isPrimaryInteractionPointer(event)) {
      return;
    }

    const workspace = workspaceRef.current;
    if (!workspace) {
      return;
    }

    const rect = workspace.getBoundingClientRect();
    const x = Math.max(0, Math.min(workspaceWidth, event.clientX - rect.left));
    const y = Math.max(0, Math.min(workspaceHeight, event.clientY - rect.top));

    if (tool === "select") {
      clearSelection();
    }

    if (tool === "annotate") {
      event.preventDefault();
      void submitOperation({
        peerId: activePeerId,
        kind: "add-annotation",
        nodeId: makeId("note"),
        x,
        y,
        text: annotationDraft.trim() || "Untitled note",
        updatedAtMs: Date.now()
      });
      return;
    }

    if (tool === "draw") {
      event.preventDefault();
      activePointerIdRef.current = event.pointerId;
      const initial = [{ x, y }];
      drawRef.current = initial;
      setActiveStrokePoints(initial);
    }
  }

  function handleNodePointerDown(event: ReactPointerEvent<HTMLDivElement>, nodeId: string) {
    event.stopPropagation();

    const node = nodeById.get(nodeId);
    if (!node) {
      return;
    }

    if (tool !== "select") {
      return;
    }

    if (!isPrimaryInteractionPointer(event)) {
      return;
    }

    if (event.shiftKey && selectedNodeId && selectedNodeId !== nodeId) {
      void submitOperation({
        peerId: activePeerId,
        kind: "add-edge",
        fromNodeId: selectedNodeId,
        toNodeId: nodeId,
        updatedAtMs: Date.now()
      });
      setSelectedNodeId(nodeId);
      return;
    }

    event.preventDefault();
    activePointerIdRef.current = event.pointerId;
    const nodeRect = event.currentTarget.getBoundingClientRect();
    setSelectedNodeId(nodeId);
    setSelectedEdgeId(null);
    setSelectedAnnotationId(null);
    setSelectedStrokeId(null);
    dragRef.current = {
      nodeId,
      offsetX: event.clientX - nodeRect.left,
      offsetY: event.clientY - nodeRect.top
    };
  }

  function handleAnnotationPointerDown(event: ReactPointerEvent<HTMLDivElement>, annotationId: string) {
    event.stopPropagation();
    if (tool !== "select" || !isPrimaryInteractionPointer(event)) {
      return;
    }

    setSelectedAnnotationId(annotationId);
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
    setSelectedStrokeId(null);
  }

  function handleStrokePointerDown(event: ReactPointerEvent<SVGPolylineElement>, strokeId: string) {
    event.stopPropagation();
    if (tool !== "select" || !isPrimaryInteractionPointer(event)) {
      return;
    }

    setSelectedStrokeId(strokeId);
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
    setSelectedAnnotationId(null);
  }

  function handleEdgePointerDown(event: ReactPointerEvent<SVGLineElement>, edgeId: string) {
    event.stopPropagation();
    if (tool !== "select" || !isPrimaryInteractionPointer(event)) {
      return;
    }

    setSelectedEdgeId(edgeId);
    setSelectedNodeId(null);
    setSelectedAnnotationId(null);
    setSelectedStrokeId(null);
  }

  async function deleteSelection() {
    const updatedAtMs = Date.now();

    if (selectedNodeId) {
      const nodeId = selectedNodeId;
      clearSelection();
      await submitOperation({
        peerId: activePeerId,
        kind: "delete-node",
        nodeId,
        updatedAtMs
      });
      setStatusMessage(`Deleted node ${nodeId}`);
      return;
    }

    if (selectedAnnotationId) {
      const annotationId = selectedAnnotationId;
      clearSelection();
      await submitOperation({
        peerId: activePeerId,
        kind: "delete-annotation",
        nodeId: annotationId,
        updatedAtMs
      });
      setStatusMessage(`Deleted annotation ${annotationId}`);
      return;
    }

    if (selectedEdgeId) {
      const edgeId = selectedEdgeId;
      clearSelection();
      await submitOperation({
        peerId: activePeerId,
        kind: "delete-edge",
        nodeId: edgeId,
        updatedAtMs
      });
      setStatusMessage(`Deleted edge ${edgeId}`);
      return;
    }

    if (selectedStrokeId) {
      const strokeId = selectedStrokeId;
      clearSelection();
      await submitOperation({
        peerId: activePeerId,
        kind: "delete-stroke",
        nodeId: strokeId,
        updatedAtMs
      });
      setStatusMessage(`Deleted stroke ${strokeId}`);
    }
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Delete" && event.key !== "Backspace") {
        return;
      }

      const active = document.activeElement;
      if (
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement ||
        active instanceof HTMLSelectElement ||
        (active instanceof HTMLElement && active.isContentEditable)
      ) {
        return;
      }

      if (!selectedNodeId && !selectedEdgeId && !selectedAnnotationId && !selectedStrokeId) {
        return;
      }

      event.preventDefault();
      void deleteSelection();
    }

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [selectedNodeId, selectedEdgeId, selectedAnnotationId, selectedStrokeId, activePeerId, roomId]);

  function handleAssetUpload(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    for (const file of files) {
      void submitOperation({
        peerId: activePeerId,
        kind: "add-asset",
        nodeId: makeId("asset"),
        assetName: file.name,
        x: 380 + Math.random() * 900,
        y: 180 + Math.random() * 600,
        updatedAtMs: Date.now()
      });
    }

    event.currentTarget.value = "";
  }

  function createNewRoom() {
    const nextRoomId = generateRoomId();
    setRoomId(nextRoomId);
    setStatusMessage(`Created room ${nextRoomId}`);
  }

  async function addNode() {
    await submitOperation({
      peerId: activePeerId,
      kind: "add-node",
      nodeId: makeId("node"),
      x: 80 + Math.random() * 280,
      y: 80 + Math.random() * 220,
      label: `Node ${state.nodes.length + 1}`,
      color: peerColor[activePeerId],
      updatedAtMs: Date.now()
    });
  }

  async function copyRoomLink() {
    const url = `${window.location.origin}/modes/room-workspace?room=${encodeURIComponent(roomId)}`;
    try {
      await navigator.clipboard.writeText(url);
      setStatusMessage("Room link copied");
    } catch {
      setStatusMessage(url);
    }
  }

  return (
    <section className="feature-page infinite-workspace-page">
      <header className="feature-header tactical-header">
        <p className="hero-tag">REAL SHARED ROOM</p>
        <h1>Infinite Workspace (Room-Backed)</h1>
        <p>
          This mode uses host endpoints keyed by room id. Open this same room URL in multiple browsers and all participants share one live canvas.
        </p>
      </header>

      <div className="infinite-controls feature-panel">
        <div className="action-row">
          <label>
            Room Id
            <input className="peer-input" value={roomId} onChange={(event) => setRoomId(event.target.value.trim() || "default")} />
          </label>
          <button type="button" className="action-btn tactical-btn" onClick={createNewRoom}>
            New Room
          </button>
          <button type="button" className="action-btn tactical-btn" onClick={() => void copyRoomLink()}>
            Copy Room Link
          </button>
        </div>

        <div className="action-row">
          <label>
            Active Peer
            <select className="peer-select" value={activePeerId} onChange={(event) => setActivePeerId(event.target.value as PeerId)}>
              {peers.map((peerId) => (
                <option key={peerId} value={peerId}>
                  {peerId}
                </option>
              ))}
            </select>
          </label>

          <label>
            Tool
            <select className="peer-select" value={tool} onChange={(event) => setTool(event.target.value as WorkspaceTool)}>
              <option value="select">select + drag + connect (shift click)</option>
              <option value="draw">draw stroke</option>
              <option value="annotate">annotate on canvas click</option>
            </select>
          </label>

          <label>
            Transport
            <select
              className="peer-select"
              value={transportPreference}
              onChange={(event) => setTransportPreference(event.target.value as TransportPreference)}
            >
              <option value="auto">auto (ws + rtc when available)</option>
              <option value="ws-only">force ws-only (disable rtc)</option>
            </select>
          </label>

          <label>
            Annotation
            <input
              className="peer-input"
              type="text"
              value={annotationDraft}
              onChange={(event) => setAnnotationDraft(event.target.value)}
              maxLength={64}
            />
          </label>
        </div>

        <div className="action-row">
          <button type="button" className="action-btn tactical-btn" onClick={() => void addNode()} disabled={isBusy}>
            Add Node
          </button>
          <button
            type="button"
            className="action-btn tactical-btn"
            onClick={() => void deleteSelection()}
            disabled={!selectedNodeId && !selectedEdgeId && !selectedAnnotationId && !selectedStrokeId}
          >
            Delete Selected
          </button>
          <label className="action-btn tactical-btn upload-btn">
            Upload Asset
            <input type="file" onChange={handleAssetUpload} multiple />
          </label>
          <button
            type="button"
            className="action-btn tactical-btn"
            onClick={() => {
              setCloudConnected((value) => !value);
              setStatusMessage(cloudConnected ? "Cloud disconnected (offline queue active)" : "Cloud reconnecting...");
            }}
          >
            {cloudConnected ? "Disconnect Cloud" : "Reconnect Cloud"}
          </button>
        </div>
        {statusMessage ? <p className="topology-note">{statusMessage}</p> : null}
        {hostError ? <p className="error-text">Host: {hostError}</p> : null}
      </div>

      <div className="infinite-layout">
        <article className="feature-panel">
          <div className="workspace-scroll">
            <div
              className={`workspace-surface ${tool === "draw" ? "workspace-surface-draw" : "workspace-surface-navigate"}`}
              ref={workspaceRef}
              onPointerDown={handleWorkspacePointerDown}
              role="presentation"
            >
              <svg className="workspace-edges" width={workspaceWidth} height={workspaceHeight}>
                {displayState.edges.map((edge) => {
                  const from = nodeById.get(edge.fromNodeId);
                  const to = nodeById.get(edge.toNodeId);
                  if (!from || !to) {
                    return null;
                  }

                  return (
                    <line
                      key={edge.id}
                      className={selectedEdgeId === edge.id ? "workspace-edge selected" : "workspace-edge"}
                      x1={from.x + 68}
                      y1={from.y + 22}
                      x2={to.x + 68}
                      y2={to.y + 22}
                      stroke="#2d3a50"
                      strokeOpacity={0.6}
                      strokeWidth={2.5}
                      onPointerDown={(event) => handleEdgePointerDown(event, edge.id)}
                    />
                  );
                })}

                {displayState.strokes.map((stroke) => (
                  <polyline
                    key={stroke.id}
                    className={selectedStrokeId === stroke.id ? "workspace-stroke selected" : "workspace-stroke"}
                    fill="none"
                    stroke={stroke.color}
                    strokeOpacity={0.75}
                    strokeWidth={stroke.width}
                    points={stroke.points.map((point) => `${point.x},${point.y}`).join(" ")}
                    onPointerDown={(event) => handleStrokePointerDown(event, stroke.id)}
                  />
                ))}

                {activeStrokePoints.length > 1 ? (
                  <polyline
                    fill="none"
                    stroke={peerColor[activePeerId]}
                    strokeOpacity={0.9}
                    strokeWidth={3}
                    points={activeStrokePoints.map((point) => `${point.x},${point.y}`).join(" ")}
                  />
                ) : null}

                {pendingStrokes.map((pending) => (
                  <polyline
                    key={`pending-${pending.id}`}
                    fill="none"
                    stroke={pending.color}
                    strokeOpacity={0.9}
                    strokeWidth={pending.width}
                    points={pending.points.map((point) => `${point.x},${point.y}`).join(" ")}
                  />
                ))}
              </svg>

              {displayState.assets.map((asset) => (
                <div key={asset.id} className="workspace-asset" style={{ left: asset.x, top: asset.y }}>
                  <strong>{asset.name}</strong>
                  <small>from {asset.updatedBy}</small>
                </div>
              ))}

              {displayState.annotations.map((annotation) => (
                <div
                  key={annotation.id}
                  className={selectedAnnotationId === annotation.id ? "workspace-note selected" : "workspace-note"}
                  style={{ left: annotation.x, top: annotation.y }}
                  onPointerDown={(event) => handleAnnotationPointerDown(event, annotation.id)}
                >
                  <strong>{annotation.text}</strong>
                  <small>{annotation.updatedBy}</small>
                </div>
              ))}

              {renderedNodes.map((node) => (
                <div
                  key={node.id}
                  className={selectedNodeId === node.id ? "workspace-node selected" : "workspace-node"}
                  onPointerDown={(event) => handleNodePointerDown(event, node.id)}
                  style={{ left: node.x, top: node.y, borderColor: node.color }}
                  role="button"
                  tabIndex={0}
                >
                  <strong>{node.label}</strong>
                  <small>{node.updatedBy}</small>
                </div>
              ))}
            </div>
          </div>
        </article>

        <aside className="telemetry-panel">
          <h2>Room Telemetry</h2>
          <ul>
            <li>Room: {roomId}</li>
            <li>Operations: {state.operationCount}</li>
            <li>Cloud: {cloudConnected ? "connected" : "disconnected"}</li>
            <li>Transport preference: {transportPreference}</li>
            <li>Transport: {transportMode}</li>
            <li>Offline queue (active peer): {activePeerOfflineOperations.length}</li>
            <li>Offline queue (total): {countOfflineQueue(offlineQueueByPeer)}</li>
            <li>Nodes: {displayState.nodes.length}</li>
            <li>Edges: {displayState.edges.length}</li>
            <li>Assets: {displayState.assets.length}</li>
            <li>Annotations: {displayState.annotations.length}</li>
            <li>Strokes: {displayState.strokes.length}</li>
          </ul>

          <h2>RTC Diagnostics</h2>
          <ul>
            <li>Signal socket: {signalSocketState}</li>
            <li>Known signal peers: {knownSignalPeers.length > 0 ? knownSignalPeers.join(", ") : "none"}</li>
            <li>Offers sent/received: {rtcDiagnostics.offersSent} / {rtcDiagnostics.offersReceived}</li>
            <li>Answers sent/received: {rtcDiagnostics.answersSent} / {rtcDiagnostics.answersReceived}</li>
            <li>ICE sent/received: {rtcDiagnostics.iceSent} / {rtcDiagnostics.iceReceived}</li>
          </ul>

          <ul className="ops-list replay-stream-list">
            {rtcPeerStatuses.map((status) => (
              <li key={status.peerId}>
                <span className="ops-meta">{status.peerId}</span>
                <span>pc={status.connectionState} channel={status.channelState}</span>
              </li>
            ))}
            {rtcPeerStatuses.length === 0 ? <li className="ops-empty">No RTC peers yet.</li> : null}
          </ul>

          <h2>Replay Timeline</h2>
          <div className="tool-group">
            <input
              type="range"
              min={0}
              max={mergedOperations.length}
              value={replayCursor}
              onChange={(event) => {
                const nextCursor = Number(event.target.value);
                setReplayCursor(nextCursor);
                if (nextCursor >= mergedOperations.length) {
                  setFollowLiveReplay(true);
                  setIsReplayPlaying(false);
                  return;
                }

                setFollowLiveReplay(false);
              }}
            />
            <p className="topology-note">
              Cursor {replayCursor} / {mergedOperations.length} {followLiveReplay ? "(live)" : "(replay)"}
            </p>
            <div className="action-row">
              <button
                type="button"
                className="action-btn tactical-btn"
                onClick={() => {
                  if (followLiveReplay) {
                    setFollowLiveReplay(false);
                    setReplayCursor(0);
                    setIsReplayPlaying(true);
                    return;
                  }

                  if (replayCursor >= mergedOperations.length) {
                    setReplayCursor(0);
                  }

                  setIsReplayPlaying((value) => !value);
                }}
                disabled={mergedOperations.length === 0}
              >
                {isReplayPlaying ? "Pause" : "Play"}
              </button>

              <button
                type="button"
                className="action-btn tactical-btn"
                onClick={() => {
                  setFollowLiveReplay(true);
                  setReplayCursor(mergedOperations.length);
                  setIsReplayPlaying(false);
                }}
              >
                Jump Live
              </button>
            </div>

            <label>
              Playback speed ({replaySpeedOpsPerSecond} ops/s)
              <input
                type="range"
                min={1}
                max={120}
                step={1}
                value={replaySpeedOpsPerSecond}
                onChange={(event) => setReplaySpeedOpsPerSecond(Number(event.target.value))}
              />
            </label>
          </div>

          <h2>Room Event Feed</h2>
          <ul className="ops-list replay-stream-list">
            {events
              .slice()
              .reverse()
              .map((event, index) => (
                <li key={`${event.updatedAtMs}-${event.kind}-${index}`}>
                  <span className="ops-meta">
                    {new Date(event.updatedAtMs).toLocaleTimeString()} [{event.peerId}] {event.kind}
                  </span>
                  <span>{event.message}</span>
                </li>
              ))}
            {events.length === 0 ? <li className="ops-empty">No room events yet.</li> : null}
          </ul>
        </aside>
      </div>
    </section>
  );
}
