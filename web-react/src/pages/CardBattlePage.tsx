import { useEffect, useMemo, useState } from "react";
import {
  applyCardBattleAction,
  applyTacticalAction,
  connectPeer,
  fetchCardBattleState,
  fetchReplicationEvents,
  fetchReplicationTopology
} from "../app/hostClient";
import type { CardBattleCard, CardBattleState, PeerStatus, ReplayEventItem } from "../../../shared/contracts/runtime";

const fallbackCardBattleState: CardBattleState = {
  turn: 1,
  activeTeam: "blue",
  players: [
    { team: "blue", hp: 30, energy: 3, deckCount: 0, discardCount: 0, hand: [] },
    { team: "red", hp: 30, energy: 3, deckCount: 0, discardCount: 0, hand: [] }
  ],
  partitionedPeers: [],
  queuedOps: [],
  updatedAtUtc: new Date().toISOString()
};

function teamForPeer(peerId: string): "blue" | "red" {
  return peerId.toLowerCase().includes("red") ? "red" : "blue";
}

export function CardBattlePage() {
  const [state, setState] = useState<CardBattleState>(fallbackCardBattleState);
  const [events, setEvents] = useState<ReplayEventItem[]>([]);
  const [peers, setPeers] = useState<PeerStatus[]>([]);
  const [activePeerId, setActivePeerId] = useState("alpha");
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [hostError, setHostError] = useState<string | null>(null);

  const activeTeam = teamForPeer(activePeerId);
  const queueDepth = useMemo(() => state.queuedOps.reduce((sum, item) => sum + item.count, 0), [state.queuedOps]);
  const blue = state.players.find((player) => player.team === "blue") ?? fallbackCardBattleState.players[0];
  const red = state.players.find((player) => player.team === "red") ?? fallbackCardBattleState.players[1];

  useEffect(() => {
    let isCanceled = false;

    async function refresh() {
      try {
        const [snapshot, replay, topology] = await Promise.all([
          fetchCardBattleState(),
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
  }, [activePeerId]);

  async function runAction(action: "card-draw" | "card-end-turn" | "card-reset", extras?: Record<string, string>) {
    try {
      const response = await applyCardBattleAction({
        action,
        actorPeerId: activePeerId,
        team: activeTeam,
        ...(extras ?? {})
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
              <p className="topology-note">
                Team: <strong>{activeTeam}</strong> | Turn {state.turn} ({state.activeTeam} to act)
              </p>
              <div className="action-row">
                <button type="button" className="action-btn tactical-btn" onClick={() => void addPeer()}>
                  Add Peer
                </button>
                <button type="button" className="action-btn tactical-btn" onClick={() => void runAction("card-draw")}>
                  Draw Card
                </button>
                <button type="button" className="action-btn tactical-btn" onClick={() => void runAction("card-end-turn")}>
                  End Turn
                </button>
                <button type="button" className="action-btn tactical-btn" onClick={() => void runAction("card-reset")}>
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
              <p>Deck: {blue.deckCount} | Discard: {blue.discardCount}</p>
            </div>
            <div className="card-team-panel">
              <h3>Red Team</h3>
              <p>HP: {red.hp}</p>
              <p>Energy: {red.energy}</p>
              <p>Deck: {red.deckCount} | Discard: {red.discardCount}</p>
            </div>
          </div>

          <div className="card-hand-grid">
            {(activeTeam === "blue" ? blue.hand : red.hand).map((card) => {
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
                >
                  <strong>{card.name}</strong>
                  <span>{card.effectType === "damage" ? "Damage" : "Heal"}: {card.amount}</span>
                  <small>Cost: {card.cost}</small>
                </button>
              );
            })}
            {(activeTeam === "blue" ? blue.hand : red.hand).length === 0 ? (
              <p className="ops-empty">No cards in hand. Draw to start your turn.</p>
            ) : null}
          </div>
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
                <span>{event.message}</span>
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
