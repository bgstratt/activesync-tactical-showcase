import { useEffect, useState } from "react";
import {
  applyTacticalAction,
  connectPeer,
  disconnectPeer,
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
import type {
  DemoScenarioRunResponse,
  PeerStatus,
  ReplayEventItem,
  TacticalActionRequest,
  TacticalBoardState,
  TacticalToken
} from "../../../shared/contracts/runtime";

type TerrainType = "plain" | "wall" | "difficult";
type ToolMode = "terrain" | "fog" | "token" | "ping" | "erase";
type TokenTeam = "blue" | "red";

const rows = 12;
const cols = 16;
const terrainPalette: TerrainType[] = ["plain", "wall", "difficult"];

const fallbackState: TacticalBoardState = {
  rows,
  cols,
  terrain: Array.from({ length: rows }, () => Array.from({ length: cols }, () => "plain")),
  fog: Array.from({ length: rows }, () => Array.from({ length: cols }, () => false)),
  tokens: [],
  pings: [],
  turn: 1,
  partitionedPeers: [],
  queuedOps: [],
  updatedAtUtc: new Date().toISOString(),
  triggerLinks: []
};

export function TacticalStrategyPage() {
  const [state, setState] = useState<TacticalBoardState>(fallbackState);
  const [activePeerId, setActivePeerId] = useState("alpha");
  const [tool, setTool] = useState<ToolMode>("terrain");
  const [selectedTerrain, setSelectedTerrain] = useState<TerrainType>("wall");
  const [selectedTokenId, setSelectedTokenId] = useState<string | null>(null);
  const [replayOps, setReplayOps] = useState<ReplayEventItem[]>([]);
  const [onlinePeers, setOnlinePeers] = useState<PeerStatus[]>([]);
  const [peerDraft, setPeerDraft] = useState("charlie");
  const [peerMessage, setPeerMessage] = useState<string | null>(null);
  const [hostError, setHostError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [scenarioResult, setScenarioResult] = useState<DemoScenarioRunResponse | null>(null);
  const [scenarioHistory, setScenarioHistory] = useState<ScenarioHistoryEntry[]>(() => loadScenarioHistory("tactical"));
  const scenarioComparison = compareRecentScenarioRuns(scenarioHistory);

  async function refreshRuntimeViews() {
    const [replay, topology] = await Promise.all([fetchReplicationEvents(80), fetchReplicationTopology()]);
    const tacticalEvents = replay.events.filter((event) => event.stream === "tactical" || event.stream === "command");
    setReplayOps(tacticalEvents);
    setOnlinePeers(topology.peers);
  }

  useEffect(() => {
    let isCanceled = false;

    async function loadState() {
      try {
        const [snapshot, replay, topology] = await Promise.all([
          fetchTacticalState(),
          fetchReplicationEvents(80),
          fetchReplicationTopology()
        ]);
        if (!isCanceled) {
          setState(snapshot);
          setHostError(null);
          const tacticalEvents = replay.events.filter((event) => event.stream === "tactical" || event.stream === "command");
          setReplayOps(tacticalEvents);
          setOnlinePeers(topology.peers);
          if (snapshot.tokens.length > 0) {
            setSelectedTokenId(snapshot.tokens[0].id);
          }

          if (topology.peers.length > 0 && !topology.peers.some((peer) => peer.peerId === activePeerId)) {
            setActivePeerId(topology.peers[0].peerId);
          }
        }
      } catch (error) {
        if (!isCanceled) {
          setHostError(error instanceof Error ? error.message : "Unable to load host tactical state");
        }
      }
    }

    void loadState();
    const intervalId = window.setInterval(() => {
      void loadState();
    }, 3500);

    return () => {
      isCanceled = true;
      window.clearInterval(intervalId);
    };
  }, []);

  async function dispatchAction(action: TacticalActionRequest) {
    setIsBusy(true);
    try {
      const result = await applyTacticalAction({
        actorPeerId: activePeerId,
        ...action
      });
      setState(result.state);
      setHostError(result.ok ? null : result.message);
      await refreshRuntimeViews();
    } catch (error) {
      setHostError(error instanceof Error ? error.message : "Host tactical action failed");
    } finally {
      setIsBusy(false);
    }
  }

  async function handlePeerConnect() {
    const peerId = peerDraft.trim();
    if (!peerId) {
      setPeerMessage("Enter a peer id first");
      return;
    }

    setIsBusy(true);
    try {
      const response = await connectPeer(peerId);
      setPeerMessage(response.message);
      setActivePeerId(peerId);
      await refreshRuntimeViews();
    } catch (error) {
      setPeerMessage(error instanceof Error ? error.message : "Peer connect failed");
    } finally {
      setIsBusy(false);
    }
  }

  async function handlePeerDisconnect(peerId: string) {
    setIsBusy(true);
    try {
      const response = await disconnectPeer(peerId);
      setPeerMessage(response.message);
      await refreshRuntimeViews();
    } catch (error) {
      setPeerMessage(error instanceof Error ? error.message : "Peer disconnect failed");
    } finally {
      setIsBusy(false);
    }
  }

  async function handlePartitionToggle(enabled: boolean) {
    setIsBusy(true);
    try {
      const response = await applyTacticalAction({
        action: "set-partition",
        actorPeerId: activePeerId,
        targetPeerId: activePeerId,
        enabled
      });
      setState(response.state);
      setPeerMessage(response.message);
      await refreshRuntimeViews();
    } catch (error) {
      setPeerMessage(error instanceof Error ? error.message : "Unable to update partition state");
    } finally {
      setIsBusy(false);
    }
  }


  function handleClearScenarioHistory() {
    clearScenarioHistory("tactical");
    setScenarioHistory([]);
  }
  async function handleRunScenario() {
  
    setIsBusy(true);
    try {
      const result = await runDemoScenario("tactical.partition-replay");
      setPeerMessage(result.message);
      setScenarioResult(result);
      setScenarioHistory(recordScenarioRun("tactical", result));
      const snapshot = await fetchTacticalState();
      setState(snapshot);
      await refreshRuntimeViews();
    } catch (error) {
      setPeerMessage(error instanceof Error ? error.message : "Unable to run tactical scenario");
    } finally {
      setIsBusy(false);
    }
  }

  function clearBoard() {
    void dispatchAction({ action: "reset" });
  }

  function tokenAt(x: number, y: number): TacticalToken | undefined {
    return state.tokens.find((token) => token.x === x && token.y === y);
  }

  function applyCellAction(x: number, y: number) {
    if (tool === "terrain") {
      void dispatchAction({ action: "terrain", x, y, value: selectedTerrain });
      return;
    }

    if (tool === "fog") {
      void dispatchAction({ action: "fog", x, y });
      return;
    }

    if (tool === "ping") {
      void dispatchAction({ action: "ping", x, y, label: `Ping ${x},${y}` });
      return;
    }

    if (tool === "erase") {
      void dispatchAction({ action: "erase", x, y });
      return;
    }

    const occupant = tokenAt(x, y);
    if (occupant) {
      setSelectedTokenId(occupant.id);
      return;
    }

    if (!selectedTokenId) {
      setHostError("No token selected for movement");
      return;
    }

    void dispatchAction({ action: "token-move", x, y, tokenId: selectedTokenId });
  }

  function addToken(team: TokenTeam) {
    void dispatchAction({ action: "token-add", team });
  }

  function advanceTurn() {
    void dispatchAction({ action: "advance-turn" });
  }

  return (
    <section className="feature-page tactical-page">
      <header className="feature-header tactical-header">
        <p className="hero-tag">MODE</p>
        <h1>Tactical Strategy Vertical Slice</h1>
        <p>
          Collaborative battle-planning sandbox with editable terrain, fog-of-war, synchronized token-style entities, and a replay-friendly runtime
          operation timeline.
        </p>
        <p className="topology-note">
          Controls: Tool selects what clicks do. Terrain choice only applies when Tool is terrain. Token tool moves selected unit. Advance Turn increments
          shared initiative. Run Scenario executes a deterministic partition/replay script.
        </p>
      </header>

      <div className="tactical-layout">
        <article className="feature-panel tactical-board-panel">
          <div className="tactical-toolbar">
            {hostError && <p className="error-text">Host sync error: {hostError}</p>}
            <div className="tool-group">
              <span>Tool</span>
              <div className="action-row">
                {(["terrain", "fog", "token", "ping", "erase"] as ToolMode[]).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    className={tool === mode ? "action-btn tactical-btn active" : "action-btn tactical-btn"}
                    onClick={() => setTool(mode)}
                  >
                    {mode}
                  </button>
                ))}
              </div>
            </div>

            <div className="tool-group">
              <span>Terrain</span>
              <div className="action-row">
                {terrainPalette.map((terrainType) => (
                  <button
                    key={terrainType}
                    type="button"
                    className={selectedTerrain === terrainType ? "action-btn tactical-btn active" : "action-btn tactical-btn"}
                    onClick={() => setSelectedTerrain(terrainType)}
                  >
                    {terrainType}
                  </button>
                ))}
              </div>
            </div>

            <div className="action-row">
              <button type="button" className="action-btn tactical-btn" onClick={advanceTurn}>
                Advance Turn ({state.turn})
              </button>
              <button type="button" className="action-btn tactical-btn" onClick={() => void handleRunScenario()} disabled={isBusy}>
                Run Scenario
              </button>
              <button type="button" className="action-btn tactical-btn" onClick={clearBoard}>
                Reset Board
              </button>
            </div>
          </div>

          <div className="tactical-grid" style={{ gridTemplateColumns: `repeat(${state.cols}, minmax(24px, 1fr))` }}>
            {Array.from({ length: state.rows }).flatMap((_, y) =>
              Array.from({ length: state.cols }).map((__, x) => {
                const occupant = tokenAt(x, y);
                const terrainType = state.terrain[y][x];
                const isFogged = state.fog[y][x];
                const hasPing = state.pings.some((ping) => ping.x === x && ping.y === y);
                const terrainClass = `terrain-${terrainType}`;

                return (
                  <button
                    key={`${x}-${y}`}
                    type="button"
                    className={`tactical-cell ${terrainClass} ${isFogged ? "is-fogged" : ""} ${hasPing ? "has-ping" : ""}`}
                    onClick={() => applyCellAction(x, y)}
                    title={`x:${x} y:${y}`}
                    disabled={isBusy}
                  >
                    {occupant ? <span className={`token-chip team-${occupant.team}`}>{occupant.name}</span> : null}
                  </button>
                );
              })
            )}
          </div>
        </article>

        <aside className="telemetry-panel tactical-side-panel">
          <h2>Units</h2>
          <div className="token-list">
            {state.tokens.map((token) => (
              <button
                key={token.id}
                type="button"
                className={selectedTokenId === token.id ? "token-row selected" : "token-row"}
                onClick={() => setSelectedTokenId(token.id)}
              >
                <span>{token.name}</span>
                <small>
                  {token.team} | ({token.x},{token.y}) | HP {token.hp}
                </small>
              </button>
            ))}
          </div>

          <div className="action-row">
            <button type="button" className="action-btn tactical-btn" onClick={() => addToken("blue")}>
              Add Blue
            </button>
            <button type="button" className="action-btn tactical-btn" onClick={() => addToken("red")}>
              Add Red
            </button>
          </div>

          <h2>Peers</h2>
          <div className="tool-group">
            <span>Active Peer POV</span>
            <select
              className="peer-select"
              value={activePeerId}
              onChange={(event) => setActivePeerId(event.target.value)}
              disabled={isBusy}
            >
              {onlinePeers.map((peer) => (
                <option key={peer.peerId} value={peer.peerId}>
                  {peer.peerId} {peer.online ? "(online)" : "(offline)"}
                </option>
              ))}
            </select>
            <div className="action-row">
              <button
                type="button"
                className="action-btn tactical-btn"
                onClick={() => void handlePartitionToggle(true)}
                disabled={isBusy || state.partitionedPeers.includes(activePeerId)}
              >
                Partition Active
              </button>
              <button
                type="button"
                className="action-btn tactical-btn"
                onClick={() => void handlePartitionToggle(false)}
                disabled={isBusy || !state.partitionedPeers.includes(activePeerId)}
              >
                Reconnect Active
              </button>
            </div>
          </div>

          <div className="peer-row">
            <input
              className="peer-input"
              type="text"
              value={peerDraft}
              onChange={(event) => setPeerDraft(event.target.value)}
              placeholder="peer id"
              disabled={isBusy}
            />
            <button type="button" className="action-btn tactical-btn" onClick={() => void handlePeerConnect()} disabled={isBusy}>
              Connect
            </button>
          </div>
          {peerMessage && <p className="topology-note">{peerMessage}</p>}
          <div className="peer-list">
            {onlinePeers.map((peer) => (
              <div key={peer.peerId} className="peer-item">
                <span>
                  {peer.peerId} {peer.online ? "online" : "offline"}
                </span>
                <button
                  type="button"
                  className="action-btn tactical-btn"
                  onClick={() => void handlePeerDisconnect(peer.peerId)}
                  disabled={isBusy || !peer.online}
                >
                  Disconnect
                </button>
              </div>
            ))}
          </div>

          <h2>Convergence</h2>
          <div className="convergence-box">
            <p>
              <strong>Partitioned:</strong> {state.partitionedPeers.length > 0 ? state.partitionedPeers.join(", ") : "none"}
            </p>
            <ul>
              {state.queuedOps.map((entry) => (
                <li key={entry.peerId}>
                  {entry.peerId}: {entry.count} queued op(s)
                </li>
              ))}
              {state.queuedOps.length === 0 ? <li>No queued operations</li> : null}
            </ul>
          </div>

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
                <button type="button" className="action-btn tactical-btn" onClick={handleClearScenarioHistory} disabled={isBusy}>
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

          <h2>Operation Timeline</h2>
          <ul className="ops-list">
            {replayOps.map((op, index) => (
              <li key={`${op.timestampUtc}-${op.type}-${index}`}>
                <span className="ops-meta">
                  {new Date(op.timestampUtc).toLocaleTimeString()} [{op.stream}:{op.type}]
                </span>
                <span>{op.message}</span>
                {op.peerId ? <span className="replay-peer">peer: {op.peerId}</span> : null}
              </li>
            ))}
            {replayOps.length === 0 ? <li className="ops-empty">No runtime events yet. Start editing the board.</li> : null}
          </ul>
        </aside>
      </div>
    </section>
  );
}


