import { useEffect, useMemo, useState } from "react";
import {
  applyCardBattleAction,
  applyTacticalAction,
  connectPeer,
  fetchCardBattleState,
  fetchReplicationEvents,
  fetchReplicationTopology
} from "../app/hostClient";
import type { CardBattleCard, CardBattlePerspective, CardBattleState, PeerStatus, ReplayEventItem } from "../../../shared/contracts/runtime";

const fallbackCardBattleState: CardBattleState = {
  turn: 1,
  activeTeam: "blue",
  players: [
    { team: "blue", hp: 30, energy: 3, deckCount: 0, discardCount: 0, concealedHandCount: 0, hand: [] },
    { team: "red", hp: 30, energy: 3, deckCount: 0, discardCount: 0, concealedHandCount: 0, hand: [] }
  ],
  partitionedPeers: [],
  queuedOps: [],
  updatedAtUtc: new Date().toISOString()
};

type ViewerTeam = "blue" | "red" | "observer";

function teamForPeer(peerId: string): ViewerTeam {
  const normalized = peerId.toLowerCase();
  if (normalized.includes("observer") || normalized.includes("spectator") || normalized.includes("obs")) {
    return "observer";
  }

  return normalized.includes("red") ? "red" : "blue";
}

export function CardBattlePage() {
  const [state, setState] = useState<CardBattleState>(fallbackCardBattleState);
  const [events, setEvents] = useState<ReplayEventItem[]>([]);
  const [peers, setPeers] = useState<PeerStatus[]>([]);
  const [activePeerId, setActivePeerId] = useState("alpha");
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [hostError, setHostError] = useState<string | null>(null);
  const [perspective, setPerspective] = useState<CardBattlePerspective>("auto");

  const detectedTeam = teamForPeer(activePeerId);
  const viewerTeam = perspective === "auto" ? detectedTeam : perspective;
  const activeTeam = viewerTeam === "observer" ? "blue" : viewerTeam;
  const canAct = viewerTeam !== "observer";

  const queueDepth = useMemo(() => state.queuedOps.reduce((sum, item) => sum + item.count, 0), [state.queuedOps]);
  const blue = state.players.find((player) => player.team === "blue") ?? fallbackCardBattleState.players[0];
  const red = state.players.find((player) => player.team === "red") ?? fallbackCardBattleState.players[1];
  const selfPlayer = activeTeam === "blue" ? blue : red;
  const opponentPlayer = activeTeam === "blue" ? red : blue;
  const visibleHand = useMemo(() => (canAct ? selfPlayer.hand : []), [canAct, selfPlayer.hand]);

  useEffect(() => {
    let isCanceled = false;

    async function refresh() {
      try {
        const [snapshot, replay, topology] = await Promise.all([
          fetchCardBattleState(activePeerId, perspective),
          fetchReplicationEvents(120),
          fetchReplicationTopology()
        ]);

        if (!isCanceled) {
          setState(snapshot);
          setPeers(topology.peers);
          const filtered = replay.events.filter(
            (event) => event.stream === "card-battle" || event.type === "queued" || event.type === "replay"
          );
          setEvents(filtered);
          setHostError(null);

          if (topology.peers.length > 0 && !topology.peers.some((peer) => peer.peerId === activePeerId)) {
            setActivePeerId(topology.peers[0].peerId);
          }
        }
      } catch (error) {
        if (!isCanceled) {
          setHostError(error instanceof Error ? error.message : "Unable to load card battle state");
        }
      }
    }

    void refresh();
    const intervalId = window.setInterval(() => {
      void refresh();
    }, 2200);

    return () => {
      isCanceled = true;
      window.clearInterval(intervalId);
    };
  }, [activePeerId, perspective]);

  async function runAction(action: "card-draw" | "card-end-turn" | "card-reset") {
    if (!canAct) {
      setMessage("Observer perspective is read-only");
      return;
    }

    try {
      const response = await applyCardBattleAction({
        action,
        actorPeerId: activePeerId,
        team: activeTeam
      });
      setState(response.state);
      setMessage(response.message);

      if (action === "card-reset") {
        setSelectedCardId(null);
      }
    } catch (error) {
      setHostError(error instanceof Error ? error.message : "Action failed");
    }
  }

  async function playCard(card: CardBattleCard) {
    if (!canAct) {
      setMessage("Observer perspective is read-only");
      return;
    }

    const targetTeam = card.effectType === "heal" ? activeTeam : activeTeam === "blue" ? "red" : "blue";
    try {
      const response = await applyCardBattleAction({
        action: "card-play",
        actorPeerId: activePeerId,
        team: activeTeam,
        cardId: card.id,
        targetTeam
      });
      setState(response.state);
      setMessage(response.message);
      setSelectedCardId(null);
    } catch (error) {
      setHostError(error instanceof Error ? error.message : "Play failed");
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
      setMessage(`Connected ${id}`);
    } catch (error) {
      setHostError(error instanceof Error ? error.message : "Unable to add peer");
    }
  }

  return (
    <section className="feature-page tactical-page card-battle-page">
      <header className="feature-header tactical-header">
        <p className="hero-tag">MODE</p>
        <h1>Card Battle</h1>
        <p>Host-backed synchronized deck play with turn authority, partition queueing, and replayable event stream.</p>
      </header>

      <div className="tactical-layout">
        <article className="feature-panel tactical-board-panel">
          <div className="tactical-toolbar">
            {hostError && <p className="error-text">Host sync error: {hostError}</p>}
            {message && <p className="topology-note">{message}</p>}
            <div className="tool-group">
              <span>Active Peer / Team</span>
              <select className="peer-select" value={activePeerId} onChange={(event) => setActivePeerId(event.target.value)}>
                {peers.map((peer) => (
                  <option key={peer.peerId} value={peer.peerId}>
                    {peer.peerId} {peer.online ? "(online)" : "(offline)"}
                  </option>
                ))}
              </select>
              <div className="peer-row">
                <label>
                  Perspective
                  <select className="peer-select" value={perspective} onChange={(event) => setPerspective(event.target.value as CardBattlePerspective)}>
                    <option value="auto">Auto ({detectedTeam})</option>
                    <option value="blue">Blue</option>
                    <option value="red">Red</option>
                    <option value="observer">Observer</option>
                  </select>
                </label>
              </div>
              <p className="topology-note">
                Perspective: <strong>{viewerTeam}</strong> | Acting team: <strong>{activeTeam}</strong> | Turn {state.turn} ({state.activeTeam} to act)
              </p>
              <div className="action-row">
                <button type="button" className="action-btn tactical-btn" onClick={() => void addPeer()}>
                  Add Peer
                </button>
                <button type="button" className="action-btn tactical-btn" onClick={() => void runAction("card-draw")} disabled={!canAct}>
                  Draw Card
                </button>
                <button type="button" className="action-btn tactical-btn" onClick={() => void runAction("card-end-turn")} disabled={!canAct}>
                  End Turn
                </button>
                <button type="button" className="action-btn tactical-btn" onClick={() => void runAction("card-reset")} disabled={!canAct}>
                  Reset Match
                </button>
              </div>
              <div className="action-row">
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
          </div>

          <div className="card-battle-board">
            <div className="card-team-panel">
              <h3>Blue Team</h3>
              <p>HP: {blue.hp}</p>
              <p>Energy: {blue.energy}</p>
              <p>Deck: {blue.deckCount} | Discard: {blue.discardCount} | Hand: {blue.hand.length}</p>
            </div>
            <div className="card-team-panel">
              <h3>Red Team</h3>
              <p>HP: {red.hp}</p>
              <p>Energy: {red.energy}</p>
              <p>Deck: {red.deckCount} | Discard: {red.discardCount} | Hand: {red.hand.length}</p>
            </div>
          </div>

          <div className="card-hand-section">
            <h3 className="card-hand-header">Visible Hand ({activeTeam})</h3>
            <div className="card-hand-grid">
              {visibleHand.map((card) => {
                const selected = selectedCardId === card.id;
                return (
                  <button
                    key={card.id}
                    type="button"
                    className={selected ? "card-tile selected" : "card-tile"}
                    onClick={() => {
                      setSelectedCardId(card.id);
                      void playCard(card);
                    }}
                    disabled={!canAct}
                  >
                    <strong>{card.name}</strong>
                    <span>{card.effectType === "damage" ? "Damage" : "Heal"}: {card.amount}</span>
                    <small>Cost: {card.cost}</small>
                  </button>
                );
              })}
              {visibleHand.length === 0 ? <p className="ops-empty">No visible cards in hand.</p> : null}
            </div>
          </div>

          {viewerTeam === "observer" ? (
            <>
              <div className="card-hand-section">
                <h3 className="card-hand-header">Concealed Blue Hand</h3>
                <div className="card-hand-grid">
                  {Array.from({ length: blue.concealedHandCount }).map((_, index) => (
                    <div key={`concealed-blue-${index}`} className="card-tile concealed" aria-hidden="true">
                      <strong>Hidden Card</strong>
                      <span>Observer view redacts all hand details</span>
                      <small>Card back</small>
                    </div>
                  ))}
                  {blue.concealedHandCount === 0 ? <p className="ops-empty">No concealed blue cards.</p> : null}
                </div>
              </div>

              <div className="card-hand-section">
                <h3 className="card-hand-header">Concealed Red Hand</h3>
                <div className="card-hand-grid">
                  {Array.from({ length: red.concealedHandCount }).map((_, index) => (
                    <div key={`concealed-red-${index}`} className="card-tile concealed" aria-hidden="true">
                      <strong>Hidden Card</strong>
                      <span>Observer view redacts all hand details</span>
                      <small>Card back</small>
                    </div>
                  ))}
                  {red.concealedHandCount === 0 ? <p className="ops-empty">No concealed red cards.</p> : null}
                </div>
              </div>
            </>
          ) : (
            <div className="card-hand-section">
              <h3 className="card-hand-header">Concealed Opponent Hand ({opponentPlayer.team})</h3>
              <div className="card-hand-grid">
                {Array.from({ length: opponentPlayer.concealedHandCount }).map((_, index) => (
                  <div key={`concealed-${index}`} className="card-tile concealed" aria-hidden="true">
                    <strong>Hidden Card</strong>
                    <span>Details redacted for this peer view</span>
                    <small>Card back</small>
                  </div>
                ))}
                {opponentPlayer.concealedHandCount === 0 ? <p className="ops-empty">No concealed opponent cards.</p> : null}
              </div>
            </div>
          )}
        </article>

        <aside className="telemetry-panel tactical-side-panel">
          <h2>Convergence</h2>
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

          <h2>Battle Timeline</h2>
          <ul className="ops-list">
            {events.map((event, index) => (
              <li key={`${event.timestampUtc}-${event.type}-${index}`}>
                <span className="ops-meta">
                  {new Date(event.timestampUtc).toLocaleTimeString()} [{event.stream}:{event.type}]
                </span>
                <span>{projectEventMessage(event, viewerTeam)}</span>
                {event.peerId ? <span className="replay-peer">peer: {event.peerId}</span> : null}
              </li>
            ))}
            {events.length === 0 ? <li className="ops-empty">No card battle events yet.</li> : null}
          </ul>
        </aside>
      </div>
    </section>
  );
}

function projectEventMessage(event: ReplayEventItem, viewerTeam: ViewerTeam): string {
  if (event.stream !== "card-battle" || event.type !== "draw") {
    return event.message;
  }

  const match = event.message.match(/^(blue|red)\s+drew\s+.+$/i);
  if (!match) {
    return event.message;
  }

  const drawTeam = match[1].toLowerCase() as "blue" | "red";
  if (viewerTeam === "observer" || drawTeam !== viewerTeam) {
    return `${drawTeam} drew a card`;
  }

  return event.message;
}
