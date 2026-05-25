using ActiveSync.Host.Composition;
using TacticalShowcase.Host.Contracts;
using TacticalShowcase.Host.Ffi;
using TacticalShowcase.Host.Runtime;
using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;

var builder = WebApplication.CreateBuilder(args);
var hostUrls = Environment.GetEnvironmentVariable("TACTICAL_HOST_URLS");
builder.WebHost.UseUrls(string.IsNullOrWhiteSpace(hostUrls) ? "http://0.0.0.0:5074" : hostUrls);

builder.Services.AddSingleton<INativeRuntimeProbe, NativeRuntimeProbe>();
builder.Services.AddSingleton<IRuntimeReplicationService, RuntimeReplicationService>();
builder.Services.AddSingleton<IRoomWorkspaceService, RoomWorkspaceService>();
builder.Services.AddActiveSyncHostProviders(builder.Configuration);

builder.Services.AddCors(options =>
{
    options.AddPolicy("WebReactDev", policy =>
    {
        policy
            .SetIsOriginAllowed(origin =>
            {
                if (!Uri.TryCreate(origin, UriKind.Absolute, out var uri))
                {
                    return false;
                }

                if (!string.Equals(uri.Scheme, "http", StringComparison.OrdinalIgnoreCase)
                    && !string.Equals(uri.Scheme, "https", StringComparison.OrdinalIgnoreCase))
                {
                    return false;
                }

                return uri.Port is 4173 or 5173;
            })
            .AllowAnyHeader()
            .AllowAnyMethod();
    });
});

var app = builder.Build();

var signalRooms = new ConcurrentDictionary<string, ConcurrentDictionary<string, WebSocket>>(StringComparer.OrdinalIgnoreCase);
var runtimeRooms = new ConcurrentDictionary<string, ConcurrentDictionary<string, (string RoomId, string PeerId, WebSocket Socket)>>(StringComparer.OrdinalIgnoreCase);
var runtimePresence = new ConcurrentDictionary<string, ConcurrentDictionary<string, (object? Data, long ExpiresAtUnixMs)>>(StringComparer.OrdinalIgnoreCase);

app.UseCors("WebReactDev");
app.UseWebSockets();

app.MapGet("/", () => Results.Ok(new
{
    service = "activesync-tactical-showcase-host",
    runtime = ".NET",
    status = "ready"
}));

app.MapGet("/api/host/health", (INativeRuntimeProbe runtimeProbe) =>
{
    var probe = runtimeProbe.Probe();
    return Results.Ok(new HostHealthResponse(
        Service: "activesync-tactical-showcase-host",
        Status: "ok",
        TimestampUtc: DateTimeOffset.UtcNow,
        NativeRuntime: new NativeRuntimeStatus(
            Available: probe.Available,
            LibraryName: NativeMethods.LibraryName,
            AbiVersion: probe.AbiVersion,
            Error: probe.Error
        )
    ));
});

app.MapGet("/api/replication/topology", (IRuntimeReplicationService runtime) =>
{
    return Results.Ok(runtime.GetTopology());
});

app.MapGet("/api/replication/events", (IRuntimeReplicationService runtime, int? take, string? viewerPeerId, string? perspective) =>
{
    return Results.Ok(runtime.GetReplayEvents(take ?? 60, viewerPeerId, perspective));
});

app.MapPost("/api/runtime/peers/connect", (IRuntimeReplicationService runtime, PeerActionRequest request) =>
{
    var result = runtime.ConnectPeer(request.PeerId);
    return Results.Ok(new PeerActionResponse(result.IsSuccess, result.Message));
});

app.MapPost("/api/runtime/peers/disconnect", (IRuntimeReplicationService runtime, PeerActionRequest request) =>
{
    var result = runtime.DisconnectPeer(request.PeerId);
    return Results.Ok(new PeerActionResponse(result.IsSuccess, result.Message));
});

app.MapGet("/api/tactical/state", (IRuntimeReplicationService runtime) =>
{
    return Results.Ok(runtime.GetTacticalState());
});

app.MapPost("/api/tactical/action", (IRuntimeReplicationService runtime, TacticalActionRequest request) =>
{
    return Results.Ok(runtime.ApplyTacticalAction(request));
});

app.MapGet("/api/card-battle/state", (IRuntimeReplicationService runtime, string? viewerPeerId, string? perspective) =>
{
    return Results.Ok(runtime.GetCardBattleState(viewerPeerId, perspective));
});

app.MapPost("/api/card-battle/action", (IRuntimeReplicationService runtime, TacticalActionRequest request) =>
{
    return Results.Ok(runtime.ApplyCardBattleAction(request));
});

app.MapPost("/api/scenarios/run", (IRuntimeReplicationService runtime, DemoScenarioRunRequest request) =>
{
    return Results.Ok(runtime.RunDemoScenario(request.ScenarioId));
});

app.MapGet("/api/workspace/rooms/{roomId}/state", (IRoomWorkspaceService workspace, string roomId) =>
{
    return Results.Ok(workspace.GetState(roomId));
});

app.MapGet("/api/workspace/rooms/{roomId}/events", (IRoomWorkspaceService workspace, string roomId, int? take) =>
{
    return Results.Ok(workspace.GetEvents(roomId, take ?? 120));
});

app.MapGet("/api/workspace/rooms/{roomId}/operations", (IRoomWorkspaceService workspace, string roomId, int? take) =>
{
    return Results.Ok(workspace.GetOperations(roomId, take ?? 2000));
});

app.MapPost("/api/workspace/rooms/{roomId}/ops", (IRoomWorkspaceService workspace, string roomId, WorkspaceOperationRequest request) =>
{
    try
    {
        return Results.Ok(workspace.ApplyOperation(roomId, request));
    }
    catch (InvalidOperationException ex)
    {
        return Results.BadRequest(new { ok = false, message = ex.Message });
    }
});

app.MapGet("/api/workspace/rooms/{roomId}/ws", async (HttpContext context, IRoomWorkspaceService workspace, string roomId) =>
{
    if (!context.WebSockets.IsWebSocketRequest)
    {
        context.Response.StatusCode = StatusCodes.Status400BadRequest;
        await context.Response.WriteAsync("WebSocket upgrade required");
        return;
    }

    using var socket = await context.WebSockets.AcceptWebSocketAsync();

    try
    {
        await foreach (var operation in workspace.SubscribeOperations(roomId, context.RequestAborted))
        {
            if (socket.State != WebSocketState.Open)
            {
                break;
            }

            var payload = JsonSerializer.SerializeToUtf8Bytes(operation);
            await socket.SendAsync(payload, WebSocketMessageType.Text, endOfMessage: true, context.RequestAborted);
        }
    }
    catch (OperationCanceledException)
    {
        // Normal shutdown when client disconnects or request aborts.
    }
    catch (WebSocketException)
    {
        // Socket dropped; endpoint cleanup below handles close state.
    }
    finally
    {
        if (socket.State is WebSocketState.Open or WebSocketState.CloseReceived)
        {
            await socket.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "room stream closed", CancellationToken.None);
        }
    }
});

app.MapGet("/api/workspace/rooms/{roomId}/signal", async (HttpContext context, string roomId) =>
{
    if (!context.WebSockets.IsWebSocketRequest)
    {
        context.Response.StatusCode = StatusCodes.Status400BadRequest;
        await context.Response.WriteAsync("WebSocket upgrade required");
        return;
    }

    var peerId = context.Request.Query["peerId"].ToString().Trim();
    if (string.IsNullOrWhiteSpace(peerId))
    {
        context.Response.StatusCode = StatusCodes.Status400BadRequest;
        await context.Response.WriteAsync("peerId is required");
        return;
    }

    using var socket = await context.WebSockets.AcceptWebSocketAsync();
    var roomPeers = signalRooms.GetOrAdd(roomId, _ => new ConcurrentDictionary<string, WebSocket>(StringComparer.OrdinalIgnoreCase));

    if (roomPeers.TryGetValue(peerId, out var existingSocket) && !ReferenceEquals(existingSocket, socket))
    {
        try
        {
            if (existingSocket.State is WebSocketState.Open or WebSocketState.CloseReceived)
            {
                await existingSocket.CloseOutputAsync(WebSocketCloseStatus.PolicyViolation, "peer replaced", CancellationToken.None);
            }
        }
        catch
        {
            // Best effort; stale socket cleanup will run its own disconnect path.
        }
    }

    roomPeers[peerId] = socket;

    try
    {
        var knownPeers = roomPeers.Keys.Where(value => !string.Equals(value, peerId, StringComparison.OrdinalIgnoreCase)).ToArray();
        await SendJsonAsync(socket, new
        {
            type = "peers",
            peers = knownPeers
        }, context.RequestAborted);

        await BroadcastToRoomAsync(roomPeers, new
        {
            type = "peer-joined",
            peerId
        }, excludePeerId: peerId, context.RequestAborted);

        var buffer = new byte[64 * 1024];
        while (socket.State == WebSocketState.Open && !context.RequestAborted.IsCancellationRequested)
        {
            var segment = new ArraySegment<byte>(buffer);
            var result = await socket.ReceiveAsync(segment, context.RequestAborted);
            if (result.MessageType == WebSocketMessageType.Close)
            {
                break;
            }

            if (result.MessageType != WebSocketMessageType.Text)
            {
                continue;
            }

            var json = JsonDocument.Parse(new ReadOnlyMemory<byte>(buffer, 0, result.Count));
            var messageType = json.RootElement.TryGetProperty("type", out var typeElement) && typeElement.ValueKind == JsonValueKind.String
                ? typeElement.GetString()
                : null;

            if (!json.RootElement.TryGetProperty("to", out var toElement) || toElement.ValueKind != JsonValueKind.String)
            {
                if (string.Equals(messageType, "drag-presence", StringComparison.OrdinalIgnoreCase) ||
                    string.Equals(messageType, "drag-presence-end", StringComparison.OrdinalIgnoreCase))
                {
                    var nodeId = json.RootElement.TryGetProperty("nodeId", out var nodeIdElement) && nodeIdElement.ValueKind == JsonValueKind.String
                        ? nodeIdElement.GetString()
                        : null;
                    var x = json.RootElement.TryGetProperty("x", out var xElement) && xElement.ValueKind == JsonValueKind.Number
                        ? xElement.GetDouble()
                        : (double?)null;
                    var y = json.RootElement.TryGetProperty("y", out var yElement) && yElement.ValueKind == JsonValueKind.Number
                        ? yElement.GetDouble()
                        : (double?)null;
                    var updatedAtMs = json.RootElement.TryGetProperty("updatedAtMs", out var updatedAtElement) && updatedAtElement.ValueKind == JsonValueKind.Number
                        ? updatedAtElement.GetInt64()
                        : (long?)null;

                    if (!string.IsNullOrWhiteSpace(nodeId) && x is not null && y is not null)
                    {
                        await BroadcastToRoomAsync(roomPeers, new
                        {
                            type = messageType,
                            from = peerId,
                            peerId,
                            nodeId,
                            x,
                            y,
                            updatedAtMs
                        }, excludePeerId: peerId, context.RequestAborted);
                    }
                }

                continue;
            }

            var targetPeerId = toElement.GetString();
            if (string.IsNullOrWhiteSpace(targetPeerId))
            {
                continue;
            }

            if (!roomPeers.TryGetValue(targetPeerId, out var targetSocket) || targetSocket.State != WebSocketState.Open)
            {
                continue;
            }

            using var envelope = JsonDocument.Parse(JsonSerializer.Serialize(new
            {
                type = messageType ?? "signal",
                from = peerId,
                to = targetPeerId,
                sdp = json.RootElement.TryGetProperty("sdp", out var sdpElement) && sdpElement.ValueKind == JsonValueKind.String
                    ? sdpElement.GetString()
                    : null,
                candidate = json.RootElement.TryGetProperty("candidate", out var candidateElement) && candidateElement.ValueKind == JsonValueKind.String
                    ? candidateElement.GetString()
                    : null,
                sdpMid = json.RootElement.TryGetProperty("sdpMid", out var midElement) && midElement.ValueKind == JsonValueKind.String
                    ? midElement.GetString()
                    : null,
                sdpMLineIndex = json.RootElement.TryGetProperty("sdpMLineIndex", out var lineElement) && lineElement.ValueKind == JsonValueKind.Number
                    ? lineElement.GetInt32()
                    : (int?)null
            }));

            await targetSocket.SendAsync(
                JsonSerializer.SerializeToUtf8Bytes(envelope.RootElement),
                WebSocketMessageType.Text,
                endOfMessage: true,
                context.RequestAborted);
        }
    }
    catch (OperationCanceledException)
    {
    }
    catch (WebSocketException)
    {
    }
    finally
    {
        if (roomPeers.TryGetValue(peerId, out var currentSocket) && ReferenceEquals(currentSocket, socket))
        {
            roomPeers.TryRemove(peerId, out _);
        }

        await BroadcastToRoomAsync(roomPeers, new
        {
            type = "peer-left",
            peerId
        }, excludePeerId: peerId, CancellationToken.None);

        if (socket.State is WebSocketState.Open or WebSocketState.CloseReceived)
        {
            await socket.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "signal closed", CancellationToken.None);
        }
    }
});

app.Map("/ws/runtime", HandleRuntimeWebSocketAsync);
app.Map("/ws/{roomId}", HandleRuntimeWebSocketAsync);

static async Task SendJsonAsync(WebSocket socket, object payload, CancellationToken cancellationToken)
{
    if (socket.State != WebSocketState.Open)
    {
        return;
    }

    await socket.SendAsync(JsonSerializer.SerializeToUtf8Bytes(payload), WebSocketMessageType.Text, endOfMessage: true, cancellationToken);
}

static async Task BroadcastToRoomAsync(
    ConcurrentDictionary<string, WebSocket> roomPeers,
    object payload,
    string? excludePeerId,
    CancellationToken cancellationToken)
{
    foreach (var (peerId, socket) in roomPeers)
    {
        if (!string.IsNullOrWhiteSpace(excludePeerId) && string.Equals(peerId, excludePeerId, StringComparison.OrdinalIgnoreCase))
        {
            continue;
        }

        if (socket.State != WebSocketState.Open)
        {
            continue;
        }

        try
        {
            await SendJsonAsync(socket, payload, cancellationToken);
        }
        catch
        {
            // Best-effort broadcast; stale socket cleanup happens on disconnect paths.
        }
    }
}

async Task HandleRuntimeWebSocketAsync(HttpContext context)
{
    if (!context.WebSockets.IsWebSocketRequest)
    {
        context.Response.StatusCode = StatusCodes.Status400BadRequest;
        await context.Response.WriteAsync("WebSocket upgrade required");
        return;
    }

    using var socket = await context.WebSockets.AcceptWebSocketAsync();

    (string RoomId, string PeerId, WebSocket Socket)? session = null;
    var buffer = new byte[64 * 1024];
    try
    {
        while (socket.State == WebSocketState.Open && !context.RequestAborted.IsCancellationRequested)
        {
            var result = await socket.ReceiveAsync(new ArraySegment<byte>(buffer), context.RequestAborted);
            if (result.MessageType == WebSocketMessageType.Close)
            {
                break;
            }

            if (result.MessageType != WebSocketMessageType.Text || result.Count == 0)
            {
                continue;
            }

            var payloadText = Encoding.UTF8.GetString(buffer, 0, result.Count);
            using var messageDocument = JsonDocument.Parse(payloadText);
            var root = messageDocument.RootElement;
            var messageType = TryGetString(root, "type");
            if (string.IsNullOrWhiteSpace(messageType))
            {
                continue;
            }

            if (string.Equals(messageType, "hello", StringComparison.OrdinalIgnoreCase))
            {
                session = await InitializeRuntimeSessionAsync(context, socket, root, runtimeRooms, context.RequestAborted);
                if (session is null)
                {
                    continue;
                }

                continue;
            }

            if (session is null)
            {
                await SendJsonAsync(socket, new
                {
                    type = "error",
                    message = "hello required"
                }, context.RequestAborted);
                continue;
            }

            if (string.Equals(messageType, "presence-set", StringComparison.OrdinalIgnoreCase))
            {
                await HandlePresenceSetAsync(session.Value, root, runtimeRooms, runtimePresence, context.RequestAborted);
                continue;
            }

            if (string.Equals(messageType, "presence-get", StringComparison.OrdinalIgnoreCase))
            {
                await HandlePresenceGetAsync(session.Value, runtimePresence, context.RequestAborted);
                continue;
            }

            if (string.Equals(messageType, "presence-sweep", StringComparison.OrdinalIgnoreCase))
            {
                await HandlePresenceSweepAsync(session.Value, root, runtimeRooms, runtimePresence, context.RequestAborted);
                continue;
            }

            if (string.Equals(messageType, "webrtc-offer", StringComparison.OrdinalIgnoreCase)
                || string.Equals(messageType, "webrtc-answer", StringComparison.OrdinalIgnoreCase)
                || string.Equals(messageType, "webrtc-ice", StringComparison.OrdinalIgnoreCase)
                || string.Equals(messageType, "peer-signal", StringComparison.OrdinalIgnoreCase))
            {
                await RelayRuntimeSignalAsync(session.Value, root, messageType, runtimeRooms, context.RequestAborted);
                continue;
            }

            if (string.Equals(messageType, "pull", StringComparison.OrdinalIgnoreCase)
                || string.Equals(messageType, "push", StringComparison.OrdinalIgnoreCase)
                || string.Equals(messageType, "blob-request", StringComparison.OrdinalIgnoreCase))
            {
                await SendJsonAsync(socket, new { type = "noop-ack" }, context.RequestAborted);
            }
        }
    }
    catch (OperationCanceledException)
    {
        // Request aborted.
    }
    catch (WebSocketException)
    {
        // Socket closed unexpectedly.
    }
    finally
    {
        if (session is not null)
        {
            await RemoveRuntimeSessionAsync(session.Value, runtimeRooms, runtimePresence, CancellationToken.None);
        }

        if (socket.State is WebSocketState.Open or WebSocketState.CloseReceived)
        {
            await socket.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "runtime closed", CancellationToken.None);
        }
    }
}

static async Task<(string RoomId, string PeerId, WebSocket Socket)?> InitializeRuntimeSessionAsync(
    HttpContext context,
    WebSocket socket,
    JsonElement hello,
    ConcurrentDictionary<string, ConcurrentDictionary<string, (string RoomId, string PeerId, WebSocket Socket)>> runtimeRooms,
    CancellationToken cancellationToken)
{
    var routeRoom = context.Request.RouteValues.TryGetValue("roomId", out var routeRoomValue)
        ? routeRoomValue?.ToString()
        : null;
    if (string.Equals(routeRoom, "runtime", StringComparison.OrdinalIgnoreCase))
    {
        routeRoom = null;
    }

    var requestedRoom = TryGetString(hello, "room") ?? TryGetString(hello, "roomId") ?? routeRoom;
    if (string.IsNullOrWhiteSpace(requestedRoom))
    {
        requestedRoom = "default";
    }

    var peerId = TryGetString(hello, "pubkey")
        ?? TryGetString(hello, "peerId")
        ?? $"peer-{Guid.NewGuid():N}";

    var roomPeers = runtimeRooms.GetOrAdd(requestedRoom, _ => new ConcurrentDictionary<string, (string RoomId, string PeerId, WebSocket Socket)>(StringComparer.OrdinalIgnoreCase));
    var session = (RoomId: requestedRoom, PeerId: peerId, Socket: socket);

    if (roomPeers.TryGetValue(peerId, out var existingSession) && !ReferenceEquals(existingSession.Socket, socket))
    {
        try
        {
            if (existingSession.Socket.State is WebSocketState.Open or WebSocketState.CloseReceived)
            {
                await existingSession.Socket.CloseOutputAsync(WebSocketCloseStatus.PolicyViolation, "peer replaced", cancellationToken);
            }
        }
        catch
        {
            // Best effort.
        }
    }

    roomPeers[peerId] = session;

    var knownPeers = roomPeers.Keys.Where(value => !string.Equals(value, peerId, StringComparison.OrdinalIgnoreCase)).ToArray();
    await SendJsonAsync(socket, new
    {
        type = "welcome",
        room = requestedRoom,
        peerId,
        peers = knownPeers
    }, cancellationToken);

    await BroadcastRuntimeRoomAsync(roomPeers, new
    {
        type = "peer-joined",
        room = requestedRoom,
        peerId,
        from = peerId
    }, excludePeerId: peerId, cancellationToken);

    return session;
}

static async Task RemoveRuntimeSessionAsync(
    (string RoomId, string PeerId, WebSocket Socket) session,
    ConcurrentDictionary<string, ConcurrentDictionary<string, (string RoomId, string PeerId, WebSocket Socket)>> runtimeRooms,
    ConcurrentDictionary<string, ConcurrentDictionary<string, (object? Data, long ExpiresAtUnixMs)>> runtimePresence,
    CancellationToken cancellationToken)
{
    if (!runtimeRooms.TryGetValue(session.RoomId, out var roomPeers))
    {
        return;
    }

    if (roomPeers.TryGetValue(session.PeerId, out var current) && ReferenceEquals(current.Socket, session.Socket))
    {
        roomPeers.TryRemove(session.PeerId, out _);
    }

    if (runtimePresence.TryGetValue(session.RoomId, out var roomPresence))
    {
        roomPresence.TryRemove(session.PeerId, out _);
    }

    await BroadcastRuntimeRoomAsync(roomPeers, new
    {
        type = "peer-left",
        room = session.RoomId,
        peerId = session.PeerId,
        from = session.PeerId
    }, excludePeerId: session.PeerId, cancellationToken);

    if (roomPeers.IsEmpty)
    {
        runtimeRooms.TryRemove(session.RoomId, out _);
        runtimePresence.TryRemove(session.RoomId, out _);
    }
}

static async Task RelayRuntimeSignalAsync(
    (string RoomId, string PeerId, WebSocket Socket) session,
    JsonElement payload,
    string messageType,
    ConcurrentDictionary<string, ConcurrentDictionary<string, (string RoomId, string PeerId, WebSocket Socket)>> runtimeRooms,
    CancellationToken cancellationToken)
{
    var targetPeerId = TryGetString(payload, "to");
    if (string.IsNullOrWhiteSpace(targetPeerId))
    {
        return;
    }

    if (!runtimeRooms.TryGetValue(session.RoomId, out var roomPeers)
        || !roomPeers.TryGetValue(targetPeerId, out var targetSession)
        || targetSession.Socket.State != WebSocketState.Open)
    {
        return;
    }

    await SendJsonAsync(targetSession.Socket, new
    {
        type = messageType,
        room = session.RoomId,
        from = session.PeerId,
        peerId = session.PeerId,
        to = targetPeerId,
        sdp = TryGetString(payload, "sdp"),
        candidate = TryGetString(payload, "candidate"),
        sdpMid = TryGetString(payload, "sdpMid"),
        sdpMLineIndex = TryGetInt(payload, "sdpMLineIndex")
    }, cancellationToken);
}

static async Task HandlePresenceSetAsync(
    (string RoomId, string PeerId, WebSocket Socket) session,
    JsonElement payload,
    ConcurrentDictionary<string, ConcurrentDictionary<string, (string RoomId, string PeerId, WebSocket Socket)>> runtimeRooms,
    ConcurrentDictionary<string, ConcurrentDictionary<string, (object? Data, long ExpiresAtUnixMs)>> runtimePresence,
    CancellationToken cancellationToken)
{
    if (!payload.TryGetProperty("data", out var dataElement))
    {
        return;
    }

    var nowUnixMs = TryGetLong(payload, "now_unix_ms") ?? DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    var ttlMs = TryGetLong(payload, "ttl_ms") ?? 20_000;
    var expiresAtUnixMs = nowUnixMs + Math.Max(0, ttlMs);
    var data = JsonSerializer.Deserialize<object?>(dataElement.GetRawText());

    var roomPresence = runtimePresence.GetOrAdd(session.RoomId, _ => new ConcurrentDictionary<string, (object? Data, long ExpiresAtUnixMs)>(StringComparer.OrdinalIgnoreCase));
    roomPresence[session.PeerId] = (Data: data, ExpiresAtUnixMs: expiresAtUnixMs);

    if (!runtimeRooms.TryGetValue(session.RoomId, out var roomPeers))
    {
        return;
    }

    await BroadcastRuntimeRoomAsync(roomPeers, new
    {
        type = "presence",
        room = session.RoomId,
        from = session.PeerId,
        peerId = session.PeerId,
        data
    }, excludePeerId: null, cancellationToken);
}

static async Task HandlePresenceGetAsync(
    (string RoomId, string PeerId, WebSocket Socket) session,
    ConcurrentDictionary<string, ConcurrentDictionary<string, (object? Data, long ExpiresAtUnixMs)>> runtimePresence,
    CancellationToken cancellationToken)
{
    if (!runtimePresence.TryGetValue(session.RoomId, out var roomPresence))
    {
        await SendJsonAsync(session.Socket, new
        {
            type = "presence-snapshot",
            room = session.RoomId,
            entries = Array.Empty<object>()
        }, cancellationToken);
        return;
    }

    var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    var entries = roomPresence
        .Where(pair => pair.Value.ExpiresAtUnixMs >= now)
        .Select(pair => new
        {
            from = pair.Key,
            peerId = pair.Key,
            data = pair.Value.Data,
            expires_at_ms = pair.Value.ExpiresAtUnixMs
        })
        .ToArray();

    await SendJsonAsync(session.Socket, new
    {
        type = "presence-snapshot",
        room = session.RoomId,
        entries
    }, cancellationToken);
}

static async Task HandlePresenceSweepAsync(
    (string RoomId, string PeerId, WebSocket Socket) session,
    JsonElement payload,
    ConcurrentDictionary<string, ConcurrentDictionary<string, (string RoomId, string PeerId, WebSocket Socket)>> runtimeRooms,
    ConcurrentDictionary<string, ConcurrentDictionary<string, (object? Data, long ExpiresAtUnixMs)>> runtimePresence,
    CancellationToken cancellationToken)
{
    if (!runtimePresence.TryGetValue(session.RoomId, out var roomPresence))
    {
        return;
    }

    var nowUnixMs = TryGetLong(payload, "now_unix_ms") ?? DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    var expiredPeerIds = roomPresence
        .Where(pair => pair.Value.ExpiresAtUnixMs < nowUnixMs)
        .Select(pair => pair.Key)
        .ToArray();

    foreach (var peerId in expiredPeerIds)
    {
        roomPresence.TryRemove(peerId, out _);
    }

    if (expiredPeerIds.Length == 0)
    {
        return;
    }

    if (!runtimeRooms.TryGetValue(session.RoomId, out var roomPeers))
    {
        return;
    }

    foreach (var peerId in expiredPeerIds)
    {
        await BroadcastRuntimeRoomAsync(roomPeers, new
        {
            type = "presence-leave",
            room = session.RoomId,
            from = peerId,
            peerId
        }, excludePeerId: null, cancellationToken);
    }
}

static async Task BroadcastRuntimeRoomAsync(
    ConcurrentDictionary<string, (string RoomId, string PeerId, WebSocket Socket)> roomPeers,
    object payload,
    string? excludePeerId,
    CancellationToken cancellationToken)
{
    foreach (var (peerId, session) in roomPeers)
    {
        if (!string.IsNullOrWhiteSpace(excludePeerId) && string.Equals(peerId, excludePeerId, StringComparison.OrdinalIgnoreCase))
        {
            continue;
        }

        if (session.Socket.State != WebSocketState.Open)
        {
            continue;
        }

        try
        {
            await SendJsonAsync(session.Socket, payload, cancellationToken);
        }
        catch
        {
            // Best-effort broadcast.
        }
    }
}

static string? TryGetString(JsonElement element, string propertyName)
{
    return element.TryGetProperty(propertyName, out var property) && property.ValueKind == JsonValueKind.String
        ? property.GetString()
        : null;
}

static int? TryGetInt(JsonElement element, string propertyName)
{
    return element.TryGetProperty(propertyName, out var property) && property.ValueKind == JsonValueKind.Number && property.TryGetInt32(out var value)
        ? value
        : null;
}

static long? TryGetLong(JsonElement element, string propertyName)
{
    return element.TryGetProperty(propertyName, out var property) && property.ValueKind == JsonValueKind.Number && property.TryGetInt64(out var value)
        ? value
        : null;
}

app.Run();
