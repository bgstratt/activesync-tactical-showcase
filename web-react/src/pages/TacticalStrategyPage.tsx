import { useEffect, useMemo, useState } from "react";
import { applyTacticalAction, fetchTacticalState } from "../app/hostClient";
import type { TacticalActionRequest, TacticalBoardState, TacticalToken } from "../../../shared/contracts/runtime";

type TerrainType = "plain" | "wall" | "difficult";
type ToolMode = "terrain" | "fog" | "token" | "ping" | "erase";
type TokenTeam = "blue" | "red";

interface TacticalOp {
  id: string;
  at: string;
  kind: string;
  detail: string;
}

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
  const [ops, setOps] = useState<TacticalOp[]>([]);
  const [hostError, setHostError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  const selectedToken = useMemo(
    () => state.tokens.find((token) => token.id === selectedTokenId) ?? null,
    [selectedTokenId, state.tokens]
  );

  useEffect(() => {
    let isCanceled = false;

    async function loadState() {
      try {
        const snapshot = await fetchTacticalState();
        if (!isCanceled) {
          setState(snapshot);
          setHostError(null);
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

    return () => {
      isCanceled = true;
    };
  }, []);

  function addOp(kind: string, detail: string) {
    const entry: TacticalOp = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      at: new Date().toLocaleTimeString(),
      kind,
      detail
    };

    setOps((current) => [entry, ...current].slice(0, 80));
  }

  async function dispatchAction(action: TacticalActionRequest, opKind: string, detail: string) {
    setIsBusy(true);
    try {
      const result = await applyTacticalAction(action);
      setState(result.state);
      setHostError(result.ok ? null : result.message);
      addOp(opKind, detail);
    } catch (error) {
      setHostError(error instanceof Error ? error.message : "Host tactical action failed");
    } finally {
      setIsBusy(false);
    }
  }

  function clearBoard() {
    void dispatchAction({ action: "reset" }, "reset", "Board reset to baseline tactical state");
  }

  function tokenAt(x: number, y: number): TacticalToken | undefined {
    return state.tokens.find((token) => token.x === x && token.y === y);
  }

  function applyCellAction(x: number, y: number) {
    if (tool === "terrain") {
      void dispatchAction({ action: "terrain", x, y, value: selectedTerrain }, "terrain", `Set (${x},${y}) to ${selectedTerrain}`);
      return;
    }

    if (tool === "fog") {
      void dispatchAction({ action: "fog", x, y }, "fog", `Toggled fog at (${x},${y})`);
      return;
    }

    if (tool === "ping") {
      void dispatchAction({ action: "ping", x, y, label: `Ping ${x},${y}` }, "ping", `Pinged sector (${x},${y})`);
      return;
    }

    if (tool === "erase") {
      void dispatchAction({ action: "erase", x, y }, "erase", `Cleared cell (${x},${y})`);
      return;
    }

    const occupant = tokenAt(x, y);
    if (occupant) {
      setSelectedTokenId(occupant.id);
      addOp("token", `Selected ${occupant.name} at (${x},${y})`);
      return;
    }

    if (!selectedTokenId) {
      addOp("token", "No token selected for movement");
      return;
    }

    void dispatchAction(
      { action: "token-move", x, y, tokenId: selectedTokenId },
      "token",
      `Moved ${selectedToken?.name ?? selectedTokenId} to (${x},${y})`
    );
  }

  function addToken(team: TokenTeam) {
    void dispatchAction({ action: "token-add", team }, "token", `Added ${team} token`);
  }

  function advanceTurn() {
    void dispatchAction({ action: "advance-turn" }, "turn", "Advanced initiative turn");
  }

  return (
    <section className="feature-page tactical-page">
      <header className="feature-header tactical-header">
        <p className="hero-tag">MODE</p>
        <h1>Tactical Strategy Vertical Slice</h1>
        <p>
          Collaborative battle-planning sandbox with editable terrain, fog-of-war, synchronized token-style entities, and a replay-friendly local
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

          <h2>Operation Timeline</h2>
          <ul className="ops-list">
            {ops.map((op) => (
              <li key={op.id}>
                <span className="ops-meta">
                  {op.at} [{op.kind}]
                </span>
                <span>{op.detail}</span>
              </li>
            ))}
            {ops.length === 0 ? <li className="ops-empty">No operations yet. Start editing the board.</li> : null}
          </ul>
        </aside>
      </div>
    </section>
  );
}
