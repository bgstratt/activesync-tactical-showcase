using TacticalShowcase.Host.Contracts;
using TacticalShowcase.Host.Ffi;

var builder = WebApplication.CreateBuilder(args);
builder.WebHost.UseUrls("http://localhost:5074");

builder.Services.AddSingleton<INativeRuntimeProbe, NativeRuntimeProbe>();

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

app.MapGet("/api/replication/topology", () =>
{
    var now = DateTimeOffset.UtcNow;
    return Results.Ok(new ReplicationTopologyResponse(
        SessionId: "tactical-demo-session",
        UpdatedAtUtc: now,
        Peers:
        [
            new PeerStatus("alpha", true, now.AddSeconds(-4), 133),
            new PeerStatus("bravo", true, now.AddSeconds(-2), 128),
            new PeerStatus("charlie", false, now.AddMinutes(-1), 121),
            new PeerStatus("delta", true, now.AddSeconds(-7), 137)
        ],
        ActiveLinks:
        [
            new PeerLink("alpha", "bravo", 9),
            new PeerLink("alpha", "delta", 12),
            new PeerLink("bravo", "delta", 8)
        ]
    ));
});

app.Run();
