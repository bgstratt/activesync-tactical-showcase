import { useEffect, useMemo, useState } from "react";
import {
  applyTacticalAction,
  connectPeer,
  fetchReplicationEvents,
  fetchReplicationTopology,
  fetchTacticalState
} from "../app/hostClient";
import type { PeerStatus, ReplayEventItem, TacticalBoardState } from "../../../shared/contracts/runtime";

type PixelBrush = "plain" | "wall" | "difficult";

const rows = 12;
const cols = 16;

const fallbackState: TacticalBoardState = {
  rows,
  cols,
  terrain: Array.from({ length: rows }, () => Array.from({ length: cols }, () => "plain")),
  fog: Array.from({ length: rows }, () => Array.from({ length: cols }, () => false)),
  tokens: [],
  pings: [],
  triggerLinks: [],
  turn: 1,
  partitionedPeers: [],
  queuedOps: [],
  updatedAtUtc: new Date().toISOString()
};

export function PixelSandboxPage() {
  const [state, setState] = useState<TacticalBoardState>(fallbackState);
  const [events, setEvents] = useState<ReplayEventItem[]>([]);
  const [peers, setPeers] = useState<PeerStatus[]>([]);
  const [activePeerId, setActivePeerId] = useState("alpha");
  const [brush, setBrush] = useState<PixelBrush>("wall");
  const [brushRadius, setBrushRadius] = useState(1);
  const [burstOps, setBurstOps] = useState(12);
  const [runningBurst, setRunningBurst] = useState(false);
  const [burstSummary, setBurstSummary] = useState<string | null>(null);
  const [hostError, setHostError] = useState<string | null>(null);

  const queueDepth = useMemo(() => state.queuedOps.reduce((sum, item) => sum + item.count, 0), [state.queuedOps]);

  useEffect(() => {
    let isCanceled = false;

    async function refresh() {
      try {
        const [snapshot, replay, topology] = await Promise.all([
          fetchTacticalState(),
          fetchReplicationEvents(200),
          fetchReplicationTopology()
        ]);

        if (!isCanceled) {
          setState(snapshot);
          setPeers(topology.peers);
          const filtered = replay.events.filter(
            (event) => event.stream === "tactical" || event.type === "queued" || event.type === "replay"
          );
          setEvents(filtered);
          setHostError(null);

          if (topology.peers.length > 0 && !topology.peers.some((peer) => peer.peerId === activePeerId)) {
            setActivePeerId(topology.peers[0].peerId);
          }
        }
      } catch (error) {
        if (!isCanceled) {
          setHostError(error instanceof Error ? error.message : "Unable to load pixel sandbox state");
        }
      }
    }

    void refresh();
    const intervalId = window.setInterval(() => {
      void refresh();
    }, 2400);

    return () => {
      isCanceled = true;
      window.clearInterval(intervalId);
    };
  }, [activePeerId]);

  function terrainClass(value: string): string {
    if (value === "wall") {
      return "terrain-wall";
    }

    if (value === "difficult") {
      return "terrain-difficult";
    }

    return "terrain-plain";
  }

  async function paintAt(x: number, y: number) {
    const writes: Array<{ x: number; y: number }> = [];
    for (let dy = -brushRadius; dy <= brushRadius; dy += 1) {
      for (let dx = -brushRadius; dx <= brushRadius; dx += 1) {
        const tx = x + dx;
        const ty = y + dy;
        if (tx >= 0 && ty >= 0 && tx < state.cols && ty < state.rows) {
          writes.push({ x: tx, y: ty });
        }
      }
    }

    for (const cell of writes) {
      await applyTacticalAction({
        action: "terrain",
        actorPeerId: activePeerId,
        x: cell.x,
        y: cell.y,
        value: brush
      });
    }
  }

  async function runBurst() {
    setRunningBurst(true);
    setBurstSummary(null);

    const start = performance.now();
    let writes = 0;

    try {
      for (let i = 0; i < burstOps; i += 1) {
        const x = Math.floor(Math.random() * state.cols);
        const y = Math.floor(Math.random() * state.rows);
        await applyTacticalAction({
          action: "terrain",
          actorPeerId: activePeerId,
          x,
          y,
          value: brush
        });
        writes += 1;
      }

      const elapsed = performance.now() - start;
      const opsPerSec = elapsed <= 0 ? writes : Math.round((writes / elapsed) * 1000);
      setBurstSummary(`Burst complete: ${writes} writes in ${Math.round(elapsed)} ms (${opsPerSec} ops/s)`);
    } catch (error) {
      setHostError(error instanceof Error ? error.message : "Burst failed");
    } finally {
      setRunningBurst(false);
    }
  }

  async function togglePartition(enabled: boolean) {
    try {
      const response = await applyTacticalAction({
        action: "set-partition",
        actorPeerId: activePeerId,
        targetPeerId: activePeerId,
        enabled
      });

      if (!response.ok) {
        setHostError(response.message);
      }
    } catch (error) {
      setHostError(error instanceof Error ? error.message : "Partition update failed");
    }
  }

  async function addPeer() {
    const id = `peer-${Math.floor(Math.random() * 9999)}`;
    try {
      await connectPeer(id);
      setActivePeerId(id);
    } catch (error) {
      setHostError(error instanceof Error ? error.message : "Unable to add peer");
    }
  }

  return (
    <section className="feature-page tactical-page pixel-page">
      <header className="feature-header tactical-header">
        <p className="hero-tag">MODE</p>
        <h1>Pixel Sandbox Stress Mode</h1>
        <p>
          High-frequency terrain painting with burst writes, peer partition toggles, and queue-depth convergence tracking.
        </p>
      </header>

      <div className="tactical-layout">
        <article className="feature-panel tactical-board-panel">
          <div className="tactical-toolbar">
            {hostError && <p className="error-text">Host sync error: {hostError}</p>}
            <div className="tool-group">
              <span>Active Peer</span>
              <select className="peer-select" value={activePeerId} onChange={(event) => setActivePeerId(event.target.value)}>
                {peers.map((peer) => (
                  <option key={peer.peerId} value={peer.peerId}>
                    {peer.peerId} {peer.online ? "(online)" : "(offline)"}
                  </option>
                ))}
              </select>
              <div className="action-row">
                <button type="button" className="action-btn tactical-btn" onClick={() => void addPeer()}>
                  Add Peer
                </button>
                <button
                  type="button"
                  className="action-btn tactical-btn"
                  onClick={() => void togglePartition(true)}
                  disabled={state.partitionedPeers.includes(activePeerId)}
                >
                  Partition Peer
                </button>
                <button
                  type="button"
                  className="action-btn tactical-btn"
                  onClick={() => void togglePartition(false)}
                  disabled={!state.partitionedPeers.includes(activePeerId)}
                >
                  Reconnect Peer
                </button>
              </div>
            </div>

            <div className="tool-group">
              <span>Brush</span>
              <div className="action-row">
                {(["plain", "wall", "difficult"] as PixelBrush[]).map((entry) => (
                  <button
                    key={entry}
                    type="button"
                    className={brush === entry ? "action-btn tactical-btn active" : "action-btn tactical-btn"}
                    onClick={() => setBrush(entry)}
                  >
                    {entry}
                  </button>
                ))}
              </div>
              <div className="peer-row">
                <label>
                  Radius
                  <input
                    className="peer-input"
                    type="number"
                    min={0}
                    max={3}
                    value={brushRadius}
                    onChange={(event) => setBrushRadius(Math.max(0, Math.min(3, Number(event.target.value) || 0)))}
                  />
                </label>
                <label>
                  Burst Ops
                  <input
                    className="peer-input"
                    type="number"
                    min={1}
                    max={120}
                    value={burstOps}
                    onChange={(event) => setBurstOps(Math.max(1, Math.min(120, Number(event.target.value) || 1)))}
                  />
                </label>
                <button type="button" className="action-btn tactical-btn" onClick={() => void runBurst()} disabled={runningBurst}>
                  {runningBurst ? "Running..." : "Run Burst"}
                </button>
              </div>
            </div>

            {burstSummary && <p className="topology-note">{burstSummary}</p>}
          </div>

          <div className="tactical-grid" style={{ gridTemplateColumns: `repeat(${state.cols}, minmax(24px, 1fr))` }}>
            {Array.from({ length: state.rows }).flatMap((_, y) =>
              Array.from({ length: state.cols }).map((__, x) => (
                <button
                  key={`${x}-${y}`}
                  type="button"
                  className={`tactical-cell ${terrainClass(state.terrain[y][x])}`}
                  onClick={() => void paintAt(x, y)}
                  title={`x:${x} y:${y}`}
                  disabled={runningBurst}
                />
              ))
            )}
          </div>
        </article>

        <aside className="telemetry-panel tactical-side-panel">
          <h2>Convergence Pressure</h2>
          <div className="convergence-box">
            <p>
              <strong>Partitioned:</strong> {state.partitionedPeers.length > 0 ? state.partitionedPeers.join(", ") : "none"}
            </p>
            <p>
              <strong>Total Queued:</strong> {queueDepth}
            </p>
            <ul>
              {state.queuedOps.map((entry) => (
                <li key={entry.peerId}>
                  {entry.peerId}: {entry.count}
                </li>
              ))}
              {state.queuedOps.length === 0 ? <li>No queued operations</li> : null}
            </ul>
          </div>

          <h2>Stress Timeline</h2>
          <ul className="ops-list">
            {events.map((event, index) => (
              <li key={`${event.timestampUtc}-${event.type}-${index}`}>
                <span className="ops-meta">
                  {new Date(event.timestampUtc).toLocaleTimeString()} [{event.stream}:{event.type}]
                </span>
                <span>{event.message}</span>
                {event.peerId ? <span className="replay-peer">peer: {event.peerId}</span> : null}
              </li>
            ))}
            {events.length === 0 ? <li className="ops-empty">No stress events yet.</li> : null}
          </ul>
        </aside>
      </div>
    </section>
  );
}
