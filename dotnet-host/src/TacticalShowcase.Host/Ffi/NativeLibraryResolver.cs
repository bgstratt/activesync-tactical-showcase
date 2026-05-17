using System.Reflection;
using System.Runtime.InteropServices;

namespace TacticalShowcase.Host.Ffi;

internal static class NativeLibraryResolver
{
    private static bool _configured;

    public static void Configure()
    {
        if (_configured)
        {
            return;
        }

        NativeLibrary.SetDllImportResolver(typeof(NativeMethods).Assembly, ResolveLibrary);
        _configured = true;
    }

    private static nint ResolveLibrary(string libraryName, Assembly assembly, DllImportSearchPath? searchPath)
    {
        if (!string.Equals(libraryName, NativeMethods.LibraryName, StringComparison.Ordinal))
        {
            return nint.Zero;
        }

        var explicitPath = Environment.GetEnvironmentVariable("ACTIVESYNC_HOST_FFI_DLL");
        if (!string.IsNullOrWhiteSpace(explicitPath) && File.Exists(explicitPath))
        {
            return NativeLibrary.Load(explicitPath);
        }

        foreach (var candidate in BuildCandidatePaths())
        {
            if (!File.Exists(candidate))
            {
                continue;
            }

            try
            {
                return NativeLibrary.Load(candidate);
            }
            catch
            {
                // Continue to next candidate if a stale path fails to load.
            }
        }

        try
        {
            return NativeLibrary.Load(libraryName, assembly, searchPath);
        }
        catch
        {
            return nint.Zero;
        }
    }

    private static IEnumerable<string> BuildCandidatePaths()
    {
        var fileName = GetPlatformLibraryFileName();
        var baseDir = AppContext.BaseDirectory;
        var cwd = Directory.GetCurrentDirectory();

        yield return Path.Combine(baseDir, fileName);
        yield return Path.Combine(cwd, fileName);
        yield return Path.Combine(cwd, "target", "debug", fileName);
        yield return Path.Combine(cwd, "target", "release", fileName);
        yield return Path.Combine(cwd, "host-ffi", "target", "debug", fileName);
        yield return Path.Combine(cwd, "host-ffi", "target", "release", fileName);
        yield return Path.Combine(cwd, "..", "..", "target", "debug", fileName);
        yield return Path.Combine(cwd, "..", "..", "target", "release", fileName);
    }

    private static string GetPlatformLibraryFileName()
    {
        if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            return "activesync_host_ffi.dll";
        }

        if (RuntimeInformation.IsOSPlatform(OSPlatform.OSX))
        {
            return "libactivesync_host_ffi.dylib";
        }

        return "libactivesync_host_ffi.so";
    }
}
