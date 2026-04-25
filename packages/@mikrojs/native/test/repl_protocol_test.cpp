#include <cerrno>
#include <cstring>
#include <string>
#include <vector>

#include <mikrojs/mikrojs.h>
#include <mikrojs/private.h>
#include <quickjs.h>

#include <doctest.h>

/* ── Mock transport ──────────────────────────────────────────────── */

/* A mock transport that reads from a pre-loaded input buffer and
 * captures all output.  Simulates a serial connection for testing
 * MIK_StartReplProtocol() without real I/O. */

struct MockTransportCtx {
    /* Input: bytes the "CLI" sends to the device */
    std::vector<uint8_t> input;
    size_t input_pos = 0;

    /* Output: bytes the device sends back to the "CLI" */
    std::vector<uint8_t> output;
};

static int mock_transport_read(uint8_t* buf, size_t size, void* opaque) {
    auto* ctx = (MockTransportCtx*)opaque;
    if (ctx->input_pos >= ctx->input.size()) {
        errno = 0; /* not EAGAIN — signal true EOF */
        return -1;
    }
    size_t avail = ctx->input.size() - ctx->input_pos;
    size_t n = avail < size ? avail : size;
    memcpy(buf, ctx->input.data() + ctx->input_pos, n);
    ctx->input_pos += n;
    return (int)n;
}

static void mock_transport_write(const void* buf, size_t len, void* opaque) {
    auto* ctx = (MockTransportCtx*)opaque;
    auto* bytes = (const uint8_t*)buf;
    ctx->output.insert(ctx->output.end(), bytes, bytes + len);
}

/* ── TLV helpers for building test input ─────────────────────────── */

static void append_frame(std::vector<uint8_t>& buf, uint8_t type, const char* payload) {
    uint32_t len = payload ? (uint32_t)strlen(payload) : 0;
    buf.push_back(type);
    buf.push_back((uint8_t)(len & 0xFF));
    buf.push_back((uint8_t)((len >> 8) & 0xFF));
    buf.push_back((uint8_t)((len >> 16) & 0xFF));
    buf.push_back((uint8_t)((len >> 24) & 0xFF));
    if (len > 0) {
        buf.insert(buf.end(), (const uint8_t*)payload, (const uint8_t*)payload + len);
    }
}

static void append_frame(std::vector<uint8_t>& buf, uint8_t type, const void* data, size_t len) {
    buf.push_back(type);
    buf.push_back((uint8_t)(len & 0xFF));
    buf.push_back((uint8_t)((len >> 8) & 0xFF));
    buf.push_back((uint8_t)((len >> 16) & 0xFF));
    buf.push_back((uint8_t)((len >> 24) & 0xFF));
    if (len > 0) {
        auto* bytes = (const uint8_t*)data;
        buf.insert(buf.end(), bytes, bytes + len);
    }
}

/* ── TLV helpers for parsing output ──────────────────────────────── */

struct ParsedFrame {
    uint8_t type;
    std::string payload;
};

/* Parse all TLV frames from the output buffer (u32le length) */
static std::vector<ParsedFrame> parse_output(const std::vector<uint8_t>& data) {
    std::vector<ParsedFrame> frames;
    size_t pos = 0;
    while (pos + MIK_PROTO_HEADER_SIZE <= data.size()) {
        uint8_t type = data[pos];
        uint32_t len = (uint32_t)data[pos + 1] | ((uint32_t)data[pos + 2] << 8) |
                       ((uint32_t)data[pos + 3] << 16) | ((uint32_t)data[pos + 4] << 24);
        if (pos + MIK_PROTO_HEADER_SIZE + len > data.size()) break;
        std::string payload((const char*)data.data() + pos + MIK_PROTO_HEADER_SIZE, len);
        frames.push_back({type, payload});
        pos += MIK_PROTO_HEADER_SIZE + len;
    }
    return frames;
}

/* Find the first frame of a given type in the output */
static const ParsedFrame* find_frame(const std::vector<ParsedFrame>& frames, uint8_t type) {
    for (auto& f : frames) {
        if (f.type == type) return &f;
    }
    return nullptr;
}

/* Find all frames of a given type in the output */
static std::vector<const ParsedFrame*> find_frames(const std::vector<ParsedFrame>& frames,
                                                    uint8_t type) {
    std::vector<const ParsedFrame*> result;
    for (auto& f : frames) {
        if (f.type == type) result.push_back(&f);
    }
    return result;
}

/* ── Test harness ────────────────────────────────────────────────── */

static MIKRuntime* proto_rt;

static void proto_setup() {
    proto_rt = MIK_NewRuntime();
}

static void proto_teardown() {
    MIK_FreeRuntime(proto_rt);
}

static std::vector<ParsedFrame> run_protocol(const std::vector<uint8_t>& input) {
    MockTransportCtx mock;
    mock.input = input;

    MIKReplTransport transport = {};
    transport.read = mock_transport_read;
    transport.write = mock_transport_write;
    transport.ctx = &mock;

    MIK_ProtocolOpen(&transport);
    MIK_ProtocolAttach(proto_rt);
    MIK_ProtocolServeLoop();
    MIK_ProtocolDetach();
    MIK_ProtocolClose();

    return parse_output(mock.output);
}

/* ── Tests: Protocol lifecycle ───────────────────────────────────── */

TEST_CASE("Protocol stays silent until CMD_HELLO" * doctest::test_suite("repl_protocol")) {
    proto_setup();

    /* Just send an empty input — transport will EOF immediately. The device
     * should not emit any frames unless asked. */
    std::vector<uint8_t> input;
    auto frames = run_protocol(input);

    CHECK_MESSAGE(frames.empty(), "Device must not send any frames before CMD_HELLO");

    proto_teardown();
}

TEST_CASE("CMD_HELLO triggers MSG_READY" * doctest::test_suite("repl_protocol")) {
    proto_setup();

    std::vector<uint8_t> input;
    append_frame(input, MIK_CMD_HELLO, nullptr);
    append_frame(input, MIK_CMD_EXIT, nullptr);

    auto frames = run_protocol(input);

    auto* ready = find_frame(frames, MIK_MSG_READY);
    CHECK_MESSAGE(ready != nullptr, "Should receive MSG_READY in response to CMD_HELLO");
    CHECK_MESSAGE(ready->payload.find("chip") != std::string::npos,
                  "MSG_READY should contain chip info");
    CHECK_MESSAGE(ready->payload.find("v") != std::string::npos,
                  "MSG_READY should contain firmware version");

    proto_teardown();
}

TEST_CASE("Protocol exits on CMD_EXIT" * doctest::test_suite("repl_protocol")) {
    proto_setup();

    std::vector<uint8_t> input;
    append_frame(input, MIK_CMD_EXIT, nullptr);

    auto frames = run_protocol(input);

    CHECK_MESSAGE(frames.empty(), "Plain CMD_EXIT should produce no output");

    proto_teardown();
}

/* ── Tests: CMD_EVAL ─────────────────────────────────────────────── */

TEST_CASE("CMD_EVAL returns MSG_RESULT for expression" * doctest::test_suite("repl_protocol")) {
    proto_setup();

    std::vector<uint8_t> input;
    append_frame(input, MIK_CMD_EVAL, "1 + 2");
    append_frame(input, MIK_CMD_EXIT, nullptr);

    auto frames = run_protocol(input);

    auto* result = find_frame(frames, MIK_MSG_RESULT);
    CHECK_MESSAGE(result != nullptr, "Should receive MSG_RESULT");
    CHECK_MESSAGE(std::string("3") == result->payload,
                  "Result should be the evaluated value");

    proto_teardown();
}

TEST_CASE("CMD_EVAL returns empty MSG_RESULT for undefined" * doctest::test_suite("repl_protocol")) {
    proto_setup();

    std::vector<uint8_t> input;
    append_frame(input, MIK_CMD_EVAL, "undefined");
    append_frame(input, MIK_CMD_EXIT, nullptr);

    auto frames = run_protocol(input);

    auto* result = find_frame(frames, MIK_MSG_RESULT);
    CHECK_MESSAGE(result != nullptr, "Should receive MSG_RESULT for undefined");
    CHECK_MESSAGE(std::string("") == result->payload,
                  "undefined result should have empty payload");

    proto_teardown();
}

TEST_CASE("CMD_EVAL returns MSG_RESULT for string" * doctest::test_suite("repl_protocol")) {
    proto_setup();

    std::vector<uint8_t> input;
    append_frame(input, MIK_CMD_EVAL, "'hello'");
    append_frame(input, MIK_CMD_EXIT, nullptr);

    auto frames = run_protocol(input);

    auto* result = find_frame(frames, MIK_MSG_RESULT);
    CHECK_MESSAGE(result != nullptr, "Should receive MSG_RESULT");
    /* mik_inspect wraps strings in quotes */
    CHECK_MESSAGE(result->payload.find("hello") != std::string::npos,
                  "Result should contain 'hello'");

    proto_teardown();
}

TEST_CASE("CMD_EVAL returns MSG_EVAL_ERROR for syntax error" * doctest::test_suite("repl_protocol")) {
    proto_setup();

    std::vector<uint8_t> input;
    append_frame(input, MIK_CMD_EVAL, "function(");
    append_frame(input, MIK_CMD_EXIT, nullptr);

    auto frames = run_protocol(input);

    auto* err = find_frame(frames, MIK_MSG_EVAL_ERROR);
    CHECK_MESSAGE(err != nullptr, "Should receive MSG_EVAL_ERROR for syntax error");
    CHECK_MESSAGE(err->payload.find("SyntaxError") != std::string::npos,
                  "Error should mention SyntaxError");

    proto_teardown();
}

TEST_CASE("CMD_EVAL returns MSG_EVAL_ERROR for runtime error" * doctest::test_suite("repl_protocol")) {
    proto_setup();

    std::vector<uint8_t> input;
    append_frame(input, MIK_CMD_EVAL, "undeclaredVariable");
    append_frame(input, MIK_CMD_EXIT, nullptr);

    auto frames = run_protocol(input);

    auto* err = find_frame(frames, MIK_MSG_EVAL_ERROR);
    CHECK_MESSAGE(err != nullptr, "Should receive MSG_EVAL_ERROR for reference error");
    CHECK_MESSAGE(err->payload.find("ReferenceError") != std::string::npos,
                  "Error should mention ReferenceError");

    proto_teardown();
}

TEST_CASE("CMD_EVAL rewrites const/let to var" * doctest::test_suite("repl_protocol")) {
    proto_setup();

    std::vector<uint8_t> input;
    /* First declare, then re-declare — should not error because const → var */
    append_frame(input, MIK_CMD_EVAL, "const x = 42");
    append_frame(input, MIK_CMD_EVAL, "const x = 99");
    append_frame(input, MIK_CMD_EVAL, "x");
    append_frame(input, MIK_CMD_EXIT, nullptr);

    auto frames = run_protocol(input);

    /* Should not have any eval errors */
    auto errors = find_frames(frames, MIK_MSG_EVAL_ERROR);
    CHECK_MESSAGE(errors.empty(), "Re-declaring const should not error (rewritten to var)");

    /* Last result should be 99 */
    auto results = find_frames(frames, MIK_MSG_RESULT);
    CHECK_MESSAGE(results.size() >= 3, "Should have at least 3 results");
    CHECK_MESSAGE(std::string("99") == results.back()->payload,
                  "x should be 99 after re-declaration");

    proto_teardown();
}

TEST_CASE("CMD_EVAL wraps object literals" * doctest::test_suite("repl_protocol")) {
    proto_setup();

    std::vector<uint8_t> input;
    append_frame(input, MIK_CMD_EVAL, "{ a: 1 }");
    append_frame(input, MIK_CMD_EXIT, nullptr);

    auto frames = run_protocol(input);

    auto* result = find_frame(frames, MIK_MSG_RESULT);
    CHECK_MESSAGE(result != nullptr, "Should receive MSG_RESULT for object literal");
    /* Should contain "a" property — the exact format depends on mik_inspect */
    CHECK_MESSAGE(result->payload.find("a") != std::string::npos,
                  "Result should contain object with property 'a'");

    proto_teardown();
}

TEST_CASE("CMD_EVAL handles async/await" * doctest::test_suite("repl_protocol")) {
    proto_setup();

    std::vector<uint8_t> input;
    append_frame(input, MIK_CMD_EVAL, "await Promise.resolve(42)");
    append_frame(input, MIK_CMD_EXIT, nullptr);

    auto frames = run_protocol(input);

    auto* result = find_frame(frames, MIK_MSG_RESULT);
    CHECK_MESSAGE(result != nullptr, "Should receive MSG_RESULT for async eval");
    CHECK_MESSAGE(std::string("42") == result->payload,
                  "Async result should be 42");

    proto_teardown();
}

TEST_CASE("CMD_EVAL sets globalThis._" * doctest::test_suite("repl_protocol")) {
    proto_setup();

    std::vector<uint8_t> input;
    append_frame(input, MIK_CMD_EVAL, "42");
    append_frame(input, MIK_CMD_EVAL, "_");
    append_frame(input, MIK_CMD_EXIT, nullptr);

    auto frames = run_protocol(input);

    auto results = find_frames(frames, MIK_MSG_RESULT);
    CHECK_MESSAGE(results.size() >= 2, "Should have at least 2 results");
    CHECK_MESSAGE(std::string("42") == results[1]->payload,
                  "_ should hold the previous result");

    proto_teardown();
}

/* ── Tests: CMD_EVAL with console output ─────────────────────────── */

TEST_CASE("console.log sends MSG_LOG in protocol mode" * doctest::test_suite("repl_protocol")) {
    proto_setup();

    std::vector<uint8_t> input;
    append_frame(input, MIK_CMD_EVAL, "console.log('test output')");
    append_frame(input, MIK_CMD_EXIT, nullptr);

    auto frames = run_protocol(input);

    auto* log = find_frame(frames, MIK_MSG_LOG);
    CHECK_MESSAGE(log != nullptr, "Should receive MSG_LOG from console.log");
    CHECK_MESSAGE(log->payload.find("test output") != std::string::npos,
                  "MSG_LOG should contain the logged text");

    proto_teardown();
}

TEST_CASE("console.warn sends MSG_WARN in protocol mode" * doctest::test_suite("repl_protocol")) {
    proto_setup();

    std::vector<uint8_t> input;
    append_frame(input, MIK_CMD_EVAL, "console.warn('caution')");
    append_frame(input, MIK_CMD_EXIT, nullptr);

    auto frames = run_protocol(input);

    auto* warn = find_frame(frames, MIK_MSG_WARN);
    CHECK_MESSAGE(warn != nullptr, "Should receive MSG_WARN from console.warn");
    CHECK_MESSAGE(warn->payload.find("caution") != std::string::npos,
                  "MSG_WARN should contain the warning text");

    proto_teardown();
}

TEST_CASE("console.error sends MSG_ERROR in protocol mode" * doctest::test_suite("repl_protocol")) {
    proto_setup();

    std::vector<uint8_t> input;
    append_frame(input, MIK_CMD_EVAL, "console.error('bad')");
    append_frame(input, MIK_CMD_EXIT, nullptr);

    auto frames = run_protocol(input);

    auto* error = find_frame(frames, MIK_MSG_ERROR);
    CHECK_MESSAGE(error != nullptr, "Should receive MSG_ERROR from console.error");
    CHECK_MESSAGE(error->payload.find("bad") != std::string::npos,
                  "MSG_ERROR should contain the error text");

    proto_teardown();
}

TEST_CASE("Multiple console.log calls produce multiple MSG_LOG frames" * doctest::test_suite("repl_protocol")) {
    proto_setup();

    std::vector<uint8_t> input;
    append_frame(input, MIK_CMD_EVAL, "console.log('a'); console.log('b')");
    append_frame(input, MIK_CMD_EXIT, nullptr);

    auto frames = run_protocol(input);

    auto logs = find_frames(frames, MIK_MSG_LOG);
    CHECK_MESSAGE(logs.size() >= 2, "Should have at least 2 MSG_LOG frames");

    proto_teardown();
}

/* ── Tests: CMD_DIRECTIVE ────────────────────────────────────────── */

TEST_CASE("CMD_DIRECTIVE /help returns MSG_INFO" * doctest::test_suite("repl_protocol")) {
    proto_setup();

    std::vector<uint8_t> input;
    append_frame(input, MIK_CMD_DIRECTIVE, "/help");
    append_frame(input, MIK_CMD_EXIT, nullptr);

    auto frames = run_protocol(input);

    auto* info = find_frame(frames, MIK_MSG_INFO);
    CHECK_MESSAGE(info != nullptr, "Should receive MSG_INFO for /help");
    CHECK_MESSAGE(info->payload.find("/help") != std::string::npos,
                  "Help output should list /help");
    CHECK_MESSAGE(info->payload.find("/mem") != std::string::npos,
                  "Help output should list /mem");
    CHECK_MESSAGE(info->payload.find("/exit") != std::string::npos,
                  "Help output should list /exit");

    proto_teardown();
}

TEST_CASE("CMD_DIRECTIVE /mem returns MSG_INFO with heap info" * doctest::test_suite("repl_protocol")) {
    proto_setup();

    std::vector<uint8_t> input;
    append_frame(input, MIK_CMD_DIRECTIVE, "/mem");
    append_frame(input, MIK_CMD_EXIT, nullptr);

    auto frames = run_protocol(input);

    auto* info = find_frame(frames, MIK_MSG_INFO);
    CHECK_MESSAGE(info != nullptr, "Should receive MSG_INFO for /mem");
    CHECK_MESSAGE(info->payload.find("QuickJS") != std::string::npos,
                  "/mem output should contain 'QuickJS'");

    proto_teardown();
}

TEST_CASE("CMD_DIRECTIVE /gc returns MSG_INFO" * doctest::test_suite("repl_protocol")) {
    proto_setup();

    std::vector<uint8_t> input;
    append_frame(input, MIK_CMD_DIRECTIVE, "/gc");
    append_frame(input, MIK_CMD_EXIT, nullptr);

    auto frames = run_protocol(input);

    auto* info = find_frame(frames, MIK_MSG_INFO);
    CHECK_MESSAGE(info != nullptr, "Should receive MSG_INFO for /gc");
    CHECK_MESSAGE(info->payload.find("GC") != std::string::npos,
                  "/gc output should mention GC");

    proto_teardown();
}

TEST_CASE("CMD_DIRECTIVE /time toggles timing" * doctest::test_suite("repl_protocol")) {
    proto_setup();

    std::vector<uint8_t> input;
    append_frame(input, MIK_CMD_DIRECTIVE, "/time");
    append_frame(input, MIK_CMD_EVAL, "1");
    append_frame(input, MIK_CMD_DIRECTIVE, "/time"); /* toggle off */
    append_frame(input, MIK_CMD_EXIT, nullptr);

    auto frames = run_protocol(input);

    /* First /time should report "on" */
    auto infos = find_frames(frames, MIK_MSG_INFO);
    CHECK_MESSAGE(infos.size() >= 1, "Should have at least one MSG_INFO");
    CHECK_MESSAGE(infos[0]->payload.find("on") != std::string::npos,
                  "First /time should report 'on'");

    /* Should have a MSG_PROMPT with timing info after eval */
    auto* prompt = find_frame(frames, MIK_MSG_PROMPT);
    CHECK_MESSAGE(prompt != nullptr, "Should receive MSG_PROMPT with timing");
    CHECK_MESSAGE(prompt->payload.find("ms") != std::string::npos,
                  "Timing prompt should contain 'ms'");

    proto_teardown();
}

TEST_CASE("CMD_DIRECTIVE /depth sets inspection depth" * doctest::test_suite("repl_protocol")) {
    proto_setup();

    std::vector<uint8_t> input;
    append_frame(input, MIK_CMD_DIRECTIVE, "/depth 5");
    append_frame(input, MIK_CMD_EXIT, nullptr);

    auto frames = run_protocol(input);

    auto* info = find_frame(frames, MIK_MSG_INFO);
    CHECK_MESSAGE(info != nullptr, "Should receive MSG_INFO for /depth");
    CHECK_MESSAGE(info->payload.find("5") != std::string::npos,
                  "/depth output should contain '5'");

    proto_teardown();
}

TEST_CASE("CMD_DIRECTIVE unknown command returns MSG_INFO" * doctest::test_suite("repl_protocol")) {
    proto_setup();

    std::vector<uint8_t> input;
    append_frame(input, MIK_CMD_DIRECTIVE, "/foobar");
    append_frame(input, MIK_CMD_EXIT, nullptr);

    auto frames = run_protocol(input);

    auto* info = find_frame(frames, MIK_MSG_INFO);
    CHECK_MESSAGE(info != nullptr, "Should receive MSG_INFO for unknown command");
    CHECK_MESSAGE(info->payload.find("Unknown") != std::string::npos,
                  "Should say 'Unknown command'");

    proto_teardown();
}

TEST_CASE("CMD_DIRECTIVE /exit terminates protocol" * doctest::test_suite("repl_protocol")) {
    proto_setup();

    std::vector<uint8_t> input;
    append_frame(input, MIK_CMD_DIRECTIVE, "/exit");
    /* These should not be processed */
    append_frame(input, MIK_CMD_EVAL, "42");

    auto frames = run_protocol(input);

    /* Should not have any MSG_RESULT since /exit ends the loop */
    auto* result = find_frame(frames, MIK_MSG_RESULT);
    CHECK_MESSAGE(result == nullptr,
                  "Should not process commands after /exit");

    proto_teardown();
}

/* ── Tests: CMD_COMPLETE ─────────────────────────────────────────── */

TEST_CASE("CMD_COMPLETE returns MSG_COMPLETIONS" * doctest::test_suite("repl_protocol")) {
    proto_setup();

    std::vector<uint8_t> input;
    /* Complete "consol" — should find "console" on globalThis */
    append_frame(input, MIK_CMD_COMPLETE, "consol");
    append_frame(input, MIK_CMD_EXIT, nullptr);

    auto frames = run_protocol(input);

    auto* completions = find_frame(frames, MIK_MSG_COMPLETIONS);
    CHECK_MESSAGE(completions != nullptr, "Should receive MSG_COMPLETIONS");
    CHECK_MESSAGE(completions->payload.find("console") != std::string::npos,
                  "Completions should include 'console'");

    proto_teardown();
}

TEST_CASE("CMD_COMPLETE with property access" * doctest::test_suite("repl_protocol")) {
    proto_setup();

    std::vector<uint8_t> input;
    append_frame(input, MIK_CMD_COMPLETE, "console.l");
    append_frame(input, MIK_CMD_EXIT, nullptr);

    auto frames = run_protocol(input);

    auto* completions = find_frame(frames, MIK_MSG_COMPLETIONS);
    CHECK_MESSAGE(completions != nullptr, "Should receive MSG_COMPLETIONS");
    CHECK_MESSAGE(completions->payload.find("console.log") != std::string::npos,
                  "Completions should include 'console.log'");

    proto_teardown();
}

/* ── Tests: Control bytes in TLV frames ──────────────────────────── */

/* Regression: payload lengths that coincide with control characters (CR=0x0D,
 * LF=0x0A, NUL=0x00) must not be translated or stripped by the transport.
 * The original bug: `const a = "b"` (13 bytes = 0x0D = CR) failed because
 * the ESP32 VFS serial driver translated the 0x0D length byte as a carriage
 * return, corrupting the TLV header. */

TEST_CASE("CMD_EVAL with 13-byte payload (0x0D = CR length)" * doctest::test_suite("repl_protocol")) {
    proto_setup();

    /* "const a = \"b\"" is exactly 13 bytes — the length byte is 0x0D */
    std::vector<uint8_t> input;
    append_frame(input, MIK_CMD_EVAL, "const a = \"b\"");

    /* Verify the TLV header contains 0x0D as the length byte */
    CHECK_EQ(MIK_CMD_EVAL, input[0]);  /* type */
    CHECK_EQ(0x0D, input[1]);  /* length byte 0 = 13 = CR */
    CHECK_EQ(0x00, input[2]);  /* length byte 1 */
    CHECK_EQ(0x00, input[3]);  /* length byte 2 */
    CHECK_EQ(0x00, input[4]);  /* length byte 3 */

    append_frame(input, MIK_CMD_EVAL, "a");
    append_frame(input, MIK_CMD_EXIT, nullptr);

    auto frames = run_protocol(input);

    /* Should NOT get a syntax error */
    auto errors = find_frames(frames, MIK_MSG_EVAL_ERROR);
    CHECK_MESSAGE(errors.empty(),
                  "const a = \"b\" should not produce a syntax error");

    /* Second eval should return the value of a */
    auto results = find_frames(frames, MIK_MSG_RESULT);
    CHECK_MESSAGE(results.size() >= 2, "Should have at least 2 results");
    CHECK_MESSAGE(results.back()->payload.find("b") != std::string::npos,
                  "Variable 'a' should contain 'b'");

    proto_teardown();
}

TEST_CASE("CMD_EVAL with 10-byte payload (0x0A = LF length)" * doctest::test_suite("repl_protocol")) {
    proto_setup();

    /* "1234567890" is exactly 10 bytes — the length byte is 0x0A = LF */
    std::vector<uint8_t> input;
    append_frame(input, MIK_CMD_EVAL, "1234567890");

    CHECK_EQ(0x0A, input[1]);  /* length low = 10 = LF */

    append_frame(input, MIK_CMD_EXIT, nullptr);

    auto frames = run_protocol(input);

    auto errors = find_frames(frames, MIK_MSG_EVAL_ERROR);
    CHECK_MESSAGE(errors.empty(),
                  "10-byte payload should not produce errors");

    auto* result = find_frame(frames, MIK_MSG_RESULT);
    CHECK_MESSAGE(result != nullptr, "Should get a result");
    CHECK_MESSAGE(std::string("1234567890") == result->payload,
                  "Result should be 1234567890");

    proto_teardown();
}

TEST_CASE("CMD_DIRECTIVE response with newlines in payload" * doctest::test_suite("repl_protocol")) {
    proto_setup();

    /* /help produces multi-line output with \n characters.
     * The MSG_INFO response payload contains these \n bytes.
     * If TX line-ending translation is active, \n→\r\n would expand
     * the payload beyond the TLV length field, corrupting the stream. */
    std::vector<uint8_t> input;
    append_frame(input, MIK_CMD_DIRECTIVE, "/help");
    /* After /help, send another command to verify stream is not corrupted */
    append_frame(input, MIK_CMD_EVAL, "42");
    append_frame(input, MIK_CMD_EXIT, nullptr);

    auto frames = run_protocol(input);

    auto* info = find_frame(frames, MIK_MSG_INFO);
    CHECK_MESSAGE(info != nullptr, "Should receive MSG_INFO for /help");
    CHECK_MESSAGE(info->payload.find('\n') != std::string::npos,
                  "/help output should contain newlines");

    /* The eval after /help must still work - stream is not corrupted */
    auto results = find_frames(frames, MIK_MSG_RESULT);
    CHECK_MESSAGE(!results.empty(),
                  "Should get a result after /help (stream not corrupted)");
    CHECK_MESSAGE(std::string("42") == results.back()->payload,
                  "Result after /help should be 42");

    proto_teardown();
}

TEST_CASE("console.log with newlines does not corrupt protocol stream" * doctest::test_suite("repl_protocol")) {
    proto_setup();

    std::vector<uint8_t> input;
    append_frame(input, MIK_CMD_EVAL, "console.log('line1\\nline2\\nline3')");
    append_frame(input, MIK_CMD_EVAL, "99");
    append_frame(input, MIK_CMD_EXIT, nullptr);

    auto frames = run_protocol(input);

    /* The MSG_LOG payload should contain the newlines */
    auto* log = find_frame(frames, MIK_MSG_LOG);
    CHECK_MESSAGE(log != nullptr, "Should receive MSG_LOG");
    CHECK_MESSAGE(log->payload.find("line1") != std::string::npos,
                  "Log should contain 'line1'");

    /* Subsequent eval must still work */
    auto results = find_frames(frames, MIK_MSG_RESULT);
    CHECK_MESSAGE(!results.empty(), "Should still get results after log");
    CHECK_MESSAGE(std::string("99") == results.back()->payload,
                  "Result should be 99");

    proto_teardown();
}

/* ── Tests: Multiple commands in sequence ────────────────────────── */

TEST_CASE("Multiple evals in sequence" * doctest::test_suite("repl_protocol")) {
    proto_setup();

    std::vector<uint8_t> input;
    append_frame(input, MIK_CMD_EVAL, "var x = 10");
    append_frame(input, MIK_CMD_EVAL, "var y = 20");
    append_frame(input, MIK_CMD_EVAL, "x + y");
    append_frame(input, MIK_CMD_EXIT, nullptr);

    auto frames = run_protocol(input);

    auto results = find_frames(frames, MIK_MSG_RESULT);
    CHECK_MESSAGE(results.size() >= 3, "Should have 3 results");
    CHECK_MESSAGE(std::string("30") == results[2]->payload,
                  "x + y should be 30");

    proto_teardown();
}

TEST_CASE("Protocol mode flag is reset after exit" * doctest::test_suite("repl_protocol")) {
    proto_setup();

    /* Verify protocol mode is off before start */
    CHECK_MESSAGE(!mik__repl_is_protocol_mode(),
                  "Protocol mode should be off initially");

    std::vector<uint8_t> input;
    append_frame(input, MIK_CMD_EXIT, nullptr);
    run_protocol(input);

    /* Verify protocol mode is off after exit */
    CHECK_MESSAGE(!mik__repl_is_protocol_mode(),
                  "Protocol mode should be off after exit");

    proto_teardown();
}

/* ── Tests: CMD_DIRECTIVE /pause / /resume ────────────────────────── */

TEST_CASE("CMD_DIRECTIVE /pause returns MSG_INFO containing paused" * doctest::test_suite("repl_protocol")) {
    proto_setup();

    std::vector<uint8_t> input;
    append_frame(input, MIK_CMD_DIRECTIVE, "/pause");
    append_frame(input, MIK_CMD_EXIT, nullptr);

    auto frames = run_protocol(input);

    auto* info = find_frame(frames, MIK_MSG_INFO);
    CHECK_MESSAGE(info != nullptr, "Should receive MSG_INFO for /pause");
    CHECK_MESSAGE(info->payload.find("paused") != std::string::npos,
                  "/pause response should contain 'paused'");

    proto_teardown();
}

TEST_CASE("CMD_DIRECTIVE /resume after /pause returns MSG_INFO containing resumed" * doctest::test_suite("repl_protocol")) {
    proto_setup();

    std::vector<uint8_t> input;
    append_frame(input, MIK_CMD_DIRECTIVE, "/pause");
    append_frame(input, MIK_CMD_DIRECTIVE, "/resume");
    append_frame(input, MIK_CMD_EXIT, nullptr);

    auto frames = run_protocol(input);

    auto infos = find_frames(frames, MIK_MSG_INFO);
    CHECK_MESSAGE(infos.size() >= 2, "Should have at least 2 MSG_INFO frames");

    /* The second MSG_INFO should be from /resume */
    CHECK_MESSAGE(infos[1]->payload.find("resumed") != std::string::npos,
                  "/resume response should contain 'resumed'");

    proto_teardown();
}

TEST_CASE("CMD_DIRECTIVE /pause when already paused returns already paused" * doctest::test_suite("repl_protocol")) {
    proto_setup();

    std::vector<uint8_t> input;
    append_frame(input, MIK_CMD_DIRECTIVE, "/pause");
    append_frame(input, MIK_CMD_DIRECTIVE, "/pause");
    append_frame(input, MIK_CMD_EXIT, nullptr);

    auto frames = run_protocol(input);

    auto infos = find_frames(frames, MIK_MSG_INFO);
    CHECK_MESSAGE(infos.size() >= 2, "Should have at least 2 MSG_INFO frames");

    /* The second MSG_INFO should indicate already paused */
    CHECK_MESSAGE(infos[1]->payload.find("already paused") != std::string::npos,
                  "Second /pause should say 'already paused'");

    proto_teardown();
}

TEST_CASE("CMD_DIRECTIVE /resume when not paused returns not paused" * doctest::test_suite("repl_protocol")) {
    proto_setup();

    std::vector<uint8_t> input;
    append_frame(input, MIK_CMD_DIRECTIVE, "/resume");
    append_frame(input, MIK_CMD_EXIT, nullptr);

    auto frames = run_protocol(input);

    auto* info = find_frame(frames, MIK_MSG_INFO);
    CHECK_MESSAGE(info != nullptr, "Should receive MSG_INFO for /resume");
    CHECK_MESSAGE(info->payload.find("not paused") != std::string::npos,
                  "/resume without /pause should say 'not paused'");

    proto_teardown();
}

/* ── Tests: Payload clamping (large output) ──────────────────────── */

TEST_CASE("CMD_EVAL with large string result produces valid TLV frames" * doctest::test_suite("repl_protocol")) {
    proto_setup();

    /* Generate a string larger than typical payloads to exercise any clamping logic.
     * We use repeat() to build a ~70000 char string (exceeds uint16 max 65535). */
    std::vector<uint8_t> input;
    append_frame(input, MIK_CMD_EVAL, "'x'.repeat(70000)");
    append_frame(input, MIK_CMD_EXIT, nullptr);

    MockTransportCtx mock;
    mock.input = input;

    MIKReplTransport transport = {};
    transport.read = mock_transport_read;
    transport.write = mock_transport_write;
    transport.ctx = &mock;

    MIK_ProtocolOpen(&transport);
    MIK_ProtocolAttach(proto_rt);
    MIK_ProtocolServeLoop();
    MIK_ProtocolDetach();
    MIK_ProtocolClose();

    /* Verify all output bytes form valid TLV frames (no corruption) */
    size_t pos = 0;
    int frame_count = 0;
    while (pos + MIK_PROTO_HEADER_SIZE <= mock.output.size()) {
        uint32_t len = (uint32_t)mock.output[pos + 1] | ((uint32_t)mock.output[pos + 2] << 8) |
                       ((uint32_t)mock.output[pos + 3] << 16) | ((uint32_t)mock.output[pos + 4] << 24);
        CHECK_MESSAGE(pos + MIK_PROTO_HEADER_SIZE + len <= mock.output.size(),
                      "Frame payload should not exceed output buffer");
        pos += MIK_PROTO_HEADER_SIZE + len;
        frame_count++;
    }
    CHECK_MESSAGE(pos == mock.output.size(),
                  "All output bytes should be consumed by frame parser (no corruption)");
    CHECK_MESSAGE(frame_count > 0, "Should have at least one output frame");

    /* Additionally verify we got a MSG_RESULT (possibly clamped but still valid) */
    auto frames = parse_output(mock.output);
    auto* result = find_frame(frames, MIK_MSG_RESULT);
    CHECK_MESSAGE(result != nullptr, "Should receive MSG_RESULT for large string");

    proto_teardown();
}

/* ── Tests: TLV frame integrity ──────────────────────────────────── */

TEST_CASE("All output frames have valid TLV structure" * doctest::test_suite("repl_protocol")) {
    proto_setup();

    std::vector<uint8_t> input;
    append_frame(input, MIK_CMD_EVAL, "1 + 2");
    append_frame(input, MIK_CMD_DIRECTIVE, "/help");
    append_frame(input, MIK_CMD_COMPLETE, "consol");
    append_frame(input, MIK_CMD_EXIT, nullptr);

    MockTransportCtx mock;
    mock.input = input;

    MIKReplTransport transport = {};
    transport.read = mock_transport_read;
    transport.write = mock_transport_write;
    transport.ctx = &mock;

    MIK_ProtocolOpen(&transport);
    MIK_ProtocolAttach(proto_rt);
    MIK_ProtocolServeLoop();
    MIK_ProtocolDetach();
    MIK_ProtocolClose();

    /* Verify all output bytes can be parsed as valid TLV frames */
    size_t pos = 0;
    int frame_count = 0;
    while (pos + MIK_PROTO_HEADER_SIZE <= mock.output.size()) {
        uint32_t len = (uint32_t)mock.output[pos + 1] | ((uint32_t)mock.output[pos + 2] << 8) |
                       ((uint32_t)mock.output[pos + 3] << 16) | ((uint32_t)mock.output[pos + 4] << 24);
        CHECK_MESSAGE(pos + MIK_PROTO_HEADER_SIZE + len <= mock.output.size(),
                      "Frame payload should not exceed output buffer");
        pos += MIK_PROTO_HEADER_SIZE + len;
        frame_count++;
    }
    CHECK_MESSAGE(pos == mock.output.size(),
                  "All output bytes should be consumed by frame parser");
    CHECK_MESSAGE(frame_count > 0, "Should have at least one output frame");

    proto_teardown();
}
