namespace TacticalShowcase.Host.Contracts;

public sealed record HostHealthResponse(
    string Service,
    string Status,
    DateTimeOffset TimestampUtc,
    NativeRuntimeStatus NativeRuntime
);

public sealed record NativeRuntimeStatus(
    bool Available,
    string LibraryName,
    uint? AbiVersion,
    string? Error
);

public sealed record ReplicationTopologyResponse(
    string SessionId,
    DateTimeOffset UpdatedAtUtc,
    IReadOnlyList<PeerStatus> Peers,
    IReadOnlyList<PeerLink> ActiveLinks
);

public sealed record PeerStatus(
    string PeerId,
    bool Online,
    DateTimeOffset LastSeenUtc,
    int FrontierCount
);

public sealed record PeerLink(
    string FromPeerId,
    string ToPeerId,
    int ReplicationLagMs
);

public sealed record ReplayEventsResponse(
    string SessionId,
    DateTimeOffset UpdatedAtUtc,
    IReadOnlyList<ReplayEventItem> Events
);

public sealed record ReplayEventItem(
    DateTimeOffset TimestampUtc,
    string Stream,
    string Type,
    string? PeerId,
    string Message,
    string? PayloadJson
);

public sealed record PeerActionRequest(string PeerId);

public sealed record PeerActionResponse(bool Ok, string Message);

public sealed record TacticalTokenDto(
    string Id,
    string Name,
    string Team,
    int X,
    int Y,
    int Hp
);

public sealed record TacticalPingDto(
    string Id,
    int X,
    int Y,
    string Label
);

public sealed record TacticalBoardStateResponse(
    int Rows,
    int Cols,
    IReadOnlyList<IReadOnlyList<string>> Terrain,
    IReadOnlyList<IReadOnlyList<bool>> Fog,
    IReadOnlyList<TacticalTokenDto> Tokens,
    IReadOnlyList<TacticalPingDto> Pings,
    int Turn,
    IReadOnlyList<string> PartitionedPeers,
    IReadOnlyList<PeerQueueDepthDto> QueuedOps,
    DateTimeOffset UpdatedAtUtc
);

public sealed record PeerQueueDepthDto(string PeerId, int Count);

public sealed record TacticalActionRequest(
    string Action,
    int? X,
    int? Y,
    string? Value,
    string? TokenId,
    string? Team,
    string? Label,
    string? ActorPeerId,
    string? TargetPeerId,
    bool? Enabled
);

public sealed record TacticalActionResponse(bool Ok, string Message, TacticalBoardStateResponse State);
