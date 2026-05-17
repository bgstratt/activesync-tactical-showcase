namespace TacticalShowcase.Host.Ffi;

public interface INativeRuntimeProbe
{
    NativeRuntimeProbeResult Probe();
}

public sealed record NativeRuntimeProbeResult(bool Available, uint? AbiVersion, string? Error);

internal sealed class NativeRuntimeProbe : INativeRuntimeProbe
{
    public NativeRuntimeProbeResult Probe()
    {
        try
        {
            NativeLibraryResolver.Configure();
            var abi = NativeMethods.AbiVersion();
            return new NativeRuntimeProbeResult(true, abi, null);
        }
        catch (Exception ex)
        {
            return new NativeRuntimeProbeResult(false, null, ex.Message);
        }
    }
}
