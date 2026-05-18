import { useEffect, useState } from "react";
import {
  applyTacticalAction,
  connectPeer,
  disconnectPeer,
  fetchReplicationEvents,
  fetchReplicationTopology,
  fetchTacticalState
} from "../app/hostClient";
import type {
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
  updatedAtUtc: new Date().toISOString()
};

export function TacticalStrategyPage() {
  const [state, setState] = useState<TacticalBoardState>(fallbackState);
  const [tool, setTool] = useState<ToolMode>("terrain");
  const [selectedTerrain, setSelectedTerrain] = useState<TerrainType>("wall");
  const [selectedTokenId, setSelectedTokenId] = useState<string | null>(null);
  const [replayOps, setReplayOps] = useState<ReplayEventItem[]>([]);
  const [onlinePeers, setOnlinePeers] = useState<PeerStatus[]>([]);
  const [peerDraft, setPeerDraft] = useState("charlie");
  const [peerMessage, setPeerMessage] = useState<string | null>(null);
  const [hostError, setHostError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);

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
      const result = await applyTacticalAction(action);
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
