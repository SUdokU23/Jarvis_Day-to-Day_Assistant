$ErrorActionPreference = 'Stop'

# Join the job before launching the service so every descendant inherits membership.
# The non-inheritable handle closes even if the launcher is terminated.
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading.Tasks;

public static class SidecarJob {
    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimits {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr MinWorkingSet, MaxWorkingSet;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint Priority, SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimits {
        public BasicLimits Basic;
        public ulong ReadOperations, WriteOperations, OtherOperations;
        public ulong ReadBytes, WriteBytes, OtherBytes;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits limits, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")]
    private static extern IntPtr GetStdHandle(int handle);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);

    public static int Run(string executable, string args) {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) return 70;
        // Let Windows close the job handle on launcher exit, preserving its exit code.
        var limits = new ExtendedLimits();
        limits.Basic.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits)) ||
            !SetHandleInformation(GetStdHandle(-10), 1, 0) ||
            !AssignProcessToJobObject(job, GetCurrentProcess())) return 70;

        // Keep Electron's control pipe private to the launcher.
        var parentClosed = Task.Run(() => Console.OpenStandardInput().ReadByte());
        if (parentClosed.IsCompleted) return 0;
        Process child;
        try {
            child = Process.Start(new ProcessStartInfo(executable, args) {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardInput = true
            });
        } catch (Win32Exception error) {
            return error.NativeErrorCode == 2 || error.NativeErrorCode == 3 ? 71 : 72;
        }
        using (child) {
            child.StandardInput.Close();
            var childExited = Task.Run(() => child.WaitForExit());
            return Task.WaitAny(parentClosed, childExited) == 0 ? 0 : 73;
        }
    }
}
'@

exit [SidecarJob]::Run($env:JARVIS_SIDECAR_EXECUTABLE, $env:JARVIS_SIDECAR_ARGS)
