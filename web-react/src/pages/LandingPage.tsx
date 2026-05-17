import { Link } from "react-router-dom";
import { appRoutes } from "../app/routes";

const coreHighlights = [
  "CRDT map convergence with deterministic merges",
  "Content-addressed asset deduplication and lazy pull",
  "Partition-tolerant local-first multiplayer",
  "Replayable timeline and merge introspection"
];

export function LandingPage() {
  const featureLinks = appRoutes.filter((route) => route.group === "core");
  const modeLinks = appRoutes.filter((route) => route.group === "modes");

  return (
    <div className="landing-page">
      <section className="hero-panel">
        <p className="hero-tag">Collaborative Tactical Sandbox Platform</p>
        <h1>Build, simulate, and synchronize shared worlds across disconnected peers.</h1>
        <p>
          This demo showcases ActiveSync as a replicated simulation engine, not a single title. The same runtime powers
          tactical maps, entity systems, chat, inventory, scripts, and replay diagnostics.
        </p>
        <div className="hero-actions">
          <Link to="/modes/tactical-strategy" className="cta-primary">
            Launch Tactical Strategy
          </Link>
          <Link to="/diagnostics/ops" className="cta-secondary">
            Open Operation Stream
          </Link>
        </div>
      </section>

      <section className="metrics-strip" aria-label="Live status preview">
        <div>
          <strong>Peers</strong>
          <span>4 active / 2 offline</span>
        </div>
        <div>
          <strong>Ops/sec</strong>
          <span>1,284 replicated</span>
        </div>
        <div>
          <strong>Merge Time</strong>
          <span>11.7 ms p95</span>
        </div>
        <div>
          <strong>CAS Hit Ratio</strong>
          <span>93.4%</span>
        </div>
      </section>

      <section>
        <h2>Technology Focus</h2>
        <div className="pill-grid">
          {coreHighlights.map((item) => (
            <span key={item} className="pill">
              {item}
            </span>
          ))}
        </div>
      </section>

      <section className="card-grid-section">
        <header>
          <h2>Core Features</h2>
          <p>Each page maps user-facing interactions to specific synchronization primitives.</p>
        </header>
        <div className="card-grid">
          {featureLinks.map((route) => (
            <Link key={route.path} to={route.path} className="showcase-card">
              <h3>{route.title}</h3>
              <p>{route.description}</p>
            </Link>
          ))}
        </div>
      </section>

      <section className="card-grid-section">
        <header>
          <h2>Showcase Modes</h2>
          <p>Mini-game style scenarios demonstrating the same replication substrate.</p>
        </header>
        <div className="card-grid">
          {modeLinks.map((route) => (
            <Link key={route.path} to={route.path} className="showcase-card">
              <h3>{route.title}</h3>
              <p>{route.description}</p>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
