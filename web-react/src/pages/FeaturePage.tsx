import { useEffect, useState } from "react";
import { fetchHostHealth, fetchReplicationTopology } from "../app/hostClient";
import { appRoutes } from "../app/routes";
import type { HostHealthResponse, ReplicationTopologyResponse } from "../../../shared/contracts/runtime";

interface FeaturePageProps {
  routePath: string;
}

const demoActions = ["Spawn peer", "Inject partition", "Apply local edit", "Replay delta"];

export function FeaturePage({ routePath }: FeaturePageProps) {
  const route = appRoutes.find((entry) => entry.path === routePath);
  const [hostHealth, setHostHealth] = useState<HostHealthResponse | null>(null);
  const [topology, setTopology] = useState<ReplicationTopologyResponse | null>(null);
  const [hostError, setHostError] = useState<string | null>(null);

  useEffect(() => {
    if (!routePath.startsWith("/diagnostics/")) {
      return;
    }

    let isCanceled = false;

    async function loadDiagnosticsData() {
      setHostError(null);

      try {
        const [health, topo] = await Promise.all([fetchHostHealth(), fetchReplicationTopology()]);

        if (!isCanceled) {
          setHostHealth(health);
          setTopology(topo);
        }
      } catch (error) {
        if (!isCanceled) {
          setHostError(error instanceof Error ? error.message : "Unknown host connectivity error");
          setHostHealth(null);
          setTopology(null);
        }
      }
    }

    void loadDiagnosticsData();

    return () => {
      isCanceled = true;
    };
  }, [routePath]);

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

          {route.group === "diagnostics" && (
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
            {route.group === "diagnostics" && topology && <li>Active links: {topology.activeLinks.length}</li>}
          </ul>
        </aside>
      </div>
    </section>
  );
}
