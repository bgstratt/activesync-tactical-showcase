import type { ChangeEvent, MouseEvent as ReactMouseEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  applyWorkspaceRoomOperation,
  fetchWorkspaceRoomEvents,
  fetchWorkspaceRoomOperations,
  fetchWorkspaceRoomState
} from "../app/hostClient";
import type {
  WorkspaceEventItem,
  WorkspaceOperationItem,
  WorkspaceOperationRequest,
  WorkspacePoint,
  WorkspaceStateResponse
} from "../../../shared/contracts/runtime";

type PeerId = "alpha" | "bravo" | "charlie";
type WorkspaceTool = "select" | "draw" | "annotate";
type OfflineQueueByPeer = Record<PeerId, WorkspaceOperationItem[]>;

const peers: PeerId[] = ["alpha", "bravo", "charlie"];

const peerColor: Record<PeerId, string> = {
  alpha: "#2563eb",
  bravo: "#16a34a",
  charlie: "#dc2626"
};

const workspaceWidth = 2200;
const workspaceHeight = 1400;
const offlineQueueStoragePrefix = "room-workspace:offline-queue:";

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

function flattenOfflineQueue(queueByPeer: OfflineQueueByPeer): WorkspaceOperationItem[] {
  return [...queueByPeer.alpha, ...queueByPeer.bravo, ...queueByPeer.charlie].sort((a, b) => a.updatedAtMs - b.updatedAtMs);
}

function countOfflineQueue(queueByPeer: OfflineQueueByPeer): number {
  return queueByPeer.alpha.length + queueByPeer.bravo.length + queueByPeer.charlie.length;
}

export function RoomWorkspacePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [roomId, setRoomId] = useState(searchParams.get("room")?.trim() || generateRoomId());
  const [activePeerId, setActivePeerId] = useState<PeerId>("alpha");
  const [tool, setTool] = useState<WorkspaceTool>("select");
  const [annotationDraft, setAnnotationDraft] = useState("Decision note");
  const [state, setState] = useState<WorkspaceStateResponse>(emptyState);
  const [events, setEvents] = useState<WorkspaceEventItem[]>([]);
  const [operations, setOperations] = useState<WorkspaceOperationItem[]>([]);
  const [offlineQueueByPeer, setOfflineQueueByPeer] = useState<OfflineQueueByPeer>(createEmptyOfflineQueue());
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [activeStrokePoints, setActiveStrokePoints] = useState<WorkspacePoint[]>([]);
  const [pendingStroke, setPendingStroke] = useState<{
    id: string;
    points: WorkspacePoint[];
    color: string;
    width: number;
    peerId: string;
  } | null>(null);
  const [dragPreview, setDragPreview] = useState<{ nodeId: string; x: number; y: number } | null>(null);
  const [replayCursor, setReplayCursor] = useState(0);
  const [followLiveReplay, setFollowLiveReplay] = useState(true);
  const [cloudConnected, setCloudConnected] = useState(true);
  const [isBusy, setIsBusy] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [hostError, setHostError] = useState<string | null>(null);

  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ nodeId: string; offsetX: number; offsetY: number } | null>(null);
  const drawRef = useRef<WorkspacePoint[] | null>(null);

  useEffect(() => {
    setSearchParams((previous) => {
      const next = new URLSearchParams(previous);
      next.set("room", roomId);
      return next;
    }, { replace: true });
  }, [roomId, setSearchParams]);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(`${offlineQueueStoragePrefix}${roomId}`);
      if (!raw) {
        setOfflineQueueByPeer(createEmptyOfflineQueue());
        return;
      }

      const parsed = JSON.parse(raw) as Partial<OfflineQueueByPeer>;
      const next = createEmptyOfflineQueue();
      next.alpha = Array.isArray(parsed.alpha) ? parsed.alpha : [];
      next.bravo = Array.isArray(parsed.bravo) ? parsed.bravo : [];
      next.charlie = Array.isArray(parsed.charlie) ? parsed.charlie : [];
      setOfflineQueueByPeer(next);
    } catch {
      setOfflineQueueByPeer(createEmptyOfflineQueue());
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
    const intervalId = window.setInterval(() => {
      void refresh();
    }, 1000);

    return () => {
      isCanceled = true;
      window.clearInterval(intervalId);
    };
  }, [cloudConnected, roomId]);

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
    if (!pendingStroke) {
      return;
    }

    const acknowledged = operations.some(
      (op) => op.kind === "add-stroke" && op.nodeId === pendingStroke.id && op.peerId === pendingStroke.peerId
    );

    if (acknowledged) {
      setPendingStroke(null);
    }
  }, [operations, pendingStroke]);

  const activePeerOfflineOperations = useMemo(() => offlineQueueByPeer[activePeerId], [activePeerId, offlineQueueByPeer]);
  const mergedOperations = useMemo(
    () => [...operations, ...activePeerOfflineOperations],
    [activePeerOfflineOperations, operations]
  );

  const displayState = useMemo(() => {
    if (followLiveReplay) {
      return replayRoomState(mergedOperations, mergedOperations.length, roomId);
    }

    return replayRoomState(mergedOperations, replayCursor, roomId);
  }, [followLiveReplay, mergedOperations, replayCursor, roomId]);

  useEffect(() => {
    function onPointerMove(event: MouseEvent) {
      const workspace = workspaceRef.current;
      if (!workspace) {
        return;
      }

      const rect = workspace.getBoundingClientRect();
      const x = Math.max(0, Math.min(workspaceWidth, event.clientX - rect.left));
      const y = Math.max(0, Math.min(workspaceHeight, event.clientY - rect.top));

      if (dragRef.current) {
        setDragPreview({
          nodeId: dragRef.current.nodeId,
          x: x - dragRef.current.offsetX,
          y: y - dragRef.current.offsetY
        });
      }

      if (drawRef.current) {
        const nextPoints = [...drawRef.current, { x, y }];
        drawRef.current = nextPoints;
        setActiveStrokePoints(nextPoints);
      }
    }

    function onPointerUp() {
      const dragged = dragRef.current;
      const preview = dragPreview;
      if (dragged && preview && dragged.nodeId === preview.nodeId) {
        void submitOperation(
          {
            peerId: activePeerId,
            kind: "move-node",
            nodeId: dragged.nodeId,
            x: preview.x,
            y: preview.y,
            updatedAtMs: Date.now()
          },
          false
        );
      }

      dragRef.current = null;
      setDragPreview(null);

      const points = drawRef.current;
      if (points && points.length > 1) {
        const strokeId = makeId("stroke");
        setPendingStroke({
          id: strokeId,
          points,
          color: peerColor[activePeerId],
          width: 3,
          peerId: activePeerId
        });
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

    window.addEventListener("mousemove", onPointerMove);
    window.addEventListener("mouseup", onPointerUp);

    return () => {
      window.removeEventListener("mousemove", onPointerMove);
      window.removeEventListener("mouseup", onPointerUp);
    };
  }, [activePeerId, dragPreview, roomId]);

  const renderedNodes = useMemo(() => {
    if (!dragPreview) {
      return displayState.nodes;
    }

    return displayState.nodes.map((node) =>
      node.id === dragPreview.nodeId
        ? {
            ...node,
            x: dragPreview.x,
            y: dragPreview.y
          }
        : node
    );
  }, [displayState.nodes, dragPreview]);

  const nodeById = useMemo(() => {
    return new Map(renderedNodes.map((node) => [node.id, node]));
  }, [renderedNodes]);

  async function submitOperation(operation: WorkspaceOperationRequest, announce = true) {
    const normalized = {
      ...operation,
      updatedAtMs: operation.updatedAtMs ?? Date.now()
    };

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
      if (announce) {
        setStatusMessage(`Applied ${operation.kind}`);
      }
    } catch (error) {
      setHostError(error instanceof Error ? error.message : "Operation failed");
      setCloudConnected(false);
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

  function handleWorkspaceMouseDown(event: ReactMouseEvent<HTMLDivElement>) {
    const workspace = workspaceRef.current;
    if (!workspace) {
      return;
    }

    const rect = workspace.getBoundingClientRect();
    const x = Math.max(0, Math.min(workspaceWidth, event.clientX - rect.left));
    const y = Math.max(0, Math.min(workspaceHeight, event.clientY - rect.top));

    if (tool === "annotate") {
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
      const initial = [{ x, y }];
      drawRef.current = initial;
      setActiveStrokePoints(initial);
    }
  }

  function handleNodeMouseDown(event: ReactMouseEvent<HTMLDivElement>, nodeId: string) {
    event.stopPropagation();

    const node = nodeById.get(nodeId);
    if (!node) {
      return;
    }

    if (tool !== "select") {
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

    setSelectedNodeId(nodeId);
    dragRef.current = {
      nodeId,
      offsetX: event.nativeEvent.offsetX,
      offsetY: event.nativeEvent.offsetY
    };
  }

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
      x: 320 + Math.random() * 900,
      y: 220 + Math.random() * 600,
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
            <div className="workspace-surface" ref={workspaceRef} onMouseDown={handleWorkspaceMouseDown} role="presentation">
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
                      x1={from.x + 68}
                      y1={from.y + 22}
                      x2={to.x + 68}
                      y2={to.y + 22}
                      stroke="#2d3a50"
                      strokeOpacity={0.6}
                      strokeWidth={2.5}
                    />
                  );
                })}

                {displayState.strokes.map((stroke) => (
                  <polyline
                    key={stroke.id}
                    fill="none"
                    stroke={stroke.color}
                    strokeOpacity={0.75}
                    strokeWidth={stroke.width}
                    points={stroke.points.map((point) => `${point.x},${point.y}`).join(" ")}
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

                {pendingStroke ? (
                  <polyline
                    fill="none"
                    stroke={pendingStroke.color}
                    strokeOpacity={0.9}
                    strokeWidth={pendingStroke.width}
                    points={pendingStroke.points.map((point) => `${point.x},${point.y}`).join(" ")}
                  />
                ) : null}
              </svg>

              {displayState.assets.map((asset) => (
                <div key={asset.id} className="workspace-asset" style={{ left: asset.x, top: asset.y }}>
                  <strong>{asset.name}</strong>
                  <small>from {asset.updatedBy}</small>
                </div>
              ))}

              {displayState.annotations.map((annotation) => (
                <div key={annotation.id} className="workspace-note" style={{ left: annotation.x, top: annotation.y }}>
                  <strong>{annotation.text}</strong>
                  <small>{annotation.updatedBy}</small>
                </div>
              ))}

              {renderedNodes.map((node) => (
                <div
                  key={node.id}
                  className={selectedNodeId === node.id ? "workspace-node selected" : "workspace-node"}
                  onMouseDown={(event) => handleNodeMouseDown(event, node.id)}
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
            <li>Offline queue (active peer): {activePeerOfflineOperations.length}</li>
            <li>Offline queue (total): {countOfflineQueue(offlineQueueByPeer)}</li>
            <li>Nodes: {displayState.nodes.length}</li>
            <li>Edges: {displayState.edges.length}</li>
            <li>Assets: {displayState.assets.length}</li>
            <li>Annotations: {displayState.annotations.length}</li>
            <li>Strokes: {displayState.strokes.length}</li>
          </ul>

          <h2>Replay Timeline</h2>
          <div className="tool-group">
            <input
              type="range"
              min={0}
              max={mergedOperations.length}
              value={replayCursor}
              onChange={(event) => {
                setReplayCursor(Number(event.target.value));
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
                  setFollowLiveReplay(true);
                  setReplayCursor(mergedOperations.length);
                }}
              >
                Jump Live
              </button>
            </div>
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
