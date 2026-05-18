using System.Text.Json;
using System.Text.Json.Nodes;
using TacticalShowcase.Host.Contracts;
using TacticalShowcase.Host.Ffi;

namespace TacticalShowcase.Host.Runtime;

public interface IRuntimeReplicationService
{
    ReplicationTopologyResponse GetTopology();
    ReplayEventsResponse GetReplayEvents(int take);
    RuntimePeerActionResult ConnectPeer(string peerId);
    RuntimePeerActionResult DisconnectPeer(string peerId);
    TacticalBoardStateResponse GetTacticalState();
    TacticalActionResponse ApplyTacticalAction(TacticalActionRequest request);
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
    private TacticalState _tacticalState = TacticalState.CreateDefault();

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

    public ReplayEventsResponse GetReplayEvents(int take)
    {
        lock (_sync)
        {
            var normalizedTake = Math.Clamp(take, 10, 200);
            var items = _eventLog
                .TakeLast(normalizedTake)
                .Reverse<ReplayEventItem>()
                .ToArray();

            return new ReplayEventsResponse(DemoRoomId, DateTimeOffset.UtcNow, items);
        }
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

    public void Dispose()
    {
        lock (_sync)
        {
            _ffi?.Dispose();
            _ffi = null;
        }
    }
}
