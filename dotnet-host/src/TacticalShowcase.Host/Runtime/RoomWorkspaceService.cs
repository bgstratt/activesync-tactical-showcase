using TacticalShowcase.Host.Contracts;
using System.Runtime.CompilerServices;
using System.Threading.Channels;

namespace TacticalShowcase.Host.Runtime;

public interface IRoomWorkspaceService
{
    WorkspaceStateResponse GetState(string roomId);
    WorkspaceEventsResponse GetEvents(string roomId, int take);
    WorkspaceOperationsResponse GetOperations(string roomId, int take);
    WorkspaceStateResponse ApplyOperation(string roomId, WorkspaceOperationRequest request);
    IAsyncEnumerable<WorkspaceOperationItem> SubscribeOperations(string roomId, CancellationToken cancellationToken);
}

internal sealed class RoomWorkspaceService : IRoomWorkspaceService
{
    private readonly object _sync = new();
    private readonly Dictionary<string, RoomState> _rooms = new(StringComparer.OrdinalIgnoreCase);

    public WorkspaceStateResponse GetState(string roomId)
    {
        lock (_sync)
        {
            var room = GetOrCreateRoom(roomId);
            return ToStateResponse(roomId, room);
        }
    }

    public WorkspaceEventsResponse GetEvents(string roomId, int take)
    {
        lock (_sync)
        {
            var room = GetOrCreateRoom(roomId);
            var normalizedTake = Math.Clamp(take, 1, 500);
            var events = room.Events
                .TakeLast(normalizedTake)
                .ToArray();

            return new WorkspaceEventsResponse(roomId, room.UpdatedAtUtc, events);
        }
    }

    public WorkspaceOperationsResponse GetOperations(string roomId, int take)
    {
        lock (_sync)
        {
            var room = GetOrCreateRoom(roomId);
            var normalizedTake = Math.Clamp(take, 1, 2000);
            var operations = room.Operations
                .TakeLast(normalizedTake)
                .ToArray();

            return new WorkspaceOperationsResponse(roomId, room.UpdatedAtUtc, operations);
        }
    }

    public WorkspaceStateResponse ApplyOperation(string roomId, WorkspaceOperationRequest request)
    {
        lock (_sync)
        {
            var room = GetOrCreateRoom(roomId);
            var nowMs = request.UpdatedAtMs ?? DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var peerId = string.IsNullOrWhiteSpace(request.PeerId) ? "anonymous" : request.PeerId.Trim();
            var kind = string.IsNullOrWhiteSpace(request.Kind) ? "unknown" : request.Kind.Trim().ToLowerInvariant();

            switch (kind)
            {
                case "add-node":
                    ApplyAddNode(room, request, peerId, nowMs);
                    break;
                case "move-node":
                    ApplyMoveNode(room, request, peerId, nowMs);
                    break;
                case "add-edge":
                    ApplyAddEdge(room, request, peerId, nowMs);
                    break;
                case "add-asset":
                    ApplyAddAsset(room, request, peerId, nowMs);
                    break;
                case "add-annotation":
                    ApplyAddAnnotation(room, request, peerId, nowMs);
                    break;
                case "add-stroke":
                    ApplyAddStroke(room, request, peerId, nowMs);
                    break;
                default:
                    throw new InvalidOperationException($"Unsupported workspace operation '{request.Kind}'");
            }

            var operationItem = new WorkspaceOperationItem(
                Id: $"op-{Guid.NewGuid():N}",
                UpdatedAtMs: nowMs,
                PeerId: peerId,
                Kind: kind,
                NodeId: request.NodeId,
                FromNodeId: request.FromNodeId,
                ToNodeId: request.ToNodeId,
                X: request.X,
                Y: request.Y,
                Label: request.Label,
                Text: request.Text,
                AssetName: request.AssetName,
                Color: request.Color,
                Width: request.Width,
                Points: request.Points?.ToArray()
            );

            room.Operations.Add(operationItem);

            room.UpdatedAtUtc = DateTimeOffset.UtcNow;
            if (room.Events.Count > 1200)
            {
                room.Events.RemoveRange(0, room.Events.Count - 1200);
            }

            if (room.Operations.Count > 5000)
            {
                room.Operations.RemoveRange(0, room.Operations.Count - 5000);
            }

            if (room.OperationSubscribers.Count > 0)
            {
                room.OperationSubscribers.RemoveAll(writer => !writer.TryWrite(operationItem));
            }

            return ToStateResponse(roomId, room);
        }
    }

    public IAsyncEnumerable<WorkspaceOperationItem> SubscribeOperations(string roomId, CancellationToken cancellationToken)
    {
        var channel = Channel.CreateUnbounded<WorkspaceOperationItem>(new UnboundedChannelOptions
        {
            SingleReader = true,
            SingleWriter = false
        });

        lock (_sync)
        {
            var room = GetOrCreateRoom(roomId);
            room.OperationSubscribers.Add(channel.Writer);
        }

        return StreamOperations(roomId, channel, cancellationToken);
    }

    private async IAsyncEnumerable<WorkspaceOperationItem> StreamOperations(
        string roomId,
        Channel<WorkspaceOperationItem> channel,
        [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        try
        {
            await foreach (var operation in channel.Reader.ReadAllAsync(cancellationToken))
            {
                yield return operation;
            }
        }
        finally
        {
            lock (_sync)
            {
                var room = GetOrCreateRoom(roomId);
                room.OperationSubscribers.Remove(channel.Writer);
            }
        }
    }

    private static void ApplyAddNode(RoomState room, WorkspaceOperationRequest request, string peerId, long updatedAtMs)
    {
        var id = string.IsNullOrWhiteSpace(request.NodeId) ? $"node-{Guid.NewGuid():N}" : request.NodeId.Trim();
        var x = request.X ?? 320;
        var y = request.Y ?? 260;
        var label = string.IsNullOrWhiteSpace(request.Label) ? "Node" : request.Label.Trim();
        var color = string.IsNullOrWhiteSpace(request.Color) ? "#2563eb" : request.Color.Trim();

        var node = new WorkspaceNodeDto(id, x, y, label, color, updatedAtMs, peerId);
        UpsertByTimestamp(room.Nodes, node, updatedAtMs, static value => value.UpdatedAtMs);
        room.OperationCount += 1;
        room.Events.Add(new WorkspaceEventItem(updatedAtMs, peerId, "add-node", $"Added {label}"));
    }

    private static void ApplyMoveNode(RoomState room, WorkspaceOperationRequest request, string peerId, long updatedAtMs)
    {
        if (string.IsNullOrWhiteSpace(request.NodeId) || !room.Nodes.TryGetValue(request.NodeId, out var node))
        {
            return;
        }

        if (updatedAtMs < node.UpdatedAtMs)
        {
            return;
        }

        var next = node with
        {
            X = request.X ?? node.X,
            Y = request.Y ?? node.Y,
            UpdatedAtMs = updatedAtMs,
            UpdatedBy = peerId
        };

        room.Nodes[node.Id] = next;
        room.OperationCount += 1;
        room.Events.Add(new WorkspaceEventItem(updatedAtMs, peerId, "move-node", $"Moved {node.Id}"));
    }

    private static void ApplyAddEdge(RoomState room, WorkspaceOperationRequest request, string peerId, long updatedAtMs)
    {
        if (string.IsNullOrWhiteSpace(request.FromNodeId) || string.IsNullOrWhiteSpace(request.ToNodeId))
        {
            return;
        }

        var id = $"edge:{request.FromNodeId}:{request.ToNodeId}";
        var edge = new WorkspaceEdgeDto(id, request.FromNodeId.Trim(), request.ToNodeId.Trim(), updatedAtMs, peerId);
        UpsertByTimestamp(room.Edges, edge, updatedAtMs, static value => value.UpdatedAtMs);
        room.OperationCount += 1;
        room.Events.Add(new WorkspaceEventItem(updatedAtMs, peerId, "add-edge", $"Connected {edge.FromNodeId} -> {edge.ToNodeId}"));
    }

    private static void ApplyAddAsset(RoomState room, WorkspaceOperationRequest request, string peerId, long updatedAtMs)
    {
        var id = string.IsNullOrWhiteSpace(request.NodeId) ? $"asset-{Guid.NewGuid():N}" : request.NodeId.Trim();
        var name = string.IsNullOrWhiteSpace(request.AssetName) ? "asset.bin" : request.AssetName.Trim();
        var x = request.X ?? 360;
        var y = request.Y ?? 300;
        var asset = new WorkspaceAssetDto(id, x, y, name, updatedAtMs, peerId);
        UpsertByTimestamp(room.Assets, asset, updatedAtMs, static value => value.UpdatedAtMs);
        room.OperationCount += 1;
        room.Events.Add(new WorkspaceEventItem(updatedAtMs, peerId, "add-asset", $"Uploaded {name}"));
    }

    private static void ApplyAddAnnotation(RoomState room, WorkspaceOperationRequest request, string peerId, long updatedAtMs)
    {
        var id = string.IsNullOrWhiteSpace(request.NodeId) ? $"note-{Guid.NewGuid():N}" : request.NodeId.Trim();
        var text = string.IsNullOrWhiteSpace(request.Text) ? "Untitled note" : request.Text.Trim();
        var x = request.X ?? 300;
        var y = request.Y ?? 300;
        var note = new WorkspaceAnnotationDto(id, x, y, text, updatedAtMs, peerId);
        UpsertByTimestamp(room.Annotations, note, updatedAtMs, static value => value.UpdatedAtMs);
        room.OperationCount += 1;
        room.Events.Add(new WorkspaceEventItem(updatedAtMs, peerId, "add-annotation", $"Annotated: {text}"));
    }

    private static void ApplyAddStroke(RoomState room, WorkspaceOperationRequest request, string peerId, long updatedAtMs)
    {
        if (request.Points is null || request.Points.Count < 2)
        {
            return;
        }

        var id = string.IsNullOrWhiteSpace(request.NodeId) ? $"stroke-{Guid.NewGuid():N}" : request.NodeId.Trim();
        var color = string.IsNullOrWhiteSpace(request.Color) ? "#2563eb" : request.Color.Trim();
        var width = request.Width ?? 3;
        var stroke = new WorkspaceStrokeDto(id, request.Points.ToArray(), color, width, updatedAtMs, peerId);
        UpsertByTimestamp(room.Strokes, stroke, updatedAtMs, static value => value.UpdatedAtMs);
        room.OperationCount += 1;
        room.Events.Add(new WorkspaceEventItem(updatedAtMs, peerId, "add-stroke", $"Stroke with {stroke.Points.Count} points"));
    }

    private static void UpsertByTimestamp<T>(Dictionary<string, T> map, T value, long timestamp, Func<T, long> getTimestamp)
        where T : class
    {
        var id = GetEntityId(value);
        if (!map.TryGetValue(id, out var existing) || timestamp >= getTimestamp(existing))
        {
            map[id] = value;
        }
    }

    private static string GetEntityId<T>(T value)
        where T : class
    {
        return value switch
        {
            WorkspaceNodeDto node => node.Id,
            WorkspaceEdgeDto edge => edge.Id,
            WorkspaceAssetDto asset => asset.Id,
            WorkspaceAnnotationDto annotation => annotation.Id,
            WorkspaceStrokeDto stroke => stroke.Id,
            _ => throw new InvalidOperationException("Unsupported workspace entity type")
        };
    }

    private static WorkspaceStateResponse ToStateResponse(string roomId, RoomState room)
    {
        return new WorkspaceStateResponse(
            roomId,
            room.UpdatedAtUtc,
            room.Nodes.Values.OrderBy(item => item.Id, StringComparer.Ordinal).ToArray(),
            room.Edges.Values.OrderBy(item => item.Id, StringComparer.Ordinal).ToArray(),
            room.Assets.Values.OrderBy(item => item.Id, StringComparer.Ordinal).ToArray(),
            room.Annotations.Values.OrderBy(item => item.Id, StringComparer.Ordinal).ToArray(),
            room.Strokes.Values.OrderBy(item => item.Id, StringComparer.Ordinal).ToArray(),
            room.OperationCount
        );
    }

    private RoomState GetOrCreateRoom(string roomId)
    {
        var normalized = string.IsNullOrWhiteSpace(roomId) ? "default" : roomId.Trim();
        if (_rooms.TryGetValue(normalized, out var existing))
        {
            return existing;
        }

        var created = new RoomState
        {
            UpdatedAtUtc = DateTimeOffset.UtcNow
        };

        _rooms[normalized] = created;
        return created;
    }

    private sealed class RoomState
    {
        public Dictionary<string, WorkspaceNodeDto> Nodes { get; } = new(StringComparer.Ordinal);
        public Dictionary<string, WorkspaceEdgeDto> Edges { get; } = new(StringComparer.Ordinal);
        public Dictionary<string, WorkspaceAssetDto> Assets { get; } = new(StringComparer.Ordinal);
        public Dictionary<string, WorkspaceAnnotationDto> Annotations { get; } = new(StringComparer.Ordinal);
        public Dictionary<string, WorkspaceStrokeDto> Strokes { get; } = new(StringComparer.Ordinal);
        public List<WorkspaceEventItem> Events { get; } = [];
        public List<WorkspaceOperationItem> Operations { get; } = [];
        public List<ChannelWriter<WorkspaceOperationItem>> OperationSubscribers { get; } = [];
        public DateTimeOffset UpdatedAtUtc { get; set; }
        public int OperationCount { get; set; }
    }
}
