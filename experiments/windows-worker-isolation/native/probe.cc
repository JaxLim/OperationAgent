// EXPERIMENT ONLY. No application may load this addon.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <userenv.h>
#include <sddl.h>
#include <aclapi.h>
#include <tlhelp32.h>
#include <bcrypt.h>
#include <node_api.h>
#include <algorithm>
#include <cstdint>
#include <cstring>
#include <memory>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <vector>

namespace {
struct Handle {
  HANDLE value = nullptr;
  Handle() = default;
  explicit Handle(HANDLE h) : value(h) {}
  ~Handle() { reset(); }
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
  void reset(HANDLE h = nullptr) {
    if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value);
    value = h;
  }
};
struct Sid {
  PSID value = nullptr;
  ~Sid() { if (value) FreeSid(value); }
};
struct Attributes {
  std::vector<unsigned char> bytes;
  LPPROC_THREAD_ATTRIBUTE_LIST list = nullptr;
  ~Attributes() { if (list) DeleteProcThreadAttributeList(list); }
};
struct Run {
  Handle job, process, pipe, leak, output;
  DWORD pid = 0;
  ~Run() {
    job.reset();
    if (process.value && WaitForSingleObject(process.value, 0) == WAIT_TIMEOUT) {
      TerminateProcess(process.value, 0xDEC001);
      WaitForSingleObject(process.value, 5000);
    }
  }
};
std::unordered_map<uint32_t, std::unique_ptr<Run>> runs;
uint32_t next_id = 1;

[[noreturn]] void fail(const char* operation, DWORD code = GetLastError()) {
  throw std::runtime_error(std::string(operation) + " (win32=" + std::to_string(code) + ")");
}
void check(napi_status s) { if (s != napi_ok) throw std::runtime_error("Node-API validation failed"); }
napi_value object(napi_env e) { napi_value v; check(napi_create_object(e, &v)); return v; }
napi_value number(napi_env e, double n) { napi_value v; check(napi_create_double(e, n, &v)); return v; }
napi_value boolean(napi_env e, bool b) { napi_value v; check(napi_get_boolean(e, b, &v)); return v; }
napi_value string(napi_env e, const std::string& s) { napi_value v; check(napi_create_string_utf8(e, s.c_str(), s.size(), &v)); return v; }
void put(napi_env e, napi_value o, const char* key, napi_value v) { check(napi_set_named_property(e, o, key, v)); }
napi_value get(napi_env e, napi_value o, const char* key) { napi_value v; check(napi_get_named_property(e, o, key, &v)); return v; }
std::string utf8(napi_env e, napi_value v) {
  size_t length = 0; check(napi_get_value_string_utf8(e, v, nullptr, 0, &length));
  if (length > 32768) throw std::runtime_error("String limit exceeded");
  std::vector<char> b(length + 1); check(napi_get_value_string_utf8(e, v, b.data(), b.size(), &length));
  std::string result(b.data(), length);
  if (result.find('\0') != std::string::npos) throw std::runtime_error("Embedded NUL rejected");
  return result;
}
std::wstring wide(const std::string& s) {
  if (s.empty()) return L"";
  int n = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, s.data(), static_cast<int>(s.size()), nullptr, 0);
  if (!n) fail("UTF8 conversion");
  std::wstring w(n, L'\0');
  MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, s.data(), static_cast<int>(s.size()), w.data(), n);
  return w;
}
std::string narrow(const std::wstring& w) {
  if (w.empty()) return "";
  int n = WideCharToMultiByte(CP_UTF8, 0, w.data(), static_cast<int>(w.size()), nullptr, 0, nullptr, nullptr);
  std::string s(n, '\0'); WideCharToMultiByte(CP_UTF8, 0, w.data(), static_cast<int>(w.size()), s.data(), n, nullptr, nullptr); return s;
}
uint32_t integer(napi_env e, napi_value v) { uint32_t n; check(napi_get_value_uint32(e, v, &n)); return n; }
std::vector<napi_value> args(napi_env e, napi_callback_info info, size_t count) {
  std::vector<napi_value> a(count); size_t actual = count;
  check(napi_get_cb_info(e, info, &actual, a.data(), nullptr, nullptr));
  if (actual != count) throw std::runtime_error("Wrong argument count"); return a;
}
std::string sid_string(PSID sid) {
  LPWSTR s = nullptr; if (!ConvertSidToStringSidW(sid, &s)) fail("ConvertSidToStringSidW");
  std::string result = narrow(s); LocalFree(s); return result;
}
std::vector<unsigned char> token_data(HANDLE token, TOKEN_INFORMATION_CLASS kind) {
  DWORD size = 0; GetTokenInformation(token, kind, nullptr, 0, &size);
  if (!size) fail("GetTokenInformation(size)");
  std::vector<unsigned char> data(size);
  if (!GetTokenInformation(token, kind, data.data(), size, &size)) fail("GetTokenInformation"); return data;
}
DWORD parent_pid(DWORD pid) {
  Handle snap(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0));
  if (snap.value == INVALID_HANDLE_VALUE) fail("Process snapshot");
  PROCESSENTRY32W entry{}; entry.dwSize = sizeof(entry);
  if (Process32FirstW(snap.value, &entry)) do { if (entry.th32ProcessID == pid) return entry.th32ParentProcessID; } while (Process32NextW(snap.value, &entry));
  fail("PID missing from snapshot", ERROR_NOT_FOUND);
}
napi_value identity(napi_env e, HANDLE process, DWORD pid) {
  Handle token; if (!OpenProcessToken(process, TOKEN_QUERY, &token.value)) fail("OpenProcessToken");
  const auto app = token_data(token.value, TokenIsAppContainer);
  const auto elevated = token_data(token.value, TokenElevation);
  const auto integrity = token_data(token.value, TokenIntegrityLevel);
  const auto caps = token_data(token.value, TokenCapabilities);
  const auto restricting = token_data(token.value, TokenRestrictedSids);
  const auto* label = reinterpret_cast<const TOKEN_MANDATORY_LABEL*>(integrity.data());
  const DWORD il = *GetSidSubAuthority(label->Label.Sid, *GetSidSubAuthorityCount(label->Label.Sid) - 1);
  napi_value out = object(e);
  put(e, out, "pid", number(e, pid)); put(e, out, "ppid", number(e, parent_pid(pid)));
  put(e, out, "appContainer", boolean(e, *reinterpret_cast<const DWORD*>(app.data()) != 0));
  put(e, out, "restricted", boolean(e, IsTokenRestricted(token.value) != FALSE));
  put(e, out, "elevated", boolean(e, reinterpret_cast<const TOKEN_ELEVATION*>(elevated.data())->TokenIsElevated != 0));
  put(e, out, "integrityRid", number(e, il));
  put(e, out, "capabilityCount", number(e, reinterpret_cast<const TOKEN_GROUPS*>(caps.data())->GroupCount));
  put(e, out, "restrictedSidCount", number(e, reinterpret_cast<const TOKEN_GROUPS*>(restricting.data())->GroupCount));
  std::string app_sid;
  if (*reinterpret_cast<const DWORD*>(app.data())) {
    const auto info = token_data(token.value, TokenAppContainerSid);
    app_sid = sid_string(reinterpret_cast<const TOKEN_APPCONTAINER_INFORMATION*>(info.data())->TokenAppContainer);
  }
  put(e, out, "appContainerSid", string(e, app_sid));
  PROCESS_MITIGATION_CHILD_PROCESS_POLICY child{};
  BOOL ok = GetProcessMitigationPolicy(process, ProcessChildProcessPolicy, &child, sizeof(child));
  put(e, out, "childPolicyQuerySucceeded", boolean(e, ok != FALSE));
  put(e, out, "noChildProcessCreation", boolean(e, ok && child.NoChildProcessCreation));
  BOOL in_job = FALSE; if (!IsProcessInJob(process, nullptr, &in_job)) fail("IsProcessInJob");
  put(e, out, "inJob", boolean(e, in_job != FALSE)); return out;
}
void make_job(Run& r, DWORD active_limit) {
  r.job.reset(CreateJobObjectW(nullptr, nullptr)); if (!r.job.value) fail("CreateJobObjectW");
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (active_limit) { limits.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_ACTIVE_PROCESS; limits.BasicLimitInformation.ActiveProcessLimit = active_limit; }
  if (!SetInformationJobObject(r.job.value, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) fail("SetInformationJobObject");
}
void attribute(Attributes& a, DWORD_PTR key, void* value, SIZE_T size) {
  if (!UpdateProcThreadAttribute(a.list, 0, key, value, size, nullptr, nullptr)) fail("UpdateProcThreadAttribute");
}
std::wstring quote(const std::wstring& input) {
  std::wstring out = L"\""; size_t slashes = 0;
  for (wchar_t c : input) {
    if (c == L'\\') { slashes++; continue; }
    out.append(c == L'"' ? slashes * 2 + 1 : slashes, L'\\'); slashes = 0; out += c;
  }
  out.append(slashes * 2, L'\\'); out += L'"'; return out;
}
Run& find(napi_env e, napi_value id) {
  auto it = runs.find(integer(e, id)); if (it == runs.end()) throw std::runtime_error("Unknown experiment run"); return *it->second;
}
#define ENTRY(name) napi_value name(napi_env e, napi_callback_info info) { try
#define END_ENTRY catch (const std::exception& ex) { napi_throw_error(e, "EXPERIMENT_NATIVE_ERROR", ex.what()); return nullptr; } }

ENTRY(Identity) {
  const auto a = args(e, info, 1); DWORD pid = integer(e, a[0]);
  if (!pid || pid == GetCurrentProcessId()) return identity(e, GetCurrentProcess(), GetCurrentProcessId());
  Handle p(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid)); if (!p.value) fail("OpenProcess(identity)");
  return identity(e, p.value, pid);
} END_ENTRY

ENTRY(DeriveSid) {
  const auto a = args(e, info, 1); Sid sid;
  HRESULT hr = DeriveAppContainerSidFromAppContainerName(wide(utf8(e, a[0])).c_str(), &sid.value);
  if (FAILED(hr)) fail("DeriveAppContainerSidFromAppContainerName", static_cast<DWORD>(hr));
  return string(e, sid_string(sid.value));
} END_ENTRY

ENTRY(GrantReadExecute) {
  const auto a = args(e, info, 2); auto path = wide(utf8(e, a[0]));
  if (path.find(L"windows-worker-isolation") == std::wstring::npos || path.find(L"_runs") == std::wstring::npos) throw std::runtime_error("ACL target must be experimental runtime under _runs");
  PSID sid = nullptr; if (!ConvertStringSidToSidW(wide(utf8(e, a[1])).c_str(), &sid)) fail("Convert SID");
  PACL old_acl = nullptr, new_acl = nullptr; PSECURITY_DESCRIPTOR sd = nullptr;
  DWORD result = GetNamedSecurityInfoW(path.data(), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, nullptr, nullptr, &old_acl, nullptr, &sd);
  if (result == ERROR_SUCCESS) {
    EXPLICIT_ACCESSW access{}; access.grfAccessPermissions = GENERIC_READ | GENERIC_EXECUTE;
    access.grfAccessMode = GRANT_ACCESS; access.grfInheritance = SUB_CONTAINERS_AND_OBJECTS_INHERIT;
    access.Trustee.TrusteeForm = TRUSTEE_IS_SID; access.Trustee.ptstrName = static_cast<LPWSTR>(sid);
    result = SetEntriesInAclW(1, &access, old_acl, &new_acl);
    if (result == ERROR_SUCCESS) result = SetNamedSecurityInfoW(path.data(), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, nullptr, nullptr, new_acl, nullptr);
  }
  if (new_acl) LocalFree(new_acl); if (sd) LocalFree(sd); LocalFree(sid);
  if (result != ERROR_SUCCESS) fail("Runtime RX ACL", result);
  return boolean(e, true);
} END_ENTRY

ENTRY(Launch) {
  const auto a = args(e, info, 1); napi_value config = a[0];
  const auto exe = wide(utf8(e, get(e, config, "exe")));
  const auto cwd = wide(utf8(e, get(e, config, "cwd")));
  const auto mode = utf8(e, get(e, config, "mode"));
  if (mode != "appcontainer" && mode != "lpac" && mode != "restricted" && mode != "plain-native" && mode != "lowbox") throw std::runtime_error("Unrecognized native experiment mode");
  const bool app = mode == "appcontainer" || mode == "lpac";
  Sid sid; const auto moniker = wide(utf8(e, get(e, config, "moniker")));
  HRESULT hr = DeriveAppContainerSidFromAppContainerName(moniker.c_str(), &sid.value);
  if (FAILED(hr)) fail("Derive SID", static_cast<DWORD>(hr));
  auto r = std::make_unique<Run>(); make_job(*r, 1);
  SECURITY_ATTRIBUTES inherit{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
  unsigned char random[16]{}; if (BCryptGenRandom(nullptr, random, sizeof(random), BCRYPT_USE_SYSTEM_PREFERRED_RNG) != 0) throw std::runtime_error("Random pipe name failed");
  std::wstring name = L"\\\\.\\pipe\\OperationAgent.Dec001." + std::to_wstring(GetCurrentProcessId()) + L".";
  const wchar_t* hex = L"0123456789abcdef"; for (auto b : random) { name += hex[b >> 4]; name += hex[b & 15]; }
  r->pipe.reset(CreateNamedPipeW(name.c_str(), PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 1, 65536, 65536, 0, nullptr));
  if (r->pipe.value == INVALID_HANDLE_VALUE) fail("CreateNamedPipeW");
  Handle client(CreateFileW(name.c_str(), GENERIC_READ | GENERIC_WRITE, 0, &inherit, OPEN_EXISTING, FILE_FLAG_OVERLAPPED, nullptr));
  if (client.value == INVALID_HANDLE_VALUE) fail("CreateFileW(pipe)");
  if (!ConnectNamedPipe(r->pipe.value, nullptr) && GetLastError() != ERROR_PIPE_CONNECTED) fail("ConnectNamedPipe");
  Handle nul_in(CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, &inherit, OPEN_EXISTING, 0, nullptr));
  Handle nul_out;
  if (!CreatePipe(&r->output.value, &nul_out.value, &inherit, 65536)) fail("Diagnostic pipe");
  if (!SetHandleInformation(r->output.value, HANDLE_FLAG_INHERIT, 0)) fail("Diagnostic read handle inheritance");
  if (nul_in.value == INVALID_HANDLE_VALUE) fail("NUL input");
  r->leak.reset(CreateFileW(wide(utf8(e, get(e, config, "leakPath"))).c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, &inherit, OPEN_EXISTING, 0, nullptr));
  if (r->leak.value == INVALID_HANDLE_VALUE) fail("Leak canary open");
  HANDLE inherited[] = {nul_in.value, nul_out.value, client.value};
  Attributes attributes; SIZE_T bytes = 0; const DWORD count = 3 + (app ? 1 : 0) + (mode == "lpac" ? 1 : 0);
  InitializeProcThreadAttributeList(nullptr, count, 0, &bytes); attributes.bytes.resize(bytes);
  auto* list = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attributes.bytes.data());
  if (!InitializeProcThreadAttributeList(list, count, 0, &bytes)) fail("InitializeProcThreadAttributeList"); attributes.list = list;
  attribute(attributes, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherited, sizeof(inherited));
  attribute(attributes, PROC_THREAD_ATTRIBUTE_JOB_LIST, &r->job.value, sizeof(HANDLE));
  DWORD child_policy = PROCESS_CREATION_CHILD_PROCESS_RESTRICTED;
  attribute(attributes, PROC_THREAD_ATTRIBUTE_CHILD_PROCESS_POLICY, &child_policy, sizeof(child_policy));
  SECURITY_CAPABILITIES capabilities{}; capabilities.AppContainerSid = sid.value;
  if (app) attribute(attributes, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, &capabilities, sizeof(capabilities));
  DWORD all_packages = PROCESS_CREATION_ALL_APPLICATION_PACKAGES_OPT_OUT;
  if (mode == "lpac") attribute(attributes, PROC_THREAD_ATTRIBUTE_ALL_APPLICATION_PACKAGES_POLICY, &all_packages, sizeof(all_packages));
  const auto argv = get(e, config, "args"); uint32_t argc = 0; check(napi_get_array_length(e, argv, &argc));
  std::wstring command = quote(exe);
  for (uint32_t i = 0; i < argc; i++) { napi_value value; check(napi_get_element(e, argv, i, &value)); command += L" " + quote(wide(utf8(e, value))); }
  std::vector<std::wstring> env_entries;
  const auto environment = get(e, config, "env"); napi_value keys; check(napi_get_property_names(e, environment, &keys)); uint32_t length; check(napi_get_array_length(e, keys, &length));
  for (uint32_t i = 0; i < length; i++) { napi_value k, v; check(napi_get_element(e, keys, i, &k)); check(napi_get_property(e, environment, k, &v)); const auto key = utf8(e, k); if (key.find('=') != std::string::npos) throw std::runtime_error("Invalid env key"); env_entries.push_back(wide(key + "=" + utf8(e, v))); }
  env_entries.push_back(L"NODE_CHANNEL_FD=3"); env_entries.push_back(L"NODE_CHANNEL_SERIALIZATION_MODE=json");
  env_entries.push_back(L"DEC001_LEAK_CANARY_HANDLE=" + std::to_wstring(reinterpret_cast<uintptr_t>(r->leak.value)));
  std::sort(env_entries.begin(), env_entries.end(), [](const auto& x, const auto& y) { return _wcsicmp(x.c_str(), y.c_str()) < 0; });
  std::vector<wchar_t> env; for (const auto& entry : env_entries) { env.insert(env.end(), entry.begin(), entry.end()); env.push_back(0); } env.push_back(0);
  // Windows CRT fd table, as used by the locked Node/libuv process-stdio.c.
  const int fd_count = 4; std::vector<unsigned char> crt(sizeof(int) + fd_count + fd_count * sizeof(HANDLE));
  memcpy(crt.data(), &fd_count, sizeof(int)); const unsigned char flags[] = {0x41, 0x09, 0x09, 0x09}; memcpy(crt.data() + sizeof(int), flags, fd_count);
  HANDLE fds[] = {nul_in.value, nul_out.value, nul_out.value, client.value}; memcpy(crt.data() + sizeof(int) + fd_count, fds, sizeof(fds));
  STARTUPINFOEXW startup{}; startup.StartupInfo.cb = sizeof(startup); startup.lpAttributeList = attributes.list;
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW; startup.StartupInfo.wShowWindow = SW_HIDE; startup.StartupInfo.hStdInput = nul_in.value; startup.StartupInfo.hStdOutput = nul_out.value; startup.StartupInfo.hStdError = nul_out.value;
  startup.StartupInfo.cbReserved2 = static_cast<WORD>(crt.size()); startup.StartupInfo.lpReserved2 = crt.data();
  // No console host: inherited RPC, diagnostic write pipe, and NUL input only.
  PROCESS_INFORMATION pi{}; const DWORD creation = EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | CREATE_SUSPENDED | DETACHED_PROCESS;
  BOOL created;
  Handle current_token, restricted;
  if (mode == "lowbox") {
    // Experimental, undocumented kernelbase export also used by Chromium.
    // Deriving a SID and creating a token do not create an AppContainer profile.
    using CreateToken = BOOL(WINAPI*)(HANDLE, PSECURITY_CAPABILITIES, PHANDLE);
    auto create_token = reinterpret_cast<CreateToken>(GetProcAddress(GetModuleHandleW(L"kernelbase.dll"), "CreateAppContainerToken"));
    if (!create_token) fail("CreateAppContainerToken export", ERROR_PROC_NOT_FOUND);
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_DUPLICATE | TOKEN_QUERY | TOKEN_ASSIGN_PRIMARY, &current_token.value)) fail("Open parent token");
    if (!create_token(current_token.value, &capabilities, &restricted.value)) fail("CreateAppContainerToken");
    created = CreateProcessAsUserW(restricted.value, exe.c_str(), command.data(), nullptr, nullptr, TRUE, creation, env.data(), cwd.c_str(), &startup.StartupInfo, &pi);
  } else if (mode == "restricted") {
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_DUPLICATE | TOKEN_QUERY | TOKEN_ASSIGN_PRIMARY, &current_token.value)) fail("Open parent token");
    if (!CreateRestrictedToken(current_token.value, DISABLE_MAX_PRIVILEGE, 0, nullptr, 0, nullptr, 0, nullptr, &restricted.value)) fail("CreateRestrictedToken");
    created = CreateProcessAsUserW(restricted.value, exe.c_str(), command.data(), nullptr, nullptr, TRUE, creation, env.data(), cwd.c_str(), &startup.StartupInfo, &pi);
  } else {
    created = CreateProcessW(exe.c_str(), command.data(), nullptr, nullptr, TRUE, creation, env.data(), cwd.c_str(), &startup.StartupInfo, &pi);
  }
  if (!created) fail("CreateProcess with startup restrictions");
  r->process.reset(pi.hProcess); r->pid = pi.dwProcessId; Handle thread(pi.hThread);
  client.reset();
  BOOL member = FALSE; if (!IsProcessInJob(r->process.value, r->job.value, &member) || !member) fail("Atomic job membership verification");
  napi_value result = object(e);
  put(e, result, "beforeResume", identity(e, r->process.value, r->pid));
  put(e, result, "creatorPid", number(e, GetCurrentProcessId()));
  put(e, result, "suspendedBeforeVerification", boolean(e, true)); put(e, result, "jobAssignedAtCreation", boolean(e, true));
  put(e, result, "leakHandle", number(e, static_cast<double>(reinterpret_cast<uintptr_t>(r->leak.value))));
  put(e, result, "inheritedHandleCount", number(e, 3)); put(e, result, "rpcChannelCount", number(e, 1));
  put(e, result, "profileCreated", boolean(e, false)); put(e, result, "lpacRequested", boolean(e, mode == "lpac"));
  const auto id = next_id++; put(e, result, "id", number(e, id)); put(e, result, "pid", number(e, r->pid));
  if (ResumeThread(thread.value) != 1) fail("ResumeThread(initial suspend count)");
  runs.emplace(id, std::move(r)); return result;
} END_ENTRY

ENTRY(Read) {
  const auto a = args(e, info, 1); auto& r = find(e, a[0]); napi_value result = object(e); DWORD available = 0;
  bool eof = !r.pipe.value;
  if (!eof && !PeekNamedPipe(r.pipe.value, nullptr, 0, nullptr, &available, nullptr)) {
    DWORD error = GetLastError(); if (error == ERROR_BROKEN_PIPE || error == ERROR_PIPE_NOT_CONNECTED) eof = true; else fail("PeekNamedPipe", error);
  }
  std::vector<char> bytes(std::min<DWORD>(available, 65536)); DWORD read = 0;
  if (!bytes.empty() && !ReadFile(r.pipe.value, bytes.data(), static_cast<DWORD>(bytes.size()), &read, nullptr)) fail("ReadFile(pipe)");
  napi_value data; check(napi_create_buffer_copy(e, read, read ? bytes.data() : nullptr, nullptr, &data)); put(e, result, "data", data);
  DWORD output_available = 0, output_read = 0;
  if (r.output.value && PeekNamedPipe(r.output.value, nullptr, 0, nullptr, &output_available, nullptr) && output_available) {
    bytes.resize(std::min<DWORD>(output_available, 65536));
    if (!ReadFile(r.output.value, bytes.data(), static_cast<DWORD>(bytes.size()), &output_read, nullptr)) fail("Read diagnostic pipe");
  }
  check(napi_create_buffer_copy(e, output_read, output_read ? bytes.data() : nullptr, nullptr, &data)); put(e, result, "output", data);
  DWORD code; if (!GetExitCodeProcess(r.process.value, &code)) fail("GetExitCodeProcess");
  put(e, result, "exitCode", number(e, code)); put(e, result, "eof", boolean(e, eof)); return result;
} END_ENTRY

ENTRY(Write) {
  const auto a = args(e, info, 2); auto& r = find(e, a[0]); void* bytes; size_t size; check(napi_get_buffer_info(e, a[1], &bytes, &size));
  if (size > 16384) throw std::runtime_error("Parent frame exceeds experiment limit");
  DWORD written; if (!WriteFile(r.pipe.value, bytes, static_cast<DWORD>(size), &written, nullptr)) fail("WriteFile(pipe)");
  if (written != size) throw std::runtime_error("Partial pipe write"); return boolean(e, true);
} END_ENTRY

ENTRY(Disconnect) { const auto a = args(e, info, 1); find(e, a[0]).pipe.reset(); return boolean(e, true); } END_ENTRY
ENTRY(Close) {
  const auto a = args(e, info, 1); const auto id = integer(e, a[0]); auto& r = find(e, a[0]);
  r.job.reset(); const DWORD wait = WaitForSingleObject(r.process.value, 5000);
  DWORD code = STILL_ACTIVE; GetExitCodeProcess(r.process.value, &code);
  napi_value out = object(e); put(e, out, "wait", number(e, wait)); put(e, out, "exitCode", number(e, code));
  runs.erase(id); return out;
} END_ENTRY

ENTRY(AssignJob) {
  const auto a = args(e, info, 1); auto r = std::make_unique<Run>(); r->pid = integer(e, a[0]);
  r->process.reset(OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, r->pid));
  if (!r->process.value) fail("OpenProcess(assign job)"); make_job(*r, 1);
  if (!AssignProcessToJobObject(r->job.value, r->process.value)) fail("AssignProcessToJobObject");
  const auto id = next_id++; runs.emplace(id, std::move(r)); return number(e, id);
} END_ENTRY

ENTRY(ProbeFile) {
  const auto a = args(e, info, 2); const auto path = wide(utf8(e, a[0])); const auto mode = utf8(e, a[1]);
  Handle file(CreateFileW(path.c_str(), mode == "write" ? GENERIC_WRITE : GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, 0, nullptr));
  const DWORD error = file.value == INVALID_HANDLE_VALUE ? GetLastError() : 0;
  napi_value result = object(e); put(e, result, "allowed", boolean(e, error == 0)); put(e, result, "error", number(e, error)); return result;
} END_ENTRY

ENTRY(ProbeParent) {
  const auto a = args(e, info, 1); DWORD pid = integer(e, a[0]);
  Handle p(OpenProcess(PROCESS_CREATE_PROCESS | PROCESS_VM_WRITE | PROCESS_DUP_HANDLE, FALSE, pid));
  DWORD error = p.value ? 0 : GetLastError(); napi_value out = object(e); put(e, out, "allowed", boolean(e, error == 0)); put(e, out, "error", number(e, error)); return out;
} END_ENTRY

ENTRY(ProbeSpawn) {
  const auto a = args(e, info, 2); auto exe = wide(utf8(e, a[0])); bool breakaway; check(napi_get_value_bool(e, a[1], &breakaway));
  auto command = quote(exe) + L" --version"; STARTUPINFOW s{}; s.cb = sizeof(s); PROCESS_INFORMATION p{};
  const BOOL ok = CreateProcessW(exe.c_str(), command.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW | (breakaway ? CREATE_BREAKAWAY_FROM_JOB : 0), nullptr, nullptr, &s, &p);
  const DWORD error = ok ? 0 : GetLastError();
  if (ok) { TerminateProcess(p.hProcess, 0); WaitForSingleObject(p.hProcess, 5000); CloseHandle(p.hProcess); CloseHandle(p.hThread); }
  napi_value out = object(e); put(e, out, "allowed", boolean(e, ok != FALSE)); put(e, out, "error", number(e, error)); return out;
} END_ENTRY

ENTRY(ProbeInheritedHandle) {
  const auto a = args(e, info, 1); double value; check(napi_get_value_double(e, a[0], &value));
  HANDLE handle = reinterpret_cast<HANDLE>(static_cast<uintptr_t>(value)); wchar_t path[32768];
  DWORD size = 0, error = 0, observed_exception = 0;
  // A deliberately invalid canary may raise STATUS_INVALID_HANDLE under strict
  // handle checks. Catch only that expected probe exception, not arbitrary faults.
  auto query = [](HANDLE h, wchar_t* buffer, DWORD* err, DWORD* raised) -> DWORD {
    __try {
      DWORD flags = 0;
      if (!GetHandleInformation(h, &flags)) { *err = GetLastError(); return 0; }
      DWORD n = GetFinalPathNameByHandleW(h, buffer, 32768, FILE_NAME_NORMALIZED);
      *err = n ? 0 : GetLastError(); return n;
    } __except (GetExceptionCode() == 0xC0000008UL ? EXCEPTION_EXECUTE_HANDLER : EXCEPTION_CONTINUE_SEARCH) {
      *raised = 0xC0000008UL; *err = ERROR_INVALID_HANDLE; return 0;
    }
  };
  size = query(handle, path, &error, &observed_exception);
  napi_value out = object(e); put(e, out, "resolved", boolean(e, size > 0 && size < 32768));
  put(e, out, "path", string(e, size > 0 && size < 32768 ? narrow(std::wstring(path, size)) : ""));
  put(e, out, "error", number(e, error)); put(e, out, "exceptionCode", number(e, observed_exception)); return out;
} END_ENTRY

ENTRY(ProbeTcp) {
  const auto a = args(e, info, 2); const auto host = utf8(e, a[0]); const auto port = integer(e, a[1]);
  if (host != "1.1.1.1" && host != "127.0.0.1") throw std::runtime_error("Only fixed harmless TCP probe targets are allowed");
  WSADATA ws{}; int error = WSAStartup(MAKEWORD(2, 2), &ws);
  if (error) fail("WSAStartup", static_cast<DWORD>(error));
  SOCKET socket = WSASocketW(AF_INET, SOCK_STREAM, IPPROTO_TCP, nullptr, 0, 0);
  if (socket == INVALID_SOCKET) error = WSAGetLastError();
  else {
    u_long nonblocking = 1; ioctlsocket(socket, FIONBIO, &nonblocking);
    sockaddr_in address{}; address.sin_family = AF_INET; address.sin_port = htons(static_cast<u_short>(port));
    inet_pton(AF_INET, host.c_str(), &address.sin_addr);
    if (connect(socket, reinterpret_cast<sockaddr*>(&address), sizeof(address)) == SOCKET_ERROR) {
      error = WSAGetLastError();
      if (error == WSAEWOULDBLOCK) {
        fd_set write_set, error_set; FD_ZERO(&write_set); FD_ZERO(&error_set); FD_SET(socket, &write_set); FD_SET(socket, &error_set);
        timeval timeout{1, 500000}; const int ready = select(0, nullptr, &write_set, &error_set, &timeout);
        if (ready > 0) { int size = sizeof(error); if (getsockopt(socket, SOL_SOCKET, SO_ERROR, reinterpret_cast<char*>(&error), &size) != 0) error = WSAGetLastError(); }
        else error = ready == 0 ? WSAETIMEDOUT : WSAGetLastError();
      }
    }
    closesocket(socket);
  }
  WSACleanup(); napi_value out = object(e); put(e, out, "allowed", boolean(e, error == 0)); put(e, out, "error", number(e, error)); return out;
} END_ENTRY

ENTRY(IsAlive) {
  const auto a = args(e, info, 1); Handle process(OpenProcess(SYNCHRONIZE, FALSE, integer(e, a[0])));
  if (!process.value) { if (GetLastError() == ERROR_INVALID_PARAMETER) return boolean(e, false); fail("OpenProcess(liveness)"); }
  return boolean(e, WaitForSingleObject(process.value, 0) == WAIT_TIMEOUT);
} END_ENTRY

napi_value Init(napi_env e, napi_value exports) {
  struct Fn { const char* name; napi_callback callback; } functions[] = {
    {"identity", Identity}, {"deriveSid", DeriveSid}, {"grantReadExecute", GrantReadExecute}, {"launch", Launch},
    {"read", Read}, {"write", Write}, {"disconnect", Disconnect}, {"close", Close}, {"assignJob", AssignJob},
    {"probeFile", ProbeFile}, {"probeParent", ProbeParent}, {"probeSpawn", ProbeSpawn}, {"probeInheritedHandle", ProbeInheritedHandle}, {"probeTcp", ProbeTcp}, {"isAlive", IsAlive}
  };
  for (const auto& f : functions) { napi_value v; napi_create_function(e, f.name, NAPI_AUTO_LENGTH, f.callback, nullptr, &v); napi_set_named_property(e, exports, f.name, v); }
  return exports;
}
}  // namespace
NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
