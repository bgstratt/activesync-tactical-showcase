import { NavLink, Outlet } from "react-router-dom";
import { appRoutes, type RouteGroup } from "../../app/routes";

const groupOrder: RouteGroup[] = ["overview", "core", "modes", "diagnostics"];

const groupLabel: Record<RouteGroup, string> = {
  overview: "Platform Overview",
  core: "Core Features",
  modes: "Showcase Modes",
  diagnostics: "Diagnostics"
};

export function AppShell() {
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-block">
          <p className="brand-kicker">ActiveSync Demo</p>
          <h1>TACTICAL SANDBOX</h1>
          <p className="brand-subtitle">Local-first collaborative simulation platform</p>
        </div>

        <nav className="sidebar-nav" aria-label="Main navigation">
          {groupOrder.map((group) => {
            const entries = appRoutes.filter((route) => route.group === group);
            return (
              <section key={group} className="nav-group">
                <h2>{groupLabel[group]}</h2>
                {entries.map((entry) => (
                  <NavLink
                    key={entry.path}
                    className={({ isActive }) => (isActive ? "nav-link active" : "nav-link")}
                    to={entry.path}
                  >
                    <span>{entry.title}</span>
                    <small>{entry.description}</small>
                  </NavLink>
                ))}
              </section>
            );
          })}
        </nav>
      </aside>

      <main className="content-area">
        <Outlet />
      </main>
    </div>
  );
}
