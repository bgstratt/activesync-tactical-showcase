import { useEffect, useState } from "react";
import {
  connectPeer,
  disconnectPeer,
  fetchHostHealth,
  fetchReplicationEvents,
  fetchReplicationTopology
} from "../app/hostClient";
import { appRoutes } from "../app/routes";
import type { HostHealthResponse, ReplayEventsResponse, ReplicationTopologyResponse } from "../../../shared/contracts/runtime";

interface FeaturePageProps {
  routePath: string;
}

const demoActions = ["Spawn peer", "Inject partition", "Apply local edit", "Replay delta"];

export function FeaturePage({ routePath }: FeaturePageProps) {
  const route = appRoutes.find((entry) => entry.path === routePath);
  const [hostHealth, setHostHealth] = useState<HostHealthResponse | null>(null);
  const [topology, setTopology] = useState<ReplicationTopologyResponse | null>(null);
  const [replayEvents, setReplayEvents] = useState<ReplayEventsResponse | null>(null);
  const [hostError, setHostError] = useState<string | null>(null);
  const [peerActionMessage, setPeerActionMessage] = useState<string | null>(null);

  const shouldLoadRuntimeData = routePath.startsWith("/diagnostics/") || routePath === "/modes/replay-inspector";

  useEffect(() => {
    if (!shouldLoadRuntimeData) {
      return;
    }

    let isCanceled = false;

    async function loadRuntimeData() {
      setHostError(null);

      try {
        const [health, topo, events] = await Promise.all([
          fetchHostHealth(),
          fetchReplicationTopology(),
          fetchReplicationEvents(80)
        ]);

        if (!isCanceled) {
          setHostHealth(health);
          setTopology(topo);
          setReplayEvents(events);
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

    try {
      const response = action === "connect" ? await connectPeer(peerId) : await disconnectPeer(peerId);
      setPeerActionMessage(response.message);

      const [topo, events] = await Promise.all([fetchReplicationTopology(), fetchReplicationEvents(80)]);
      setTopology(topo);
      setReplayEvents(events);
    } catch (error) {
      setPeerActionMessage(error instanceof Error ? error.message : "Peer action failed");
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
          <h2>Scenario Canvas</h2>
          <p>
            This scaffold page will host the interactive simulation surface for <strong>{route.title}</strong>. Use this area
            to drive edits, movements, scripted interactions, and synchronization events.
          </p>
          <div className="action-row">
            {demoActions.map((action) => (
              <button key={action} type="button" className="action-btn">
                {action}
              </button>
            ))}
          </div>

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
                </div>
              )}

              {routePath === "/modes/replay-inspector" && (
                <>
                  <div className="action-row">
                    <button type="button" className="action-btn" onClick={() => void handlePeerAction("connect", "charlie")}>
                      Connect Charlie
                    </button>
                    <button type="button" className="action-btn" onClick={() => void handlePeerAction("disconnect", "charlie")}>
                      Disconnect Charlie
                    </button>
                    <button type="button" className="action-btn" onClick={() => void handlePeerAction("connect", "echo")}>
                      Connect Echo
                    </button>
                  </div>

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
                </>
              )}
            </section>
          )}
        </article>

        <aside className="telemetry-panel">
          <h2>Telemetry Lens</h2>
          <ul>
            <li>Local apply latency: 4.2 ms</li>
            <li>Outbound op queue: 19</li>
            <li>Merge resolutions: 7</li>
            <li>Asset pulls (CAS): 3</li>
            {shouldLoadRuntimeData && topology && <li>Active links: {topology.activeLinks.length}</li>}
            {routePath === "/modes/replay-inspector" && replayEvents && <li>Recent events: {replayEvents.events.length}</li>}
          </ul>
        </aside>
      </div>
    </section>
  );
}
