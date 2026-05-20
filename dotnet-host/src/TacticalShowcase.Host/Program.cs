using TacticalShowcase.Host.Contracts;
using TacticalShowcase.Host.Ffi;
using TacticalShowcase.Host.Runtime;
using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text.Json;

var builder = WebApplication.CreateBuilder(args);
builder.WebHost.UseUrls("http://localhost:5074");

builder.Services.AddSingleton<INativeRuntimeProbe, NativeRuntimeProbe>();
builder.Services.AddSingleton<IRuntimeReplicationService, RuntimeReplicationService>();
builder.Services.AddSingleton<IRoomWorkspaceService, RoomWorkspaceService>();

builder.Services.AddCors(options =>
{
    options.AddPolicy("WebReactDev", policy =>
    {
        policy
            .WithOrigins(
                "http://127.0.0.1:4173",
                "http://localhost:4173",
                "http://127.0.0.1:5173",
                "http://localhost:5173")
            .AllowAnyHeader()
            .AllowAnyMethod();
    });
});

var app = builder.Build();

var signalRooms = new ConcurrentDictionary<string, ConcurrentDictionary<string, WebSocket>>(StringComparer.OrdinalIgnoreCase);

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

app.Run();
