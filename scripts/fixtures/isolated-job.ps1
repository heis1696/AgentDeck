param([Parameter(Mandatory=$true)][string]$Configuration)
$ErrorActionPreference = 'Stop'
$config = Get-Content -LiteralPath $Configuration -Raw -Encoding UTF8 | ConvertFrom-Json
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.ComponentModel;
using System.Threading.Tasks;
public sealed class IsolatedJob : IDisposable {
  static readonly Task<string> ownerRead = Task.Factory.StartNew<string>(() => Console.ReadLine());
  public static bool OwnerGone { get { return ownerRead.IsCompleted && ownerRead.Result == null; } }
  [StructLayout(LayoutKind.Sequential)] struct Limits {
    public long ProcessTime, JobTime;
    public uint Flags;
    public UIntPtr Minimum, Maximum;
    public uint ActiveLimit;
    public UIntPtr Affinity;
    public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct Counters { public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes; }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits { public Limits Basic; public Counters IO; public UIntPtr ProcessMemory, JobMemory, PeakProcess, PeakJob; }
  [StructLayout(LayoutKind.Sequential)] struct Accounting { public long User, Kernel, PeriodUser, PeriodKernel; public uint Faults, Total, Active, Terminated; }
  [StructLayout(LayoutKind.Sequential)] struct Security { public int Size; public IntPtr Descriptor; public int Inherit; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
    public int Size; public string Reserved, Desktop, Title;
    public int PositionX, PositionY, Width, Height, XChars, YChars, Fill, Flags;
    public short Show, ReservedSize; public IntPtr ReservedBytes, Input, Output, Error;
  }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedStartup { public Startup Info; public IntPtr Attributes; }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process, Thread; public uint Pid, Tid; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr security, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits info, int length);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, ref Accounting info, int length, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, IntPtr info, int length, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr attributes, uint count, uint flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr attributes, uint flags, UIntPtr attribute, IntPtr value, UIntPtr size, IntPtr previous, IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr attributes);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool assigned);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFile(string file, uint access, uint sharing, ref Security security, uint mode, uint attributes, IntPtr template);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string app, StringBuilder command, IntPtr processSecurity, IntPtr threadSecurity, bool inherit, uint flags, IntPtr environment, string cwd, ref ExtendedStartup startup, out ProcessInfo process);
  IntPtr job, root;
  uint pid;
  string created;
  bool assignedAtCreation;
  public string Name { get; private set; }
  static void Check(bool success) { if (!success) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  static IntPtr File(string file, uint access, uint mode) {
    var security = new Security { Size=Marshal.SizeOf(typeof(Security)), Inherit=1 };
    var handle = CreateFile(file, access, 7, ref security, mode, 128, IntPtr.Zero);
    Check(handle != new IntPtr(-1)); return handle;
  }
  public IsolatedJob(string app, string command, string cwd, string environment, string stdout, string stderr, string name, string creationReady, string creationRelease) {
    Name = name;
    job = CreateJobObject(IntPtr.Zero, name); Check(job != IntPtr.Zero);
    var limits = new ExtendedLimits(); limits.Basic.Flags = 0x2000;
    Check(SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(typeof(ExtendedLimits))));
    Launch(app, command, cwd, environment, stdout, stderr, creationReady, creationRelease);
  }
  public void Launch(string app, string command, string cwd, string environment, string stdout, string stderr, string creationReady, string creationRelease) {
    IntPtr output=IntPtr.Zero, error=IntPtr.Zero, input=IntPtr.Zero, block=IntPtr.Zero, thread=IntPtr.Zero;
    IntPtr attributes=IntPtr.Zero, handles=IntPtr.Zero;
    bool initialized=false;
    try {
      output=File(stdout, 0x40000000, 2); error=File(stderr, 0x40000000, 2); input=File("NUL", 0x80000000, 3);
      IntPtr size=IntPtr.Zero;
      InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
      Check(size != IntPtr.Zero);
      attributes=Marshal.AllocHGlobal(size);
      Check(InitializeProcThreadAttributeList(attributes, 1, 0, ref size)); initialized=true;
      handles=Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(handles, job);
      Check(UpdateProcThreadAttribute(attributes, 0, new UIntPtr(0x0002000D), handles, new UIntPtr((uint)IntPtr.Size), IntPtr.Zero, IntPtr.Zero));
      var startup = new ExtendedStartup { Info=new Startup { Size=Marshal.SizeOf(typeof(ExtendedStartup)), Flags=0x100, Input=input, Output=output, Error=error }, Attributes=attributes };
      block=Marshal.StringToHGlobalUni(environment);
      ProcessInfo process;
      assignedAtCreation=false;
      Check(CreateProcess(app, new StringBuilder(command), IntPtr.Zero, IntPtr.Zero, true, 4|0x400|0x08000000|0x00080000, block, cwd, ref startup, out process));
      if (root != IntPtr.Zero) CloseHandle(root);
      root=process.Process; thread=process.Thread; pid=process.Pid;
      long birth, exit, kernel, user; Check(GetProcessTimes(root, out birth, out exit, out kernel, out user)); created=DateTime.FromFileTimeUtc(birth).ToString("o");
      if (!String.IsNullOrEmpty(creationReady)) {
        System.IO.File.WriteAllText(creationReady, pid.ToString(System.Globalization.CultureInfo.InvariantCulture));
        var deadline=DateTime.UtcNow.AddSeconds(15);
        while (!System.IO.File.Exists(creationRelease)) {
          if (OwnerGone || DateTime.UtcNow > deadline) throw new InvalidOperationException("Creation fault pause owner closed or timed out");
          System.Threading.Thread.Sleep(25);
        }
      }
      bool assigned; Check(IsProcessInJob(root, job, out assigned));
      if (!assigned) throw new InvalidOperationException("Root was not atomically assigned to the held Job");
      assignedAtCreation=true;
      Check(ResumeThread(thread) != UInt32.MaxValue);
    } catch { Dispose(); throw; }
    finally { if (initialized) DeleteProcThreadAttributeList(attributes); if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes); if (handles != IntPtr.Zero) Marshal.FreeHGlobal(handles); if (output != IntPtr.Zero) CloseHandle(output); if (error != IntPtr.Zero) CloseHandle(error); if (input != IntPtr.Zero) CloseHandle(input); if (thread != IntPtr.Zero) CloseHandle(thread); if (block != IntPtr.Zero) Marshal.FreeHGlobal(block); }
  }
  public sealed class State {
    public string JobName, Created;
    public uint Pid, Active, Total;
    public uint[] Members;
    public bool AssignedAtCreation, AssignedBeforeResume=true, NoBreakaway=true, RootExited;
    public uint? RootExitCode;
  }
  public State Query() {
    var accounting = new Accounting(); Check(QueryInformationJobObject(job, 1, ref accounting, Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero));
    uint exit; Check(GetExitCodeProcess(root, out exit));
    var state = new State { JobName=Name, Created=created, Pid=pid, AssignedAtCreation=assignedAtCreation, Active=accounting.Active, Total=accounting.Total, RootExited=WaitForSingleObject(root, 0)==0 };
    if (state.RootExited) state.RootExitCode=exit;
    int length=8192;
    while (true) {
      var buffer=Marshal.AllocHGlobal(length);
      try {
        if (!QueryInformationJobObject(job, 3, buffer, length, IntPtr.Zero)) { int failure=Marshal.GetLastWin32Error(); if (failure==234 || failure==122) { length*=2; if (length>1048576) throw new Win32Exception(failure); continue; } throw new Win32Exception(failure); }
        int count=Marshal.ReadInt32(buffer, 4); state.Members=new uint[count];
        for (int index=0; index<count; index++) state.Members[index]=(uint)(IntPtr.Size==8 ? Marshal.ReadInt64(buffer, 8+index*8) : Marshal.ReadInt32(buffer, 8+index*4));
        return state;
      } finally { Marshal.FreeHGlobal(buffer); }
    }
  }
  public void Terminate() { Check(TerminateJobObject(job, 1)); }
  public void Dispose() { if (job != IntPtr.Zero) { CloseHandle(job); job=IntPtr.Zero; } if (root != IntPtr.Zero) { CloseHandle(root); root=IntPtr.Zero; } }
}
'@
function Publish($value) {
  $temporary = $config.state + '.tmp'
  [IO.File]::WriteAllText($temporary, ($value | ConvertTo-Json -Depth 8 -Compress), [Text.UTF8Encoding]::new($false))
  if ([IO.File]::Exists($config.state)) { [IO.File]::Replace($temporary, $config.state, $config.state + '.previous') } else { [IO.File]::Move($temporary, $config.state) }
}
$job = $null
$commands = @()
try {
  $environment = (([Environment]::GetEnvironmentVariables().GetEnumerator() | Sort-Object Key | ForEach-Object { $_.Key + '=' + [string]$_.Value }) -join [char]0) + [char]0 + [char]0
  $job = [IsolatedJob]::new($config.executable, $config.commandLine, $config.cwd, $environment, $config.stdout, $config.stderr, $config.jobName, $config.creationReady, $config.creationRelease)
  $terminating = $false
  $deadline = [DateTime]::MaxValue
  while ($true) {
    if ([IO.File]::Exists($config.add)) {
      if ($terminating -or [IsolatedJob]::OwnerGone -or [IO.File]::Exists($config.control)) { throw 'Additional root refused after termination request or owner closure' }
      $additional = Get-Content -LiteralPath $config.add -Raw -Encoding UTF8 | ConvertFrom-Json
      [IO.File]::Delete($config.add)
      $job.Launch($additional.executable, $additional.commandLine, $additional.cwd, $environment, $additional.stdout, $additional.stderr, $null, $null)
    }
    $state = $job.Query()
    $confirmed = $terminating -and $state.Active -eq 0 -and $state.RootExited
    Publish @{ state=$state; confirmed=$confirmed; commands=$commands }
    if ($confirmed) { break }
    if (!$terminating -and ([IO.File]::Exists($config.control) -or [IsolatedJob]::OwnerGone)) {
      $job.Terminate()
      $commands += @{ operation='TerminateJobObject'; status=0; jobName=$config.jobName; reason=$(if ([IsolatedJob]::OwnerGone) { 'owner-closed' } else { 'requested' }) }
      $terminating = $true
      $deadline = [DateTime]::UtcNow.AddSeconds(10)
    }
    if ([DateTime]::UtcNow -gt $deadline) { throw 'Job active process count did not reach zero' }
    Start-Sleep -Milliseconds 100
  }
} catch {
  Publish @{ confirmed=$false; commands=$commands; error=$_.Exception.ToString() }
  exit 1
} finally { if ($null -ne $job) { $job.Dispose() } }
