import { useMemo, useState } from "react";

type TerrainType = "plain" | "wall" | "difficult";
type ToolMode = "terrain" | "fog" | "token" | "ping" | "erase";

type TokenTeam = "blue" | "red";

interface TacticalToken {
  id: string;
  name: string;
  team: TokenTeam;
  x: number;
  y: number;
  hp: number;
}

interface TacticalPing {
  id: string;
  x: number;
  y: number;
  label: string;
}

interface TacticalOp {
  id: string;
  at: string;
  kind: string;
  detail: string;
}

const rows = 12;
const cols = 16;
const terrainPalette: TerrainType[] = ["plain", "wall", "difficult"];

function buildTerrainGrid(fill: TerrainType): TerrainType[][] {
  return Array.from({ length: rows }, () => Array.from({ length: cols }, () => fill));
}

function buildFogGrid(fill: boolean): boolean[][] {
  return Array.from({ length: rows }, () => Array.from({ length: cols }, () => fill));
}

const initialTokens: TacticalToken[] = [
  { id: "t-blue-1", name: "A1", team: "blue", x: 2, y: 2, hp: 10 },
  { id: "t-blue-2", name: "A2", team: "blue", x: 3, y: 5, hp: 8 },
  { id: "t-red-1", name: "R1", team: "red", x: 12, y: 8, hp: 10 },
  { id: "t-red-2", name: "R2", team: "red", x: 10, y: 3, hp: 7 }
];

export function TacticalStrategyPage() {
  const [terrain, setTerrain] = useState<TerrainType[][]>(() => buildTerrainGrid("plain"));
  const [fog, setFog] = useState<boolean[][]>(() => buildFogGrid(false));
  const [tokens, setTokens] = useState<TacticalToken[]>(initialTokens);
  const [pings, setPings] = useState<TacticalPing[]>([]);
  const [tool, setTool] = useState<ToolMode>("terrain");
  const [selectedTerrain, setSelectedTerrain] = useState<TerrainType>("wall");
  const [selectedTokenId, setSelectedTokenId] = useState<string | null>(initialTokens[0]?.id ?? null);
  const [turn, setTurn] = useState(1);
  const [ops, setOps] = useState<TacticalOp[]>([]);

  const selectedToken = useMemo(() => tokens.find((token) => token.id === selectedTokenId) ?? null, [selectedTokenId, tokens]);

  function addOp(kind: string, detail: string) {
    const entry: TacticalOp = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      at: new Date().toLocaleTimeString(),
      kind,
      detail
    };

    setOps((current) => [entry, ...current].slice(0, 80));
  }

  function clearBoard() {
    setTerrain(buildTerrainGrid("plain"));
    setFog(buildFogGrid(false));
    setPings([]);
    setOps([]);
    setTurn(1);
    addOp("reset", "Board reset to baseline tactical state");
  }

  function tokenAt(x: number, y: number): TacticalToken | undefined {
    return tokens.find((token) => token.x === x && token.y === y);
  }

  function applyCellAction(x: number, y: number) {
    if (tool === "terrain") {
      setTerrain((current) => {
        const next = current.map((row) => row.slice());
        next[y][x] = selectedTerrain;
        return next;
      });
      addOp("terrain", `Set (${x},${y}) to ${selectedTerrain}`);
      return;
    }

    if (tool === "fog") {
      setFog((current) => {
        const next = current.map((row) => row.slice());
        next[y][x] = !next[y][x];
        return next;
      });
      addOp("fog", `Toggled fog at (${x},${y})`);
      return;
    }

    if (tool === "ping") {
      const ping: TacticalPing = {
        id: `${Date.now()}-${x}-${y}`,
        x,
        y,
        label: `Ping ${x},${y}`
      };
      setPings((current) => [ping, ...current].slice(0, 25));
      addOp("ping", `Pinged sector (${x},${y})`);
      return;
    }

    if (tool === "erase") {
      setTerrain((current) => {
        const next = current.map((row) => row.slice());
        next[y][x] = "plain";
        return next;
      });
      setFog((current) => {
        const next = current.map((row) => row.slice());
        next[y][x] = false;
        return next;
      });
      setTokens((current) => current.filter((token) => !(token.x === x && token.y === y)));
      setPings((current) => current.filter((ping) => !(ping.x === x && ping.y === y)));
      addOp("erase", `Cleared cell (${x},${y})`);
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

    setTokens((current) =>
      current.map((token) =>
        token.id === selectedTokenId
          ? {
              ...token,
              x,
              y
            }
          : token
      )
    );
    addOp("token", `Moved ${selectedToken?.name ?? selectedTokenId} to (${x},${y})`);
  }

  function addToken(team: TokenTeam) {
    const id = `${team}-${Date.now()}`;
    const name = team === "blue" ? `A${tokens.filter((token) => token.team === "blue").length + 1}` : `R${tokens.filter((token) => token.team === "red").length + 1}`;
    const newToken: TacticalToken = {
      id,
      name,
      team,
      x: team === "blue" ? 1 : cols - 2,
      y: team === "blue" ? 1 : rows - 2,
      hp: 10
    };
    setTokens((current) => [...current, newToken]);
    setSelectedTokenId(newToken.id);
    addOp("token", `Added ${newToken.name} (${team})`);
  }

  function advanceTurn() {
    setTurn((current) => current + 1);
    addOp("turn", "Advanced initiative turn");
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
                Advance Turn ({turn})
              </button>
              <button type="button" className="action-btn tactical-btn" onClick={clearBoard}>
                Reset Board
              </button>
            </div>
          </div>

          <div className="tactical-grid" style={{ gridTemplateColumns: `repeat(${cols}, minmax(24px, 1fr))` }}>
            {Array.from({ length: rows }).flatMap((_, y) =>
              Array.from({ length: cols }).map((__, x) => {
                const occupant = tokenAt(x, y);
                const terrainType = terrain[y][x];
                const isFogged = fog[y][x];
                const hasPing = pings.some((ping) => ping.x === x && ping.y === y);
                const terrainClass = `terrain-${terrainType}`;

                return (
                  <button
                    key={`${x}-${y}`}
                    type="button"
                    className={`tactical-cell ${terrainClass} ${isFogged ? "is-fogged" : ""} ${hasPing ? "has-ping" : ""}`}
                    onClick={() => applyCellAction(x, y)}
                    title={`x:${x} y:${y}`}
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
            {tokens.map((token) => (
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
