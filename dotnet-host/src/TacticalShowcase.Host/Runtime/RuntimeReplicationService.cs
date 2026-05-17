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

    public void Dispose()
    {
        lock (_sync)
        {
            _ffi?.Dispose();
            _ffi = null;
        }
    }
}
