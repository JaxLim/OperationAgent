#pragma once
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <node_api.h>
#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <vector>

namespace oa {
constexpr uint32_t kMaxIoBytes = 262152;
constexpr uint32_t kMaxDeadlineMs = 30000;
struct Handle {
  HANDLE value = nullptr;
  Handle() = default;
  explicit Handle(HANDLE handle) : value(handle) {}
  ~Handle() { reset(); }
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
  void reset(HANDLE handle = nullptr) {
    if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value);
    value = handle;
  }
};
[[noreturn]] inline void fail(const char* operation, DWORD code = GetLastError()) {
  throw std::runtime_error(std::string(operation) + " (win32=" + std::to_string(code) + ")");
}
inline void check(napi_status status) { if (status != napi_ok) throw std::runtime_error("NODE_API_FAILED"); }
inline napi_value number(napi_env env, double value) { napi_value result; check(napi_create_double(env, value, &result)); return result; }
inline napi_value boolean(napi_env env, bool value) { napi_value result; check(napi_get_boolean(env, value, &result)); return result; }
inline napi_value string(napi_env env, const std::string& value) { napi_value result; check(napi_create_string_utf8(env, value.data(), value.size(), &result)); return result; }
inline napi_value object(napi_env env) { napi_value result; check(napi_create_object(env, &result)); return result; }
inline void put(napi_env env, napi_value target, const char* key, napi_value value) { check(napi_set_named_property(env, target, key, value)); }
inline std::string text(napi_env env, napi_value value) {
  size_t length = 0; check(napi_get_value_string_utf8(env, value, nullptr, 0, &length));
  if (length == 0 || length > 32768) throw std::runtime_error("INVALID_STRING_LENGTH");
  std::vector<char> bytes(length + 1); check(napi_get_value_string_utf8(env, value, bytes.data(), bytes.size(), &length));
  std::string result(bytes.data(), length);
  if (result.find('\0') != std::string::npos) throw std::runtime_error("EMBEDDED_NUL");
  return result;
}
inline uint32_t integer(napi_env env, napi_value value, uint32_t maximum) {
  double result = 0; check(napi_get_value_double(env, value, &result));
  if (!(result >= 1 && result <= maximum) || result != static_cast<uint32_t>(result)) throw std::runtime_error("INVALID_LIMIT");
  return static_cast<uint32_t>(result);
}
inline std::wstring wide(const std::string& value) {
  const int size = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), nullptr, 0);
  if (size <= 0) fail("INVALID_UTF8");
  std::wstring result(size, L'\0');
  if (!MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), result.data(), size)) fail("INVALID_UTF8");
  return result;
}
inline std::string narrow(const std::wstring& value) {
  const int size = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
  if (size <= 0) fail("INVALID_UTF16");
  std::string result(size, '\0');
  if (!WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), result.data(), size, nullptr, nullptr)) fail("INVALID_UTF16");
  return result;
}

// A channel owns one preconnected pipe. There is no API for opening a name or arbitrary handle.
struct Channel {
  Handle pipe;
  std::mutex mutex;
  std::condition_variable idle;
  bool reading = false, writing = false, closed = false;
  virtual ~Channel() { if (pipe.value) CancelIoEx(pipe.value, nullptr); }
  void claim(bool write) {
    std::lock_guard<std::mutex> lock(mutex);
    if (closed || !pipe.value) throw std::runtime_error("CHANNEL_CLOSED");
    bool& busy = write ? writing : reading;
    if (busy) throw std::runtime_error("CHANNEL_IO_PENDING");
    busy = true;
  }
  void release(bool write) {
    std::lock_guard<std::mutex> lock(mutex); (write ? writing : reading) = false; idle.notify_all();
  }
  void cancel() {
    std::lock_guard<std::mutex> lock(mutex); closed = true;
    if (pipe.value) CancelIoEx(pipe.value, nullptr);
  }
  virtual void cleanup() {
    cancel();
    std::unique_lock<std::mutex> lock(mutex);
    if (!idle.wait_for(lock, std::chrono::seconds(5), [this] { return !reading && !writing; })) throw std::runtime_error("CHANNEL_CLEANUP_UNCONFIRMED");
    pipe.reset();
  }
  DWORD io(std::vector<uint8_t>& bytes, bool write, DWORD timeout) {
    // The OVERLAPPED and buffer stay alive until completion, including after cancellation.
    Handle event(CreateEventW(nullptr, TRUE, FALSE, nullptr));
    if (!event.value) fail("CreateEventW");
    OVERLAPPED overlapped{}; overlapped.hEvent = event.value;
    DWORD count = 0;
    BOOL immediate = FALSE; DWORD error = ERROR_SUCCESS;
    {
      // Serialize issuing I/O against close. A queued operation must not start after cancel.
      std::lock_guard<std::mutex> lock(mutex);
      if (closed) throw std::runtime_error("CHANNEL_CLOSED");
      immediate = write ? WriteFile(pipe.value, bytes.data(), static_cast<DWORD>(bytes.size()), &count, &overlapped) :
        ReadFile(pipe.value, bytes.data(), static_cast<DWORD>(bytes.size()), &count, &overlapped);
      if (!immediate) error = GetLastError();
    }
    if (!immediate) {
      if (!write && (error == ERROR_BROKEN_PIPE || error == ERROR_PIPE_NOT_CONNECTED)) return 0;
      if (error != ERROR_IO_PENDING) fail("PIPE_IO", error);
      const DWORD wait = WaitForSingleObject(event.value, timeout);
      if (wait != WAIT_OBJECT_0) {
        CancelIoEx(pipe.value, &overlapped);
        // Cancellation is only a request. Completion must be observed before freeing its buffer.
        GetOverlappedResult(pipe.value, &overlapped, &count, TRUE);
        if (wait == WAIT_TIMEOUT) throw std::runtime_error("CHANNEL_DEADLINE");
        fail("PIPE_WAIT");
      }
      if (!GetOverlappedResult(pipe.value, &overlapped, &count, FALSE)) {
        const DWORD completion = GetLastError();
        if (!write && (completion == ERROR_BROKEN_PIPE || completion == ERROR_PIPE_NOT_CONNECTED)) return 0;
        fail("PIPE_COMPLETION", completion);
      }
    }
    return count;
  }
};

struct Work {
  napi_env env;
  napi_async_work handle = nullptr;
  napi_deferred deferred;
  std::function<void()> execute;
  std::function<napi_value(napi_env)> result;
  std::string error;
};
inline napi_value async(napi_env env, std::function<void()> execute, std::function<napi_value(napi_env)> result) {
  auto work = std::make_unique<Work>(); work->env = env; work->execute = std::move(execute); work->result = std::move(result);
  napi_value promise; check(napi_create_promise(env, &work->deferred, &promise));
  check(napi_create_async_work(env, nullptr, string(env, "OperationAgentWorker"), [](napi_env, void* raw) {
    auto* task = static_cast<Work*>(raw);
    try { task->execute(); } catch (const std::exception& error) { task->error = error.what(); }
  }, [](napi_env e, napi_status status, void* raw) {
    std::unique_ptr<Work> task(static_cast<Work*>(raw));
    try {
      if (status != napi_ok && task->error.empty()) task->error = "ASYNC_CANCELLED";
      if (task->error.empty()) check(napi_resolve_deferred(e, task->deferred, task->result(e)));
      else { napi_value error; check(napi_create_error(e, string(e, "WORKER_ISOLATION_UNAVAILABLE"), string(e, task->error), &error)); check(napi_reject_deferred(e, task->deferred, error)); }
    } catch (const std::exception& error) { napi_throw_error(e, "NODE_API_FAILED", error.what()); }
    napi_delete_async_work(e, task->handle);
  }, work.get(), &work->handle));
  const auto queued = napi_queue_async_work(env, work->handle);
  if (queued != napi_ok) { napi_delete_async_work(env, work->handle); check(queued); }
  work.release(); return promise;
}
using Owner = std::shared_ptr<Channel>;
inline Owner receiver(napi_env env, napi_callback_info info, size_t count, napi_value* arguments) {
  napi_value self; size_t actual = count;
  check(napi_get_cb_info(env, info, &actual, arguments, &self, nullptr));
  if (actual != count) throw std::runtime_error("ARGUMENT_COUNT");
  void* raw = nullptr; check(napi_unwrap(env, self, &raw));
  if (!raw) throw std::runtime_error("INVALID_CHANNEL");
  return *static_cast<Owner*>(raw);
}
#define OA_ENTRY(name) inline napi_value name(napi_env env, napi_callback_info info) { try
#define OA_END catch (const std::exception& error) { napi_throw_error(env, "WORKER_ISOLATION_UNAVAILABLE", error.what()); return nullptr; } }
OA_ENTRY(Read) {
  napi_value args[2]; auto channel = receiver(env, info, 2, args);
  const uint32_t length = integer(env, args[0], kMaxIoBytes), deadline = integer(env, args[1], kMaxDeadlineMs);
  auto bytes = std::make_shared<std::vector<uint8_t>>(length);
  channel->claim(false);
  try { return async(env, [channel, bytes, deadline] {
    try { bytes->resize(channel->io(*bytes, false, deadline)); channel->release(false); }
    catch (...) { channel->release(false); throw; }
  }, [bytes](napi_env e) { napi_value result; check(napi_create_buffer_copy(e, bytes->size(), bytes->data(), nullptr, &result)); return result; }); }
  catch (...) { channel->release(false); throw; }
} OA_END
OA_ENTRY(Write) {
  napi_value args[2]; auto channel = receiver(env, info, 2, args);
  bool isBuffer = false; check(napi_is_buffer(env, args[0], &isBuffer));
  if (!isBuffer) throw std::runtime_error("BUFFER_REQUIRED");
  void* data = nullptr; size_t length = 0; check(napi_get_buffer_info(env, args[0], &data, &length));
  if (length == 0 || length > kMaxIoBytes) throw std::runtime_error("INVALID_IO_LENGTH");
  const uint32_t deadline = integer(env, args[1], kMaxDeadlineMs);
  auto bytes = std::make_shared<std::vector<uint8_t>>(static_cast<uint8_t*>(data), static_cast<uint8_t*>(data) + length);
  auto count = std::make_shared<DWORD>(0); channel->claim(true);
  try { return async(env, [channel, bytes, count, deadline] {
    try { *count = channel->io(*bytes, true, deadline); channel->release(true); }
    catch (...) { channel->release(true); throw; }
  }, [count](napi_env e) { return number(e, *count); }); }
  catch (...) { channel->release(true); throw; }
} OA_END
OA_ENTRY(Close) {
  auto channel = receiver(env, info, 0, nullptr);
  return async(env, [channel] { channel->cleanup(); }, [](napi_env e) { return boolean(e, true); });
} OA_END
inline napi_value channelObject(napi_env env, Owner channel) {
  const auto result = object(env);
  auto* owner = new Owner(std::move(channel));
  check(napi_wrap(env, result, owner, [](napi_env, void* raw, void*) {
    auto* value = static_cast<Owner*>(raw); (*value)->cancel(); delete value;
  }, nullptr, nullptr));
  const napi_property_descriptor methods[] = {
    {"read", nullptr, Read, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"write", nullptr, Write, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"close", nullptr, Close, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  check(napi_define_properties(env, result, 3, methods)); return result;
}
}  // namespace oa
