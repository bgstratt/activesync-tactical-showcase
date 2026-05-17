# Implementation Plan: ActiveSync Tactical Showcase

## 1. Goals

- Build a production-style demo app that convincingly demonstrates ActiveSync technology in realistic collaboration scenarios.
- Use an embedded .NET host with a React web client.
- Provide a clear information architecture: landing page, sidebar navigation, and dedicated pages for each showcase facet.
- Keep scope staged so the project can ship incremental demo-ready milestones.

## 2. Success Criteria

- A user can launch the platform locally and navigate all showcase pages from a persistent sidebar.
- Each page exposes a clear technical story, live state, and observability panel.
- At least one mode (Tactical Strategy) is end-to-end functional with multi-peer convergence.
- Replay Inspector can visualize operation flow and merge behavior.

## 3. High-Level Architecture

- Embedded host: .NET runtime process embedded with host APIs for replication/session/asset lifecycle.
- Frontend: React SPA with route-based pages and shared shell layout.
- Sync engine bridge: Host-to-frontend contracts for command/event streaming and state snapshots.
- Asset layer: Content-addressed blob store with deduplication and lazy fetch.
- Observability: Event timeline, replication stats, and conflict/merge diagnostics.

## 4. UX and Navigation Plan

### 4.1 App Shell

- Top-level layout includes:
  - left sidebar with grouped navigation
  - primary content area
  - optional right rail for diagnostics
- Sidebar groups:
  - Platform Overview
  - Core Features
  - Showcase Modes
  - Diagnostics

### 4.2 Required Pages

- Landing Page
  - Platform pitch, architecture diagram, quick start actions.
- Core Feature Pages
  - Real-Time Collaborative Maps
  - Shared Tokens and Entities
  - Integrated Chat and Presence
  - Content Addressed Assets
  - Real-Time Drawing and Annotation
  - Cards, Inventory, and Items
  - Scripted Behaviors and Triggers
  - Offline Multiplayer
  - Timeline Replay and Time Travel
- Showcase Mode Pages
  - Tactical Strategy Mode
  - Dungeon Builder Mode
  - Pixel Sandbox Mode
  - Card Battle Mode
  - Replay Inspector Mode
- Diagnostics Pages
  - Replication Topology
  - Operation Stream
  - Asset Store
  - Merge Explorer

### 4.3 Shared Page Template

Each page should include:

- feature narrative (what user sees)
- technology lens (what ActiveSync primitive is demonstrated)
- interactive panel (controls and simulation actions)
- telemetry panel (latency, op counts, merge/conflict stats)

## 5. Phased Delivery

## Phase 0: Repository and Foundations

- Create repository structure.
- Create shell docs and architecture docs.
- Define shared host/frontend contracts.
- Set up CI skeleton and local run scripts.

## Phase 1: Shell, Landing, and Routing

- Implement app shell and sidebar.
- Build landing page with mode cards and feature map.
- Stub all showcase routes with consistent layout.
- Implement state model for navigation metadata.

## Phase 2: Embedded Host Integration

- Implement embedded .NET host bootstrap.
- Expose session creation, peer simulation, and operation feed.
- Add frontend bridge client and resilience/reconnect logic.
- Add host health and startup diagnostics page.

## Phase 3: Core Feature Implementations

- Deliver each core feature page with functional interactions:
  - maps
  - tokens
  - chat/presence
  - assets
  - drawing
  - inventory/cards
  - scripts/triggers
  - offline behavior
  - replay timeline

## Phase 4: Showcase Modes

- Ship Tactical Strategy first as vertical slice.
- Add Dungeon Builder and Pixel Sandbox next.
- Add Card Battle mode and hidden-state support.
- Integrate Replay Inspector overlays into all modes.

## Phase 5: Hardening and Demo Polish

- Performance profiling and optimization.
- Convergence correctness and deterministic replay tests.
- UX polish, onboarding flow, and scripted demo scenarios.
- Packaging for local presentation and recorded walkthroughs.

## 6. Workstreams

- Runtime and replication
- Host/frontend bridge
- Frontend shell and interaction design
- Assets and storage
- Diagnostics and replay tooling
- Testing and benchmark scenarios

## 7. Testing Strategy

- Unit tests for CRDT operations and merge logic.
- Contract tests for host/frontend messages.
- Multi-peer simulation tests including partition/rejoin.
- Deterministic replay snapshot tests.
- UI integration tests for navigation and page-specific interactions.

## 8. Risks and Mitigations

- Runtime contract drift:
  - Mitigate via versioned shared contracts and schema checks.
- Performance under high operation volume:
  - Mitigate with incremental batching and viewport-based subscriptions.
- UX complexity across many pages:
  - Mitigate with shared page scaffold and strict IA conventions.
- Determinism regressions:
  - Mitigate with replay goldens and seeded scenario tests.

## 9. Immediate Next Tasks

1. Initialize Git repository and first commit with this scaffold.
2. Decide initial tech stack details in `web-react` (router, state, charting).
3. Define v1 host/frontend contract for session, peers, ops, and assets.
4. Implement Phase 1 shell: landing page + sidebar + route stubs.
