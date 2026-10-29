#include "channel.hpp"
#include <tlhelp32.h>

namespace {
napi_value Init(napi_env env, napi_value) {
  try {
    // The parent grants exactly this connected handle. No function accepts a handle argument.
    wchar_t value[32]{};
    const DWORD length = GetEnvironmentVariableW(L"OA_INHERITED_CHANNEL", value, 32);
    SetEnvironmentVariableW(L"OA_INHERITED_CHANNEL", nullptr);
    if (length == 0 || length >= 32) throw std::runtime_error("INHERITED_CHANNEL_MISSING");
    wchar_t* end = nullptr; const auto raw = _wcstoui64(value, &end, 10);
    if (!end || *end || !raw || raw > UINTPTR_MAX) throw std::runtime_error("INHERITED_CHANNEL_INVALID");
    HANDLE handle = reinterpret_cast<HANDLE>(static_cast<uintptr_t>(raw));
    DWORD flags = 0;
    if (!GetHandleInformation(handle, &flags) || !(flags & HANDLE_FLAG_INHERIT) || GetFileType(handle) != FILE_TYPE_PIPE) throw std::runtime_error("INHERITED_CHANNEL_INVALID");
    ULONG server = 0;
    if (!GetNamedPipeServerProcessId(handle, &server) || !server) throw std::runtime_error("INHERITED_CHANNEL_PEER_INVALID");
    oa::Handle snapshot(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0));
    if (snapshot.value == INVALID_HANDLE_VALUE) oa::fail("PARENT_SNAPSHOT");
    DWORD parent = 0; PROCESSENTRY32W entry{}; entry.dwSize = sizeof(entry);
    if (Process32FirstW(snapshot.value, &entry)) do {
      if (entry.th32ProcessID == GetCurrentProcessId()) { parent = entry.th32ParentProcessID; break; }
    } while (Process32NextW(snapshot.value, &entry));
    if (!parent || server != parent) throw std::runtime_error("INHERITED_CHANNEL_PEER_INVALID");
    oa::Handle token; if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token.value)) oa::fail("SELF_TOKEN");
    DWORD app = 0, returned = 0;
    if (!GetTokenInformation(token.value, TokenIsAppContainer, &app, sizeof(app), &returned) || app != 1) throw std::runtime_error("ISOLATED_CHILD_REQUIRED");
    if (!SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0)) oa::fail("CLEAR_INHERITANCE");
    auto channel = std::make_shared<oa::Channel>(); channel->pipe.reset(handle);
    return oa::channelObject(env, channel);
  } catch (const std::exception& error) { napi_throw_error(env, "WORKER_ISOLATION_UNAVAILABLE", error.what()); return nullptr; }
}
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
