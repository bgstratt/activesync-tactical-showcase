# Tactical Showcase Host

Minimal embedded .NET host for the ActiveSync Tactical Showcase demo.

## Endpoints

- GET `/`: service metadata.
- GET `/api/host/health`: host and native runtime availability.
- GET `/api/replication/topology`: runtime-backed peer topology snapshot.
- GET `/api/replication/events?take=60`: recent runtime command/event replay stream.
- POST `/api/runtime/peers/connect`: connect a peer into the demo room.
- POST `/api/runtime/peers/disconnect`: close a peer session.
- WS `/ws/runtime`: SDK runtime websocket endpoint (room selected via `hello.room`).
- WS `/ws/{roomId}`: compatibility runtime websocket endpoint with room in URL.

These endpoints are tactical-showcase host APIs. They are not direct HTTP mirrors of NuGet package methods.
The NuGet integration provides the native ActiveSync runtime library; this host maps showcase-specific HTTP/WebSocket routes onto that runtime via its runtime services.

## Native Runtime Resolution

The host probes native library `activesync_host_ffi` via:

1. `ACTIVESYNC_HOST_FFI_DLL` absolute path if set.
2. common local candidate paths under `target/debug` and `target/release`.
3. platform default native search.

When this repo sits beside the main `activeSync` repo, the resolver also checks sibling paths such as `../activeSync/target/debug` and `../activeSync/target/release`.

If native runtime is not found, `/api/host/health` remains available and reports `available=false` with an error string.

### Local NuGet Package Mode (Recommended)

Use local ActiveSync NuGet artifacts from the sibling `activeSync` repo.

The tactical host now consumes the managed host package layer (`ActiveSync.Host.Abstractions` +
`ActiveSync.Host.Composition`) in addition to RID-native runtime packages. This aligns tactical
startup wiring with the package-first host model instead of only loading native FFI binaries.

1. Build local packages in `activeSync` first:

```powershell
cd ..\activeSync\dotnet-host
pwsh -File .\pack-local-nuget.ps1 -Version 0.1.0-local
```

2. Restore tactical host using local feed:

```powershell
cd ..\activesync-tactical-showcase\dotnet-host
dotnet restore .\TacticalShowcase.Host.sln --configfile .\NuGet.Local.config -p:ActiveSyncPackageVersion=0.1.0-local
```

3. Run tactical host with local package version:

```powershell
cd src\TacticalShowcase.Host
dotnet run -p:ActiveSyncPackageVersion=0.1.0-local
```

The project references RID-specific native runtime packages (`win-x64`, `linux-x64`). .NET will select the correct native asset for the current runtime environment.

### Port and WebSocket Behavior

- Host bind address is configured with `UseUrls("http://localhost:5074")` in `Program.cs`.
- HTTP and WebSocket endpoints share that same host/port.
- Example websocket endpoints use the same port (`ws://localhost:5074/...`) because they are upgraded HTTP requests on the same listener.

### Reuse Runtime From Sibling activesync Repo

```powershell
cd ..\activeSync
cargo build -p activesync-host-ffi
```

Then run this host normally; it will auto-discover the built native runtime from the sibling repo path.

## Run

```powershell
cd dotnet-host/src/TacticalShowcase.Host
dotnet run
```

The web-react dev app expects this host at `http://localhost:5074` by default.
