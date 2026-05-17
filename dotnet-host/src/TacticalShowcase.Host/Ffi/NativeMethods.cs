using System.Runtime.InteropServices;

namespace TacticalShowcase.Host.Ffi;

public enum AsStatus : uint
{
    Ok = 0,
    InvalidArg = 1,
    NotFound = 2,
    Auth = 3,
    Policy = 4,
    Protocol = 5,
    Internal = 255
}

public struct AsBytesView
{
    public nint Ptr;
    public nuint Len;
}

public struct AsBytesOwned
{
    public nint Ptr;
    public nuint Len;
}

internal static class NativeMethods
{
    public const string LibraryName = "activesync_host_ffi";

    [DllImport(LibraryName, EntryPoint = "as_host_abi_version")]
    public static extern uint AbiVersion();

    [DllImport(LibraryName, EntryPoint = "as_host_engine_new")]
    public static extern AsStatus HostEngineNew(out nint engine);

    [DllImport(LibraryName, EntryPoint = "as_host_engine_free")]
    public static extern AsStatus HostEngineFree(nint engine);

    [DllImport(LibraryName, EntryPoint = "as_host_submit_command_json")]
    public static extern AsStatus HostSubmitCommandJson(
        nint engine,
        AsBytesView commandJson,
        out AsBytesOwned outEventsJson
    );

    [DllImport(LibraryName, EntryPoint = "as_bytes_owned_free")]
    public static extern void BytesOwnedFree(AsBytesOwned bytes);
}
