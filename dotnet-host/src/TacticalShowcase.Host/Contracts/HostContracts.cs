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

public sealed record DemoScenarioRunRequest(string ScenarioId);

public sealed record PeerActionResponse(bool Ok, string Message);

public sealed record DemoScenarioRunResponse(
    bool Ok,
    string ScenarioId,
    string Mode,
    string Message,
    IReadOnlyList<DemoScenarioAssertion> Assertions,
    DateTimeOffset CompletedAtUtc
);

public sealed record DemoScenarioAssertion(
    string Name,
    bool Passed,
    string Expected,
    string Actual
);

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

public sealed record TacticalTriggerLinkDto(
    string Id,
    int FromX,
    int FromY,
    int ToX,
    int ToY,
    string Label
);

public sealed record TacticalBoardStateResponse(
    int Rows,
    int Cols,
    IReadOnlyList<IReadOnlyList<string>> Terrain,
    IReadOnlyList<IReadOnlyList<bool>> Fog,
    IReadOnlyList<TacticalTokenDto> Tokens,
    IReadOnlyList<TacticalPingDto> Pings,
    IReadOnlyList<TacticalTriggerLinkDto> TriggerLinks,
    int Turn,
    IReadOnlyList<string> PartitionedPeers,
    IReadOnlyList<PeerQueueDepthDto> QueuedOps,
    DateTimeOffset UpdatedAtUtc
);

public sealed record PeerQueueDepthDto(string PeerId, int Count);

public sealed record TacticalCellWriteDto(int X, int Y);

public sealed record CardBattleCardDto(
    string Id,
    string Name,
    string EffectType,
    int Amount,
    int Cost
);

public sealed record CardBattlePlayerStateDto(
    string Team,
    int Hp,
    int Energy,
    int DeckCount,
    int DiscardCount,
    int ConcealedHandCount,
    IReadOnlyList<CardBattleCardDto> Hand
);

public sealed record CardBattleStateResponse(
    int Turn,
    string ActiveTeam,
    IReadOnlyList<CardBattlePlayerStateDto> Players,
    IReadOnlyList<string> PartitionedPeers,
    IReadOnlyList<PeerQueueDepthDto> QueuedOps,
    DateTimeOffset UpdatedAtUtc
);

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
    string? CardId,
    string? TargetTeam,
    int? TargetX,
    int? TargetY,
    bool? Enabled,
    IReadOnlyList<TacticalCellWriteDto>? Cells
);

public sealed record TacticalActionResponse(bool Ok, string Message, TacticalBoardStateResponse State);

public sealed record CardBattleActionResponse(bool Ok, string Message, CardBattleStateResponse State);

public sealed record WorkspacePointDto(double X, double Y);

public sealed record WorkspaceNodeDto(
    string Id,
    double X,
    double Y,
    string Label,
    string Color,
    long UpdatedAtMs,
    string UpdatedBy
);

public sealed record WorkspaceEdgeDto(
    string Id,
    string FromNodeId,
    string ToNodeId,
    long UpdatedAtMs,
    string UpdatedBy
);

public sealed record WorkspaceAssetDto(
    string Id,
    double X,
    double Y,
    string Name,
    long UpdatedAtMs,
    string UpdatedBy
);

public sealed record WorkspaceAnnotationDto(
    string Id,
    double X,
    double Y,
    string Text,
    long UpdatedAtMs,
    string UpdatedBy
);

public sealed record WorkspaceStrokeDto(
    string Id,
    IReadOnlyList<WorkspacePointDto> Points,
    string Color,
    double Width,
    long UpdatedAtMs,
    string UpdatedBy
);

public sealed record WorkspaceStateResponse(
    string RoomId,
    DateTimeOffset UpdatedAtUtc,
    IReadOnlyList<WorkspaceNodeDto> Nodes,
    IReadOnlyList<WorkspaceEdgeDto> Edges,
    IReadOnlyList<WorkspaceAssetDto> Assets,
    IReadOnlyList<WorkspaceAnnotationDto> Annotations,
    IReadOnlyList<WorkspaceStrokeDto> Strokes,
    int OperationCount
);

public sealed record WorkspaceOperationRequest(
    string PeerId,
    string Kind,
    string? NodeId,
    string? FromNodeId,
    string? ToNodeId,
    double? X,
    double? Y,
    string? Label,
    string? Text,
    string? AssetName,
    string? Color,
    double? Width,
    IReadOnlyList<WorkspacePointDto>? Points,
    long? UpdatedAtMs
);

public sealed record WorkspaceEventItem(
    long UpdatedAtMs,
    string PeerId,
    string Kind,
    string Message
);

public sealed record WorkspaceEventsResponse(
    string RoomId,
    DateTimeOffset UpdatedAtUtc,
    IReadOnlyList<WorkspaceEventItem> Events
);

public sealed record WorkspaceOperationItem(
    string Id,
    long UpdatedAtMs,
    string PeerId,
    string Kind,
    string? NodeId,
    string? FromNodeId,
    string? ToNodeId,
    double? X,
    double? Y,
    string? Label,
    string? Text,
    string? AssetName,
    string? Color,
    double? Width,
    IReadOnlyList<WorkspacePointDto>? Points
);

public sealed record WorkspaceOperationsResponse(
    string RoomId,
    DateTimeOffset UpdatedAtUtc,
    IReadOnlyList<WorkspaceOperationItem> Operations
);
