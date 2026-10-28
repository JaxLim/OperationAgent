#include "channel.hpp"
#include <userenv.h>
#include <sddl.h>
#include <aclapi.h>
#include <bcrypt.h>
#include <tlhelp32.h>
#include <algorithm>

namespace {
using namespace oa;
struct Sid { PSID value = nullptr; ~Sid() { if (value) FreeSid(value); } };
struct Local { void* value = nullptr; ~Local() { if (value) LocalFree(value); } };
struct Attributes {
  std::vector<uint8_t> bytes; LPPROC_THREAD_ATTRIBUTE_LIST list = nullptr;
  ~Attributes() { if (list) DeleteProcThreadAttributeList(list); }
  void initialize(DWORD count) {
    SIZE_T size = 0; InitializeProcThreadAttributeList(nullptr, count, 0, &size); bytes.resize(size);
    list = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(bytes.data());
    if (!InitializeProcThreadAttributeList(list, count, 0, &size)) { list = nullptr; fail("INITIALIZE_ATTRIBUTES"); }
  }
  void add(DWORD_PTR key, void* value, SIZE_T size) { if (!UpdateProcThreadAttribute(list, 0, key, value, size, nullptr, nullptr)) fail("UPDATE_ATTRIBUTE"); }
};
std::vector<uint8_t> tokenData(HANDLE token, TOKEN_INFORMATION_CLASS kind) {
  DWORD size = 0; GetTokenInformation(token, kind, nullptr, 0, &size);
  if (!size) fail("TOKEN_SIZE");
  std::vector<uint8_t> bytes(size);
  if (!GetTokenInformation(token, kind, bytes.data(), size, &size)) fail("TOKEN_INFORMATION");
  return bytes;
}
std::wstring sidText(PSID sid) {
  LPWSTR value = nullptr; if (!ConvertSidToStringSidW(sid, &value)) fail("SID_STRING");
  std::wstring result(value); LocalFree(value); return result;
}
std::wstring randomName() {
  uint8_t bytes[16]{}; if (BCryptGenRandom(nullptr, bytes, sizeof(bytes), BCRYPT_USE_SYSTEM_PREFERRED_RNG) != 0) throw std::runtime_error("RANDOM_FAILED");
  std::wstring result = L"OperationAgent.P1."; const wchar_t* hex = L"0123456789abcdef";
  for (auto byte : bytes) { result += hex[byte >> 4]; result += hex[byte & 15]; }
  return result;
}
std::wstring quote(const std::wstring& value) {
  std::wstring result = L"\""; size_t slashes = 0;
  for (auto character : value) {
    if (character == L'\\') { ++slashes; continue; }
    result.append(character == L'"' ? slashes * 2 + 1 : slashes, L'\\'); slashes = 0; result += character;
  }
  result.append(slashes * 2, L'\\'); return result + L"\"";
}
DWORD parentPid(DWORD pid) {
  Handle snapshot(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0));
  if (snapshot.value == INVALID_HANDLE_VALUE) fail("PROCESS_SNAPSHOT");
  PROCESSENTRY32W entry{}; entry.dwSize = sizeof(entry);
  if (Process32FirstW(snapshot.value, &entry)) do { if (entry.th32ProcessID == pid) return entry.th32ParentProcessID; } while (Process32NextW(snapshot.value, &entry));
  throw std::runtime_error("PARENT_IDENTITY_UNAVAILABLE");
}
struct Run final : Channel {
  Handle job, process;
  Sid sid;
  Local originalSecurity;
  PACL originalDacl = nullptr;
  std::wstring runtime, profile;
  DWORD pid = 0, integrity = 0, parent = 0;
  bool profileCreated = false, aclChanged = false, cleaned = false;
  std::mutex cleanupMutex;
  ~Run() override {
    // Job close still terminates a Worker when its JS owner is abandoned. Explicit close is
    // required to confirm exit and remove the profile; P1.5 owns crash/orphan reconciliation.
    job.reset();
  }
  void cleanup() override {
    std::lock_guard<std::mutex> cleanupLock(cleanupMutex);
    if (cleaned) return;
    cancel();
    if (process.value && WaitForSingleObject(process.value, 0) == WAIT_TIMEOUT) {
      if (!TerminateJobObject(job.value, 1)) fail("TERMINATE_JOB");
      if (WaitForSingleObject(process.value, 5000) != WAIT_OBJECT_0) throw std::runtime_error("WORKER_CLEANUP_UNCONFIRMED");
    }
    Channel::cleanup();
    if (aclChanged) {
      const DWORD status = SetNamedSecurityInfoW(runtime.data(), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, nullptr, nullptr, originalDacl, nullptr);
      if (status != ERROR_SUCCESS) fail("RESTORE_RUNTIME_ACL", status);
      aclChanged = false;
    }
    if (profileCreated) {
      const HRESULT status = DeleteAppContainerProfile(profile.c_str());
      if (FAILED(status)) fail("DELETE_APPCONTAINER_PROFILE", static_cast<DWORD>(status));
      profileCreated = false;
    }
    process.reset(); job.reset(); cleaned = true;
  }
};
void requireDirectory(const std::wstring& directory) {
  if (directory.size() < 4 || directory[1] != L':' || (directory[2] != L'/' && directory[2] != L'\\')) throw std::runtime_error("ABSOLUTE_RUNTIME_REQUIRED");
  // Reject reparse points in every ancestor, not just the leaf.
  for (size_t index = 3; index <= directory.size(); ++index) {
    if (index != directory.size() && directory[index] != L'/' && directory[index] != L'\\') continue;
    const auto component = directory.substr(0, index);
    const DWORD flags = GetFileAttributesW(component.c_str());
    if (flags == INVALID_FILE_ATTRIBUTES || !(flags & FILE_ATTRIBUTE_DIRECTORY) || flags & FILE_ATTRIBUTE_REPARSE_POINT) throw std::runtime_error("UNTRUSTED_RUNTIME_PATH");
  }
}
void grantRuntime(Run& run) {
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  DWORD status = GetNamedSecurityInfoW(run.runtime.data(), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, nullptr, nullptr, &run.originalDacl, nullptr, &descriptor);
  run.originalSecurity.value = descriptor;
  if (status != ERROR_SUCCESS || !run.originalDacl) fail("READ_RUNTIME_ACL", status);
  EXPLICIT_ACCESSW entry{}; entry.grfAccessPermissions = GENERIC_READ | GENERIC_EXECUTE;
  entry.grfAccessMode = GRANT_ACCESS; entry.grfInheritance = SUB_CONTAINERS_AND_OBJECTS_INHERIT;
  entry.Trustee.TrusteeForm = TRUSTEE_IS_SID; entry.Trustee.ptstrName = static_cast<LPWSTR>(run.sid.value);
  PACL next = nullptr; status = SetEntriesInAclW(1, &entry, run.originalDacl, &next); Local allocation; allocation.value = next;
  if (status == ERROR_SUCCESS) status = SetNamedSecurityInfoW(run.runtime.data(), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, nullptr, nullptr, next, nullptr);
  if (status != ERROR_SUCCESS) fail("GRANT_RUNTIME_RX", status);
  run.aclChanged = true;
}
void verifySuspended(Run& run) {
  Handle token; if (!OpenProcessToken(run.process.value, TOKEN_QUERY, &token.value)) fail("OPEN_WORKER_TOKEN");
  const auto app = tokenData(token.value, TokenIsAppContainer), elevation = tokenData(token.value, TokenElevation);
  const auto caps = tokenData(token.value, TokenCapabilities), label = tokenData(token.value, TokenIntegrityLevel);
  const auto appSid = tokenData(token.value, TokenAppContainerSid);
  auto* integrity = reinterpret_cast<const TOKEN_MANDATORY_LABEL*>(label.data());
  run.integrity = *GetSidSubAuthority(integrity->Label.Sid, *GetSidSubAuthorityCount(integrity->Label.Sid) - 1);
  run.parent = parentPid(run.pid);
  if (!*reinterpret_cast<const DWORD*>(app.data()) || reinterpret_cast<const TOKEN_ELEVATION*>(elevation.data())->TokenIsElevated ||
    reinterpret_cast<const TOKEN_GROUPS*>(caps.data())->GroupCount != 0 || run.integrity > SECURITY_MANDATORY_LOW_RID ||
    !EqualSid(reinterpret_cast<const TOKEN_APPCONTAINER_INFORMATION*>(appSid.data())->TokenAppContainer, run.sid.value) || run.parent != GetCurrentProcessId()) throw std::runtime_error("WORKER_TOKEN_BASELINE_REJECTED");
  BOOL member = FALSE; if (!IsProcessInJob(run.process.value, run.job.value, &member) || !member) throw std::runtime_error("WORKER_JOB_REJECTED");
  PROCESS_MITIGATION_CHILD_PROCESS_POLICY child{};
  if (!GetProcessMitigationPolicy(run.process.value, ProcessChildProcessPolicy, &child, sizeof(child)) || !child.NoChildProcessCreation) throw std::runtime_error("WORKER_CHILD_POLICY_REJECTED");
}
void create(Run& run) {
  wchar_t github[8]{}, runner[16]{};
  if (!GetEnvironmentVariableW(L"GITHUB_ACTIONS", github, 8) || std::wstring(github) != L"true" ||
    !GetEnvironmentVariableW(L"RUNNER_OS", runner, 16) || std::wstring(runner) != L"Windows") throw std::runtime_error("DISPOSABLE_WINDOWS_RUNNER_REQUIRED");
  requireDirectory(run.runtime);
  for (const auto* name : {L"node.exe", L"bootstrap.mjs", L"channel.node"}) {
    const DWORD flags = GetFileAttributesW((run.runtime + L"/" + name).c_str());
    if (flags == INVALID_FILE_ATTRIBUTES || flags & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) throw std::runtime_error("FIXTURE_RUNTIME_INCOMPLETE");
  }
  run.profile = randomName();
  const HRESULT profile = CreateAppContainerProfile(run.profile.c_str(), run.profile.c_str(), L"OperationAgent isolated P1 fixture", nullptr, 0, &run.sid.value);
  if (FAILED(profile)) fail("CREATE_APPCONTAINER_PROFILE", static_cast<DWORD>(profile));
  run.profileCreated = true;
  grantRuntime(run);
  run.job.reset(CreateJobObjectW(nullptr, nullptr)); if (!run.job.value) fail("CREATE_JOB");
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
  limits.BasicLimitInformation.ActiveProcessLimit = 1;
  if (!SetInformationJobObject(run.job.value, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) fail("SET_JOB_LIMITS");
  Handle parentToken; if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &parentToken.value)) fail("OPEN_PARENT_TOKEN");
  const auto user = tokenData(parentToken.value, TokenUser);
  const std::wstring dacl = L"D:P(A;;GA;;;SY)(A;;GA;;;" + sidText(reinterpret_cast<const TOKEN_USER*>(user.data())->User.Sid) + L")";
  PSECURITY_DESCRIPTOR security = nullptr;
  if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(dacl.c_str(), SDDL_REVISION_1, &security, nullptr)) fail("PIPE_DACL");
  Local securityMemory; securityMemory.value = security;
  SECURITY_ATTRIBUTES pipeSecurity{sizeof(SECURITY_ATTRIBUTES), security, FALSE};
  const std::wstring pipeName = L"\\\\.\\pipe\\" + randomName();
  run.pipe.reset(CreateNamedPipeW(pipeName.c_str(), PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE | FILE_FLAG_OVERLAPPED,
    PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 1, 65536, 65536, 0, &pipeSecurity));
  if (run.pipe.value == INVALID_HANDLE_VALUE) fail("CREATE_PIPE");
  SECURITY_ATTRIBUTES inherit{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
  Handle child(CreateFileW(pipeName.c_str(), GENERIC_READ | GENERIC_WRITE, 0, &inherit, OPEN_EXISTING, FILE_FLAG_OVERLAPPED, nullptr));
  if (child.value == INVALID_HANDLE_VALUE) fail("PRECONNECT_PIPE");
  Handle connected(CreateEventW(nullptr, TRUE, FALSE, nullptr)); if (!connected.value) fail("PIPE_CONNECT_EVENT");
  OVERLAPPED connect{}; connect.hEvent = connected.value;
  if (!ConnectNamedPipe(run.pipe.value, &connect) && GetLastError() != ERROR_PIPE_CONNECTED) fail("PIPE_CONNECT");
  Attributes attributes; attributes.initialize(4);
  attributes.add(PROC_THREAD_ATTRIBUTE_HANDLE_LIST, &child.value, sizeof(HANDLE));
  attributes.add(PROC_THREAD_ATTRIBUTE_JOB_LIST, &run.job.value, sizeof(HANDLE));
  DWORD childPolicy = PROCESS_CREATION_CHILD_PROCESS_RESTRICTED;
  attributes.add(PROC_THREAD_ATTRIBUTE_CHILD_PROCESS_POLICY, &childPolicy, sizeof(childPolicy));
  SECURITY_CAPABILITIES capabilities{}; capabilities.AppContainerSid = run.sid.value;
  attributes.add(PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, &capabilities, sizeof(capabilities));
  wchar_t windows[MAX_PATH]{}; const UINT count = GetWindowsDirectoryW(windows, MAX_PATH);
  if (!count || count >= MAX_PATH) fail("WINDOWS_DIRECTORY");
  // AppContainer creation rewrites LOCALAPPDATA/TEMP/TMP to the container's own folders and fails with
  // ERROR_ENVVAR_NOT_FOUND when they are absent. Nothing else is inherited; the block is sorted.
  wchar_t local[MAX_PATH]{};
  const DWORD localLength = GetEnvironmentVariableW(L"LOCALAPPDATA", local, MAX_PATH);
  if (!localLength || localLength >= MAX_PATH) fail("LOCALAPPDATA_UNAVAILABLE");
  const std::wstring temp = std::wstring(local) + L"\\Temp";
  const std::vector<std::wstring> entries = {L"LOCALAPPDATA=" + std::wstring(local),
    L"OA_INHERITED_CHANNEL=" + std::to_wstring(reinterpret_cast<uintptr_t>(child.value)),
    L"SystemRoot=" + std::wstring(windows), L"TEMP=" + temp, L"TMP=" + temp, L"WINDIR=" + std::wstring(windows)};
  std::vector<wchar_t> environment;
  for (const auto& entry : entries) { environment.insert(environment.end(), entry.begin(), entry.end()); environment.push_back(0); }
  environment.push_back(0);
  const auto exe = run.runtime + L"/node.exe";
  std::wstring command = quote(exe) + L" " + quote(run.runtime + L"/bootstrap.mjs");
  STARTUPINFOEXW startup{}; startup.StartupInfo.cb = sizeof(startup); startup.lpAttributeList = attributes.list;
  startup.StartupInfo.dwFlags = STARTF_USESHOWWINDOW; startup.StartupInfo.wShowWindow = SW_HIDE;
  PROCESS_INFORMATION process{};
  if (!CreateProcessW(exe.c_str(), command.data(), nullptr, nullptr, TRUE,
    EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | CREATE_SUSPENDED | DETACHED_PROCESS,
    environment.data(), run.runtime.c_str(), &startup.StartupInfo, &process)) fail("CREATE_RESTRICTED_WORKER");
  run.process.reset(process.hProcess); run.pid = process.dwProcessId; Handle thread(process.hThread); child.reset();
  verifySuspended(run);
  if (ResumeThread(thread.value) != 1) fail("RESUME_WORKER");
}
OA_ENTRY(Wait) {
  napi_value args[1]; auto run = std::dynamic_pointer_cast<Run>(receiver(env, info, 1, args));
  if (!run) throw std::runtime_error("PARENT_CHANNEL_REQUIRED");
  const uint32_t deadline = integer(env, args[0], kMaxDeadlineMs); auto exitCode = std::make_shared<DWORD>(0);
  auto process = std::make_shared<Handle>();
  {
    // Cleanup can close the owned process handle while an independent wait is in flight.
    std::lock_guard<std::mutex> lock(run->cleanupMutex);
    if (!run->process.value || !DuplicateHandle(GetCurrentProcess(), run->process.value, GetCurrentProcess(), &process->value,
      SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, 0)) fail("DUPLICATE_WAIT_HANDLE");
  }
  return async(env, [process, deadline, exitCode] {
    if (WaitForSingleObject(process->value, deadline) != WAIT_OBJECT_0) throw std::runtime_error("WORKER_EXIT_UNCONFIRMED");
    if (!GetExitCodeProcess(process->value, exitCode.get())) fail("WORKER_EXIT_CODE");
  }, [exitCode](napi_env e) { return number(e, *exitCode); });
} OA_END
OA_ENTRY(LaunchFixture) {
  napi_value arg; size_t count = 1; check(napi_get_cb_info(env, info, &count, &arg, nullptr, nullptr));
  if (count != 1) throw std::runtime_error("ARGUMENT_COUNT");
  auto run = std::make_shared<Run>(); run->runtime = wide(text(env, arg));
  return async(env, [run] {
    try { create(*run); }
    catch (...) { const auto original = std::current_exception(); try { run->cleanup(); } catch (...) { throw std::runtime_error("WORKER_CREATION_CLEANUP_UNCONFIRMED"); } std::rethrow_exception(original); }
  }, [run](napi_env e) {
    const auto result = channelObject(e, run), evidence = object(e);
    put(e, evidence, "pid", number(e, run->pid)); put(e, evidence, "parentPid", number(e, run->parent));
    put(e, evidence, "integrityRid", number(e, run->integrity)); put(e, evidence, "appContainer", oa::boolean(e, true));
    put(e, evidence, "capabilityCount", number(e, 0)); put(e, evidence, "jobAssignedAtCreation", oa::boolean(e, true));
    put(e, evidence, "noChildProcessCreation", oa::boolean(e, true)); put(e, evidence, "inheritedHandleCount", number(e, 1));
    put(e, evidence, "verifiedBeforeResume", oa::boolean(e, true)); put(e, evidence, "profile", string(e, narrow(run->profile)));
    put(e, result, "baseline", evidence);
    const napi_property_descriptor method = {"wait", nullptr, Wait, nullptr, nullptr, nullptr, napi_default, nullptr};
    check(napi_define_properties(e, result, 1, &method)); return result;
  });
} OA_END
napi_value Init(napi_env env, napi_value exports) {
  const napi_property_descriptor method = {"launchFixture", nullptr, LaunchFixture, nullptr, nullptr, nullptr, napi_default, nullptr};
  napi_define_properties(env, exports, 1, &method); return exports;
}
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
