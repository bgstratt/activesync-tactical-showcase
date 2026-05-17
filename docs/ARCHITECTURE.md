# Architecture Overview

## Components

- Embedded .NET Host
  - Owns runtime lifecycle, replication graph coordination, operation ingestion, and persistence integration.
- React Frontend
  - Provides shell, navigation, mode interfaces, and diagnostics visualizations.
- Shared Contract Layer
  - Defines command/event payloads, snapshots, and schema versioning.
- Asset Store
  - Content-addressed blob handling and deduplicated retrieval.

## Host Responsibilities

- peer lifecycle (create/connect/disconnect)
- operation application and replication
- deterministic replay timeline materialization
- conflict resolution statistics and merge event reporting
- asset metadata and blob availability checks

## Frontend Responsibilities

- shell and route-based feature surfaces
- user interaction capture and command dispatch
- state visualization for operations and convergence
- diagnostics and replay controls

## Suggested Runtime Boundaries

- Commands from frontend to host:
  - `Session.Create`
  - `Peer.Connect`
  - `Peer.Disconnect`
  - `Map.ApplyEdit`
  - `Entity.Mutate`
  - `Asset.Upload`
  - `Replay.Scrub`
- Events from host to frontend:
  - `Session.StateChanged`
  - `Peer.PresenceChanged`
  - `Replication.OpApplied`
  - `Replication.MergeResolved`
  - `Asset.AvailabilityChanged`
  - `Replay.PositionChanged`

## Initial Observability Signals

- local apply latency
- replication queue depth
- ops/sec in and out
- merge count and merge duration
- CAS hit ratio and transfer volume
