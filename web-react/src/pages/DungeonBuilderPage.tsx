import { useEffect, useState } from "react";
import { applyTacticalAction, fetchReplicationEvents, fetchTacticalState, runDemoScenario } from "../app/hostClient";
import {
  clearScenarioHistory,
  compareRecentScenarioRuns,
  loadScenarioHistory,
  recordScenarioRun,
  type ScenarioHistoryEntry
} from "../app/scenarioHistory";
import type { DemoScenarioRunResponse, ReplayEventItem, TacticalActionRequest, TacticalBoardState, TacticalToken } from "../../../shared/contracts/runtime";

type PaintType = "room" | "wall" | "door" | "trap" | "loot";
type BuilderTool = "paint" | "erase" | "token" | "link";
type TokenTeam = "blue" | "red";

const rows = 12;
const cols = 16;
const palette: PaintType[] = ["room", "wall", "door", "trap", "loot"];

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

export function DungeonBuilderPage() {
  const [state, setState] = useState<TacticalBoardState>(fallbackState);
  const [tool, setTool] = useState<BuilderTool>("paint");
  const [paintType, setPaintType] = useState<PaintType>("room");
  const [selectedTokenId, setSelectedTokenId] = useState<string | null>(null);
  const [linkStart, setLinkStart] = useState<{ x: number; y: number } | null>(null);
  const [events, setEvents] = useState<ReplayEventItem[]>([]);
  const [scenarioResult, setScenarioResult] = useState<DemoScenarioRunResponse | null>(null);
  const [scenarioHistory, setScenarioHistory] = useState<ScenarioHistoryEntry[]>(() => loadScenarioHistory("dungeon"));
  const scenarioComparison = compareRecentScenarioRuns(scenarioHistory);
  const [hostError, setHostError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  useEffect(() => {
    let isCanceled = false;

    async function loadState() {
      try {
        const [snapshot, replay] = await Promise.all([fetchTacticalState(), fetchReplicationEvents(120)]);
        if (!isCanceled) {
          setState(snapshot);
          const modeEvents = replay.events.filter(
            (event) => event.stream === "tactical" && ["terrain", "token-add", "token-move", "link-trigger", "unlink-trigger", "erase"].includes(event.type)
          );
          setEvents(modeEvents);
          setHostError(null);
          if (snapshot.tokens.length > 0 && !selectedTokenId) {
            setSelectedTokenId(snapshot.tokens[0].id);
          }
        }
      } catch (error) {
        if (!isCanceled) {
          setHostError(error instanceof Error ? error.message : "Unable to load dungeon state");
        }
      }
    }

    void loadState();
    const intervalId = window.setInterval(() => {
      void loadState();
    }, 2600);

    return () => {
      isCanceled = true;
      window.clearInterval(intervalId);
    };
  }, [selectedTokenId]);

  function tokenAt(x: number, y: number): TacticalToken | undefined {
    return state.tokens.find((token) => token.x === x && token.y === y);
  }

  function tileClass(value: string): string {
    switch (value) {
      case "room":
        return "terrain-room";
      case "wall":
        return "terrain-wall";
      case "door":
        return "terrain-door";
      case "trap":
        return "terrain-trap";
      case "loot":
        return "terrain-loot";
      default:
        return "terrain-plain";
    }
  }

  async function dispatchAction(action: TacticalActionRequest) {
    setIsBusy(true);
    try {
      const result = await applyTacticalAction(action);
      setState(result.state);
      setHostError(result.ok ? null : result.message);
    } catch (error) {
      setHostError(error instanceof Error ? error.message : "Dungeon action failed");
    } finally {
      setIsBusy(false);
    }
  }

  async function runScenario() {
    setIsBusy(true);
    try {
      const result = await runDemoScenario("dungeon.trigger-reconnect");
      setScenarioResult(result);
      setScenarioHistory(recordScenarioRun("dungeon", result));
      const [snapshot, replay] = await Promise.all([fetchTacticalState(), fetchReplicationEvents(120)]);
      setState(snapshot);
      const modeEvents = replay.events.filter(
        (event) => event.stream === "tactical" && ["terrain", "token-add", "token-move", "link-trigger", "unlink-trigger", "erase", "replay"].includes(event.type)
      );
      setEvents(modeEvents);
      setHostError(null);
      setLinkStart(null);
      setSelectedTokenId(snapshot.tokens[0]?.id ?? null);
      if (result.message) {
        setHostError(null);
      }
    } catch (error) {
      setHostError(error instanceof Error ? error.message : "Unable to run dungeon scenario");
    } finally {
      setIsBusy(false);
    }
  }

  function handleClearScenarioHistory() {
    clearScenarioHistory("dungeon");
    setScenarioHistory([]);
  }

  function addEntity(team: TokenTeam) {
    void dispatchAction({ action: "token-add", team, actorPeerId: "builder" });
  }

  function handleCellClick(x: number, y: number) {
    if (tool === "paint") {
      void dispatchAction({ action: "terrain", x, y, value: paintType, actorPeerId: "builder" });
      return;
    }

    if (tool === "erase") {
      void dispatchAction({ action: "erase", x, y, actorPeerId: "builder" });
      return;
    }

    if (tool === "token") {
      const occupant = tokenAt(x, y);
      if (occupant) {
        setSelectedTokenId(occupant.id);
        return;
      }

      if (!selectedTokenId) {
        setHostError("Select an entity first");
        return;
      }

      void dispatchAction({ action: "token-move", x, y, tokenId: selectedTokenId, actorPeerId: "builder" });
      return;
    }

    if (!linkStart) {
      setLinkStart({ x, y });
      return;
    }

    if (linkStart.x === x && linkStart.y === y) {
      setLinkStart(null);
      return;
    }

    void dispatchAction({
      action: "link-trigger",
      x: linkStart.x,
      y: linkStart.y,
      targetX: x,
      targetY: y,
      label: "trigger-link",
      actorPeerId: "builder"
    });
    setLinkStart(null);
  }

  return (
    <section className="feature-page tactical-page dungeon-page">
      <header className="feature-header tactical-header">
        <p className="hero-tag">MODE</p>
        <h1>Dungeon Builder Vertical Slice</h1>
        <p>
          Build shared dungeon layouts with rooms, doors, traps, loot markers, entity placement, and trigger wiring over the replicated host-backed board.
        </p>
      </header>

      <div className="tactical-layout">
        <article className="feature-panel tactical-board-panel">
          <div className="tactical-toolbar">
            {hostError && <p className="error-text">Host sync error: {hostError}</p>}
            <div className="tool-group">
              <span>Builder Tool</span>
              <div className="action-row">
                {(["paint", "erase", "token", "link"] as BuilderTool[]).map((mode) => (
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
              <span>Tile Palette</span>
              <div className="action-row">
                {palette.map((entry) => (
                  <button
                    key={entry}
                    type="button"
                    className={paintType === entry ? "action-btn tactical-btn active" : "action-btn tactical-btn"}
                    onClick={() => setPaintType(entry)}
                  >
                    {entry}
                  </button>
                ))}
              </div>
            </div>

            <div className="action-row">
              <button type="button" className="action-btn tactical-btn" onClick={() => void runScenario()} disabled={isBusy}>
                Run Scenario
              </button>
              <button type="button" className="action-btn tactical-btn" onClick={() => void dispatchAction({ action: "reset", actorPeerId: "builder" })}>
                Reset Dungeon
              </button>
              <button
                type="button"
                className="action-btn tactical-btn"
                onClick={() => {
                  if (linkStart) {
                    void dispatchAction({ action: "unlink-trigger", x: linkStart.x, y: linkStart.y, actorPeerId: "builder" });
                    setLinkStart(null);
                  }
                }}
              >
                Remove Links From Start
              </button>
            </div>
          </div>

          <div className="tactical-grid" style={{ gridTemplateColumns: `repeat(${state.cols}, minmax(24px, 1fr))` }}>
            {Array.from({ length: state.rows }).flatMap((_, y) =>
              Array.from({ length: state.cols }).map((__, x) => {
                const occupant = tokenAt(x, y);
                const terrainClass = tileClass(state.terrain[y][x]);
                const hasLinkAnchor = state.triggerLinks.some((link) => link.fromX === x && link.fromY === y);
                const isLinkStart = linkStart?.x === x && linkStart?.y === y;

                return (
                  <button
                    key={`${x}-${y}`}
                    type="button"
                    className={`tactical-cell ${terrainClass} ${hasLinkAnchor ? "has-ping" : ""} ${isLinkStart ? "is-link-start" : ""}`}
                    onClick={() => handleCellClick(x, y)}
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
          <h2>Entities</h2>
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
            <button type="button" className="action-btn tactical-btn" onClick={() => addEntity("blue")}>
              Add NPC
            </button>
            <button type="button" className="action-btn tactical-btn" onClick={() => addEntity("red")}>
              Add Encounter
            </button>
          </div>

          <h2>Trigger Links</h2>
          <ul className="ops-list">
            {state.triggerLinks.map((link) => (
              <li key={link.id}>
                <span className="ops-meta">{link.label}</span>
                <span>
                  ({link.fromX},{link.fromY}) {"->"} ({link.toX},{link.toY})
                </span>
              </li>
            ))}
            {state.triggerLinks.length === 0 ? <li className="ops-empty">No trigger links yet.</li> : null}
          </ul>

          <h2>Build Log</h2>
          <ul className="ops-list">
            {events.map((event, index) => (
              <li key={`${event.timestampUtc}-${event.type}-${index}`}>
                <span className="ops-meta">
                  {new Date(event.timestampUtc).toLocaleTimeString()} [{event.type}]
                </span>
                <span>{event.message}</span>
              </li>
            ))}
            {events.length === 0 ? <li className="ops-empty">No dungeon events yet.</li> : null}
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
              {scenarioComparison ? <p className="topology-note">Compare: {scenarioComparison.summary}</p> : null}
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
        </aside>
      </div>
    </section>
  );
}

