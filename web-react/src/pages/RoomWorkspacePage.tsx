import type { ChangeEvent, MouseEvent as ReactMouseEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  applyWorkspaceRoomOperation,
  fetchWorkspaceRoomEvents,
  fetchWorkspaceRoomState
} from "../app/hostClient";
import type {
  WorkspaceEventItem,
  WorkspaceOperationRequest,
  WorkspacePoint,
  WorkspaceStateResponse
} from "../../../shared/contracts/runtime";

type PeerId = "alpha" | "bravo" | "charlie";
type WorkspaceTool = "select" | "draw" | "annotate";

const peers: PeerId[] = ["alpha", "bravo", "charlie"];

const peerColor: Record<PeerId, string> = {
  alpha: "#2563eb",
  bravo: "#16a34a",
  charlie: "#dc2626"
};

const workspaceWidth = 2200;
const workspaceHeight = 1400;

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

export function RoomWorkspacePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [roomId, setRoomId] = useState(searchParams.get("room")?.trim() || generateRoomId());
  const [activePeerId, setActivePeerId] = useState<PeerId>("alpha");
  const [tool, setTool] = useState<WorkspaceTool>("select");
  const [annotationDraft, setAnnotationDraft] = useState("Decision note");
  const [state, setState] = useState<WorkspaceStateResponse>(emptyState);
  const [events, setEvents] = useState<WorkspaceEventItem[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [activeStrokePoints, setActiveStrokePoints] = useState<WorkspacePoint[]>([]);
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
    let isCanceled = false;

    async function refresh() {
      try {
        const [snapshot, latestEvents] = await Promise.all([
          fetchWorkspaceRoomState(roomId),
          fetchWorkspaceRoomEvents(roomId, 120)
        ]);

        if (!isCanceled) {
          setState(snapshot);
          setEvents(latestEvents.events);
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
  }, [roomId]);

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
        void submitOperation({
          peerId: activePeerId,
          kind: "move-node",
          nodeId: dragRef.current.nodeId,
          x: x - dragRef.current.offsetX,
          y: y - dragRef.current.offsetY,
          updatedAtMs: Date.now()
        }, false);
      }

      if (drawRef.current) {
        const nextPoints = [...drawRef.current, { x, y }];
        drawRef.current = nextPoints;
        setActiveStrokePoints(nextPoints);
      }
    }

    function onPointerUp() {
      dragRef.current = null;

      const points = drawRef.current;
      if (points && points.length > 1) {
        void submitOperation({
          peerId: activePeerId,
          kind: "add-stroke",
          nodeId: makeId("stroke"),
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
  }, [activePeerId, roomId]);

  const nodeById = useMemo(() => {
    return new Map(state.nodes.map((node) => [node.id, node]));
  }, [state.nodes]);

  async function submitOperation(operation: WorkspaceOperationRequest, announce = true) {
    setIsBusy(true);
    try {
      const nextState = await applyWorkspaceRoomOperation(roomId, operation);
      setState(nextState);
      if (announce) {
        setStatusMessage(`Applied ${operation.kind}`);
      }
    } catch (error) {
      setHostError(error instanceof Error ? error.message : "Operation failed");
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
        </div>
        {statusMessage ? <p className="topology-note">{statusMessage}</p> : null}
        {hostError ? <p className="error-text">Host: {hostError}</p> : null}
      </div>

      <div className="infinite-layout">
        <article className="feature-panel">
          <div className="workspace-scroll">
            <div className="workspace-surface" ref={workspaceRef} onMouseDown={handleWorkspaceMouseDown} role="presentation">
              <svg className="workspace-edges" width={workspaceWidth} height={workspaceHeight}>
                {state.edges.map((edge) => {
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

                {state.strokes.map((stroke) => (
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
              </svg>

              {state.assets.map((asset) => (
                <div key={asset.id} className="workspace-asset" style={{ left: asset.x, top: asset.y }}>
                  <strong>{asset.name}</strong>
                  <small>from {asset.updatedBy}</small>
                </div>
              ))}

              {state.annotations.map((annotation) => (
                <div key={annotation.id} className="workspace-note" style={{ left: annotation.x, top: annotation.y }}>
                  <strong>{annotation.text}</strong>
                  <small>{annotation.updatedBy}</small>
                </div>
              ))}

              {state.nodes.map((node) => (
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
            <li>Nodes: {state.nodes.length}</li>
            <li>Edges: {state.edges.length}</li>
            <li>Assets: {state.assets.length}</li>
            <li>Annotations: {state.annotations.length}</li>
            <li>Strokes: {state.strokes.length}</li>
          </ul>

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
