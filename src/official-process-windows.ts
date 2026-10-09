/** System Windows PowerShell / .NET only. The constant source travels on stdin,
 * avoiding Windows' argv length limit and keeping process capabilities off argv.
 * No elevation, debug privilege, external compiler, process-name kill or PID kill.
 * Only native 64-bit targets are eligible; unknown process-parameter layouts fail
 * closed. Bounded launch metadata is read in memory and never sent to the UI. */
export const WINDOWS_PROCESS_BOOTSTRAP = String.raw`
$ErrorActionPreference='Stop'
try {
 # Redirected helpers have no console code page. Use one explicit reader for
 # source, request and acknowledgement; never reset its buffered input.
 $encoding=[Text.UTF8Encoding]::new($false,$true)
 [Console]::SetIn([IO.StreamReader]::new([Console]::OpenStandardInput(),$encoding,$false,4096,$true))
 $writer=[IO.StreamWriter]::new([Console]::OpenStandardOutput(),$encoding,4096,$true)
 $writer.AutoFlush=$true
 [Console]::SetOut($writer)
 $source=[Console]::In.ReadLine()
 if($null -eq $source -or $source.Length -gt 262144){throw 'invalid'}
 & ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($source))))
} catch { [Console]::Out.WriteLine('{"code":"OFFICIAL_PROCESS_END_UNAVAILABLE"}') }
`;
export const WINDOWS_PROCESS_HELPER = String.raw`
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
public static class AgProcess {
 const uint Query=0x0400, VmRead=0x10, Synchronize=0x100000, Terminate=1;
 [StructLayout(LayoutKind.Sequential)] struct Basic { public IntPtr Reserved1,Peb,Reserved2a,Reserved2b,Pid,Parent; }
 [StructLayout(LayoutKind.Sequential)] struct Region { public IntPtr Base,AllocationBase; public uint AllocationProtect; public ushort Partition,Padding; public UIntPtr Size; public uint State,Protect,Type; }
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr h);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr h,out long creation,out long exit,out long kernel,out long user);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool QueryFullProcessImageName(IntPtr h,uint flags,StringBuilder image,ref uint size);
 [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr h,uint ms);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr h,uint code);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool IsWow64Process2(IntPtr h,out ushort machine,out ushort nativeMachine);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool ReadProcessMemory(IntPtr h,IntPtr address,byte[] bytes,UIntPtr size,out UIntPtr read);
 [DllImport("kernel32.dll",SetLastError=true)] static extern UIntPtr VirtualQueryEx(IntPtr h,IntPtr address,out Region region,UIntPtr size);
 [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int which);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool PeekNamedPipe(IntPtr h,IntPtr buffer,uint size,IntPtr read,out uint available,IntPtr left);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr h,uint access,out IntPtr token);
 [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h,int kind,out Basic basic,int size,out int returned);
 [DllImport("shell32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CommandLineToArgvW(string raw,out int count);
 [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern IntPtr GetModuleHandle(string name);
 [DllImport("kernel32.dll",CharSet=CharSet.Ansi,ExactSpelling=true)] static extern IntPtr GetProcAddress(IntPtr module,string name);
 public sealed class Row {
  public string platform="win32"; public int pid,parentPid; public string startTicks,commandHash,kind="unverified",scope="unknown",scopeReason="ancestry-unavailable",credentialScopeReason="process-identity-unverified",parentState="unknown",startedAt; public bool canEnd,credentialScopeVerified;
 }
 static readonly string[] AuthEnvironment={"JETSKI_OAUTH_TOKEN","JETSKI_TEST_GAIA_TOKEN","GOOGLE_API_KEY","GEMINI_API_KEY","GOOGLE_APPLICATION_CREDENTIALS","AGY_ADC_AUTH"};
 static readonly string[] ConfigEnvironment={"ANTIGRAVITY_SERVER_URL","AGY_RELEASE_BASE_URL","CLOUD_WORKSTATIONS","CLOUD_SHELL","ANTIGRAVITY_CDE","XDG_CONFIG_HOME","XDG_DATA_HOME","XDG_STATE_HOME","XDG_CACHE_HOME"};
 static readonly string[] BusinessPrefixes={"AGY_","ANTIGRAVITY_","JETSKI_","GOOGLE_","GEMINI_","CODEIUM_","WINDSURF_","CLOUD_"};
 static bool Contains(string[] values,string key){foreach(string value in values)if(value.Equals(key,StringComparison.OrdinalIgnoreCase))return true;return false;}
 static bool LaunchArgument(string arg){if(arg.StartsWith("--add-dir=",StringComparison.Ordinal))return arg.Length>10&&arg.Length<=32778;string key=arg.Split('=')[0];return key=="--hub"||key=="--app_data_dir"||key=="--hub-port"||key=="--csrf_token";}
 static bool HomeField(string key){return Contains(new[]{"USERPROFILE","HOME","HOMEDRIVE","HOMEPATH","APPDATA","LOCALAPPDATA"},key);}
 static bool OfficialMarker(string key){return key=="AGY_ENABLE_HUB"||key=="ANTIGRAVITY_VSCODE_HOST"||key=="ANTIGRAVITY_AUTH_SUCCESS_APP";}
 static bool ValidMarker(string key,string value){return key=="ANTIGRAVITY_AUTH_SUCCESS_APP"?System.Text.RegularExpressions.Regex.IsMatch(value,@"\A[A-Za-z][A-Za-z0-9+.-]{0,127}\z"):value=="1";}
 static bool BusinessField(string key){foreach(string prefix in BusinessPrefixes)if(key.StartsWith(prefix,StringComparison.OrdinalIgnoreCase))return true;return false;}
 sealed class Fixed : Exception { public string Code; public Fixed(string code){Code=code;} }
 static Fixed Stale(){return new Fixed("OFFICIAL_PROCESS_SELECTION_STALE");}
 static Fixed Unavailable(){return new Fixed("OFFICIAL_PROCESS_END_UNAVAILABLE");}
 static bool Exited(IntPtr h){uint state=WaitForSingleObject(h,0);if(state==0)return true;if(state!=258)throw Unavailable();return false;}
 static Fixed NativeError(IntPtr h){int error=Marshal.GetLastWin32Error();if(h!=IntPtr.Zero && Exited(h))return new Fixed("gone");return new Fixed(error==5?"OFFICIAL_PROCESS_END_DENIED":"OFFICIAL_PROCESS_END_UNAVAILABLE");}
 static IntPtr Bind(int pid,bool terminate){IntPtr h=OpenProcess(Query|VmRead|Synchronize|(terminate?Terminate:0),false,pid);if(h==IntPtr.Zero){int e=Marshal.GetLastWin32Error();if(e==87)throw new Fixed("gone");throw new Fixed(e==5?"OFFICIAL_PROCESS_END_DENIED":"OFFICIAL_PROCESS_END_UNAVAILABLE");}return h;}
 static long Birth(IntPtr h){long c,e,k,u;if(!GetProcessTimes(h,out c,out e,out k,out u))throw NativeError(h);if(c<=0)throw Stale();return c;}
 static string Image(IntPtr h){StringBuilder s=new StringBuilder(32768);uint n=32768;if(!QueryFullProcessImageName(h,0,s,ref n))throw NativeError(h);return s.ToString();}
 static string Sid(IntPtr h){IntPtr token;if(!OpenProcessToken(h,8,out token))throw NativeError(h);try{using(WindowsIdentity identity=new WindowsIdentity(token)){if(identity.User==null)throw Stale();return identity.User.Value;}}finally{CloseHandle(token);}}
 static string CurrentSid(){using(WindowsIdentity identity=WindowsIdentity.GetCurrent()){if(identity.User==null)throw Stale();return identity.User.Value;}}
 static bool Absolute(string s){
  if(String.IsNullOrEmpty(s))return false;
  if(s.Length>=3&&Char.IsLetter(s[0])&&s[1]==':'&&(s[2]=='\\'||s[2]=='/'))return true;
  if(!s.StartsWith(@"\\",StringComparison.Ordinal))return false;
  string[] parts=s.Substring(2).Split('\\');return parts.Length>=2&&parts[0].Length>0&&parts[1].Length>0&&parts[0]!="?"&&parts[0]!=".";
 }
 static bool SamePath(string a,string b){try{return Absolute(a)&&Absolute(b)&&String.Equals(Path.GetFullPath(a).TrimEnd('\\'),Path.GetFullPath(b).TrimEnd('\\'),StringComparison.OrdinalIgnoreCase);}catch{return false;}}
 static byte[] Read(IntPtr h,long address,int count){if(address<=0||count<0||count>131072)throw Stale();byte[] b=new byte[count];UIntPtr read;if(!ReadProcessMemory(h,new IntPtr(address),b,new UIntPtr((uint)count),out read)||read.ToUInt64()!=(ulong)count)throw NativeError(h);return b;}
 static long Pointer(byte[] b,int at){long p=BitConverter.ToInt64(b,at);if(p<=0||p%2!=0)throw Stale();return p;}
 static readonly Encoding Utf16=new UnicodeEncoding(false,false,true);
 static string Unicode(IntPtr h,byte[] parameters,int at){int length=BitConverter.ToUInt16(parameters,at),max=BitConverter.ToUInt16(parameters,at+2);if(length<=0||length%2!=0||length>max||max>65534)throw Stale();return Utf16.GetString(Read(h,Pointer(parameters,at+8),length));}
 static Dictionary<string,string> EnvironmentScope(IntPtr h,long address){
  // Never retain arbitrary variables. Traverse at most 128 KiB, respecting region
  // boundaries; duplicate/missing scope fields and inaccessible memory fail closed.
  Dictionary<string,string> scope=new Dictionary<string,string>(StringComparer.OrdinalIgnoreCase);
  StringBuilder entry=new StringBuilder();bool previousZero=false;int consumed=0;
  while(consumed<131072){
   Region region;long current=checked(address+consumed);
   if(VirtualQueryEx(h,new IntPtr(current),out region,new UIntPtr((uint)Marshal.SizeOf(typeof(Region))))==UIntPtr.Zero||region.State!=0x1000||(region.Protect&0x101)!=0)throw NativeError(h);
   long available=checked(region.Base.ToInt64()+(long)region.Size.ToUInt64()-current);int count=(int)Math.Min(512,Math.Min(131072-consumed,available));if(count<=0||count%2!=0)throw Stale();
   byte[] part=Read(h,current,count);
   for(int i=0;i<part.Length;i+=2){char c=(char)BitConverter.ToUInt16(part,i);if(c=='\0'){
    if(previousZero)return scope;
    string value=entry.ToString();entry.Length=0;int equals=value.IndexOf('=');
    if(equals>0){string key=value.Substring(0,equals).ToUpperInvariant();if(HomeField(key)||Contains(AuthEnvironment,key)||Contains(ConfigEnvironment,key)||BusinessField(key)){if(scope.ContainsKey(key))throw Stale();scope.Add(key,HomeField(key)||OfficialMarker(key)?value.Substring(equals+1):"<present>");}}
    previousZero=true;
   }else{previousZero=false;entry.Append(c);}}
   consumed+=count;
  }
  throw Stale();
 }
 sealed class EnvironmentProof { public string Fingerprint,Reason="verified"; }
 static EnvironmentProof Scope(Dictionary<string,string> scope,string home){
  EnvironmentProof result=new EnvironmentProof();string profile=null,value=null,drive=null,homePath=null;
  bool hasProfile=scope.TryGetValue("USERPROFILE",out profile),hasHome=scope.TryGetValue("HOME",out value),hasDrive=scope.TryGetValue("HOMEDRIVE",out drive),hasPath=scope.TryGetValue("HOMEPATH",out homePath);
  if(!hasProfile||!SamePath(profile,home)||hasHome&&!SamePath(value,home)||hasDrive!=hasPath||hasDrive&&!SamePath(drive+homePath,home))result.Reason="home-mismatch";
  if(result.Reason=="verified")foreach(string key in scope.Keys){
   if(Contains(AuthEnvironment,key)){result.Reason="auth-environment-override";break;}
   if(OfficialMarker(key)){if(!ValidMarker(key,scope[key]))result.Reason="config-environment-override";continue;}
   if(key=="APPDATA"&&!SamePath(scope[key],Path.Combine(home,"AppData","Roaming"))||key=="LOCALAPPDATA"&&!SamePath(scope[key],Path.Combine(home,"AppData","Local"))||!HomeField(key))result.Reason="config-environment-override";
  }
  StringBuilder selected=new StringBuilder();List<string> keys=new List<string>(scope.Keys);keys.Sort(StringComparer.Ordinal);foreach(string key in keys)selected.Append(key).Append('=').Append(scope[key]).Append('\0');result.Fingerprint=selected.ToString();return result;
 }
 static string[] Args(string command){int count;IntPtr p=CommandLineToArgvW(command,out count);if(p==IntPtr.Zero)throw Stale();try{if(count<1||count>1024)throw Stale();string[] result=new string[count];for(int i=0;i<count;i++)result[i]=Marshal.PtrToStringUni(Marshal.ReadIntPtr(p,i*IntPtr.Size));return result;}finally{LocalFree(p);}}
 static string Flag(string[] args,string flag){string found=null;int count=0;foreach(string a in args){if(a.Split('=')[0]==flag){count++;if(a.StartsWith(flag+"=",StringComparison.Ordinal))found=a.Substring(flag.Length+1);}}return count==1?found:null;}
 static string Hash(string value){using(SHA256 sha=SHA256.Create()){return BitConverter.ToString(sha.ComputeHash(new UTF8Encoding(false,true).GetBytes(value))).Replace("-","").ToLowerInvariant();}}
 sealed class Metadata { public int Parent;public string Command,Scope,Image,CredentialReason; }
 sealed class Ancestor { public IntPtr Handle;public int Pid,Parent;public long Birth; }
 static string ScopeResult(string scope,string label,out string reason){reason=label;return scope;}
 static string Ancestry(int parent,long childBirth,int ownerPid,out string reason){
  List<Ancestor> held=new List<Ancestor>();HashSet<int> seen=new HashSet<int>();int cursor=parent;long beforeChild=childBirth;
  try{for(int depth=0;depth<64;depth++){
   if(cursor<=0)return ScopeResult("unknown","ancestry-unavailable",out reason);if(!seen.Add(cursor))return ScopeResult("unknown","ancestry-cycle",out reason);
   IntPtr h=OpenProcess(Query|Synchronize,false,cursor);
   if(h==IntPtr.Zero)return depth==0&&Marshal.GetLastWin32Error()==87?ScopeResult("detached","parent-exited",out reason):ScopeResult("unknown","ancestor-unreadable",out reason);
   Ancestor row=new Ancestor{Handle=h,Pid=cursor};held.Add(row);
   if(Exited(h))return depth==0?ScopeResult("detached","parent-exited",out reason):ScopeResult("unknown","ancestor-replaced",out reason);
   row.Birth=Birth(h);if(row.Birth>beforeChild)return ScopeResult("unknown","ancestor-replaced",out reason);if(Sid(h)!=CurrentSid())return ScopeResult("unknown","ancestor-user-mismatch",out reason);
   Basic basic;int returned;if(NtQueryInformationProcess(h,0,out basic,Marshal.SizeOf(typeof(Basic)),out returned)!=0||returned!=Marshal.SizeOf(typeof(Basic))||basic.Pid.ToInt64()!=cursor||basic.Parent.ToInt64()<0||basic.Parent.ToInt64()>Int32.MaxValue)return ScopeResult("unknown","ancestry-unavailable",out reason);
   row.Parent=(int)basic.Parent.ToInt64();
   if(cursor==ownerPid){foreach(Ancestor item in held){Basic after;int length;if(Exited(item.Handle)||Birth(item.Handle)!=item.Birth||NtQueryInformationProcess(item.Handle,0,out after,Marshal.SizeOf(typeof(Basic)),out length)!=0||length!=Marshal.SizeOf(typeof(Basic))||after.Pid.ToInt64()!=item.Pid||after.Parent.ToInt64()!=item.Parent)throw Stale();}return ScopeResult("current-window","current-host-ancestry",out reason);}
   if(row.Parent==0)return ScopeResult("other-window","different-host-ancestry",out reason);
   beforeChild=row.Birth;cursor=row.Parent;
  }return ScopeResult("unknown","ancestry-limit",out reason);}catch(Fixed){return ScopeResult("unknown","ancestor-unreadable",out reason);}finally{foreach(Ancestor item in held)CloseHandle(item.Handle);}
 }
 static bool Eligible(Row row){return row.kind=="unowned-hub"&&row.credentialScopeVerified;}
 static Metadata Launch(IntPtr h,int pid,string home,Action<string> progress=null){
  if(progress!=null)progress("architecture");
  ushort machine,native;if(IntPtr.Size!=8||!IsWow64Process2(h,out machine,out native)||machine!=0||(native!=0x8664&&native!=0xaa64))throw Unavailable();
  if(progress!=null)progress("process-info");Basic basic;int returned;if(NtQueryInformationProcess(h,0,out basic,Marshal.SizeOf(typeof(Basic)),out returned)!=0||returned!=Marshal.SizeOf(typeof(Basic))||basic.Pid.ToInt64()!=pid||basic.Parent.ToInt64()<0||basic.Parent.ToInt64()>Int32.MaxValue)throw Stale();
  if(progress!=null)progress("parameters");byte[] peb=Read(h,basic.Peb.ToInt64(),40);long parameters=Pointer(peb,32);byte[] block=Read(h,parameters,136);
  uint maximum=BitConverter.ToUInt32(block,0),length=BitConverter.ToUInt32(block,4),flags=BitConverter.ToUInt32(block,8);
  if(length<136||maximum<length||maximum>131072||(flags&1)==0)throw Stale();
  if(progress!=null)progress("environment");EnvironmentProof env=Scope(EnvironmentScope(h,Pointer(block,128)),home);return new Metadata{Parent=(int)basic.Parent.ToInt64(),Command=Unicode(h,block,112),Image=Unicode(h,block,96),Scope=env.Fingerprint,CredentialReason=env.Reason};
 }
 static Row Inspect(IntPtr h,int pid,string executable,string home,int ownerPid,int port,string csrf,Action<string> progress=null){
  if(progress!=null)progress("identity");if(Exited(h))throw new Fixed("gone");long birth=Birth(h);string image=Image(h),sid=Sid(h);if(!SamePath(image,executable)||sid!=CurrentSid())throw Stale();Metadata launch=Launch(h,pid,home,progress);
  if(progress!=null)progress("image-path");if(!SamePath(launch.Image,executable))throw Stale();
  if(progress!=null)progress("argv");string[] args=Args(launch.Command);if(!SamePath(args[0],executable))throw Stale();
  int hubs=0;bool exactHub=false;foreach(string a in args){if(a.Split('=')[0]=="--hub"){hubs++;exactHub=a=="--hub";}}
  string advertisedPort=Flag(args,"--hub-port"),advertisedCsrf=Flag(args,"--csrf_token");int parsedPort;
  if(hubs!=1||!exactHub||Flag(args,"--app_data_dir")!="antigravity"||advertisedPort==null||!System.Text.RegularExpressions.Regex.IsMatch(advertisedPort,@"\A[1-9][0-9]{0,4}\z")||!Int32.TryParse(advertisedPort,out parsedPort)||parsedPort>65535||advertisedCsrf==null||!System.Text.RegularExpressions.Regex.IsMatch(advertisedCsrf,@"\A[A-Za-z0-9_-]{16,128}\z"))throw Stale();
  string credentialReason=launch.CredentialReason;if(credentialReason=="verified")for(int i=1;i<args.Length;i++)if(!LaunchArgument(args[i])){credentialReason="unsupported-launch-flags";break;}
  if(progress!=null)progress("stability");Metadata after=Launch(h,pid,home);if(Exited(h))throw new Fixed("gone");
  if(birth!=Birth(h)||image!=Image(h)||sid!=Sid(h)||launch.Parent!=after.Parent||launch.Command!=after.Command||launch.Scope!=after.Scope||launch.CredentialReason!=after.CredentialReason||launch.Image!=after.Image)throw Stale();
  bool advertised=parsedPort==port&&advertisedCsrf==csrf;
  string scopeReason="api-capability-match",scope=advertised?"current-window":Ancestry(launch.Parent,birth,ownerPid,out scopeReason);
  Row row=new Row{pid=pid,parentPid=launch.Parent,startTicks=birth.ToString(CultureInfo.InvariantCulture),commandHash=Hash(launch.Command+"\0"+launch.Scope+"\0"+image+"\0"+sid+"\0"+launch.Parent+"\0"+scope),kind=advertised?"current-hub":"unowned-hub",scope=scope,scopeReason=scopeReason,credentialScopeVerified=credentialReason=="verified",credentialScopeReason=credentialReason,startedAt=DateTime.FromFileTimeUtc(birth).ToString("o",CultureInfo.InvariantCulture)};
  IntPtr parent=OpenProcess(Synchronize,false,row.parentPid);if(parent!=IntPtr.Zero){try{row.parentState=Exited(parent)?"gone":"alive";}finally{CloseHandle(parent);}}else if(Marshal.GetLastWin32Error()==87)row.parentState="gone";
  return row;
 }
 // Fixed stage labels support the internal read-only native fixture. They carry
 // no path, argv, SID, environment or capability and are never shown by the UI.
 public static object InspectOnly(int pid,string executable,string home,int ownerPid,int port,string csrf){IntPtr h=IntPtr.Zero;string stage="bind";try{h=Bind(pid,false);return Inspect(h,pid,executable,home,ownerPid,port,csrf,value=>stage=value);}catch(Fixed e){return new {code=e.Code,stage=stage};}finally{if(h!=IntPtr.Zero)CloseHandle(h);}}
 public static Row[] Scan(string executable,string home,int ownerPid,int port,string csrf){
  List<Row> rows=new List<Row>();Process[] processes=Process.GetProcessesByName("agy");if(processes.Length>1024)throw Unavailable();
  foreach(Process process in processes){using(process){int pid;try{pid=process.Id;}catch(InvalidOperationException){continue;}IntPtr h=IntPtr.Zero;string stage="identity";
   try{h=Bind(pid,false);Row row=Inspect(h,pid,executable,home,ownerPid,port,csrf,value=>stage=value);
    if(Eligible(row)){IntPtr end=IntPtr.Zero;try{end=Bind(pid,true);Row checkedRow=Inspect(end,pid,executable,home,ownerPid,port,csrf);row.canEnd=checkedRow.startTicks==row.startTicks&&checkedRow.commandHash==row.commandHash&&Eligible(checkedRow);}catch(Fixed){}finally{if(end!=IntPtr.Zero)CloseHandle(end);}}
    rows.Add(row);
   }catch(Fixed e){if(e.Code!="gone")rows.Add(new Row{pid=pid,credentialScopeReason=stage=="environment"?"environment-unreadable":"process-identity-unverified"});}finally{if(h!=IntPtr.Zero)CloseHandle(h);}
  }}return rows.ToArray();
 }
 static void CancelCheck(){uint available;if(!PeekNamedPipe(GetStdHandle(-10),IntPtr.Zero,0,IntPtr.Zero,out available,IntPtr.Zero)||available!=0)throw new Fixed("OFFICIAL_PROCESS_END_CANCELLED");}
 static void Match(Row row,string birth,string proof){if(!Eligible(row)||row.startTicks!=birth||row.commandHash!=proof)throw Stale();}
 public static string End(int pid,string birth,string proof,string executable,string home,int ownerPid,int port,string csrf){
  IntPtr h=IntPtr.Zero;try{
   h=Bind(pid,true);Match(Inspect(h,pid,executable,home,ownerPid,port,csrf),birth,proof);
   CancelCheck();Console.Out.WriteLine("{\"authorize\":\"force\"}");Console.Out.Flush();if(Console.In.ReadLine()!="continue")throw new Fixed("OFFICIAL_PROCESS_END_CANCELLED");
   Match(Inspect(h,pid,executable,home,ownerPid,port,csrf),birth,proof);CancelCheck();
   // This is explicitly forced termination, never a normal-exit request.
   if(!TerminateProcess(h,1)){if(Exited(h))return "{\"result\":\"gone\"}";throw NativeError(h);}
   Stopwatch wait=Stopwatch.StartNew();while(wait.ElapsedMilliseconds<4000){uint state=WaitForSingleObject(h,50);if(state==0)return "{\"result\":\"forced\"}";if(state!=258)throw NativeError(h);CancelCheck();}
   return "{\"code\":\"OFFICIAL_BACKEND_STOP_TIMEOUT\"}";
  }catch(Fixed e){return e.Code=="gone"?"{\"result\":\"gone\"}":"{\"code\":\""+e.Code+"\"}";}finally{if(h!=IntPtr.Zero)CloseHandle(h);}
 }
 public static bool Supported(){return IntPtr.Size==8 && GetProcAddress(GetModuleHandle("kernel32.dll"),"IsWow64Process2")!=IntPtr.Zero;}
}
'@
$line=[Console]::In.ReadLine()
if($null -eq $line -or $line.Length -gt 16384){throw 'invalid'}
$r=$line | ConvertFrom-Json
if($r.operation -eq 'probe'){[Console]::Out.WriteLine((@{supported=[AgProcess]::Supported()}|ConvertTo-Json -Compress))}
elseif($r.operation -eq 'inspect'){
 [Console]::Out.WriteLine(([AgProcess]::InspectOnly([int]$r.pid,[string]$r.executable,[string]$r.home,[int]$r.ownerPid,[int]$r.port,[string]$r.csrfToken)|ConvertTo-Json -Depth 5 -Compress))
}elseif($r.operation -eq 'scan'){
 $rows=@([AgProcess]::Scan([string]$r.executable,[string]$r.home,[int]$r.ownerPid,[int]$r.port,[string]$r.csrfToken))
 [Console]::Out.WriteLine((@{supported=[AgProcess]::Supported();processes=$rows}|ConvertTo-Json -Depth 5 -Compress))
}elseif($r.operation -eq 'end'){
 [Console]::Out.WriteLine([AgProcess]::End([int]$r.target.pid,[string]$r.target.startTicks,[string]$r.target.commandHash,[string]$r.executable,[string]$r.home,[int]$r.ownerPid,[int]$r.port,[string]$r.csrfToken))
}else{throw 'invalid'}
`;
