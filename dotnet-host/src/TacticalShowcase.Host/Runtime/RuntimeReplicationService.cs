using System.Text.Json;
using System.Text.Json.Nodes;
using TacticalShowcase.Host.Contracts;
using TacticalShowcase.Host.Ffi;

namespace TacticalShowcase.Host.Runtime;

public interface IRuntimeReplicationService
{
    ReplicationTopologyResponse GetTopology();
    ReplayEventsResponse GetReplayEvents(int take, string? viewerPeerId = null, string? perspective = null);
    RuntimePeerActionResult ConnectPeer(string peerId);
    RuntimePeerActionResult DisconnectPeer(string peerId);
    TacticalBoardStateResponse GetTacticalState();
    TacticalActionResponse ApplyTacticalAction(TacticalActionRequest request);
    CardBattleStateResponse GetCardBattleState(string? viewerPeerId = null, string? perspective = null);
    CardBattleActionResponse ApplyCardBattleAction(TacticalActionRequest request);
    DemoScenarioRunResponse RunDemoScenario(string scenarioId);
}

public sealed record RuntimePeerActionResult(bool IsSuccess, string Message);

internal sealed class RuntimeReplicationService : IRuntimeReplicationService, IDisposable
{
    private readonly object _sync = new();
    private readonly INativeRuntimeProbe _nativeProbe;
    private HostFfiClient? _ffi;
    private bool _bootstrapAttempted;
    private ulong _nextSessionId = 100;

    private readonly Dictionary<string, PeerRuntimeState> _peers = new(StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<ulong, string> _sessionToPeer = new();
    private readonly List<ReplayEventItem> _eventLog = new();
    private readonly HashSet<string> _partitionedPeers = new(StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<string, List<TacticalActionRequest>> _queuedActionsByPeer = new(StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<string, List<TacticalActionRequest>> _queuedCardActionsByPeer = new(StringComparer.OrdinalIgnoreCase);
    private TacticalState _tacticalState = TacticalState.CreateDefault();
    private CardBattleState _cardBattleState = CardBattleState.CreateDefault();

    private const string DemoRoomId = "tactical-demo-session";

    public RuntimeReplicationService(INativeRuntimeProbe nativeProbe)
    {
        _nativeProbe = nativeProbe;
    }

    public RuntimePeerActionResult ConnectPeer(string peerId)
    {
        if (string.IsNullOrWhiteSpace(peerId))
        {
            return new RuntimePeerActionResult(false, "peerId is required");
        }

        lock (_sync)
        {
            if (!EnsureEngine())
            {
                return new RuntimePeerActionResult(false, "Native runtime unavailable");
            }

            var normalizedPeer = peerId.Trim();
            if (_peers.TryGetValue(normalizedPeer, out var existing) && existing.Online)
            {
                return new RuntimePeerActionResult(true, $"Peer '{normalizedPeer}' is already online");
            }

            var sessionId = existing?.SessionId ?? _nextSessionId++;
            _sessionToPeer[sessionId] = normalizedPeer;

            var helloCommands = BuildHelloCommands(normalizedPeer, sessionId);
            foreach (var command in helloCommands)
            {
                var dispatch = DispatchCommand(command);
                if (!dispatch.IsSuccess)
                {
                    return dispatch;
                }
            }

            _peers[normalizedPeer] = new PeerRuntimeState(
                PeerId: normalizedPeer,
                SessionId: sessionId,
                Online: true,
                LastSeenUtc: DateTimeOffset.UtcNow,
                FrontierCount: 0
            );

            return new RuntimePeerActionResult(true, $"Peer '{normalizedPeer}' connected");
        }
    }

    public RuntimePeerActionResult DisconnectPeer(string peerId)
    {
        if (string.IsNullOrWhiteSpace(peerId))
        {
            return new RuntimePeerActionResult(false, "peerId is required");
        }

        lock (_sync)
        {
            if (!_peers.TryGetValue(peerId, out var existing))
            {
                return new RuntimePeerActionResult(false, $"Peer '{peerId}' not found");
            }

            if (!EnsureEngine())
            {
                return new RuntimePeerActionResult(false, "Native runtime unavailable");
            }

            var closeEnvelope = SerializeEnvelope(
                DemoRoomId,
                new JsonObject
                {
                    ["CloseSession"] = new JsonObject
                    {
                        ["session_id"] = existing.SessionId
                    }
                }
            );

            var dispatch = DispatchCommand(closeEnvelope);
            if (!dispatch.IsSuccess)
            {
                return dispatch;
            }

            _peers[existing.PeerId] = existing with
            {
                Online = false,
                LastSeenUtc = DateTimeOffset.UtcNow
            };

            return new RuntimePeerActionResult(true, $"Peer '{existing.PeerId}' disconnected");
        }
    }

    public ReplicationTopologyResponse GetTopology()
    {
        lock (_sync)
        {
            BootstrapDemoPeersIfNeeded();

            var now = DateTimeOffset.UtcNow;
            var peers = _peers.Values
                .OrderBy(p => p.PeerId, StringComparer.OrdinalIgnoreCase)
                .Select(p => new PeerStatus(p.PeerId, p.Online, p.LastSeenUtc, p.FrontierCount))
                .ToList();

            var onlinePeers = peers.Where(p => p.Online).ToList();
            var links = new List<PeerLink>();
            for (var i = 0; i < onlinePeers.Count; i++)
            {
                for (var j = i + 1; j < onlinePeers.Count; j++)
                {
                    var lag = 5 + Math.Abs(onlinePeers[i].PeerId.GetHashCode() - onlinePeers[j].PeerId.GetHashCode()) % 17;
                    links.Add(new PeerLink(onlinePeers[i].PeerId, onlinePeers[j].PeerId, lag));
                }
            }

            return new ReplicationTopologyResponse(
                SessionId: DemoRoomId,
                UpdatedAtUtc: now,
                Peers: peers,
                ActiveLinks: links
            );
        }
    }

    public ReplayEventsResponse GetReplayEvents(int take, string? viewerPeerId = null, string? perspective = null)
    {
        lock (_sync)
        {
            var normalizedTake = Math.Clamp(take, 10, 200);
            var viewerTeam = ResolveViewerTeam(viewerPeerId, perspective);
            var items = _eventLog
                .TakeLast(normalizedTake)
                .Reverse<ReplayEventItem>()
                .Select(item => ProjectReplayEvent(item, viewerTeam))
                .ToArray();

            return new ReplayEventsResponse(DemoRoomId, DateTimeOffset.UtcNow, items);
        }
    }

    private static ReplayEventItem ProjectReplayEvent(ReplayEventItem item, string viewerTeam)
    {
        if (!string.Equals(item.Stream, "card-battle", StringComparison.OrdinalIgnoreCase))
        {
            return item;
        }

        var message = item.Message;
        if (string.Equals(item.Type, "draw", StringComparison.OrdinalIgnoreCase))
        {
            var match = System.Text.RegularExpressions.Regex.Match(message, "^(blue|red)\\s+drew\\s+.+$", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
            if (match.Success)
            {
                var drawTeam = match.Groups[1].Value.ToLowerInvariant();
                if (string.Equals(viewerTeam, "observer", StringComparison.OrdinalIgnoreCase) ||
                    !string.Equals(viewerTeam, drawTeam, StringComparison.OrdinalIgnoreCase))
                {
                    message = $"{drawTeam} drew a card";
                }
            }
        }

        if (string.Equals(item.Type, "play", StringComparison.OrdinalIgnoreCase) &&
            string.Equals(viewerTeam, "observer", StringComparison.OrdinalIgnoreCase))
        {
            message = System.Text.RegularExpressions.Regex.Replace(
                message,
                "played\\s+.+?\\s+(for|to)",
                "played a card $1",
                System.Text.RegularExpressions.RegexOptions.IgnoreCase
            );
        }

        return item with { Message = message };
    }

    public TacticalBoardStateResponse GetTacticalState()
    {
        lock (_sync)
        {
            return ToTacticalResponse(_tacticalState);
        }
    }

    public TacticalActionResponse ApplyTacticalAction(TacticalActionRequest request)
    {
        if (string.IsNullOrWhiteSpace(request.Action))
        {
            return new TacticalActionResponse(false, "action is required", ToTacticalResponse(_tacticalState));
        }

        lock (_sync)
        {
            var actorPeerId = string.IsNullOrWhiteSpace(request.ActorPeerId) ? "alpha" : request.ActorPeerId.Trim();
            EnsurePeerRegistered(actorPeerId);

            var action = request.Action.Trim().ToLowerInvariant();
            if (action == "set-partition")
            {
                var partitionResult = ApplyPartitionChange(request, actorPeerId);
                return new TacticalActionResponse(partitionResult.IsSuccess, partitionResult.Message, ToTacticalResponse(_tacticalState));
            }

            if (_partitionedPeers.Contains(actorPeerId))
            {
                if (!_queuedActionsByPeer.TryGetValue(actorPeerId, out var queue))
                {
                    queue = [];
                    _queuedActionsByPeer[actorPeerId] = queue;
                }

                queue.Add(request);
                AddLocalEvent("tactical", "queued", $"Queued '{action}' while peer partitioned", actorPeerId);
                return new TacticalActionResponse(true, $"Action queued for partitioned peer '{actorPeerId}'", ToTacticalResponse(_tacticalState));
            }

            var result = action switch
            {
                "terrain" => ApplyTerrain(request, actorPeerId),
                "terrain-batch" => ApplyTerrainBatch(request, actorPeerId),
                "fog" => ApplyFog(request, actorPeerId),
                "ping" => ApplyPing(request, actorPeerId),
                "link-trigger" => ApplyLinkTrigger(request, actorPeerId),
                "unlink-trigger" => ApplyUnlinkTrigger(request, actorPeerId),
                "erase" => ApplyErase(request, actorPeerId),
                "token-move" => ApplyTokenMove(request, actorPeerId),
                "token-add" => ApplyTokenAdd(request, actorPeerId),
                "advance-turn" => ApplyAdvanceTurn(actorPeerId),
                "reset" => ApplyReset(actorPeerId),
                _ => new RuntimePeerActionResult(false, $"Unsupported action '{request.Action}'")
            };

            if (result.IsSuccess)
            {
                _tacticalState = _tacticalState with { UpdatedAtUtc = DateTimeOffset.UtcNow };
                PersistTacticalState();
            }

            return new TacticalActionResponse(result.IsSuccess, result.Message, ToTacticalResponse(_tacticalState));
        }
    }

    public CardBattleStateResponse GetCardBattleState(string? viewerPeerId = null, string? perspective = null)
    {
        lock (_sync)
        {
            return ToCardBattleResponse(_cardBattleState, viewerPeerId, perspective);
        }
    }

    public CardBattleActionResponse ApplyCardBattleAction(TacticalActionRequest request)
    {
        if (string.IsNullOrWhiteSpace(request.Action))
        {
            return new CardBattleActionResponse(false, "action is required", ToCardBattleResponse(_cardBattleState, request.ActorPeerId, null));
        }

        lock (_sync)
        {
            var actorPeerId = string.IsNullOrWhiteSpace(request.ActorPeerId) ? "alpha" : request.ActorPeerId.Trim();
            EnsurePeerRegistered(actorPeerId);

            var action = request.Action.Trim().ToLowerInvariant();
            if (action == "set-partition")
            {
                var partitionResult = ApplyPartitionChange(request, actorPeerId);
                return new CardBattleActionResponse(
                    partitionResult.IsSuccess,
                    partitionResult.Message,
                    ToCardBattleResponse(_cardBattleState, actorPeerId, null)
                );
            }

            if (_partitionedPeers.Contains(actorPeerId))
            {
                if (!_queuedCardActionsByPeer.TryGetValue(actorPeerId, out var queue))
                {
                    queue = [];
                    _queuedCardActionsByPeer[actorPeerId] = queue;
                }

                queue.Add(request);
                AddLocalEvent("card-battle", "queued", $"Queued '{action}' while peer partitioned", actorPeerId);
                return new CardBattleActionResponse(
                    true,
                    $"Action queued for partitioned peer '{actorPeerId}'",
                    ToCardBattleResponse(_cardBattleState, actorPeerId, null)
                );
            }

            var result = action switch
            {
                "card-draw" => ApplyCardDraw(request, actorPeerId),
                "card-play" => ApplyCardPlay(request, actorPeerId),
                "card-end-turn" => ApplyCardEndTurn(actorPeerId),
                "card-reset" => ApplyCardReset(actorPeerId),
                _ => new RuntimePeerActionResult(false, $"Unsupported action '{request.Action}'")
            };

            if (result.IsSuccess)
            {
                _cardBattleState = _cardBattleState with { UpdatedAtUtc = DateTimeOffset.UtcNow };
                PersistCardBattleState();
            }

            return new CardBattleActionResponse(result.IsSuccess, result.Message, ToCardBattleResponse(_cardBattleState, actorPeerId, null));
        }
    }

    public DemoScenarioRunResponse RunDemoScenario(string scenarioId)
    {
        if (string.IsNullOrWhiteSpace(scenarioId))
        {
            return new DemoScenarioRunResponse(
                false,
                "",
                "unknown",
                "scenarioId is required",
                [new DemoScenarioAssertion("scenario id provided", false, "non-empty", "empty")],
                DateTimeOffset.UtcNow
            );
        }

        lock (_sync)
        {
            var normalized = scenarioId.Trim().ToLowerInvariant();
            RuntimePeerActionResult result;
            var mode = "unknown";

            switch (normalized)
            {
                case "tactical.partition-replay":
                    mode = "tactical";
                    result = RunTacticalPartitionReplayScenario();
                    break;
                case "pixel.burst-partition":
                    mode = "pixel";
                    result = RunPixelBurstPartitionScenario();
                    break;
                case "dungeon.trigger-reconnect":
                    mode = "dungeon";
                    result = RunDungeonTriggerReconnectScenario();
                    break;
                case "card.private-turn":
                    mode = "card-battle";
                    result = RunCardPrivateTurnScenario();
                    break;
                default:
                    result = new RuntimePeerActionResult(false, $"Unknown scenario '{scenarioId}'");
                    break;
            }

            var assertions = BuildScenarioAssertions(normalized, result.IsSuccess);
            AddLocalEvent("scenario", result.IsSuccess ? "run" : "run-failed", $"{normalized}: {result.Message}", "scenario");
            return new DemoScenarioRunResponse(result.IsSuccess, normalized, mode, result.Message, assertions, DateTimeOffset.UtcNow);
        }
    }

    private IReadOnlyList<DemoScenarioAssertion> BuildScenarioAssertions(string scenarioId, bool runSuccess)
    {
        var assertions = new List<DemoScenarioAssertion>
        {
            new("scenario execution", runSuccess, "success", runSuccess ? "success" : "failed")
        };

        if (!runSuccess)
        {
            return assertions;
        }

        switch (scenarioId)
        {
            case "tactical.partition-replay":
                assertions.Add(new DemoScenarioAssertion(
                    "alpha partition cleared",
                    !_partitionedPeers.Contains("alpha"),
                    "alpha not partitioned",
                    _partitionedPeers.Contains("alpha") ? "alpha partitioned" : "alpha not partitioned"
                ));
                assertions.Add(new DemoScenarioAssertion(
                    "alpha tactical queue drained",
                    !_queuedActionsByPeer.TryGetValue("alpha", out var alphaQueue) || alphaQueue.Count == 0,
                    "0 queued ops",
                    _queuedActionsByPeer.TryGetValue("alpha", out alphaQueue) ? alphaQueue.Count.ToString() : "0"
                ));
                assertions.Add(new DemoScenarioAssertion(
                    "terrain write applied",
                    _tacticalState.Terrain[2][2] == "wall",
                    "terrain(2,2)=wall",
                    _tacticalState.Terrain[2][2]
                ));
                break;

            case "pixel.burst-partition":
                assertions.Add(new DemoScenarioAssertion(
                    "bravo partition cleared",
                    !_partitionedPeers.Contains("bravo"),
                    "bravo not partitioned",
                    _partitionedPeers.Contains("bravo") ? "bravo partitioned" : "bravo not partitioned"
                ));
                assertions.Add(new DemoScenarioAssertion(
                    "bravo tactical queue drained",
                    !_queuedActionsByPeer.TryGetValue("bravo", out var bravoQueue) || bravoQueue.Count == 0,
                    "0 queued ops",
                    _queuedActionsByPeer.TryGetValue("bravo", out bravoQueue) ? bravoQueue.Count.ToString() : "0"
                ));
                assertions.Add(new DemoScenarioAssertion(
                    "pixel terrain mutated",
                    _tacticalState.Terrain[0][0] == "difficult",
                    "terrain(0,0)=difficult",
                    _tacticalState.Terrain[0][0]
                ));
                break;

            case "dungeon.trigger-reconnect":
                assertions.Add(new DemoScenarioAssertion(
                    "builder partition cleared",
                    !_partitionedPeers.Contains("builder"),
                    "builder not partitioned",
                    _partitionedPeers.Contains("builder") ? "builder partitioned" : "builder not partitioned"
                ));
                assertions.Add(new DemoScenarioAssertion(
                    "trigger link exists",
                    _tacticalState.TriggerLinks.Any(link => link.FromX == 4 && link.FromY == 4 && link.ToX == 8 && link.ToY == 8),
                    "link 4,4 -> 8,8",
                    _tacticalState.TriggerLinks.Any(link => link.FromX == 4 && link.FromY == 4 && link.ToX == 8 && link.ToY == 8)
                        ? "present"
                        : "missing"
                ));
                assertions.Add(new DemoScenarioAssertion(
                    "door tile replayed",
                    _tacticalState.Terrain[6][6] == "door",
                    "terrain(6,6)=door",
                    _tacticalState.Terrain[6][6]
                ));
                break;

            case "card.private-turn":
                assertions.Add(new DemoScenarioAssertion(
                    "red partition cleared",
                    !_partitionedPeers.Contains("red-1"),
                    "red-1 not partitioned",
                    _partitionedPeers.Contains("red-1") ? "red-1 partitioned" : "red-1 not partitioned"
                ));
                assertions.Add(new DemoScenarioAssertion(
                    "red card queue drained",
                    !_queuedCardActionsByPeer.TryGetValue("red-1", out var redQueue) || redQueue.Count == 0,
                    "0 queued card ops",
                    _queuedCardActionsByPeer.TryGetValue("red-1", out redQueue) ? redQueue.Count.ToString() : "0"
                ));
                var redHandCount = _cardBattleState.Players.TryGetValue("red", out var redState) ? redState.Hand.Count : -1;
                assertions.Add(new DemoScenarioAssertion(
                    "red drew one card",
                    redHandCount == 1,
                    "red hand=1",
                    redHandCount.ToString()
                ));
                break;

            default:
                assertions.Add(new DemoScenarioAssertion("known scenario id", false, "known scenario", "unknown scenario"));
                break;
        }

        return assertions;
    }

    private RuntimePeerActionResult RunTacticalPartitionReplayScenario()
    {
        EnsurePeerRegistered("alpha");

        var reset = ExecuteImmediateTacticalAction(BuildAction(action: "reset"), "scenario");
        if (!reset.IsSuccess)
        {
            return reset;
        }

        var partition = ApplyPartitionChange(BuildAction(action: "set-partition", targetPeerId: "alpha", enabled: true), "scenario");
        if (!partition.IsSuccess)
        {
            return partition;
        }

        QueueTacticalAction("alpha", BuildAction(action: "terrain", x: 2, y: 2, value: "wall", actorPeerId: "alpha"));
        QueueTacticalAction("alpha", BuildAction(action: "token-add", team: "blue", actorPeerId: "alpha"));
        QueueTacticalAction("alpha", BuildAction(action: "ping", x: 2, y: 2, label: "scenario-ping", actorPeerId: "alpha"));

        var reconnect = ApplyPartitionChange(BuildAction(action: "set-partition", targetPeerId: "alpha", enabled: false), "scenario");
        if (!reconnect.IsSuccess)
        {
            return reconnect;
        }

        return new RuntimePeerActionResult(true, "Tactical partition/replay scenario complete");
    }

    private RuntimePeerActionResult RunPixelBurstPartitionScenario()
    {
        EnsurePeerRegistered("bravo");

        var reset = ExecuteImmediateTacticalAction(BuildAction(action: "reset"), "scenario");
        if (!reset.IsSuccess)
        {
            return reset;
        }

        var partition = ApplyPartitionChange(BuildAction(action: "set-partition", targetPeerId: "bravo", enabled: true), "scenario");
        if (!partition.IsSuccess)
        {
            return partition;
        }

        var cells = Enumerable.Range(0, 36)
            .Select(i => new TacticalCellWriteDto((i * 3) % _tacticalState.Cols, (i * 5) % _tacticalState.Rows))
            .ToArray();

        QueueTacticalAction("bravo", BuildAction(action: "terrain-batch", value: "difficult", cells: cells, actorPeerId: "bravo"));

        var reconnect = ApplyPartitionChange(BuildAction(action: "set-partition", targetPeerId: "bravo", enabled: false), "scenario");
        if (!reconnect.IsSuccess)
        {
            return reconnect;
        }

        return new RuntimePeerActionResult(true, "Pixel burst/partition scenario complete");
    }

    private RuntimePeerActionResult RunDungeonTriggerReconnectScenario()
    {
        EnsurePeerRegistered("builder");

        var reset = ExecuteImmediateTacticalAction(BuildAction(action: "reset"), "builder");
        if (!reset.IsSuccess)
        {
            return reset;
        }

        var paintRoom = ExecuteImmediateTacticalAction(BuildAction(action: "terrain", x: 4, y: 4, value: "room"), "builder");
        if (!paintRoom.IsSuccess)
        {
            return paintRoom;
        }

        var paintTrap = ExecuteImmediateTacticalAction(BuildAction(action: "terrain", x: 8, y: 8, value: "trap"), "builder");
        if (!paintTrap.IsSuccess)
        {
            return paintTrap;
        }

        var link = ExecuteImmediateTacticalAction(
            BuildAction(action: "link-trigger", x: 4, y: 4, targetX: 8, targetY: 8, label: "scenario-trigger"),
            "builder"
        );
        if (!link.IsSuccess)
        {
            return link;
        }

        var partition = ApplyPartitionChange(BuildAction(action: "set-partition", targetPeerId: "builder", enabled: true), "scenario");
        if (!partition.IsSuccess)
        {
            return partition;
        }

        QueueTacticalAction("builder", BuildAction(action: "terrain", x: 6, y: 6, value: "door", actorPeerId: "builder"));

        var reconnect = ApplyPartitionChange(BuildAction(action: "set-partition", targetPeerId: "builder", enabled: false), "scenario");
        if (!reconnect.IsSuccess)
        {
            return reconnect;
        }

        return new RuntimePeerActionResult(true, "Dungeon trigger/reconnect scenario complete");
    }

    private RuntimePeerActionResult RunCardPrivateTurnScenario()
    {
        EnsurePeerRegistered("blue-1");
        EnsurePeerRegistered("red-1");

        var reset = ExecuteImmediateCardAction(BuildAction(action: "card-reset", actorPeerId: "blue-1"), "blue-1");
        if (!reset.IsSuccess)
        {
            return reset;
        }

        var drawBlue = ExecuteImmediateCardAction(BuildAction(action: "card-draw", team: "blue", actorPeerId: "blue-1"), "blue-1");
        if (!drawBlue.IsSuccess)
        {
            return drawBlue;
        }

        var endBlue = ExecuteImmediateCardAction(BuildAction(action: "card-end-turn", team: "blue", actorPeerId: "blue-1"), "blue-1");
        if (!endBlue.IsSuccess)
        {
            return endBlue;
        }

        var partition = ApplyPartitionChange(BuildAction(action: "set-partition", targetPeerId: "red-1", enabled: true), "scenario");
        if (!partition.IsSuccess)
        {
            return partition;
        }

        QueueCardAction("red-1", BuildAction(action: "card-draw", team: "red", actorPeerId: "red-1"));

        var reconnect = ApplyPartitionChange(BuildAction(action: "set-partition", targetPeerId: "red-1", enabled: false), "scenario");
        if (!reconnect.IsSuccess)
        {
            return reconnect;
        }

        return new RuntimePeerActionResult(true, "Card private-turn scenario complete");
    }

    private RuntimePeerActionResult ExecuteImmediateTacticalAction(TacticalActionRequest request, string actorPeerId)
    {
        var action = request.Action.Trim().ToLowerInvariant();
        var result = action switch
        {
            "terrain" => ApplyTerrain(request, actorPeerId),
            "terrain-batch" => ApplyTerrainBatch(request, actorPeerId),
            "fog" => ApplyFog(request, actorPeerId),
            "ping" => ApplyPing(request, actorPeerId),
            "link-trigger" => ApplyLinkTrigger(request, actorPeerId),
            "unlink-trigger" => ApplyUnlinkTrigger(request, actorPeerId),
            "erase" => ApplyErase(request, actorPeerId),
            "token-move" => ApplyTokenMove(request, actorPeerId),
            "token-add" => ApplyTokenAdd(request, actorPeerId),
            "advance-turn" => ApplyAdvanceTurn(actorPeerId),
            "reset" => ApplyReset(actorPeerId),
            _ => new RuntimePeerActionResult(false, $"Unsupported action '{request.Action}'")
        };

        if (result.IsSuccess)
        {
            _tacticalState = _tacticalState with { UpdatedAtUtc = DateTimeOffset.UtcNow };
            PersistTacticalState();
        }

        return result;
    }

    private RuntimePeerActionResult ExecuteImmediateCardAction(TacticalActionRequest request, string actorPeerId)
    {
        var action = request.Action.Trim().ToLowerInvariant();
        var result = action switch
        {
            "card-draw" => ApplyCardDraw(request, actorPeerId),
            "card-play" => ApplyCardPlay(request, actorPeerId),
            "card-end-turn" => ApplyCardEndTurn(actorPeerId),
            "card-reset" => ApplyCardReset(actorPeerId),
            _ => new RuntimePeerActionResult(false, $"Unsupported action '{request.Action}'")
        };

        if (result.IsSuccess)
        {
            _cardBattleState = _cardBattleState with { UpdatedAtUtc = DateTimeOffset.UtcNow };
            PersistCardBattleState();
        }

        return result;
    }

    private void QueueTacticalAction(string peerId, TacticalActionRequest request)
    {
        if (!_queuedActionsByPeer.TryGetValue(peerId, out var queue))
        {
            queue = [];
            _queuedActionsByPeer[peerId] = queue;
        }

        queue.Add(request);
        AddLocalEvent("tactical", "queued", $"Queued '{request.Action}' for scripted scenario", peerId);
    }

    private void QueueCardAction(string peerId, TacticalActionRequest request)
    {
        if (!_queuedCardActionsByPeer.TryGetValue(peerId, out var queue))
        {
            queue = [];
            _queuedCardActionsByPeer[peerId] = queue;
        }

        queue.Add(request);
        AddLocalEvent("card-battle", "queued", $"Queued '{request.Action}' for scripted scenario", peerId);
    }

    private static TacticalActionRequest BuildAction(
        string action,
        int? x = null,
        int? y = null,
        string? value = null,
        string? tokenId = null,
        string? team = null,
        string? label = null,
        string? actorPeerId = null,
        string? targetPeerId = null,
        string? cardId = null,
        string? targetTeam = null,
        int? targetX = null,
        int? targetY = null,
        bool? enabled = null,
        IReadOnlyList<TacticalCellWriteDto>? cells = null
    )
    {
        return new TacticalActionRequest(
            Action: action,
            X: x,
            Y: y,
            Value: value,
            TokenId: tokenId,
            Team: team,
            Label: label,
            ActorPeerId: actorPeerId,
            TargetPeerId: targetPeerId,
            CardId: cardId,
            TargetTeam: targetTeam,
            TargetX: targetX,
            TargetY: targetY,
            Enabled: enabled,
            Cells: cells
        );
    }

    private RuntimePeerActionResult ApplyPartitionChange(TacticalActionRequest request, string actorPeerId)
    {
        var targetPeerId = string.IsNullOrWhiteSpace(request.TargetPeerId) ? actorPeerId : request.TargetPeerId.Trim();
        EnsurePeerRegistered(targetPeerId);

        var enabled = request.Enabled ?? true;
        if (enabled)
        {
            _partitionedPeers.Add(targetPeerId);
            AddLocalEvent("tactical", "partition", $"Partitioned peer '{targetPeerId}'", actorPeerId);
            return new RuntimePeerActionResult(true, $"Peer '{targetPeerId}' partitioned");
        }

        _partitionedPeers.Remove(targetPeerId);
        AddLocalEvent("tactical", "reconnect", $"Reconnected peer '{targetPeerId}'", actorPeerId);
        ReplayQueuedPeerActions(targetPeerId);
        ReplayQueuedCardActions(targetPeerId);
        return new RuntimePeerActionResult(true, $"Peer '{targetPeerId}' reconnected");
    }

    private void ReplayQueuedPeerActions(string peerId)
    {
        if (!_queuedActionsByPeer.TryGetValue(peerId, out var queuedActions) || queuedActions.Count == 0)
        {
            return;
        }

        var replayList = queuedActions.ToArray();
        queuedActions.Clear();

        foreach (var queued in replayList)
        {
            var action = queued.Action.Trim().ToLowerInvariant();
            var result = action switch
            {
                "terrain" => ApplyTerrain(queued, peerId),
                "terrain-batch" => ApplyTerrainBatch(queued, peerId),
                "fog" => ApplyFog(queued, peerId),
                "ping" => ApplyPing(queued, peerId),
                "link-trigger" => ApplyLinkTrigger(queued, peerId),
                "unlink-trigger" => ApplyUnlinkTrigger(queued, peerId),
                "erase" => ApplyErase(queued, peerId),
                "token-move" => ApplyTokenMove(queued, peerId),
                "token-add" => ApplyTokenAdd(queued, peerId),
                "advance-turn" => ApplyAdvanceTurn(peerId),
                "reset" => ApplyReset(peerId),
                _ => new RuntimePeerActionResult(false, $"Unsupported queued action '{queued.Action}'")
            };

            if (result.IsSuccess)
            {
                _tacticalState = _tacticalState with { UpdatedAtUtc = DateTimeOffset.UtcNow };
                PersistTacticalState();
                AddLocalEvent("tactical", "replay", $"Replayed queued action '{queued.Action}'", peerId);
            }
            else
            {
                AddLocalEvent("tactical", "replay-failed", result.Message, peerId);
            }
        }
    }

    private void ReplayQueuedCardActions(string peerId)
    {
        if (!_queuedCardActionsByPeer.TryGetValue(peerId, out var queuedActions) || queuedActions.Count == 0)
        {
            return;
        }

        var replayList = queuedActions.ToArray();
        queuedActions.Clear();

        foreach (var queued in replayList)
        {
            var action = queued.Action.Trim().ToLowerInvariant();
            var result = action switch
            {
                "card-draw" => ApplyCardDraw(queued, peerId),
                "card-play" => ApplyCardPlay(queued, peerId),
                "card-end-turn" => ApplyCardEndTurn(peerId),
                "card-reset" => ApplyCardReset(peerId),
                _ => new RuntimePeerActionResult(false, $"Unsupported queued action '{queued.Action}'")
            };

            if (result.IsSuccess)
            {
                _cardBattleState = _cardBattleState with { UpdatedAtUtc = DateTimeOffset.UtcNow };
                PersistCardBattleState();
                AddLocalEvent("card-battle", "replay", $"Replayed queued action '{queued.Action}'", peerId);
            }
            else
            {
                AddLocalEvent("card-battle", "replay-failed", result.Message, peerId);
            }
        }
    }

    private void EnsurePeerRegistered(string peerId)
    {
        if (_peers.ContainsKey(peerId))
        {
            return;
        }

        var registration = ConnectPeer(peerId);
        if (!registration.IsSuccess)
        {
            AddLocalEvent("tactical", "peer-register-failed", registration.Message, peerId);
        }
    }

    private void BootstrapDemoPeersIfNeeded()
    {
        if (_bootstrapAttempted)
        {
            return;
        }

        _bootstrapAttempted = true;

        if (!EnsureEngine())
        {
            AddLocalEvent("bootstrap", "runtime-missing", "Native runtime unavailable during demo bootstrap.", null);
            return;
        }

        var bootstrapPeers = new[] { "alpha", "bravo", "delta" };
        foreach (var peerId in bootstrapPeers)
        {
            var result = ConnectPeer(peerId);
            if (!result.IsSuccess)
            {
                AddLocalEvent("bootstrap", "peer-connect-failed", result.Message, peerId);
            }
        }
    }

    private RuntimePeerActionResult ApplyTerrain(TacticalActionRequest request, string actorPeerId)
    {
        if (!TryGetCell(request, out var x, out var y, out var error))
        {
            return new RuntimePeerActionResult(false, error!);
        }

        var terrainValue = (request.Value ?? "plain").Trim().ToLowerInvariant();
        if (terrainValue is not ("plain" or "wall" or "difficult"))
        {
            return new RuntimePeerActionResult(false, "terrain value must be plain, wall, or difficult");
        }

        _tacticalState.Terrain[y][x] = terrainValue;
        AddLocalEvent("tactical", "terrain", $"Set ({x},{y}) to {terrainValue}", actorPeerId);
        return new RuntimePeerActionResult(true, "ok");
    }

    private RuntimePeerActionResult ApplyTerrainBatch(TacticalActionRequest request, string actorPeerId)
    {
        var terrainValue = (request.Value ?? "plain").Trim().ToLowerInvariant();
        if (terrainValue is not ("plain" or "wall" or "difficult"))
        {
            return new RuntimePeerActionResult(false, "terrain value must be plain, wall, or difficult");
        }

        if (request.Cells is null || request.Cells.Count == 0)
        {
            return new RuntimePeerActionResult(false, "cells is required for terrain-batch");
        }

        if (request.Cells.Count > 1024)
        {
            return new RuntimePeerActionResult(false, "terrain-batch supports up to 1024 cells per request");
        }

        var applied = 0;
        var skipped = 0;
        foreach (var cell in request.Cells)
        {
            if (cell.X < 0 || cell.Y < 0 || cell.X >= _tacticalState.Cols || cell.Y >= _tacticalState.Rows)
            {
                skipped += 1;
                continue;
            }

            _tacticalState.Terrain[cell.Y][cell.X] = terrainValue;
            applied += 1;
        }

        if (applied == 0)
        {
            return new RuntimePeerActionResult(false, "terrain-batch had no valid cells to apply");
        }

        var suffix = skipped > 0 ? $", skipped {skipped} invalid" : string.Empty;
        AddLocalEvent("tactical", "terrain-batch", $"Applied {applied} cell write(s) as {terrainValue}{suffix}", actorPeerId);
        return new RuntimePeerActionResult(true, "ok");
    }

    private RuntimePeerActionResult ApplyFog(TacticalActionRequest request, string actorPeerId)
    {
        if (!TryGetCell(request, out var x, out var y, out var error))
        {
            return new RuntimePeerActionResult(false, error!);
        }

        _tacticalState.Fog[y][x] = !_tacticalState.Fog[y][x];
        AddLocalEvent("tactical", "fog", $"Toggled fog at ({x},{y})", actorPeerId);
        return new RuntimePeerActionResult(true, "ok");
    }

    private RuntimePeerActionResult ApplyPing(TacticalActionRequest request, string actorPeerId)
    {
        if (!TryGetCell(request, out var x, out var y, out var error))
        {
            return new RuntimePeerActionResult(false, error!);
        }

        var ping = new TacticalPingDto(
            Id: $"ping-{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}-{x}-{y}",
            X: x,
            Y: y,
            Label: string.IsNullOrWhiteSpace(request.Label) ? $"Ping {x},{y}" : request.Label.Trim()
        );

        _tacticalState.Pings.Insert(0, ping);
        if (_tacticalState.Pings.Count > 40)
        {
            _tacticalState.Pings.RemoveRange(40, _tacticalState.Pings.Count - 40);
        }

        AddLocalEvent("tactical", "ping", $"Pinged sector ({x},{y})", actorPeerId);
        return new RuntimePeerActionResult(true, "ok");
    }

    private RuntimePeerActionResult ApplyLinkTrigger(TacticalActionRequest request, string actorPeerId)
    {
        if (!TryGetCell(request, out var fromX, out var fromY, out var error))
        {
            return new RuntimePeerActionResult(false, error!);
        }

        var toX = request.TargetX;
        var toY = request.TargetY;
        if (toX is null || toY is null || toX < 0 || toY < 0 || toX >= _tacticalState.Cols || toY >= _tacticalState.Rows)
        {
            return new RuntimePeerActionResult(false, "targetX and targetY must be valid board coordinates");
        }

        var link = new TacticalTriggerLinkDto(
            Id: $"link-{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}-{fromX}-{fromY}-{toX}-{toY}",
            FromX: fromX,
            FromY: fromY,
            ToX: toX.Value,
            ToY: toY.Value,
            Label: string.IsNullOrWhiteSpace(request.Label) ? "trigger" : request.Label.Trim()
        );

        _tacticalState.TriggerLinks.Add(link);
        AddLocalEvent("tactical", "link-trigger", $"Linked trigger ({fromX},{fromY}) -> ({toX},{toY})", actorPeerId);
        return new RuntimePeerActionResult(true, "ok");
    }

    private RuntimePeerActionResult ApplyUnlinkTrigger(TacticalActionRequest request, string actorPeerId)
    {
        if (!TryGetCell(request, out var fromX, out var fromY, out var error))
        {
            return new RuntimePeerActionResult(false, error!);
        }

        var removed = _tacticalState.TriggerLinks.RemoveAll(link => link.FromX == fromX && link.FromY == fromY);
        AddLocalEvent("tactical", "unlink-trigger", $"Removed {removed} trigger link(s) from ({fromX},{fromY})", actorPeerId);
        return new RuntimePeerActionResult(true, "ok");
    }

    private RuntimePeerActionResult ApplyErase(TacticalActionRequest request, string actorPeerId)
    {
        if (!TryGetCell(request, out var x, out var y, out var error))
        {
            return new RuntimePeerActionResult(false, error!);
        }

        _tacticalState.Terrain[y][x] = "plain";
        _tacticalState.Fog[y][x] = false;
        _tacticalState.Tokens.RemoveAll(token => token.X == x && token.Y == y);
        _tacticalState.Pings.RemoveAll(ping => ping.X == x && ping.Y == y);
        _tacticalState.TriggerLinks.RemoveAll(link => link.FromX == x && link.FromY == y || link.ToX == x && link.ToY == y);

        AddLocalEvent("tactical", "erase", $"Cleared cell ({x},{y})", actorPeerId);
        return new RuntimePeerActionResult(true, "ok");
    }

    private RuntimePeerActionResult ApplyTokenMove(TacticalActionRequest request, string actorPeerId)
    {
        if (string.IsNullOrWhiteSpace(request.TokenId))
        {
            return new RuntimePeerActionResult(false, "tokenId is required");
        }

        if (!TryGetCell(request, out var x, out var y, out var error))
        {
            return new RuntimePeerActionResult(false, error!);
        }

        var index = _tacticalState.Tokens.FindIndex(token => string.Equals(token.Id, request.TokenId, StringComparison.Ordinal));
        if (index < 0)
        {
            return new RuntimePeerActionResult(false, "token not found");
        }

        var token = _tacticalState.Tokens[index];
        _tacticalState.Tokens[index] = token with { X = x, Y = y };
        AddLocalEvent("tactical", "token-move", $"Moved {token.Name} to ({x},{y})", actorPeerId);
        return new RuntimePeerActionResult(true, "ok");
    }

    private RuntimePeerActionResult ApplyTokenAdd(TacticalActionRequest request, string actorPeerId)
    {
        var team = (request.Team ?? "blue").Trim().ToLowerInvariant();
        if (team is not ("blue" or "red"))
        {
            return new RuntimePeerActionResult(false, "team must be blue or red");
        }

        var prefix = team == "blue" ? "A" : "R";
        var counter = _tacticalState.Tokens.Count(token => string.Equals(token.Team, team, StringComparison.OrdinalIgnoreCase)) + 1;
        var token = new TacticalTokenDto(
            Id: $"{team}-{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}",
            Name: $"{prefix}{counter}",
            Team: team,
            X: team == "blue" ? 1 : _tacticalState.Cols - 2,
            Y: team == "blue" ? 1 : _tacticalState.Rows - 2,
            Hp: 10
        );

        _tacticalState.Tokens.Add(token);
        AddLocalEvent("tactical", "token-add", $"Added {token.Name} ({team})", actorPeerId);
        return new RuntimePeerActionResult(true, "ok");
    }

    private RuntimePeerActionResult ApplyAdvanceTurn(string actorPeerId)
    {
        _tacticalState = _tacticalState with { Turn = _tacticalState.Turn + 1 };
        AddLocalEvent("tactical", "turn", "Advanced initiative turn", actorPeerId);
        return new RuntimePeerActionResult(true, "ok");
    }

    private RuntimePeerActionResult ApplyReset(string actorPeerId)
    {
        _tacticalState = TacticalState.CreateDefault();
        AddLocalEvent("tactical", "reset", "Board reset to baseline tactical state", actorPeerId);
        return new RuntimePeerActionResult(true, "ok");
    }

    private RuntimePeerActionResult ApplyCardDraw(TacticalActionRequest request, string actorPeerId)
    {
        var team = ResolveCardTeam(request.Team, actorPeerId);
        if (!_cardBattleState.Players.TryGetValue(team, out var player))
        {
            return new RuntimePeerActionResult(false, $"Unknown team '{team}'");
        }

        if (_cardBattleState.ActiveTeam != team)
        {
            return new RuntimePeerActionResult(false, $"It is not {team}'s turn");
        }

        if (player.Deck.Count == 0)
        {
            return new RuntimePeerActionResult(false, $"{team} has no cards left in deck");
        }

        var nextDeck = player.Deck.ToList();
        var card = nextDeck[0];
        nextDeck.RemoveAt(0);

        var nextHand = player.Hand.ToList();
        nextHand.Add(card);
        if (nextHand.Count > 8)
        {
            return new RuntimePeerActionResult(false, "Hand is full");
        }

        _cardBattleState.Players[team] = player with { Deck = nextDeck, Hand = nextHand };
        AddLocalEvent("card-battle", "draw", $"{team} drew {card.Name}", actorPeerId);
        return new RuntimePeerActionResult(true, "ok");
    }

    private RuntimePeerActionResult ApplyCardPlay(TacticalActionRequest request, string actorPeerId)
    {
        var team = ResolveCardTeam(request.Team, actorPeerId);
        if (!_cardBattleState.Players.TryGetValue(team, out var player))
        {
            return new RuntimePeerActionResult(false, $"Unknown team '{team}'");
        }

        if (_cardBattleState.ActiveTeam != team)
        {
            return new RuntimePeerActionResult(false, $"It is not {team}'s turn");
        }

        if (string.IsNullOrWhiteSpace(request.CardId))
        {
            return new RuntimePeerActionResult(false, "cardId is required");
        }

        var hand = player.Hand.ToList();
        var cardIndex = hand.FindIndex(card => string.Equals(card.Id, request.CardId, StringComparison.Ordinal));
        if (cardIndex < 0)
        {
            return new RuntimePeerActionResult(false, "card not found in hand");
        }

        var card = hand[cardIndex];
        if (player.Energy < card.Cost)
        {
            return new RuntimePeerActionResult(false, "insufficient energy");
        }

        var targetTeam = (request.TargetTeam ?? OpponentTeam(team)).Trim().ToLowerInvariant();
        if (!_cardBattleState.Players.TryGetValue(targetTeam, out var targetPlayer))
        {
            return new RuntimePeerActionResult(false, $"Unknown target team '{targetTeam}'");
        }

        hand.RemoveAt(cardIndex);
        var discard = player.Discard.ToList();
        discard.Add(card);
        var updatedPlayer = player with { Hand = hand, Discard = discard, Energy = player.Energy - card.Cost };
        _cardBattleState.Players[team] = updatedPlayer;

        if (card.EffectType == "damage")
        {
            var hp = Math.Max(0, targetPlayer.Hp - card.Amount);
            _cardBattleState.Players[targetTeam] = targetPlayer with { Hp = hp };
            AddLocalEvent("card-battle", "play", $"{team} played {card.Name} for {card.Amount} damage to {targetTeam}", actorPeerId);
        }
        else
        {
            var hp = Math.Min(30, targetPlayer.Hp + card.Amount);
            _cardBattleState.Players[targetTeam] = targetPlayer with { Hp = hp };
            AddLocalEvent("card-battle", "play", $"{team} played {card.Name} to heal {targetTeam} for {card.Amount}", actorPeerId);
        }

        return new RuntimePeerActionResult(true, "ok");
    }

    private RuntimePeerActionResult ApplyCardEndTurn(string actorPeerId)
    {
        var team = ResolveCardTeam(null, actorPeerId);
        if (_cardBattleState.ActiveTeam != team)
        {
            return new RuntimePeerActionResult(false, $"It is not {team}'s turn");
        }

        var nextTeam = OpponentTeam(team);
        _cardBattleState = _cardBattleState with
        {
            Turn = _cardBattleState.Turn + 1,
            ActiveTeam = nextTeam
        };

        if (_cardBattleState.Players.TryGetValue(nextTeam, out var nextPlayer))
        {
            _cardBattleState.Players[nextTeam] = nextPlayer with { Energy = Math.Min(6, nextPlayer.Energy + 1) };
        }

        AddLocalEvent("card-battle", "turn", $"Turn advanced to {_cardBattleState.Turn} ({nextTeam})", actorPeerId);
        return new RuntimePeerActionResult(true, "ok");
    }

    private RuntimePeerActionResult ApplyCardReset(string actorPeerId)
    {
        _cardBattleState = CardBattleState.CreateDefault();
        AddLocalEvent("card-battle", "reset", "Card battle reset to baseline", actorPeerId);
        return new RuntimePeerActionResult(true, "ok");
    }

    private static string ResolveCardTeam(string? requestedTeam, string actorPeerId)
    {
        if (!string.IsNullOrWhiteSpace(requestedTeam))
        {
            return requestedTeam.Trim().ToLowerInvariant();
        }

        return actorPeerId.Contains("red", StringComparison.OrdinalIgnoreCase) ? "red" : "blue";
    }

    private static string OpponentTeam(string team)
    {
        return string.Equals(team, "blue", StringComparison.OrdinalIgnoreCase) ? "red" : "blue";
    }

    private bool TryGetCell(TacticalActionRequest request, out int x, out int y, out string? error)
    {
        x = request.X ?? -1;
        y = request.Y ?? -1;

        if (x < 0 || y < 0 || x >= _tacticalState.Cols || y >= _tacticalState.Rows)
        {
            error = "x and y must be valid board coordinates";
            return false;
        }

        error = null;
        return true;
    }

    private TacticalBoardStateResponse ToTacticalResponse(TacticalState state)
    {
        return new TacticalBoardStateResponse(
            Rows: state.Rows,
            Cols: state.Cols,
            Terrain: state.Terrain.Select(row => (IReadOnlyList<string>)row.AsReadOnly()).ToArray(),
            Fog: state.Fog.Select(row => (IReadOnlyList<bool>)row.AsReadOnly()).ToArray(),
            Tokens: state.Tokens.ToArray(),
            Pings: state.Pings.ToArray(),
            TriggerLinks: state.TriggerLinks.ToArray(),
            Turn: state.Turn,
            PartitionedPeers: _partitionedPeers.OrderBy(peer => peer, StringComparer.OrdinalIgnoreCase).ToArray(),
            QueuedOps: _queuedActionsByPeer
                .Where(pair => pair.Value.Count > 0)
                .OrderBy(pair => pair.Key, StringComparer.OrdinalIgnoreCase)
                .Select(pair => new PeerQueueDepthDto(pair.Key, pair.Value.Count))
                .ToArray(),
            UpdatedAtUtc: state.UpdatedAtUtc
        );
    }

    private CardBattleStateResponse ToCardBattleResponse(CardBattleState state, string? viewerPeerId, string? forcedPerspective)
    {
        var viewerTeam = ResolveViewerTeam(viewerPeerId, forcedPerspective);

        return new CardBattleStateResponse(
            Turn: state.Turn,
            ActiveTeam: state.ActiveTeam,
            Players: state.Players
                .OrderBy(pair => pair.Key, StringComparer.OrdinalIgnoreCase)
                .Select(pair =>
                {
                    var team = pair.Key;
                    var participant = pair.Value;
                    var canSeeHand = viewerTeam is not null &&
                                     !string.Equals(viewerTeam, "observer", StringComparison.OrdinalIgnoreCase) &&
                                     string.Equals(viewerTeam, team, StringComparison.OrdinalIgnoreCase);

                    var hand = canSeeHand ? participant.Hand.ToArray() : Array.Empty<CardBattleCardDto>();
                    var concealedCount = canSeeHand ? 0 : participant.Hand.Count;

                    return new CardBattlePlayerStateDto(
                        Team: team,
                        Hp: participant.Hp,
                        Energy: participant.Energy,
                        DeckCount: participant.Deck.Count,
                        DiscardCount: participant.Discard.Count,
                        ConcealedHandCount: concealedCount,
                        Hand: hand
                    );
                })
                .ToArray(),
            PartitionedPeers: _partitionedPeers.OrderBy(peer => peer, StringComparer.OrdinalIgnoreCase).ToArray(),
            QueuedOps: _queuedCardActionsByPeer
                .Where(pair => pair.Value.Count > 0)
                .OrderBy(pair => pair.Key, StringComparer.OrdinalIgnoreCase)
                .Select(pair => new PeerQueueDepthDto(pair.Key, pair.Value.Count))
                .ToArray(),
            UpdatedAtUtc: state.UpdatedAtUtc
        );
    }

    private static string ResolveViewerTeam(string? viewerPeerId, string? forcedPerspective)
    {
        if (!string.IsNullOrWhiteSpace(forcedPerspective))
        {
            var requested = forcedPerspective.Trim().ToLowerInvariant();
            if (requested is "observer" or "blue" or "red")
            {
                return requested;
            }
        }

        if (string.IsNullOrWhiteSpace(viewerPeerId))
        {
            return "observer";
        }

        var peer = viewerPeerId.Trim().ToLowerInvariant();
        if (peer.Contains("observer") || peer.Contains("spectator") || peer.Contains("obs"))
        {
            return "observer";
        }

        return peer.Contains("red") ? "red" : "blue";
    }

    private void PersistTacticalState()
    {
        if (!EnsureEngine())
        {
            return;
        }

        if (!_peers.Values.Any(peer => peer.Online))
        {
            var bootstrap = ConnectPeer("alpha");
            if (!bootstrap.IsSuccess)
            {
                AddLocalEvent("tactical", "persist-skip", "Unable to bootstrap runtime peer for tactical persistence", null);
                return;
            }
        }

        var value = JsonSerializer.SerializeToNode(new
        {
            rows = _tacticalState.Rows,
            cols = _tacticalState.Cols,
            terrain = _tacticalState.Terrain,
            fog = _tacticalState.Fog,
            tokens = _tacticalState.Tokens,
            pings = _tacticalState.Pings,
            triggerLinks = _tacticalState.TriggerLinks,
            turn = _tacticalState.Turn,
            updatedAtUtc = _tacticalState.UpdatedAtUtc
        }) ?? JsonValue.Create((string?)null)!;

        var envelope = SerializeEnvelope(
            DemoRoomId,
            new JsonObject
            {
                ["MapSet"] = new JsonObject
                {
                    ["namespace"] = "tactical-strategy",
                    ["key"] = "board-state-v1",
                    ["value"] = value
                }
            }
        );

        var dispatch = DispatchCommand(envelope);
        if (!dispatch.IsSuccess)
        {
            AddLocalEvent("tactical", "persist-failed", dispatch.Message, null);
        }
    }

    private void PersistCardBattleState()
    {
        if (!EnsureEngine())
        {
            return;
        }

        if (!_peers.Values.Any(peer => peer.Online))
        {
            var bootstrap = ConnectPeer("alpha");
            if (!bootstrap.IsSuccess)
            {
                AddLocalEvent("card-battle", "persist-skip", "Unable to bootstrap runtime peer for card battle persistence", null);
                return;
            }
        }

        var value = JsonSerializer.SerializeToNode(new
        {
            turn = _cardBattleState.Turn,
            activeTeam = _cardBattleState.ActiveTeam,
            players = _cardBattleState.Players,
            updatedAtUtc = _cardBattleState.UpdatedAtUtc
        }) ?? JsonValue.Create((string?)null)!;

        var envelope = SerializeEnvelope(
            DemoRoomId,
            new JsonObject
            {
                ["MapSet"] = new JsonObject
                {
                    ["namespace"] = "card-battle",
                    ["key"] = "state-v1",
                    ["value"] = value
                }
            }
        );

        var dispatch = DispatchCommand(envelope);
        if (!dispatch.IsSuccess)
        {
            AddLocalEvent("card-battle", "persist-failed", dispatch.Message, null);
        }
    }

    private bool EnsureEngine()
    {
        if (_ffi is not null)
        {
            return true;
        }

        var probe = _nativeProbe.Probe();
        if (!probe.Available)
        {
            return false;
        }

        try
        {
            _ffi = new HostFfiClient();
            return true;
        }
        catch (Exception ex)
        {
            AddLocalEvent("host", "ffi-init-failed", ex.Message, null);
            return false;
        }
    }

    private RuntimePeerActionResult DispatchCommand(string commandJson)
    {
        if (_ffi is null)
        {
            return new RuntimePeerActionResult(false, "Native runtime is not initialized");
        }

        var (status, eventsJson) = _ffi.SubmitCommandJson(commandJson);
        if (status != AsStatus.Ok)
        {
            AddLocalEvent("command", "dispatch-failed", $"status={status}", null, commandJson);
            return new RuntimePeerActionResult(false, $"Runtime command failed: {status}");
        }

        AddLocalEvent("command", "dispatch", "Runtime command dispatched", null, commandJson);
        ParseAndApplyEvents(eventsJson);
        return new RuntimePeerActionResult(true, "ok");
    }

    private void ParseAndApplyEvents(string eventsJson)
    {
        JsonNode? parsed;
        try
        {
            parsed = JsonNode.Parse(eventsJson);
        }
        catch
        {
            AddLocalEvent("events", "parse-error", "Runtime returned non-JSON event payload", null, eventsJson);
            return;
        }

        if (parsed is not JsonArray eventsArray)
        {
            return;
        }

        foreach (var eventNode in eventsArray)
        {
            if (eventNode is not JsonObject evt)
            {
                continue;
            }

            if (evt.TryGetPropertyValue("SessionOpened", out var sessionOpenedNode) && sessionOpenedNode is JsonObject sessionOpened)
            {
                var sessionId = sessionOpened["session_id"]?.GetValue<ulong?>();
                if (sessionId is not null && _sessionToPeer.TryGetValue(sessionId.Value, out var peerId) && _peers.TryGetValue(peerId, out var peer))
                {
                    _peers[peerId] = peer with { Online = true, LastSeenUtc = DateTimeOffset.UtcNow };
                }

                AddLocalEvent("event", "session-opened", CompactJson(sessionOpened), sessionId?.ToString());
                continue;
            }

            if (evt.TryGetPropertyValue("SessionClosed", out var sessionClosedNode) && sessionClosedNode is JsonObject sessionClosed)
            {
                var sessionId = sessionClosed["session_id"]?.GetValue<ulong?>();
                if (sessionId is not null && _sessionToPeer.TryGetValue(sessionId.Value, out var peerId) && _peers.TryGetValue(peerId, out var peer))
                {
                    _peers[peerId] = peer with { Online = false, LastSeenUtc = DateTimeOffset.UtcNow };
                }

                AddLocalEvent("event", "session-closed", CompactJson(sessionClosed), sessionId?.ToString());
                continue;
            }

            if (evt.TryGetPropertyValue("PresenceValueSet", out var presenceSetNode) && presenceSetNode is JsonObject presenceSet)
            {
                var sessionId = presenceSet["session_id"]?.GetValue<ulong?>();
                var fromPeer = presenceSet["from_peer_pubkey"]?.GetValue<string>();
                if (!string.IsNullOrWhiteSpace(fromPeer) && sessionId is not null)
                {
                    _sessionToPeer[sessionId.Value] = fromPeer;
                    _peers[fromPeer] = new PeerRuntimeState(
                        PeerId: fromPeer,
                        SessionId: sessionId.Value,
                        Online: true,
                        LastSeenUtc: DateTimeOffset.UtcNow,
                        FrontierCount: 0
                    );
                }

                AddLocalEvent("event", "presence-set", CompactJson(presenceSet), fromPeer);
                continue;
            }

            AddLocalEvent("event", "runtime", CompactJson(evt), null);
        }
    }

    private void AddLocalEvent(string stream, string type, string message, string? peerId, string? payload = null)
    {
        _eventLog.Add(new ReplayEventItem(
            TimestampUtc: DateTimeOffset.UtcNow,
            Stream: stream,
            Type: type,
            PeerId: peerId,
            Message: message,
            PayloadJson: payload
        ));

        if (_eventLog.Count > 400)
        {
            _eventLog.RemoveRange(0, _eventLog.Count - 400);
        }
    }

    private static string CompactJson(JsonNode node)
    {
        return node.ToJsonString(new JsonSerializerOptions
        {
            WriteIndented = false
        });
    }

    private static string SerializeEnvelope(string roomId, JsonNode commandNode)
    {
        return new JsonObject
        {
            ["room_id"] = roomId,
            ["command"] = commandNode
        }.ToJsonString();
    }

    private static IReadOnlyList<string> BuildHelloCommands(string peerId, ulong sessionId)
    {
        var commands = new List<string>
        {
            SerializeEnvelope(DemoRoomId, JsonValue.Create("EnsureRoom")!),
            SerializeEnvelope(
                DemoRoomId,
                new JsonObject
                {
                    ["OpenSession"] = new JsonObject
                    {
                        ["session_id"] = sessionId,
                        ["peer_pubkey_hex"] = peerId
                    }
                }
            ),
            SerializeEnvelope(
                DemoRoomId,
                new JsonObject
                {
                    ["ClientHello"] = new JsonObject
                    {
                        ["session_id"] = sessionId,
                        ["hello"] = new JsonObject
                        {
                            ["peer_pubkey_hex"] = peerId,
                            ["client_frontier"] = new JsonArray(),
                            ["capabilities"] = new JsonObject
                            {
                                ["supports_ibf"] = true,
                                ["supports_mst"] = true
                            }
                        }
                    }
                }
            ),
            SerializeEnvelope(
                DemoRoomId,
                new JsonObject
                {
                    ["PresenceSet"] = new JsonObject
                    {
                        ["session_id"] = sessionId,
                        ["data"] = new JsonObject
                        {
                            ["role"] = "operator",
                            ["status"] = "active"
                        },
                        ["ttl_ms"] = 30000,
                        ["now_unix_ms"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
                    }
                }
            )
        };

        return commands;
    }

    private sealed record PeerRuntimeState(
        string PeerId,
        ulong SessionId,
        bool Online,
        DateTimeOffset LastSeenUtc,
        int FrontierCount
    );

    private sealed record TacticalState(
        int Rows,
        int Cols,
        List<List<string>> Terrain,
        List<List<bool>> Fog,
        List<TacticalTokenDto> Tokens,
        List<TacticalPingDto> Pings,
        List<TacticalTriggerLinkDto> TriggerLinks,
        int Turn,
        DateTimeOffset UpdatedAtUtc
    )
    {
        public static TacticalState CreateDefault()
        {
            const int rows = 12;
            const int cols = 16;

            var terrain = Enumerable.Range(0, rows)
                .Select(_ => Enumerable.Range(0, cols).Select(__ => "plain").ToList())
                .ToList();
            var fog = Enumerable.Range(0, rows)
                .Select(_ => Enumerable.Range(0, cols).Select(__ => false).ToList())
                .ToList();

            var tokens = new List<TacticalTokenDto>
            {
                new("t-blue-1", "A1", "blue", 2, 2, 10),
                new("t-blue-2", "A2", "blue", 3, 5, 8),
                new("t-red-1", "R1", "red", 12, 8, 10),
                new("t-red-2", "R2", "red", 10, 3, 7)
            };

            return new TacticalState(rows, cols, terrain, fog, tokens, [], [], 1, DateTimeOffset.UtcNow);
        }
    }

    private sealed record CardBattleParticipantState(
        int Hp,
        int Energy,
        List<CardBattleCardDto> Deck,
        List<CardBattleCardDto> Hand,
        List<CardBattleCardDto> Discard
    );

    private sealed record CardBattleState(
        int Turn,
        string ActiveTeam,
        Dictionary<string, CardBattleParticipantState> Players,
        DateTimeOffset UpdatedAtUtc
    )
    {
        public static CardBattleState CreateDefault()
        {
            static List<CardBattleCardDto> BuildDeck(string prefix)
            {
                var cards = new List<CardBattleCardDto>();
                for (var i = 0; i < 4; i++)
                {
                    cards.Add(new CardBattleCardDto($"{prefix}-strike-{i}", "Strike", "damage", 4, 1));
                    cards.Add(new CardBattleCardDto($"{prefix}-blast-{i}", "Blast", "damage", 6, 2));
                    cards.Add(new CardBattleCardDto($"{prefix}-mend-{i}", "Mend", "heal", 3, 1));
                }

                return cards;
            }

            var players = new Dictionary<string, CardBattleParticipantState>(StringComparer.OrdinalIgnoreCase)
            {
                ["blue"] = new CardBattleParticipantState(30, 3, BuildDeck("blue"), [], []),
                ["red"] = new CardBattleParticipantState(30, 3, BuildDeck("red"), [], [])
            };

            return new CardBattleState(1, "blue", players, DateTimeOffset.UtcNow);
        }
    }

    public void Dispose()
    {
        lock (_sync)
        {
            _ffi?.Dispose();
            _ffi = null;
        }
    }
}
