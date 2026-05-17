using System.Runtime.InteropServices;
using System.Text;

namespace TacticalShowcase.Host.Ffi;

public sealed class HostFfiClient : IDisposable
{
    private nint _engine;
    private bool _disposed;
    private readonly object _sync = new();

    public HostFfiClient()
    {
        NativeLibraryResolver.Configure();

        var status = NativeMethods.HostEngineNew(out _engine);
        if (status != AsStatus.Ok || _engine == nint.Zero)
        {
            throw new InvalidOperationException($"as_host_engine_new failed: {status}");
        }
    }

    public (AsStatus status, string eventsJson) SubmitCommandJson(string commandJson)
    {
        ArgumentNullException.ThrowIfNull(commandJson);

        var commandBytes = Encoding.UTF8.GetBytes(commandJson);

        lock (_sync)
        {
            ThrowIfDisposed();

            GCHandle? pinned = null;
            try
            {
                var view = new AsBytesView
                {
                    Ptr = nint.Zero,
                    Len = (nuint)commandBytes.Length
                };

                if (commandBytes.Length > 0)
                {
                    pinned = GCHandle.Alloc(commandBytes, GCHandleType.Pinned);
                    view.Ptr = pinned.Value.AddrOfPinnedObject();
                }

                var status = NativeMethods.HostSubmitCommandJson(_engine, view, out var owned);
                if (status != AsStatus.Ok)
                {
                    return (status, "[]");
                }

                if (owned.Ptr == nint.Zero || owned.Len == 0)
                {
                    return (status, "[]");
                }

                var eventsBytes = new byte[(int)owned.Len];
                Marshal.Copy(owned.Ptr, eventsBytes, 0, eventsBytes.Length);
                NativeMethods.BytesOwnedFree(owned);
                return (status, Encoding.UTF8.GetString(eventsBytes));
            }
            finally
            {
                if (pinned.HasValue)
                {
                    pinned.Value.Free();
                }
            }
        }
    }

    public void Dispose()
    {
        lock (_sync)
        {
            if (_disposed)
            {
                return;
            }

            if (_engine != nint.Zero)
            {
                _ = NativeMethods.HostEngineFree(_engine);
                _engine = nint.Zero;
            }

            _disposed = true;
            GC.SuppressFinalize(this);
        }
    }

    private void ThrowIfDisposed()
    {
        if (_disposed)
        {
            throw new ObjectDisposedException(nameof(HostFfiClient));
        }
    }
}
