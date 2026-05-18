import type { ChangeEvent, MouseEvent as ReactMouseEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";

type PeerId = "alpha" | "bravo" | "charlie";
type WorkspaceTool = "select" | "draw" | "annotate";

type WorkspaceOpKind = "add-node" | "move-node" | "add-edge" | "add-asset" | "add-annotation" | "add-stroke";

interface Point {
  x: number;
  y: number;
}

interface WorkspaceNode {
  id: string;
  x: number;
  y: number;
  label: string;
  color: string;
  updatedAt: number;
  updatedBy: PeerId;
}

interface WorkspaceEdge {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  updatedAt: number;
  updatedBy: PeerId;
}

interface WorkspaceAsset {
  id: string;
  x: number;
  y: number;
  name: string;
  updatedAt: number;
  updatedBy: PeerId;
}

interface WorkspaceAnnotation {
  id: string;
  x: number;
  y: number;
  text: string;
  updatedAt: number;
  updatedBy: PeerId;
}

interface WorkspaceStroke {
  id: string;
  points: Point[];
  color: string;
  width: number;
  updatedAt: number;
  updatedBy: PeerId;
}

interface WorkspaceState {
  nodes: Record<string, WorkspaceNode>;
  edges: Record<string, WorkspaceEdge>;
  assets: Record<string, WorkspaceAsset>;
  annotations: Record<string, WorkspaceAnnotation>;
  strokes: Record<string, WorkspaceStroke>;
}

interface WorkspaceOperation {
  id: string;
  kind: WorkspaceOpKind;
  peerId: PeerId;
  timestamp: number;
  payload:
    | { node: WorkspaceNode }
    | { nodeId: string; x: number; y: number }
    | { edge: WorkspaceEdge }
    | { asset: WorkspaceAsset }
    | { annotation: WorkspaceAnnotation }
    | { stroke: WorkspaceStroke };
}

interface PendingCloudTransmission {
  dueAt: number;
  op: WorkspaceOperation;
}

interface PendingPeerDelivery {
  dueAt: number;
  peerId: PeerId;
  op: WorkspaceOperation;
}

interface BranchSnapshot {
  id: string;
  createdAt: number;
  sourceIndex: number;
  state: WorkspaceState;
}

const peers: PeerId[] = ["alpha", "bravo", "charlie"];

const peerColor: Record<PeerId, string> = {
  alpha: "#2563eb",
  bravo: "#16a34a",
  charlie: "#dc2626"
};

const workspaceWidth = 2200;
const workspaceHeight = 1400;

function emptyWorkspace(): WorkspaceState {
  return {
    nodes: {},
    edges: {},
    assets: {},
    annotations: {},
    strokes: {}
  };
}

function makeId(prefix: string): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}-${crypto.randomUUID()}`;
  }

  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
}

function upsertLww<T extends { id: string; updatedAt: number }>(
  map: Record<string, T>,
  item: T,
  timestamp: number
): Record<string, T> {
  const current = map[item.id];
  if (!current || timestamp >= current.updatedAt) {
    return { ...map, [item.id]: { ...item, updatedAt: timestamp } };
  }

  return map;
}

function applyOperation(state: WorkspaceState, op: WorkspaceOperation): WorkspaceState {
  switch (op.kind) {
    case "add-node": {
      const payload = op.payload as { node: WorkspaceNode };
      return {
        ...state,
        nodes: upsertLww(state.nodes, payload.node, op.timestamp)
      };
    }
    case "move-node": {
      const payload = op.payload as { nodeId: string; x: number; y: number };
      const current = state.nodes[payload.nodeId];
      if (!current || op.timestamp < current.updatedAt) {
        return state;
      }

      return {
        ...state,
        nodes: {
          ...state.nodes,
          [payload.nodeId]: {
            ...current,
            x: payload.x,
            y: payload.y,
            updatedAt: op.timestamp,
            updatedBy: op.peerId
          }
        }
      };
    }
    case "add-edge": {
      const payload = op.payload as { edge: WorkspaceEdge };
      return {
        ...state,
        edges: upsertLww(state.edges, payload.edge, op.timestamp)
      };
    }
    case "add-asset": {
      const payload = op.payload as { asset: WorkspaceAsset };
      return {
        ...state,
        assets: upsertLww(state.assets, payload.asset, op.timestamp)
      };
    }
    case "add-annotation": {
      const payload = op.payload as { annotation: WorkspaceAnnotation };
      return {
        ...state,
        annotations: upsertLww(state.annotations, payload.annotation, op.timestamp)
      };
    }
    case "add-stroke": {
      const payload = op.payload as { stroke: WorkspaceStroke };
      return {
        ...state,
        strokes: upsertLww(state.strokes, payload.stroke, op.timestamp)
      };
    }
    default:
      return state;
  }
}

function replayWorkspace(ops: WorkspaceOperation[], count: number): WorkspaceState {
  const capped = Math.max(0, Math.min(count, ops.length));
  let state = emptyWorkspace();
  for (let i = 0; i < capped; i += 1) {
    state = applyOperation(state, ops[i]);
  }

  return state;
}

function stateSignature(state: WorkspaceState): string {
  const nodeSig = Object.values(state.nodes)
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((node) => `${node.id}:${Math.round(node.x)}:${Math.round(node.y)}:${node.updatedAt}`)
    .join("|");
  const edgeSig = Object.values(state.edges)
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((edge) => `${edge.id}:${edge.fromNodeId}:${edge.toNodeId}:${edge.updatedAt}`)
    .join("|");
  const assetSig = Object.values(state.assets)
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((asset) => `${asset.id}:${asset.name}:${Math.round(asset.x)}:${Math.round(asset.y)}:${asset.updatedAt}`)
    .join("|");
  const annotationSig = Object.values(state.annotations)
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((annotation) => `${annotation.id}:${annotation.text}:${Math.round(annotation.x)}:${Math.round(annotation.y)}:${annotation.updatedAt}`)
    .join("|");
  const strokeSig = Object.values(state.strokes)
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((stroke) => `${stroke.id}:${stroke.points.length}:${stroke.updatedAt}`)
    .join("|");

  return `${nodeSig}||${edgeSig}||${assetSig}||${annotationSig}||${strokeSig}`;
}

function randomInRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

export function InfiniteWorkspacePage() {
  const [activePeerId, setActivePeerId] = useState<PeerId>("alpha");
  const [tool, setTool] = useState<WorkspaceTool>("select");
  const [annotationDraft, setAnnotationDraft] = useState("Decision note");
  const [latencyMs, setLatencyMs] = useState(120);
  const [cloudConnected, setCloudConnected] = useState(true);
  const [autoBurst, setAutoBurst] = useState(false);

  const [peerStates, setPeerStates] = useState<Record<PeerId, WorkspaceState>>({
    alpha: emptyWorkspace(),
    bravo: emptyWorkspace(),
    charlie: emptyWorkspace()
  });
  const [cloudState, setCloudState] = useState<WorkspaceState>(emptyWorkspace());
  const [cloudLog, setCloudLog] = useState<WorkspaceOperation[]>([]);
  const [pendingCloudQueue, setPendingCloudQueue] = useState<PendingCloudTransmission[]>([]);
  const [pendingPeerQueue, setPendingPeerQueue] = useState<PendingPeerDelivery[]>([]);

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [replayCursor, setReplayCursor] = useState(0);
  const [followLiveReplay, setFollowLiveReplay] = useState(true);
  const [branches, setBranches] = useState<BranchSnapshot[]>([]);

  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ nodeId: string; offsetX: number; offsetY: number } | null>(null);
  const drawRef = useRef<Point[] | null>(null);

  const liveState = peerStates[activePeerId];
  const replayState = useMemo(() => replayWorkspace(cloudLog, replayCursor), [cloudLog, replayCursor]);
  const displayState = followLiveReplay ? liveState : replayState;

  const cloudQueueDepth = pendingCloudQueue.length;
  const peerDeliveryDepth = pendingPeerQueue.length;

  const convergence = useMemo(() => {
    const cloudSig = stateSignature(cloudState);
    const peerSigs = peers.map((peerId) => ({ peerId, sig: stateSignature(peerStates[peerId]) }));
    const allConverged = peerSigs.every((entry) => entry.sig === cloudSig);
    return {
      allConverged,
      peerDivergence: peerSigs.filter((entry) => entry.sig !== cloudSig).map((entry) => entry.peerId)
    };
  }, [cloudState, peerStates]);

  useEffect(() => {
    if (followLiveReplay) {
      setReplayCursor(cloudLog.length);
    }
  }, [cloudLog.length, followLiveReplay]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      if (!cloudConnected) {
        return;
      }

      const now = Date.now();

      setPendingCloudQueue((prevCloud) => {
        const due = prevCloud.filter((item) => item.dueAt <= now);
        if (due.length === 0) {
          return prevCloud;
        }

        const remaining = prevCloud.filter((item) => item.dueAt > now);

        setCloudState((previousCloudState) => {
          let next = previousCloudState;
          for (const item of due) {
            next = applyOperation(next, item.op);
          }

          return next;
        });

        setCloudLog((previousLog) => [...previousLog, ...due.map((item) => item.op)]);

        setPendingPeerQueue((previousPeerQueue) => {
          const additions: PendingPeerDelivery[] = [];
          for (const item of due) {
            for (const peerId of peers) {
              if (peerId === item.op.peerId) {
                continue;
              }

              additions.push({
                dueAt: now + latencyMs,
                peerId,
                op: item.op
              });
            }
          }

          return [...previousPeerQueue, ...additions];
        });

        return remaining;
      });

      setPendingPeerQueue((prevPeerDeliveries) => {
        const due = prevPeerDeliveries.filter((item) => item.dueAt <= now);
        if (due.length === 0) {
          return prevPeerDeliveries;
        }

        const remaining = prevPeerDeliveries.filter((item) => item.dueAt > now);

        setPeerStates((previousPeerStates) => {
          let next = previousPeerStates;
          for (const delivery of due) {
            next = {
              ...next,
              [delivery.peerId]: applyOperation(next[delivery.peerId], delivery.op)
            };
          }

          return next;
        });

        return remaining;
      });
    }, 100);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [cloudConnected, latencyMs]);

  useEffect(() => {
    if (!autoBurst) {
      return;
    }

    const intervalId = window.setInterval(() => {
      const peerId = peers[Math.floor(Math.random() * peers.length)];
      const nodeOp = makeAddNodeOp(peerId, randomInRange(180, workspaceWidth - 200), randomInRange(140, workspaceHeight - 160));
      submitLocalOperation(nodeOp);
    }, 650);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [autoBurst]);

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
        const op = makeMoveNodeOp(activePeerId, dragRef.current.nodeId, x - dragRef.current.offsetX, y - dragRef.current.offsetY);
        submitLocalOperation(op);
      }

      if (drawRef.current) {
        drawRef.current = [...drawRef.current, { x, y }];
      }
    }

    function onPointerUp() {
      dragRef.current = null;

      const points = drawRef.current;
      if (points && points.length > 1) {
        submitLocalOperation(makeStrokeOp(activePeerId, points));
      }

      drawRef.current = null;
    }

    window.addEventListener("mousemove", onPointerMove);
    window.addEventListener("mouseup", onPointerUp);

    return () => {
      window.removeEventListener("mousemove", onPointerMove);
      window.removeEventListener("mouseup", onPointerUp);
    };
  }, [activePeerId]);

  function submitLocalOperation(op: WorkspaceOperation): void {
    setPeerStates((previousPeerStates) => ({
      ...previousPeerStates,
      [op.peerId]: applyOperation(previousPeerStates[op.peerId], op)
    }));

    setPendingCloudQueue((previousCloudQueue) => [...previousCloudQueue, { dueAt: Date.now() + latencyMs, op }]);
  }

  function makeAddNodeOp(peerId: PeerId, x: number, y: number): WorkspaceOperation {
    const timestamp = Date.now();
    const node: WorkspaceNode = {
      id: makeId("node"),
      x,
      y,
      label: `Node ${Object.keys(peerStates[peerId].nodes).length + 1}`,
      color: peerColor[peerId],
      updatedAt: timestamp,
      updatedBy: peerId
    };

    return {
      id: makeId("op"),
      kind: "add-node",
      peerId,
      timestamp,
      payload: { node }
    };
  }

  function makeMoveNodeOp(peerId: PeerId, nodeId: string, x: number, y: number): WorkspaceOperation {
    const timestamp = Date.now();
    return {
      id: makeId("op"),
      kind: "move-node",
      peerId,
      timestamp,
      payload: { nodeId, x, y }
    };
  }

  function makeEdgeOp(peerId: PeerId, fromNodeId: string, toNodeId: string): WorkspaceOperation {
    const timestamp = Date.now();
    const edge: WorkspaceEdge = {
      id: `edge:${fromNodeId}:${toNodeId}`,
      fromNodeId,
      toNodeId,
      updatedAt: timestamp,
      updatedBy: peerId
    };

    return {
      id: makeId("op"),
      kind: "add-edge",
      peerId,
      timestamp,
      payload: { edge }
    };
  }

  function makeAssetOp(peerId: PeerId, fileName: string): WorkspaceOperation {
    const timestamp = Date.now();
    const asset: WorkspaceAsset = {
      id: makeId("asset"),
      name: fileName,
      x: randomInRange(180, workspaceWidth - 230),
      y: randomInRange(140, workspaceHeight - 180),
      updatedAt: timestamp,
      updatedBy: peerId
    };

    return {
      id: makeId("op"),
      kind: "add-asset",
      peerId,
      timestamp,
      payload: { asset }
    };
  }

  function makeAnnotationOp(peerId: PeerId, x: number, y: number, text: string): WorkspaceOperation {
    const timestamp = Date.now();
    const annotation: WorkspaceAnnotation = {
      id: makeId("note"),
      x,
      y,
      text,
      updatedAt: timestamp,
      updatedBy: peerId
    };

    return {
      id: makeId("op"),
      kind: "add-annotation",
      peerId,
      timestamp,
      payload: { annotation }
    };
  }

  function makeStrokeOp(peerId: PeerId, points: Point[]): WorkspaceOperation {
    const timestamp = Date.now();
    const stroke: WorkspaceStroke = {
      id: makeId("stroke"),
      points,
      color: peerColor[peerId],
      width: 3,
      updatedAt: timestamp,
      updatedBy: peerId
    };

    return {
      id: makeId("op"),
      kind: "add-stroke",
      peerId,
      timestamp,
      payload: { stroke }
    };
  }

  function handleWorkspaceMouseDown(event: ReactMouseEvent<HTMLDivElement>): void {
    const workspace = workspaceRef.current;
    if (!workspace) {
      return;
    }

    const rect = workspace.getBoundingClientRect();
    const x = Math.max(0, Math.min(workspaceWidth, event.clientX - rect.left));
    const y = Math.max(0, Math.min(workspaceHeight, event.clientY - rect.top));

    if (tool === "annotate") {
      submitLocalOperation(makeAnnotationOp(activePeerId, x, y, annotationDraft.trim() || "Untitled note"));
      return;
    }

    if (tool === "draw") {
      drawRef.current = [{ x, y }];
    }
  }

  function handleNodeMouseDown(event: ReactMouseEvent<HTMLDivElement>, nodeId: string): void {
    event.stopPropagation();

    const node = displayState.nodes[nodeId];
    if (!node) {
      return;
    }

    if (tool !== "select") {
      return;
    }

    if (event.shiftKey && selectedNodeId && selectedNodeId !== nodeId) {
      submitLocalOperation(makeEdgeOp(activePeerId, selectedNodeId, nodeId));
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

  function handleAssetUpload(event: ChangeEvent<HTMLInputElement>): void {
    const files = Array.from(event.target.files ?? []);
    for (const file of files) {
      submitLocalOperation(makeAssetOp(activePeerId, file.name));
    }

    event.currentTarget.value = "";
  }

  function handleForkFromReplay(): void {
    const state = replayWorkspace(cloudLog, replayCursor);
    setBranches((previous) => [
      {
        id: makeId("branch"),
        createdAt: Date.now(),
        sourceIndex: replayCursor,
        state
      },
      ...previous
    ]);
  }

  const sortedEdges = Object.values(displayState.edges);
  const sortedNodes = Object.values(displayState.nodes);
  const sortedAssets = Object.values(displayState.assets);
  const sortedAnnotations = Object.values(displayState.annotations);
  const sortedStrokes = Object.values(displayState.strokes);

  return (
    <section className="feature-page infinite-workspace-page">
      <header className="feature-header tactical-header">
        <p className="hero-tag">KILLER DEMO</p>
        <h1>Infinite Multiplayer Workspace</h1>
        <p>
          Collaborative canvas with nodes, assets, systems, freehand drawing, annotations, branching, and replay. Simulate 2000ms latency and cloud
          disconnect while keeping local edits instant.
        </p>
        <p className="topology-note">
          Sequence: multi-peer edit burst, then set 2000ms latency, disconnect cloud, diverge edits, reconnect, and scrub replay timeline.
        </p>
      </header>

      <div className="infinite-controls feature-panel">
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
          <button type="button" className="action-btn tactical-btn" onClick={() => submitLocalOperation(makeAddNodeOp(activePeerId, 360, 260))}>
            Add Node
          </button>
          <label className="action-btn tactical-btn upload-btn">
            Upload Asset
            <input type="file" onChange={handleAssetUpload} multiple />
          </label>
          <button type="button" className="action-btn tactical-btn" onClick={() => setAutoBurst((value) => !value)}>
            {autoBurst ? "Stop Multi-Peer Burst" : "Start Multi-Peer Burst"}
          </button>
          <button type="button" className="action-btn tactical-btn" onClick={() => setLatencyMs(2000)}>
            Set 2000ms Latency
          </button>
          <button type="button" className="action-btn tactical-btn" onClick={() => setLatencyMs(120)}>
            Set 120ms Latency
          </button>
          <button type="button" className="action-btn tactical-btn" onClick={() => setCloudConnected((value) => !value)}>
            {cloudConnected ? "Disconnect Cloud" : "Reconnect Cloud"}
          </button>
        </div>
      </div>

      <div className="infinite-layout">
        <article className="feature-panel">
          <div className="workspace-scroll">
            <div className="workspace-surface" ref={workspaceRef} onMouseDown={handleWorkspaceMouseDown} role="presentation">
              <svg className="workspace-edges" width={workspaceWidth} height={workspaceHeight}>
                {sortedEdges.map((edge) => {
                  const from = displayState.nodes[edge.fromNodeId];
                  const to = displayState.nodes[edge.toNodeId];
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

                {sortedStrokes.map((stroke) => (
                  <polyline
                    key={stroke.id}
                    fill="none"
                    stroke={stroke.color}
                    strokeOpacity={0.75}
                    strokeWidth={stroke.width}
                    points={stroke.points.map((point) => `${point.x},${point.y}`).join(" ")}
                  />
                ))}
              </svg>

              {sortedAssets.map((asset) => (
                <div key={asset.id} className="workspace-asset" style={{ left: asset.x, top: asset.y }}>
                  <strong>{asset.name}</strong>
                  <small>from {asset.updatedBy}</small>
                </div>
              ))}

              {sortedAnnotations.map((annotation) => (
                <div key={annotation.id} className="workspace-note" style={{ left: annotation.x, top: annotation.y }}>
                  <strong>{annotation.text}</strong>
                  <small>{annotation.updatedBy}</small>
                </div>
              ))}

              {sortedNodes.map((node) => (
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
          <h2>Live State</h2>
          <ul>
            <li>Cloud: {cloudConnected ? "connected" : "disconnected"}</li>
            <li>Simulated latency: {latencyMs} ms</li>
            <li>Cloud queue: {cloudQueueDepth}</li>
            <li>Peer delivery queue: {peerDeliveryDepth}</li>
            <li>Ops in cloud log: {cloudLog.length}</li>
            <li>Convergence: {convergence.allConverged ? "converged" : `diverged (${convergence.peerDivergence.join(", ")})`}</li>
          </ul>

          <h2>Peer Snapshots</h2>
          <ul className="ops-list">
            {peers.map((peerId) => {
              const state = peerStates[peerId];
              return (
                <li key={peerId}>
                  <span className="ops-meta">{peerId}</span>
                  <span>
                    nodes {Object.keys(state.nodes).length} | edges {Object.keys(state.edges).length} | notes {Object.keys(state.annotations).length}
                  </span>
                </li>
              );
            })}
          </ul>

          <h2>Replay Timeline</h2>
          <div className="tool-group">
            <input
              type="range"
              min={0}
              max={cloudLog.length}
              value={replayCursor}
              onChange={(event) => {
                setReplayCursor(Number(event.target.value));
                setFollowLiveReplay(false);
              }}
            />
            <p className="topology-note">
              Cursor {replayCursor} / {cloudLog.length} {followLiveReplay ? "(live)" : "(replay)"}
            </p>
            <div className="action-row">
              <button
                type="button"
                className="action-btn tactical-btn"
                onClick={() => {
                  setFollowLiveReplay(true);
                  setReplayCursor(cloudLog.length);
                }}
              >
                Jump Live
              </button>
              <button type="button" className="action-btn tactical-btn" onClick={handleForkFromReplay}>
                Fork From Cursor
              </button>
            </div>
          </div>

          <h2>Forks</h2>
          <ul className="ops-list">
            {branches.map((branch) => (
              <li key={branch.id}>
                <span className="ops-meta">{new Date(branch.createdAt).toLocaleTimeString()}</span>
                <span>
                  from op #{branch.sourceIndex} | nodes {Object.keys(branch.state.nodes).length} | edges {Object.keys(branch.state.edges).length}
                </span>
              </li>
            ))}
            {branches.length === 0 ? <li className="ops-empty">No forks yet.</li> : null}
          </ul>
        </aside>
      </div>

      <section className="feature-panel">
        <h2>Cloud Operation Feed</h2>
        <ul className="ops-list replay-stream-list">
          {[...cloudLog].reverse().slice(0, 80).map((op) => (
            <li key={op.id}>
              <span className="ops-meta">
                {new Date(op.timestamp).toLocaleTimeString()} [{op.peerId}] {op.kind}
              </span>
              <span>{operationSummary(op)}</span>
            </li>
          ))}
          {cloudLog.length === 0 ? <li className="ops-empty">No cloud operations yet. Start with Add Node or Multi-Peer Burst.</li> : null}
        </ul>
      </section>
    </section>
  );
}

function operationSummary(op: WorkspaceOperation): string {
  if (op.kind === "add-node") {
    const payload = op.payload as { node: WorkspaceNode };
    return `Added ${payload.node.label}`;
  }

  if (op.kind === "move-node") {
    const payload = op.payload as { nodeId: string; x: number; y: number };
    return `Moved ${payload.nodeId} to (${Math.round(payload.x)},${Math.round(payload.y)})`;
  }

  if (op.kind === "add-edge") {
    const payload = op.payload as { edge: WorkspaceEdge };
    return `Connected ${payload.edge.fromNodeId} -> ${payload.edge.toNodeId}`;
  }

  if (op.kind === "add-asset") {
    const payload = op.payload as { asset: WorkspaceAsset };
    return `Uploaded ${payload.asset.name}`;
  }

  if (op.kind === "add-annotation") {
    const payload = op.payload as { annotation: WorkspaceAnnotation };
    return `Annotated: ${payload.annotation.text}`;
  }

  const payload = op.payload as { stroke: WorkspaceStroke };
  return `Stroke with ${payload.stroke.points.length} points`;
}
