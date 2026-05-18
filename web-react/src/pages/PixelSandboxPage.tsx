import { useEffect, useMemo, useRef, useState } from "react";
import {
  applyTacticalAction,
  connectPeer,
  fetchReplicationEvents,
  fetchReplicationTopology,
  fetchTacticalState,
  runDemoScenario
} from "../app/hostClient";
import {
  clearScenarioHistory,
  compareRecentScenarioRuns,
  loadScenarioHistory,
  recordScenarioRun,
  type ScenarioHistoryEntry
} from "../app/scenarioHistory";
import type { DemoScenarioRunResponse, PeerStatus, ReplayEventItem, TacticalBoardState } from "../../../shared/contracts/runtime";

type PixelBrush = "plain" | "wall" | "difficult";

interface BurstSample {
  id: number;
  timestampUtc: string;
  latencyMs: number;
  writeCount: number;
  opsPerSec: number;
  queueDrainMs: number | null;
}

interface PendingDrainMeasurement {
  sampleId: number;
  baselineQueueDepth: number;
  startedAtMs: number;
}

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
  const [burstSamples, setBurstSamples] = useState<BurstSample[]>([]);
  const [scenarioResult, setScenarioResult] = useState<DemoScenarioRunResponse | null>(null);
  const [scenarioHistory, setScenarioHistory] = useState<ScenarioHistoryEntry[]>(() => loadScenarioHistory("pixel"));
  const scenarioComparison = compareRecentScenarioRuns(scenarioHistory);
  const [pendingDrain, setPendingDrain] = useState<PendingDrainMeasurement | null>(null);
  const nextSampleId = useRef(1);

  const queueDepth = useMemo(() => state.queuedOps.reduce((sum, item) => sum + item.count, 0), [state.queuedOps]);

  const latencyP50 = useMemo(() => percentile(burstSamples.map((item) => item.latencyMs), 50), [burstSamples]);
  const latencyP95 = useMemo(() => percentile(burstSamples.map((item) => item.latencyMs), 95), [burstSamples]);
  const drainSamples = useMemo(
    () => burstSamples.filter((sample) => sample.queueDrainMs !== null).map((sample) => sample.queueDrainMs as number),
    [burstSamples]
  );
  const drainP50 = useMemo(() => percentile(drainSamples, 50), [drainSamples]);
  const drainP95 = useMemo(() => percentile(drainSamples, 95), [drainSamples]);

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
          const nextQueueDepth = snapshot.queuedOps.reduce((sum, item) => sum + item.count, 0);
          const filtered = replay.events.filter(
            (event) => event.stream === "tactical" || event.type === "queued" || event.type === "replay"
          );
          setEvents(filtered);
          setHostError(null);

          if (pendingDrain && nextQueueDepth <= pendingDrain.baselineQueueDepth) {
            const drainMs = Math.round(performance.now() - pendingDrain.startedAtMs);
            setBurstSamples((previous) =>
              previous.map((entry) => (entry.id === pendingDrain.sampleId ? { ...entry, queueDrainMs: drainMs } : entry))
            );
            setPendingDrain(null);
          }

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
  }, [activePeerId, pendingDrain]);

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

    await applyTacticalAction({
      action: "terrain-batch",
      actorPeerId: activePeerId,
      value: brush,
      cells: writes
    });
  }

  async function runBurst() {
    setRunningBurst(true);
    setBurstSummary(null);

    const start = performance.now();
    let writeCount = 0;

    try {
      const batchWrites: Array<{ x: number; y: number }> = [];
      for (let i = 0; i < burstOps; i += 1) {
        const x = Math.floor(Math.random() * state.cols);
        const y = Math.floor(Math.random() * state.rows);
        batchWrites.push({ x, y });
      }

      const baselineQueueDepth = queueDepth;
      const response = await applyTacticalAction({
        action: "terrain-batch",
        actorPeerId: activePeerId,
        value: brush,
        cells: batchWrites
      });
      setState(response.state);
      writeCount = batchWrites.length;

      const elapsed = performance.now() - start;
      const opsPerSec = elapsed <= 0 ? writeCount : Math.round((writeCount / elapsed) * 1000);

      const sampleId = nextSampleId.current;
      nextSampleId.current += 1;
      const afterSubmitQueueDepth = response.state.queuedOps.reduce((sum, item) => sum + item.count, 0);
      const shouldMeasureDrain = afterSubmitQueueDepth > baselineQueueDepth;
      const sample: BurstSample = {
        id: sampleId,
        timestampUtc: new Date().toISOString(),
        latencyMs: Math.round(elapsed),
        writeCount,
        opsPerSec,
        queueDrainMs: shouldMeasureDrain ? null : 0
      };

      setBurstSamples((previous) => [sample, ...previous].slice(0, 20));
      if (shouldMeasureDrain) {
        setPendingDrain({
          sampleId,
          baselineQueueDepth,
          startedAtMs: performance.now()
        });
      }

      setBurstSummary(`Burst complete: ${writeCount} writes in ${Math.round(elapsed)} ms (${opsPerSec} ops/s)`);
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

  async function runScenario() {
    setRunningBurst(true);
    try {
      const result = await runDemoScenario("pixel.burst-partition");
      setScenarioResult(result);
      setScenarioHistory(recordScenarioRun("pixel", result));
      const [snapshot, replay, topology] = await Promise.all([
        fetchTacticalState(),
        fetchReplicationEvents(200),
        fetchReplicationTopology()
      ]);
      setState(snapshot);
      setPeers(topology.peers);
      setEvents(replay.events.filter((event) => event.stream === "tactical" || event.type === "queued" || event.type === "replay"));
      setBurstSummary(result.message);
      setHostError(null);
    } catch (error) {
      setHostError(error instanceof Error ? error.message : "Unable to run pixel scenario");
    } finally {
      setRunningBurst(false);
    }
  }

  function handleClearScenarioHistory() {
    clearScenarioHistory("pixel");
    setScenarioHistory([]);
  }

  function clearBenchmarks() {
    setBurstSamples([]);
    setPendingDrain(null);
    setBurstSummary("Benchmark samples cleared");
  }

  function exportBenchmarksJson() {
    if (burstSamples.length === 0) {
      setBurstSummary("No benchmark samples to export");
      return;
    }

    const payload = JSON.stringify(
      {
        exportedAtUtc: new Date().toISOString(),
        activePeerId,
        brush,
        brushRadius,
        burstOps,
        samples: burstSamples
      },
      null,
      2
    );

    downloadTextFile(`pixel-benchmark-${Date.now()}.json`, payload, "application/json;charset=utf-8");
    setBurstSummary(`Exported ${burstSamples.length} benchmark samples as JSON`);
  }

  function exportBenchmarksCsv() {
    if (burstSamples.length === 0) {
      setBurstSummary("No benchmark samples to export");
      return;
    }

    const header = "id,timestampUtc,latencyMs,writeCount,opsPerSec,queueDrainMs";
    const rows = burstSamples.map((sample) =>
      [
        sample.id,
        sample.timestampUtc,
        sample.latencyMs,
        sample.writeCount,
        sample.opsPerSec,
        sample.queueDrainMs === null ? "" : sample.queueDrainMs
      ].join(",")
    );

    const csv = [header, ...rows].join("\n");
    downloadTextFile(`pixel-benchmark-${Date.now()}.csv`, csv, "text/csv;charset=utf-8");
    setBurstSummary(`Exported ${burstSamples.length} benchmark samples as CSV`);
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
                <button type="button" className="action-btn tactical-btn" onClick={() => void runScenario()} disabled={runningBurst}>
                  Run Scenario
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

          <h2>Burst Benchmark</h2>
          <div className="benchmark-box">
            <div className="benchmark-actions">
              <button type="button" className="action-btn tactical-btn" onClick={exportBenchmarksJson}>
                Export JSON
              </button>
              <button type="button" className="action-btn tactical-btn" onClick={exportBenchmarksCsv}>
                Export CSV
              </button>
              <button type="button" className="action-btn tactical-btn" onClick={clearBenchmarks}>
                Clear
              </button>
            </div>
            <div className="benchmark-grid">
              <div>
                <strong>Latency p50</strong>
                <span>{latencyP50 === null ? "n/a" : `${latencyP50} ms`}</span>
              </div>
              <div>
                <strong>Latency p95</strong>
                <span>{latencyP95 === null ? "n/a" : `${latencyP95} ms`}</span>
              </div>
              <div>
                <strong>Drain p50</strong>
                <span>{drainP50 === null ? "n/a" : `${drainP50} ms`}</span>
              </div>
              <div>
                <strong>Drain p95</strong>
                <span>{drainP95 === null ? "n/a" : `${drainP95} ms`}</span>
              </div>
            </div>
            <ul className="benchmark-list">
              {burstSamples.map((sample) => (
                <li key={sample.id}>
                  <span>{new Date(sample.timestampUtc).toLocaleTimeString()}</span>
                  <span>
                    {sample.writeCount} ops, {sample.latencyMs} ms, {sample.opsPerSec} ops/s, drain{" "}
                    {sample.queueDrainMs === null ? "pending" : `${sample.queueDrainMs} ms`}
                  </span>
                </li>
              ))}
              {burstSamples.length === 0 ? <li>No burst samples yet.</li> : null}
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

          {scenarioResult ? (
            <>
              <h2>Scenario Results</h2>
              <div className="scenario-results">
                <p className="topology-note">
                  {scenarioResult.assertions.filter((item) => item.passed).length}/{scenarioResult.assertions.length} assertions passed
                </p>
                <ul className="ops-list">
                  {scenarioResult.assertions.map((item, index) => (
                    <li key={`${item.name}-${index}`} className={item.passed ? "scenario-pass" : "scenario-fail"}>
                      <span className="ops-meta">{item.passed ? "PASS" : "FAIL"}</span>
                      <span>{item.name}</span>
                      <small>
                        expected: {item.expected} | actual: {item.actual}
                      </small>
                    </li>
                  ))}
                </ul>
              </div>
            </>
          ) : null}

          {scenarioHistory.length > 0 ? (
            <>
              <h2>Recent Runs</h2>
              {scenarioComparison ? (
                <div className="scenario-compare">
                  <span
                    className={`scenario-compare-badge ${
                      scenarioComparison.isRegression
                        ? "scenario-compare-badge-regression"
                        : scenarioComparison.isImprovement
                          ? "scenario-compare-badge-improvement"
                          : "scenario-compare-badge-stable"
                    }`}
                  >
                    {scenarioComparison.isRegression ? "Regression" : scenarioComparison.isImprovement ? "Improved" : "Stable"}
                  </span>
                  <p className="topology-note">Compare: {scenarioComparison.summary}</p>
                </div>
              ) : null}
              <div className="action-row">
                <button type="button" className="action-btn tactical-btn" onClick={handleClearScenarioHistory} disabled={runningBurst}>
                  Clear History
                </button>
              </div>
              <ul className="ops-list">
                {scenarioHistory.map((entry, index) => (
                  <li key={`${entry.completedAtUtc}-${index}`}>
                    <span className="ops-meta">
                      {new Date(entry.completedAtUtc).toLocaleString()} [{entry.scenarioId}] build {entry.buildRef}
                    </span>
                    <span>
                      {entry.passed}/{entry.total} assertions passed | {entry.ok ? "ok" : "failed"}
                    </span>
                    <small>{entry.message}</small>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </aside>
      </div>
    </section>
  );
}

function downloadTextFile(fileName: string, content: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  const bounded = Math.max(0, Math.min(sorted.length - 1, idx));
  return sorted[bounded];
}
