# Tactical Showcase Host

Minimal embedded .NET host for the ActiveSync Tactical Showcase demo.

## Endpoints

- GET `/`: service metadata.
- GET `/api/host/health`: host and native runtime availability.
- GET `/api/replication/topology`: initial mock topology payload for UI wiring.

## Native Runtime Resolution

The host probes native library `activesync_host_ffi` via:

1. `ACTIVESYNC_HOST_FFI_DLL` absolute path if set.
2. common local candidate paths under `target/debug` and `target/release`.
3. platform default native search.

If native runtime is not found, `/api/host/health` remains available and reports `available=false` with an error string.

## Run

```powershell
cd dotnet-host/src/TacticalShowcase.Host
dotnet run
```

The web-react dev app expects this host at `http://localhost:5074` by default.
