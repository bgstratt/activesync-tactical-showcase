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
