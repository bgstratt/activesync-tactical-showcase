export type RouteGroup = "overview" | "core" | "modes" | "diagnostics";

export interface AppRoute {
  path: string;
  title: string;
  group: RouteGroup;
  description: string;
}

export const appRoutes: AppRoute[] = [
  {
    path: "/",
    title: "Landing",
    group: "overview",
    description: "Platform vision, quick start, and architecture orientation."
  },
  {
    path: "/features/maps",
    title: "Collaborative Maps",
    group: "core",
    description: "Real-time concurrent map editing with deterministic convergence."
  },
  {
    path: "/features/entities",
    title: "Tokens and Entities",
    group: "core",
    description: "Replicated entities with optimistic mutation and conflict-safe merging."
  },
  {
    path: "/features/chat-presence",
    title: "Chat and Presence",
    group: "core",
    description: "Durable chat streams plus ephemeral session awareness."
  },
  {
    path: "/features/assets",
    title: "Content Addressed Assets",
    group: "core",
    description: "Hash-addressed blobs with dedupe and lazy replication."
  },
  {
    path: "/features/drawing",
    title: "Drawing and Annotation",
    group: "core",
    description: "High-frequency collaborative spatial input synchronization."
  },
  {
    path: "/features/inventory",
    title: "Cards and Inventory",
    group: "core",
    description: "Ordered collections, private scopes, and conflict-safe item flow."
  },
  {
    path: "/features/scripts",
    title: "Scripts and Triggers",
    group: "core",
    description: "Replicated behavior definitions with deterministic execution."
  },
  {
    path: "/features/offline",
    title: "Offline Multiplayer",
    group: "core",
    description: "Partition tolerance, autonomous peers, and convergence on reconnect."
  },
  {
    path: "/features/replay",
    title: "Timeline Replay",
    group: "core",
    description: "Replayable operation history, branching, and merge introspection."
  },
  {
    path: "/modes/tactical-strategy",
    title: "Tactical Strategy",
    group: "modes",
    description: "Battle planning with synchronized movement, fog, and annotations."
  },
  {
    path: "/modes/infinite-workspace",
    title: "Infinite Workspace (Room-Backed)",
    group: "modes",
    description: "Shared host room by roomId across browsers with real collaboration, replay, and convergence."
  },
  {
    path: "/modes/isolated-local-runtime",
    title: "Isolated Local Runtime",
    group: "modes",
    description: "Single-browser simulation sandbox for latency/offline behavior without shared room sync."
  },
  {
    path: "/modes/dungeon-builder",
    title: "Dungeon Builder",
    group: "modes",
    description: "Collaborative trap and encounter construction."
  },
  {
    path: "/modes/pixel-sandbox",
    title: "Pixel Sandbox",
    group: "modes",
    description: "Massively concurrent terrain or pixel editing across regions."
  },
  {
    path: "/modes/card-battle",
    title: "Card Battle",
    group: "modes",
    description: "Synchronized decks, turns, hidden hands, and shared game state."
  },
  {
    path: "/modes/replay-inspector",
    title: "Replay Inspector",
    group: "modes",
    description: "Visualization layer for operations, deltas, merges, and topology."
  },
  {
    path: "/diagnostics/topology",
    title: "Replication Topology",
    group: "diagnostics",
    description: "Peer graph, sessions, and connectivity view."
  },
  {
    path: "/diagnostics/ops",
    title: "Operation Stream",
    group: "diagnostics",
    description: "Live operation and delta telemetry feed."
  },
  {
    path: "/diagnostics/assets",
    title: "Asset Store",
    group: "diagnostics",
    description: "CAS stats, dedupe behavior, and transfer activity."
  },
  {
    path: "/diagnostics/merges",
    title: "Merge Explorer",
    group: "diagnostics",
    description: "Conflict and merge introspection across peers."
  }
];
