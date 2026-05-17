import { appRoutes } from "../app/routes";

interface FeaturePageProps {
  routePath: string;
}

const demoActions = ["Spawn peer", "Inject partition", "Apply local edit", "Replay delta"];

export function FeaturePage({ routePath }: FeaturePageProps) {
  const route = appRoutes.find((entry) => entry.path === routePath);

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
        </article>

        <aside className="telemetry-panel">
          <h2>Telemetry Lens</h2>
          <ul>
            <li>Local apply latency: 4.2 ms</li>
            <li>Outbound op queue: 19</li>
            <li>Merge resolutions: 7</li>
            <li>Asset pulls (CAS): 3</li>
          </ul>
        </aside>
      </div>
    </section>
  );
}
