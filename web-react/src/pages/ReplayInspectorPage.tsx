import { useEffect, useMemo, useState } from "react";
import { fetchReplicationEvents, fetchReplicationTopology, fetchTacticalState } from "../app/hostClient";
import type { ReplayEventItem, ReplicationTopologyResponse, TacticalBoardState } from "../../../shared/contracts/runtime";

interface QueueSeriesPoint {
  index: number;
  depth: number;
  label: string;
}

function computeQueueDepthSeries(events: ReplayEventItem[]): QueueSeriesPoint[] {
  let depth = 0;
  const ordered = [...events].reverse();

  return ordered.map((event, index) => {
    if (event.type === "queued") {
      depth += 1;
    }

    if (event.type === "replay" && depth > 0) {
      depth -= 1;
    }

    return {
      index,
      depth,
      label: `${new Date(event.timestampUtc).toLocaleTimeString()} ${event.type}`
    };
  });
}

export function ReplayInspectorPage() {
  const [events, setEvents] = useState<ReplayEventItem[]>([]);
  const [topology, setTopology] = useState<ReplicationTopologyResponse | null>(null);
  const [tactical, setTactical] = useState<TacticalBoardState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let isCanceled = false;

    async function load() {
      try {
        const [eventStream, topo, tacticalState] = await Promise.all([
          fetchReplicationEvents(160),
          fetchReplicationTopology(),
          fetchTacticalState()
        ]);

        if (!isCanceled) {
          const convergenceEvents = eventStream.events.filter(
            (event) => event.stream === "tactical" || event.type === "queued" || event.type === "replay"
          );

          setEvents(convergenceEvents);
          setTopology(topo);
          setTactical(tacticalState);
          setError(null);
        }
      } catch (loadError) {
        if (!isCanceled) {
          setError(loadError instanceof Error ? loadError.message : "Failed to load replay inspector data");
        }
      }
    }

    void load();
    const intervalId = window.setInterval(() => {
      void load();
    }, 2500);

    return () => {
      isCanceled = true;
      window.clearInterval(intervalId);
    };
  }, []);

  const queueSeries = useMemo(() => computeQueueDepthSeries(events), [events]);
  const maxDepth = useMemo(() => Math.max(1, ...queueSeries.map((point) => point.depth)), [queueSeries]);
  const queuedCount = useMemo(() => events.filter((event) => event.type === "queued").length, [events]);
  const replayCount = useMemo(() => events.filter((event) => event.type === "replay").length, [events]);

  return (
    <section className="feature-page replay-inspector-page">
      <header className="feature-header">
        <p className="hero-tag">MODE</p>
        <h1>Replay Inspector</h1>
        <p>
          Visual timeline for partition windows, queued operation accumulation, replay bursts, and live peer topology during convergence.
        </p>
      </header>

      {error && <p className="error-text">Replay inspector error: {error}</p>}

      <section className="replay-metrics-grid">
        <article className="feature-panel">
          <h2>Convergence Counters</h2>
          <div className="metric-grid-compact">
            <div>
              <strong>Queued Ops</strong>
              <span>{queuedCount}</span>
            </div>
            <div>
              <strong>Replay Ops</strong>
              <span>{replayCount}</span>
            </div>
            <div>
              <strong>Partitioned Peers</strong>
              <span>{tactical?.partitionedPeers.length ?? 0}</span>
            </div>
            <div>
              <strong>Online Peers</strong>
              <span>{topology?.peers.filter((peer) => peer.online).length ?? 0}</span>
            </div>
          </div>
        </article>

        <article className="feature-panel">
          <h2>Current Queue Depth</h2>
          <ul className="queue-depth-list">
            {(tactical?.queuedOps ?? []).map((entry) => (
              <li key={entry.peerId}>
                <span>{entry.peerId}</span>
                <strong>{entry.count}</strong>
              </li>
            ))}
            {(tactical?.queuedOps.length ?? 0) === 0 ? <li>No queued ops</li> : null}
          </ul>
        </article>
      </section>

      <section className="feature-panel">
        <h2>Queue Depth Over Time</h2>
        <div className="queue-series-chart" aria-label="Queue depth timeline chart">
          {queueSeries.map((point) => {
            const heightPct = Math.max(3, Math.round((point.depth / maxDepth) * 100));
            return (
              <div
                key={`${point.index}-${point.label}`}
                className="queue-bar"
                style={{ height: `${heightPct}%` }}
                title={`${point.label} depth=${point.depth}`}
              />
            );
          })}
          {queueSeries.length === 0 ? <p className="ops-empty">No queue activity captured yet.</p> : null}
        </div>
      </section>

      <section className="feature-panel">
        <h2>Event Stream</h2>
        <ul className="ops-list replay-stream-list">
          {events.map((event, index) => (
            <li key={`${event.timestampUtc}-${event.type}-${index}`}>
              <span className="ops-meta">
                {new Date(event.timestampUtc).toLocaleTimeString()} [{event.stream}:{event.type}]
              </span>
              <span>{event.message}</span>
              {event.peerId ? <span className="replay-peer">peer: {event.peerId}</span> : null}
            </li>
          ))}
          {events.length === 0 ? <li className="ops-empty">No replay events available yet.</li> : null}
        </ul>
      </section>
    </section>
  );
}
