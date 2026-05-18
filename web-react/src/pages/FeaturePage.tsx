import { useEffect, useState } from "react";
import {
  applyTacticalAction,
  connectPeer,
  disconnectPeer,
  fetchHostHealth,
  fetchReplicationEvents,
  fetchReplicationTopology,
  fetchTacticalState,
  runDemoScenario
} from "../app/hostClient";
import { appRoutes } from "../app/routes";
import type {
  HostHealthResponse,
  ReplayEventsResponse,
  ReplicationTopologyResponse,
  TacticalBoardState
} from "../../../shared/contracts/runtime";

interface FeaturePageProps {
  routePath: string;
}

interface RoutePlaybook {
  summary: string;
  steps: string[];
  scenarioId?: string;
}

const fallbackTacticalState: TacticalBoardState = {
  rows: 12,
  cols: 16,
  terrain: Array.from({ length: 12 }, () => Array.from({ length: 16 }, () => "plain")),
  fog: Array.from({ length: 12 }, () => Array.from({ length: 16 }, () => false)),
  tokens: [],
  pings: [],
  triggerLinks: [],
  turn: 1,
  partitionedPeers: [],
  queuedOps: [],
  updatedAtUtc: new Date().toISOString()
};

const playbookByRoute: Record<string, RoutePlaybook> = {
  "/features/maps": {
    summary: "Demonstrates replicated map edits and deterministic board turn progression.",
    steps: [
      "Apply Local Edit to paint terrain at (3,3).",
      "Add Entity to spawn a synchronized token.",
      "Advance Turn to confirm shared turn state propagation."
    ],
    scenarioId: "tactical.partition-replay"
  },
  "/features/entities": {
    summary: "Demonstrates conflict-safe entity insertion and movement-ready state syncing.",
    steps: [
      "Add Entity to create a shared token.",
      "Use Connect/Disconnect peer controls to verify peer visibility changes.",
      "Run Scenario to force queued + replayed state updates."
    ],
    scenarioId: "tactical.partition-replay"
  },
  "/features/chat-presence": {
    summary: "Uses peer connect/disconnect and event stream updates as presence and timeline primitives.",
    steps: [
      "Connect Charlie and observe peer count and events update.",
      "Disconnect Charlie and confirm topology/stream changes.",
      "Partition/Reconnect active peer to simulate transient offline behavior."
    ]
  },
  "/features/assets": {
    summary: "Surfaces runtime events and topology needed for CAS synchronization diagnostics.",
    steps: [
      "Run Scenario to generate deterministic event flow.",
      "Inspect Recent Event Types for queue/replay transitions.",
      "Use Peer controls to observe link and session changes."
    ],
    scenarioId: "pixel.burst-partition"
  },
  "/features/drawing": {
    summary: "Represents high-frequency spatial updates via batch/queued tactical operations.",
    steps: [
      "Apply Local Edit repeatedly to simulate drawing strokes.",
      "Partition active peer, then apply edits while queued.",
      "Reconnect and verify replay events drain queue depth."
    ],
    scenarioId: "pixel.burst-partition"
  },
  "/features/inventory": {
    summary: "Inventory/card synchronization is demonstrated in Card Battle mode with hidden-hand projection.",
    steps: [
      "Open Card Battle mode from sidebar to interact with real card state.",
      "Use perspective selector to validate private/public hand projections.",
      "Run card.private-turn scenario for deterministic assertions."
    ],
    scenarioId: "card.private-turn"
  },
  "/features/scripts": {
    summary: "Demonstrates deterministic scripted behavior and trigger graph replication.",
    steps: [
      "Run Scenario to execute trigger-reconnect script.",
      "Inspect event stream for queued then replay transitions.",
      "Confirm turn/event counters update with script output."
    ],
    scenarioId: "dungeon.trigger-reconnect"
  },
  "/features/offline": {
    summary: "Demonstrates partition tolerance and replay-based convergence.",
    steps: [
      "Partition active peer to queue future edits.",
      "Apply Local Edit while partitioned.",
      "Reconnect active peer and verify queued depth drains."
    ],
    scenarioId: "tactical.partition-replay"
  },
  "/features/replay": {
    summary: "Demonstrates operation timeline and deterministic replay behavior.",
    steps: [
      "Run Scenario to generate known replayable event shape.",
      "Observe queued/replay counts in telemetry.",
      "Open Replay Inspector mode for detailed timeline charts."
    ],
    scenarioId: "tactical.partition-replay"
  },
  "/diagnostics/topology": {
    summary: "Live peer graph and connectivity diagnostics from host runtime.",
    steps: [
      "Connect/Disconnect peer and verify online counts.",
      "Partition/Reconnect active peer and observe status transitions.",
      "Monitor active links and queued depths while interacting."
    ]
  },
  "/diagnostics/ops": {
    summary: "Live operation stream diagnostics with queue/replay instrumentation.",
    steps: [
      "Run Scenario to seed operation timeline.",
      "Inspect latest event stream entries.",
      "Check queued vs replay counts after reconnect."
    ],
    scenarioId: "tactical.partition-replay"
  },
  "/diagnostics/assets": {
    summary: "Asset diagnostics currently focus on event flow and topology while CAS wiring is expanded.",
    steps: [
      "Run Scenario to produce deterministic diagnostic events.",
      "Observe active links and queue depth metrics.",
      "Use topology changes to stress replication metadata."
    ],
    scenarioId: "pixel.burst-partition"
  },
  "/diagnostics/merges": {
    summary: "Merge diagnostics show queue/replay transitions that precede deterministic convergence.",
    steps: [
      "Partition active peer.",
      "Apply Local Edit while partitioned.",
      "Reconnect active peer and confirm replay/merge recovery events."
    ],
    scenarioId: "tactical.partition-replay"
  }
};

export function FeaturePage({ routePath }: FeaturePageProps) {
  const route = appRoutes.find((entry) => entry.path === routePath);
  const [hostHealth, setHostHealth] = useState<HostHealthResponse | null>(null);
  const [topology, setTopology] = useState<ReplicationTopologyResponse | null>(null);
  const [replayEvents, setReplayEvents] = useState<ReplayEventsResponse | null>(null);
  const [tacticalState, setTacticalState] = useState<TacticalBoardState>(fallbackTacticalState);
  const [hostError, setHostError] = useState<string | null>(null);
  const [peerActionMessage, setPeerActionMessage] = useState<string | null>(null);
  const [activePeerId, setActivePeerId] = useState("alpha");
  const [isBusy, setIsBusy] = useState(false);

  const shouldLoadRuntimeData = routePath.startsWith("/diagnostics/") || routePath.startsWith("/features/") || routePath === "/modes/replay-inspector";
  const playbook = playbookByRoute[routePath];

  async function refreshRuntimeData() {
    const [health, topo, events, tactical] = await Promise.all([
      fetchHostHealth(),
      fetchReplicationTopology(),
      fetchReplicationEvents(80),
      fetchTacticalState()
    ]);

    setHostHealth(health);
    setTopology(topo);
    setReplayEvents(events);
    setTacticalState(tactical);

    if (topo.peers.length > 0 && !topo.peers.some((peer) => peer.peerId === activePeerId)) {
      setActivePeerId(topo.peers[0].peerId);
    }
  }

  useEffect(() => {
    if (!shouldLoadRuntimeData) {
      return;
    }

    let isCanceled = false;

    async function loadRuntimeData() {
      setHostError(null);

      try {
        await refreshRuntimeData();
        if (!isCanceled) {
          setHostError(null);
        }
      } catch (error) {
        if (!isCanceled) {
          setHostError(error instanceof Error ? error.message : "Unknown host connectivity error");
          setHostHealth(null);
          setTopology(null);
          setReplayEvents(null);
        }
      }
    }

    void loadRuntimeData();
    const intervalId = window.setInterval(() => {
      void loadRuntimeData();
    }, 3000);

    return () => {
      isCanceled = true;
      window.clearInterval(intervalId);
    };
  }, [routePath, shouldLoadRuntimeData]);

  async function handlePeerAction(action: "connect" | "disconnect", peerId: string) {
    setPeerActionMessage(null);
    setIsBusy(true);

    try {
      const response = action === "connect" ? await connectPeer(peerId) : await disconnectPeer(peerId);
      setPeerActionMessage(response.message);
      await refreshRuntimeData();
    } catch (error) {
      setPeerActionMessage(error instanceof Error ? error.message : "Peer action failed");
    } finally {
      setIsBusy(false);
    }
  }

  async function handleRuntimeAction(action: "edit" | "spawn" | "turn" | "partition" | "reconnect" | "scenario") {
    setPeerActionMessage(null);
    setIsBusy(true);

    try {
      if (action === "edit") {
        await applyTacticalAction({ action: "terrain", actorPeerId: activePeerId, x: 3, y: 3, value: "wall" });
        setPeerActionMessage("Applied local edit at (3,3)");
      } else if (action === "spawn") {
        await applyTacticalAction({ action: "token-add", actorPeerId: activePeerId, team: "blue" });
        setPeerActionMessage("Added synchronized entity");
      } else if (action === "turn") {
        await applyTacticalAction({ action: "advance-turn", actorPeerId: activePeerId });
        setPeerActionMessage("Advanced tactical turn");
      } else if (action === "partition") {
        await applyTacticalAction({ action: "set-partition", actorPeerId: activePeerId, targetPeerId: activePeerId, enabled: true });
        setPeerActionMessage(`Partitioned '${activePeerId}'`);
      } else if (action === "reconnect") {
        await applyTacticalAction({ action: "set-partition", actorPeerId: activePeerId, targetPeerId: activePeerId, enabled: false });
        setPeerActionMessage(`Reconnected '${activePeerId}'`);
      } else if (action === "scenario") {
        const scenarioId = playbook?.scenarioId ?? "tactical.partition-replay";
        const result = await runDemoScenario(scenarioId);
        setPeerActionMessage(result.message);
      }

      await refreshRuntimeData();
    } catch (error) {
      setPeerActionMessage(error instanceof Error ? error.message : "Runtime action failed");
    } finally {
      setIsBusy(false);
    }
  }

  if (!route) {
    return (
      <section className="feature-page">
        <h1>Route Missing</h1>
        <p>This page is not yet registered in the route table.</p>
      </section>
    );
  }

  return (
    <section className="feature-page">
      <header className="feature-header">
        <p className="hero-tag">{route.group.toUpperCase()}</p>
        <h1>{route.title}</h1>
        <p>{route.description}</p>
      </header>

      <div className="feature-layout">
        <article className="feature-panel">
          <h2>What This Demonstrates</h2>
          <p>{playbook?.summary ?? "Live runtime interactions over the embedded host bridge."}</p>
          {playbook?.steps?.length ? (
            <ol>
              {playbook.steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          ) : null}
          <div className="action-row">
            <button type="button" className="action-btn" onClick={() => void handlePeerAction("connect", "charlie")} disabled={isBusy}>
              Connect Charlie
            </button>
            <button type="button" className="action-btn" onClick={() => void handlePeerAction("disconnect", "charlie")} disabled={isBusy}>
              Disconnect Charlie
            </button>
            <button type="button" className="action-btn" onClick={() => void handleRuntimeAction("edit")} disabled={isBusy}>
              Apply Local Edit
            </button>
            <button type="button" className="action-btn" onClick={() => void handleRuntimeAction("spawn")} disabled={isBusy}>
              Add Entity
            </button>
            <button type="button" className="action-btn" onClick={() => void handleRuntimeAction("turn")} disabled={isBusy}>
              Advance Turn
            </button>
            <button type="button" className="action-btn" onClick={() => void handleRuntimeAction("partition")} disabled={isBusy}>
              Partition Active
            </button>
            <button type="button" className="action-btn" onClick={() => void handleRuntimeAction("reconnect")} disabled={isBusy}>
              Reconnect Active
            </button>
            <button type="button" className="action-btn" onClick={() => void handleRuntimeAction("scenario")} disabled={isBusy}>
              Run Scenario
            </button>
          </div>

          {topology?.peers?.length ? (
            <div className="tool-group">
              <span>Active Peer</span>
              <select className="peer-select" value={activePeerId} onChange={(event) => setActivePeerId(event.target.value)}>
                {topology.peers.map((peer) => (
                  <option key={peer.peerId} value={peer.peerId}>
                    {peer.peerId} {peer.online ? "(online)" : "(offline)"}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          {shouldLoadRuntimeData && (
            <section className="runtime-preview">
              <h3>Embedded Host Bridge</h3>
              {hostError && <p className="error-text">Host unreachable: {hostError}</p>}

              {hostHealth && (
                <dl className="kv-grid">
                  <div>
                    <dt>Service</dt>
                    <dd>{hostHealth.service}</dd>
                  </div>
                  <div>
                    <dt>Native Runtime</dt>
                    <dd>{hostHealth.nativeRuntime.available ? "available" : "missing"}</dd>
                  </div>
                  <div>
                    <dt>ABI Version</dt>
                    <dd>{hostHealth.nativeRuntime.abiVersion ?? "n/a"}</dd>
                  </div>
                  <div>
                    <dt>Checked At</dt>
                    <dd>{new Date(hostHealth.timestampUtc).toLocaleTimeString()}</dd>
                  </div>
                </dl>
              )}

              {topology && (
                <div className="topology-summary">
                  <p>
                    <strong>Session:</strong> {topology.sessionId}
                  </p>
                  <p>
                    <strong>Peers Online:</strong> {topology.peers.filter((peer) => peer.online).length} / {topology.peers.length}
                  </p>
                  <p>
                    <strong>Tactical Turn:</strong> {tacticalState.turn}
                  </p>
                </div>
              )}
              {peerActionMessage && <p className="topology-note">{peerActionMessage}</p>}

              <div className="replay-log">
                <h3>Replay Stream</h3>
                <ul>
                  {(replayEvents?.events ?? []).map((item, index) => (
                    <li key={`${item.timestampUtc}-${item.type}-${index}`}>
                      <span className="replay-meta">
                        {new Date(item.timestampUtc).toLocaleTimeString()} [{item.stream}] {item.type}
                      </span>
                      <span>{item.message}</span>
                      {item.peerId && <span className="replay-peer">peer: {item.peerId}</span>}
                    </li>
                  ))}
                </ul>
              </div>
            </section>
          )}
        </article>

        <aside className="telemetry-panel">
          <h2>Telemetry Lens</h2>
          <ul>
            <li>Route: {route.title}</li>
            <li>Recent events: {replayEvents?.events.length ?? 0}</li>
            <li>Partitioned peers: {tacticalState.partitionedPeers.length}</li>
            <li>Queued tactical ops: {tacticalState.queuedOps.reduce((sum, entry) => sum + entry.count, 0)}</li>
            <li>Token count: {tacticalState.tokens.length}</li>
            <li>Active links: {topology?.activeLinks.length ?? 0}</li>
          </ul>
        </aside>
      </div>
    </section>
  );
}
