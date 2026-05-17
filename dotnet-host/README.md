# Tactical Showcase Host

Minimal embedded .NET host for the ActiveSync Tactical Showcase demo.

## Endpoints

- GET `/`: service metadata.
- GET `/api/host/health`: host and native runtime availability.
- GET `/api/replication/topology`: runtime-backed peer topology snapshot.
- GET `/api/replication/events?take=60`: recent runtime command/event replay stream.
- POST `/api/runtime/peers/connect`: connect a peer into the demo room.
- POST `/api/runtime/peers/disconnect`: close a peer session.

## Native Runtime Resolution

The host probes native library `activesync_host_ffi` via:

1. `ACTIVESYNC_HOST_FFI_DLL` absolute path if set.
2. common local candidate paths under `target/debug` and `target/release`.
3. platform default native search.

When this repo sits beside the main `activesync` repo, the resolver also checks sibling paths such as `../activesync/target/debug` and `../activesync/target/release`.

If native runtime is not found, `/api/host/health` remains available and reports `available=false` with an error string.

### Reuse Runtime From Sibling activesync Repo

```powershell
cd ..\activesync
cargo build -p activesync-host-ffi
```

Then run this host normally; it will auto-discover the built native runtime from the sibling repo path.

## Run

```powershell
cd dotnet-host/src/TacticalShowcase.Host
dotnet run
```

The web-react dev app expects this host at `http://localhost:5074` by default.
