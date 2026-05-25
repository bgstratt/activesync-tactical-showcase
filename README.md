# ActiveSync Tactical Showcase

Collaborative Tactical Sandbox Platform built to showcase ActiveSync replication primitives in a sophisticated, operator-friendly demo.

## Vision

A local-first replicated world platform powered by CRDT convergence and content-addressed assets. Multiple peers can simultaneously edit maps, move entities, attach media, script behaviors, and interact in shared spaces online or offline with deterministic synchronization and replayable history.

This repository focuses on a polished, multi-page demonstration experience rather than a single game.

## Project Shape

- `dotnet-host/`: Embedded .NET host process and host-side APIs.
- `web-react/`: React frontend experience with landing page, shell, sidebar, and showcase pages.
- `shared/contracts/`: Cross-runtime contracts and DTO definitions for host/frontend boundary.
- `docs/`: Design and planning documents.

## Demo Facets

- Real-Time Collaborative Maps
- Shared Tokens and Entities
- Integrated Chat and Presence
- Content Addressed Assets
- Real-Time Drawing and Annotation
- Cards, Inventory, and Items
- Scripted Behaviors and Triggers
- Offline Multiplayer
- Timeline Replay and Time Travel
- Showcase Modes (Tactical Strategy, Dungeon Builder, Pixel Sandbox, Card Battle, Replay Inspector)

## Initial Deliverables

1. App shell with landing page and persistent sidebar navigation.
2. Route-per-facet showcase pages with narrative plus live instrumentation.
3. Embedded .NET host integration path for local runtime.
4. First playable mode vertical slice: Tactical Strategy.

## Quick Start

1. Start the host:
	- `cd dotnet-host/src/TacticalShowcase.Host`
	- `dotnet run`
2. Start the web app (new terminal):
	- `cd web-react`
	- `npm install`
	- `npm run dev -- --host 127.0.0.1 --port 4173`
3. Open `http://127.0.0.1:4173`.

Host health is exposed at `http://localhost:5074/api/host/health`. If the native runtime cannot load, the endpoint stays reachable and reports the reason.

## Integration Model

- Tactical host is package-first: it consumes local ActiveSync NuGet host packages and adds showcase-specific endpoints on top.
- Tactical web is SDK-first: runtime room signaling defaults to `activesync-sdk-js` over `/ws/runtime` and only uses the legacy room signal relay as fallback.
- To force legacy-only signaling for troubleshooting, set `VITE_DISABLE_RUNTIME_SDK_SIGNALING=1`.

## Detailed Plan

See `PLAN.md` and `docs/ARCHITECTURE.md`.
