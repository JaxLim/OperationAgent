#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <aclapi.h>
#include <bcrypt.h>
#include <sddl.h>
#include <userenv.h>
#include <cstdio>
#include <filesystem>
#include <stdexcept>
#include <string>
#include <vector>

namespace {
namespace fs = std::filesystem;

[[noreturn]] void fail(const char* operation, DWORD code = GetLastError()) {
  throw std::runtime_error(std::string(operation) + " (win32=" + std::to_string(code) + ")");
}

struct Handle {
  HANDLE value = nullptr;
  explicit Handle(HANDLE value = nullptr) : value(value) {}
  ~Handle() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); }
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
};

struct Local {
  void* value = nullptr;
  ~Local() { if (value) LocalFree(value); }
};

struct Attributes {
  std::vector<unsigned char> storage;
  LPPROC_THREAD_ATTRIBUTE_LIST value = nullptr;
  Attributes() {
    SIZE_T size = 0;
    InitializeProcThreadAttributeList(nullptr, 3, 0, &size);
    if (!size) fail("ATTRIBUTE_SIZE");
    storage.resize(size);
    value = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(storage.data());
    if (!InitializeProcThreadAttributeList(value, 3, 0, &size)) fail("INITIALIZE_ATTRIBUTES");
  }
  ~Attributes() { DeleteProcThreadAttributeList(value); }
  void add(DWORD_PTR key, void* data, SIZE_T size) {
    if (!UpdateProcThreadAttribute(value, 0, key, data, size, nullptr, nullptr)) fail("UPDATE_ATTRIBUTE");
  }
};

std::wstring environment(const wchar_t* key) {
  const DWORD size = GetEnvironmentVariableW(key, nullptr, 0);
  if (size == 0 || size > 1024) return {};
  std::vector<wchar_t> value(size);
  const DWORD copied = GetEnvironmentVariableW(key, value.data(), size);
  return copied > 0 && copied < size ? std::wstring(value.data(), copied) : std::wstring();
}

std::wstring sidString(PSID sid) {
  wchar_t* value = nullptr;
  if (!ConvertSidToStringSidW(sid, &value)) fail("SID_STRING");
  Local text{value};
  return static_cast<const wchar_t*>(text.value);
}

std::vector<unsigned char> tokenData(HANDLE token, TOKEN_INFORMATION_CLASS kind) {
  DWORD size = 0;
  GetTokenInformation(token, kind, nullptr, 0, &size);
  if (!size) fail("TOKEN_SIZE");
  std::vector<unsigned char> bytes(size);
  if (!GetTokenInformation(token, kind, bytes.data(), size, &size)) fail("TOKEN_INFO");
  return bytes;
}

void requireObject(const fs::path& path, bool directory) {
  const DWORD flags = GetFileAttributesW(path.c_str());
  if (flags == INVALID_FILE_ATTRIBUTES || (flags & FILE_ATTRIBUTE_REPARSE_POINT) ||
      ((flags & FILE_ATTRIBUTE_DIRECTORY) != 0) != directory) throw std::runtime_error("INVALID_FIXTURE_PATH");
}

fs::path requireFixture(const fs::path& supplied) {
  const fs::path checkout(environment(L"GITHUB_WORKSPACE"));
  if (!checkout.is_absolute() || checkout.native().size() < 4 || checkout.native()[1] != L':') throw std::runtime_error("RUNNER_WORKSPACE_REQUIRED");
  const fs::path sandboxRoot = (checkout / L".cache" / L"sec23").lexically_normal();
  const fs::path candidate = supplied.lexically_normal();
  const auto name = candidate.filename().native();
  if (!candidate.is_absolute() || candidate.parent_path() != sandboxRoot || !name.starts_with(L"case-") ||
      name.size() <= 5 || name.find_first_not_of(L"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-", 5) != std::wstring::npos) {
    throw std::runtime_error("SANDBOX_WORKSPACE_OUT_OF_SCOPE");
  }
  for (fs::path cursor = candidate; cursor != cursor.root_path(); cursor = cursor.parent_path()) requireObject(cursor, true);
  requireObject(candidate / L"runtime", true);
  requireObject(candidate / L"workspace", true);
  requireObject(candidate / L"workspace" / L".git", true);
  for (const auto& entry : fs::recursive_directory_iterator(candidate / L"runtime")) requireObject(entry.path(), entry.is_directory());
  return candidate;
}

void setSecurity(const fs::path& target, const std::wstring& sddl, bool label) {
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1, &descriptor, nullptr)) fail("FIXTURE_DESCRIPTOR");
  Local allocation{descriptor};
  PACL dacl = nullptr, sacl = nullptr;
  BOOL present = FALSE, inherited = FALSE;
  if (!GetSecurityDescriptorDacl(descriptor, &present, &dacl, &inherited) || !present || !dacl) fail("FIXTURE_DACL");
  if (label && (!GetSecurityDescriptorSacl(descriptor, &present, &sacl, &inherited) || !present || !sacl)) fail("FIXTURE_LABEL");
  SECURITY_INFORMATION info = DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION;
  if (label) info |= LABEL_SECURITY_INFORMATION;
  const auto status = SetNamedSecurityInfoW(const_cast<wchar_t*>(target.c_str()), SE_FILE_OBJECT, info, nullptr, nullptr, dacl, sacl);
  if (status != ERROR_SUCCESS) fail("APPLY_FIXTURE_SECURITY", status);
}

struct Session {
  std::wstring profile;
  PSID sid = nullptr;
  Handle job, process;
  unsigned long totalProcesses = 0;

  ~Session() {
    try { reclaim(); } catch (...) { /* The Job handle still closes on unwind. */ }
    if (sid) { DeleteAppContainerProfile(profile.c_str()); FreeSid(sid); }
  }

  void create() {
    unsigned char bytes[16]{};
    if (BCryptGenRandom(nullptr, bytes, sizeof(bytes), BCRYPT_USE_SYSTEM_PREFERRED_RNG) != 0) throw std::runtime_error("RANDOM_FAILED");
    profile = L"OperationAgent.SEC23.";
    const wchar_t* hex = L"0123456789abcdef";
    for (auto byte : bytes) { profile += hex[byte >> 4]; profile += hex[byte & 15]; }
    const HRESULT result = CreateAppContainerProfile(profile.c_str(), profile.c_str(), L"OperationAgent P3a disposable test", nullptr, 0, &sid);
    if (FAILED(result)) fail("CREATE_APPCONTAINER", static_cast<DWORD>(result));
    job.value = CreateJobObjectW(nullptr, nullptr);
    if (!job.value) fail("CREATE_JOB");
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS | JOB_OBJECT_LIMIT_JOB_MEMORY;
    limits.BasicLimitInformation.ActiveProcessLimit = 8;
    limits.JobMemoryLimit = 512ULL * 1024 * 1024;
    if (!SetInformationJobObject(job.value, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) fail("SET_JOB_LIMITS");
  }

  void reclaim() {
    if (!process.value) return;
    if (!TerminateJobObject(job.value, 125)) fail("TERMINATE_JOB");
    const auto deadline = GetTickCount64() + 5000;
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION counts{};
    do {
      if (!QueryInformationJobObject(job.value, JobObjectBasicAccountingInformation, &counts, sizeof(counts), nullptr)) fail("QUERY_JOB");
      if (!counts.ActiveProcesses) { totalProcesses = counts.TotalProcesses; return; }
      Sleep(10);
    } while (GetTickCount64() < deadline);
    throw std::runtime_error("JOB_CLEANUP_UNCONFIRMED");
  }

  void removeProfile() {
    const HRESULT result = DeleteAppContainerProfile(profile.c_str());
    if (FAILED(result)) fail("DELETE_APPCONTAINER", static_cast<DWORD>(result));
    FreeSid(sid);
    sid = nullptr;
  }
};

DWORD verifySuspended(const Session& run) {
  Handle token;
  if (!OpenProcessToken(run.process.value, TOKEN_QUERY, &token.value)) fail("OPEN_TOOL_TOKEN");
  const auto app = tokenData(token.value, TokenIsAppContainer);
  const auto elevated = tokenData(token.value, TokenElevation);
  const auto caps = tokenData(token.value, TokenCapabilities);
  const auto label = tokenData(token.value, TokenIntegrityLevel);
  const auto appSid = tokenData(token.value, TokenAppContainerSid);
  const auto actual = reinterpret_cast<const TOKEN_APPCONTAINER_INFORMATION*>(appSid.data())->TokenAppContainer;
  const auto sid = reinterpret_cast<const TOKEN_MANDATORY_LABEL*>(label.data())->Label.Sid;
  const DWORD integrity = *GetSidSubAuthority(sid, *GetSidSubAuthorityCount(sid) - 1);
  BOOL inJob = FALSE;
  if (!*reinterpret_cast<const DWORD*>(app.data()) || !actual || !EqualSid(actual, run.sid) ||
      reinterpret_cast<const TOKEN_ELEVATION*>(elevated.data())->TokenIsElevated || integrity > SECURITY_MANDATORY_LOW_RID ||
      reinterpret_cast<const TOKEN_GROUPS*>(caps.data())->GroupCount != 0 ||
      !IsProcessInJob(run.process.value, run.job.value, &inJob) || !inJob) throw std::runtime_error("TOOL_TOKEN_BASELINE_REJECTED");
  return integrity;
}

std::wstring quote(const fs::path& path) {
  const auto value = path.native();
  if (value.find(L'"') != std::wstring::npos || value.ends_with(L'\\')) throw std::runtime_error("INVALID_EXECUTION_PATH");
  return L"\"" + value + L"\"";
}

int execute(const fs::path& fixture, bool write, const std::wstring& name, DWORD timeout) {
  const fs::path runtime = fixture / L"runtime", workspace = fixture / L"workspace";
  const fs::path bash = runtime / L"usr" / L"bin" / L"bash.exe", node = runtime / L"node.exe";
  const fs::path writer = runtime / L"write-file.mjs";
  const fs::path tool = write ? node : bash;
  requireObject(tool, false);
  if (write) requireObject(writer, false);

  Handle hostToken, restricted;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY | TOKEN_DUPLICATE | TOKEN_ASSIGN_PRIMARY, &hostToken.value)) fail("OPEN_LAUNCHER_TOKEN");
  const auto owner = tokenData(hostToken.value, TokenUser);
  const std::wstring user = sidString(reinterpret_cast<const TOKEN_USER*>(owner.data())->User.Sid);
  if (!CreateRestrictedToken(hostToken.value, DISABLE_MAX_PRIVILEGE | LUA_TOKEN, 0, nullptr, 0, nullptr, 0, nullptr, &restricted.value)) fail("RESTRICT_LAUNCHER_TOKEN");

  Session run;
  run.create();
  const auto container = sidString(run.sid);
  const std::wstring userAcl = L"D:P(A;OICI;GA;;;SY)(A;OICI;GA;;;" + user + L")";
  const std::wstring readAcl = userAcl + L"(A;OICI;FRFX;;;" + container + L")";
  setSecurity(runtime, readAcl, false);
  // Seal .git before altering its parent. The inheritable write entry only applies to other descendants.
  setSecurity(workspace / L".git", readAcl, false);
  setSecurity(workspace, userAcl + L"(A;;0x1200af;;;" + container + L")(A;OICIIO;FRFWFX;;;" + container + L")S:(ML;;NW;;;LW)", true);

  Handle input, output;
  if (!DuplicateHandle(GetCurrentProcess(), GetStdHandle(STD_INPUT_HANDLE), GetCurrentProcess(), &input.value, 0, TRUE, DUPLICATE_SAME_ACCESS) ||
      !DuplicateHandle(GetCurrentProcess(), GetStdHandle(STD_ERROR_HANDLE), GetCurrentProcess(), &output.value, 0, TRUE, DUPLICATE_SAME_ACCESS)) fail("TOOL_STDIO");
  HANDLE handles[] = {input.value, output.value};
  SECURITY_CAPABILITIES capabilities{};
  capabilities.AppContainerSid = run.sid;
  Attributes attributes;
  attributes.add(PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, &capabilities, sizeof(capabilities));
  attributes.add(PROC_THREAD_ATTRIBUTE_JOB_LIST, &run.job.value, sizeof(HANDLE));
  attributes.add(PROC_THREAD_ATTRIBUTE_HANDLE_LIST, handles, sizeof(handles));

  const auto windows = environment(L"SystemRoot"), local = environment(L"LOCALAPPDATA");
  if (windows.empty() || local.empty()) throw std::runtime_error("WINDOWS_ENVIRONMENT_REQUIRED");
  const std::wstring entries[] = {L"LOCALAPPDATA=" + local, L"MSYSTEM=MSYS", L"PATH=" + bash.parent_path().native(),
    L"SystemRoot=" + windows, L"TEMP=" + local + L"\\Temp", L"TMP=" + local + L"\\Temp", L"WINDIR=" + windows};
  std::vector<wchar_t> env;
  for (const auto& entry : entries) { env.insert(env.end(), entry.begin(), entry.end()); env.push_back(L'\0'); }
  env.push_back(L'\0');
  std::wstring command = quote(tool) + (write ? L" --preserve-symlinks --preserve-symlinks-main " + quote(writer) + L" " + name
    : L" --noprofile --norc -s");
  STARTUPINFOEXW startup{};
  startup.StartupInfo.cb = sizeof(startup);
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
  startup.StartupInfo.wShowWindow = SW_HIDE;
  startup.StartupInfo.hStdInput = input.value;
  startup.StartupInfo.hStdOutput = output.value;
  startup.StartupInfo.hStdError = output.value;
  startup.lpAttributeList = attributes.value;
  PROCESS_INFORMATION created{};
  if (!CreateProcessAsUserW(restricted.value, tool.c_str(), command.data(), nullptr, nullptr, TRUE,
      EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | DETACHED_PROCESS | CREATE_UNICODE_ENVIRONMENT,
      env.data(), workspace.c_str(), &startup.StartupInfo, &created)) fail("LAUNCH_TOOL");
  run.process.value = created.hProcess;
  Handle thread(created.hThread);
  const auto integrity = verifySuspended(run);
  if (ResumeThread(thread.value) != 1) fail("RESUME_TOOL");

  const DWORD wait = WaitForSingleObject(run.process.value, timeout);
  if (wait != WAIT_OBJECT_0 && wait != WAIT_TIMEOUT) fail("WAIT_TOOL");
  DWORD exitCode = 0;
  if (wait == WAIT_OBJECT_0 && !GetExitCodeProcess(run.process.value, &exitCode)) fail("TOOL_EXIT_CODE");
  run.reclaim();
  run.removeProfile();
  std::printf("{\"timedOut\":%s,\"exitCode\":%lu,\"integrity\":%lu,\"totalProcesses\":%lu,\"activeProcesses\":0,\"profileRemoved\":true}\n",
    wait == WAIT_TIMEOUT ? "true" : "false", exitCode, integrity, run.totalProcesses);
  return 0;
}
}

int wmain(int argc, wchar_t** argv) {
  try {
    if (environment(L"GITHUB_ACTIONS") != L"true" || environment(L"RUNNER_OS") != L"Windows") throw std::runtime_error("DISPOSABLE_WINDOWS_RUNNER_REQUIRED");
    if (argc < 4 || argc > 5) throw std::runtime_error("INVALID_TOOL_REQUEST");
    const std::wstring tool = argv[2], deadline = argv[3];
    const bool write = tool == L"write_file";
    if ((!write && tool != L"bash") || argc != (write ? 5 : 4) || deadline.empty() || deadline.size() > 5 ||
      deadline.find_first_not_of(L"0123456789") != std::wstring::npos) throw std::runtime_error("INVALID_TOOL_REQUEST");
    const DWORD timeout = std::stoul(deadline);
    if (timeout < 1000 || timeout > 30000) throw std::runtime_error("INVALID_TOOL_TIMEOUT");
    const std::wstring name = write ? argv[4] : L"";
    if (write && (name.empty() || name.size() > 80 || name[0] == L'.' || name.back() == L'.' ||
        name.find_first_not_of(L"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.") != std::wstring::npos)) {
      throw std::runtime_error("INVALID_WRITE_NAME");
    }
    return execute(requireFixture(argv[1]), write, name, timeout);
  } catch (const std::exception& error) {
    std::fprintf(stderr, "SANDBOX_UNAVAILABLE: %s\n", error.what());
    return 1;
  }
}
