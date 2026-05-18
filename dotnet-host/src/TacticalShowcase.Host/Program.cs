using TacticalShowcase.Host.Contracts;
using TacticalShowcase.Host.Ffi;
using TacticalShowcase.Host.Runtime;

var builder = WebApplication.CreateBuilder(args);
builder.WebHost.UseUrls("http://localhost:5074");

builder.Services.AddSingleton<INativeRuntimeProbe, NativeRuntimeProbe>();
builder.Services.AddSingleton<IRuntimeReplicationService, RuntimeReplicationService>();

builder.Services.AddCors(options =>
{
    options.AddPolicy("WebReactDev", policy =>
    {
        policy
            .WithOrigins("http://127.0.0.1:4173", "http://localhost:4173")
            .AllowAnyHeader()
            .AllowAnyMethod();
    });
});

var app = builder.Build();

app.UseCors("WebReactDev");

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

app.Run();
