using System.Runtime.InteropServices;

namespace TacticalShowcase.Host.Ffi;

internal static class NativeMethods
{
    public const string LibraryName = "activesync_host_ffi";

    [DllImport(LibraryName, EntryPoint = "as_host_abi_version")]
    public static extern uint AbiVersion();
}
