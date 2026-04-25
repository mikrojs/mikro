#include <cerrno>
#include <cstring>
#include <string>
#include <vector>

#include "mikrojs.h"
#include "private.h"
#include "quickjs.h"
#include "unity.h"

/* ── Mock transport ──────────────────────────────────────────────── */

struct MockTransportCtx {
    std::vector<uint8_t> input;
    size_t input_pos = 0;
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

/* ── TLV helpers ─────────────────────────────────────────────────── */

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

struct ParsedFrame {
    uint8_t type;
    std::string payload;
};

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

static const ParsedFrame* find_frame(const std::vector<ParsedFrame>& frames, uint8_t type) {
    for (auto& f : frames) {
        if (f.type == type) return &f;
    }
    return nullptr;
}

static std::vector<const ParsedFrame*> find_frames(const std::vector<ParsedFrame>& frames,
                                                    uint8_t type) {
    std::vector<const ParsedFrame*> result;
    for (auto& f : frames) {
        if (f.type == type) result.push_back(&f);
    }
    return result;
}

/* ── Shared runtime — one allocation for all protocol tests ──────── */

static MIKRuntime* proto_rt = nullptr;

static void proto_ensure_rt() {
    if (!proto_rt) {
        proto_rt = MIK_NewRuntime();
    }
}

static std::vector<ParsedFrame> run_protocol(const std::vector<uint8_t>& input) {
    proto_ensure_rt();

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

/* ── Tests ───────────────────────────────────────────────────────── */

TEST_CASE("Protocol stays silent until CMD_HELLO", "[repl_protocol]") {
    std::vector<uint8_t> input;
    auto frames = run_protocol(input);

    TEST_ASSERT_TRUE_MESSAGE(frames.empty(),
                             "Device must not send any frames before CMD_HELLO");
}

TEST_CASE("CMD_HELLO triggers MSG_READY", "[repl_protocol]") {
    std::vector<uint8_t> input;
    append_frame(input, MIK_CMD_HELLO, nullptr);
    append_frame(input, MIK_CMD_EXIT, nullptr);

    auto frames = run_protocol(input);

    auto* ready = find_frame(frames, MIK_MSG_READY);
    TEST_ASSERT_NOT_NULL_MESSAGE(ready, "Should receive MSG_READY in response to CMD_HELLO");
    TEST_ASSERT_TRUE_MESSAGE(ready->payload.find("chip") != std::string::npos,
                             "MSG_READY should contain chip info");
    TEST_ASSERT_TRUE_MESSAGE(ready->payload.find("v") != std::string::npos,
                             "MSG_READY should contain firmware version");
}

TEST_CASE("Protocol exits on CMD_EXIT", "[repl_protocol]") {
    std::vector<uint8_t> input;
    append_frame(input, MIK_CMD_EXIT, nullptr);

    auto frames = run_protocol(input);

    TEST_ASSERT_TRUE_MESSAGE(frames.empty(), "Plain CMD_EXIT should produce no output");
}

TEST_CASE("CMD_EVAL returns MSG_RESULT for expression", "[repl_protocol]") {
    std::vector<uint8_t> input;
    append_frame(input, MIK_CMD_EVAL, "1 + 2");
    append_frame(input, MIK_CMD_EXIT, nullptr);

    auto frames = run_protocol(input);

    auto* result = find_frame(frames, MIK_MSG_RESULT);
    TEST_ASSERT_NOT_NULL_MESSAGE(result, "Should receive MSG_RESULT");
    TEST_ASSERT_EQUAL_STRING_MESSAGE("3", result->payload.c_str(),
                                     "Result should be the evaluated value");
}

TEST_CASE("CMD_EVAL returns empty MSG_RESULT for undefined", "[repl_protocol]") {
    std::vector<uint8_t> input;
    append_frame(input, MIK_CMD_EVAL, "undefined");
    append_frame(input, MIK_CMD_EXIT, nullptr);

    auto frames = run_protocol(input);

    auto* result = find_frame(frames, MIK_MSG_RESULT);
    TEST_ASSERT_NOT_NULL_MESSAGE(result, "Should receive MSG_RESULT for undefined");
    TEST_ASSERT_EQUAL_STRING_MESSAGE("", result->payload.c_str(),
                                     "undefined result should have empty payload");
}

TEST_CASE("CMD_EVAL returns MSG_EVAL_ERROR for syntax error", "[repl_protocol]") {
    std::vector<uint8_t> input;
    append_frame(input, MIK_CMD_EVAL, "function(");
    append_frame(input, MIK_CMD_EXIT, nullptr);

    auto frames = run_protocol(input);

    auto* err = find_frame(frames, MIK_MSG_EVAL_ERROR);
    TEST_ASSERT_NOT_NULL_MESSAGE(err, "Should receive MSG_EVAL_ERROR for syntax error");
    TEST_ASSERT_TRUE_MESSAGE(err->payload.find("SyntaxError") != std::string::npos,
                             "Error should mention SyntaxError");
}

TEST_CASE("console.log sends MSG_LOG in protocol mode", "[repl_protocol]") {
    std::vector<uint8_t> input;
    append_frame(input, MIK_CMD_EVAL, "console.log('test output')");
    append_frame(input, MIK_CMD_EXIT, nullptr);

    auto frames = run_protocol(input);

    auto* log = find_frame(frames, MIK_MSG_LOG);
    TEST_ASSERT_NOT_NULL_MESSAGE(log, "Should receive MSG_LOG from console.log");
    TEST_ASSERT_TRUE_MESSAGE(log->payload.find("test output") != std::string::npos,
                             "MSG_LOG should contain the logged text");
}

TEST_CASE("console.warn sends MSG_WARN in protocol mode", "[repl_protocol]") {
    std::vector<uint8_t> input;
    append_frame(input, MIK_CMD_EVAL, "console.warn('caution')");
    append_frame(input, MIK_CMD_EXIT, nullptr);

    auto frames = run_protocol(input);

    auto* warn = find_frame(frames, MIK_MSG_WARN);
    TEST_ASSERT_NOT_NULL_MESSAGE(warn, "Should receive MSG_WARN from console.warn");
    TEST_ASSERT_TRUE_MESSAGE(warn->payload.find("caution") != std::string::npos,
                             "MSG_WARN should contain the warning text");
}

TEST_CASE("console.error sends MSG_ERROR in protocol mode", "[repl_protocol]") {
    std::vector<uint8_t> input;
    append_frame(input, MIK_CMD_EVAL, "console.error('bad')");
    append_frame(input, MIK_CMD_EXIT, nullptr);

    auto frames = run_protocol(input);

    auto* error = find_frame(frames, MIK_MSG_ERROR);
    TEST_ASSERT_NOT_NULL_MESSAGE(error, "Should receive MSG_ERROR from console.error");
    TEST_ASSERT_TRUE_MESSAGE(error->payload.find("bad") != std::string::npos,
                             "MSG_ERROR should contain the error text");
}

TEST_CASE("CMD_DIRECTIVE /help returns MSG_INFO", "[repl_protocol]") {
    std::vector<uint8_t> input;
    append_frame(input, MIK_CMD_DIRECTIVE, "/help");
    append_frame(input, MIK_CMD_EXIT, nullptr);

    auto frames = run_protocol(input);

    auto* info = find_frame(frames, MIK_MSG_INFO);
    TEST_ASSERT_NOT_NULL_MESSAGE(info, "Should receive MSG_INFO for /help");
    TEST_ASSERT_TRUE_MESSAGE(info->payload.find("/help") != std::string::npos,
                             "Help output should list /help");
}

TEST_CASE("CMD_DIRECTIVE /mem returns MSG_INFO", "[repl_protocol]") {
    std::vector<uint8_t> input;
    append_frame(input, MIK_CMD_DIRECTIVE, "/mem");
    append_frame(input, MIK_CMD_EXIT, nullptr);

    auto frames = run_protocol(input);

    auto* info = find_frame(frames, MIK_MSG_INFO);
    TEST_ASSERT_NOT_NULL_MESSAGE(info, "Should receive MSG_INFO for .mem");
    /* /mem emits a Usage breakdown with "QuickJS:" and "System:" rows
     * (the "heap" lines belong to /info, not /mem). */
    TEST_ASSERT_TRUE_MESSAGE(info->payload.find("QuickJS") != std::string::npos,
                             ".mem output should contain 'QuickJS'");
}

TEST_CASE("CMD_COMPLETE returns MSG_COMPLETIONS", "[repl_protocol]") {
    std::vector<uint8_t> input;
    append_frame(input, MIK_CMD_COMPLETE, "consol");
    append_frame(input, MIK_CMD_EXIT, nullptr);

    auto frames = run_protocol(input);

    auto* completions = find_frame(frames, MIK_MSG_COMPLETIONS);
    TEST_ASSERT_NOT_NULL_MESSAGE(completions, "Should receive MSG_COMPLETIONS");
    /* Completions are CBOR-encoded: a map starting with 0xA2 (2-item map) or 0xBF (indef map) */
    TEST_ASSERT_TRUE_MESSAGE(!completions->payload.empty(),
                             "Completions payload should not be empty");
    uint8_t first = (uint8_t)completions->payload[0];
    TEST_ASSERT_TRUE_MESSAGE((first & 0xE0) == 0xA0 || first == 0xBF,
                             "Completions payload should be CBOR map");
}

/* ── Control bytes in TLV frames (regression) ────────────────────── */

TEST_CASE("CMD_EVAL with 13-byte payload (0x0D = CR length)", "[repl_protocol]") {
    std::vector<uint8_t> input;
    append_frame(input, MIK_CMD_EVAL, "const a = \"b\"");
    TEST_ASSERT_EQUAL_INT(0x0D, input[1]); /* length = 13 = CR */
    append_frame(input, MIK_CMD_EVAL, "a");
    append_frame(input, MIK_CMD_EXIT, nullptr);

    auto frames = run_protocol(input);

    auto errors = find_frames(frames, MIK_MSG_EVAL_ERROR);
    TEST_ASSERT_TRUE_MESSAGE(errors.empty(),
                             "const a = \"b\" should not produce a syntax error");

    auto results = find_frames(frames, MIK_MSG_RESULT);
    TEST_ASSERT_TRUE_MESSAGE(results.size() >= 2, "Should have at least 2 results");
    TEST_ASSERT_TRUE_MESSAGE(results.back()->payload.find("b") != std::string::npos,
                             "Variable 'a' should contain 'b'");
}

TEST_CASE("CMD_EVAL with 10-byte payload (0x0A = LF length)", "[repl_protocol]") {
    std::vector<uint8_t> input;
    append_frame(input, MIK_CMD_EVAL, "1234567890");
    TEST_ASSERT_EQUAL_INT(0x0A, input[1]); /* length = 10 = LF */
    append_frame(input, MIK_CMD_EXIT, nullptr);

    auto frames = run_protocol(input);

    auto errors = find_frames(frames, MIK_MSG_EVAL_ERROR);
    TEST_ASSERT_TRUE_MESSAGE(errors.empty(),
                             "10-byte payload should not produce errors");

    auto* result = find_frame(frames, MIK_MSG_RESULT);
    TEST_ASSERT_NOT_NULL_MESSAGE(result, "Should get a result");
    TEST_ASSERT_EQUAL_STRING_MESSAGE("1234567890", result->payload.c_str(),
                                     "Result should be 1234567890");
}

TEST_CASE("Directive then eval does not corrupt stream", "[repl_protocol]") {
    std::vector<uint8_t> input;
    append_frame(input, MIK_CMD_DIRECTIVE, "/help");
    append_frame(input, MIK_CMD_EVAL, "42");
    append_frame(input, MIK_CMD_EXIT, nullptr);

    auto frames = run_protocol(input);

    auto* info = find_frame(frames, MIK_MSG_INFO);
    TEST_ASSERT_NOT_NULL_MESSAGE(info, "Should receive MSG_INFO for /help");

    auto results = find_frames(frames, MIK_MSG_RESULT);
    TEST_ASSERT_TRUE_MESSAGE(!results.empty(),
                             "Should get a result after /help (stream not corrupted)");
    TEST_ASSERT_EQUAL_STRING_MESSAGE("42", results.back()->payload.c_str(),
                                     "Result after /help should be 42");
}

TEST_CASE("Multiple evals in sequence", "[repl_protocol]") {
    std::vector<uint8_t> input;
    append_frame(input, MIK_CMD_EVAL, "var x = 10");
    append_frame(input, MIK_CMD_EVAL, "var y = 20");
    append_frame(input, MIK_CMD_EVAL, "x + y");
    append_frame(input, MIK_CMD_EXIT, nullptr);

    auto frames = run_protocol(input);

    auto results = find_frames(frames, MIK_MSG_RESULT);
    TEST_ASSERT_TRUE_MESSAGE(results.size() >= 3, "Should have 3 results");
    TEST_ASSERT_EQUAL_STRING_MESSAGE("30", results[2]->payload.c_str(),
                                     "x + y should be 30");
}

TEST_CASE("Protocol mode flag is reset after exit", "[repl_protocol]") {
    TEST_ASSERT_FALSE_MESSAGE(mik__repl_is_protocol_mode(),
                              "Protocol mode should be off initially");

    std::vector<uint8_t> input;
    append_frame(input, MIK_CMD_EXIT, nullptr);
    run_protocol(input);

    TEST_ASSERT_FALSE_MESSAGE(mik__repl_is_protocol_mode(),
                              "Protocol mode should be off after exit");
}

TEST_CASE("All output frames have valid TLV structure", "[repl_protocol]") {
    proto_ensure_rt();

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

    size_t pos = 0;
    int frame_count = 0;
    while (pos + MIK_PROTO_HEADER_SIZE <= mock.output.size()) {
        uint32_t len = (uint32_t)mock.output[pos + 1] | ((uint32_t)mock.output[pos + 2] << 8) |
                       ((uint32_t)mock.output[pos + 3] << 16) | ((uint32_t)mock.output[pos + 4] << 24);
        TEST_ASSERT_TRUE_MESSAGE(pos + MIK_PROTO_HEADER_SIZE + len <= mock.output.size(),
                                 "Frame payload should not exceed output buffer");
        pos += MIK_PROTO_HEADER_SIZE + len;
        frame_count++;
    }
    TEST_ASSERT_TRUE_MESSAGE(pos == mock.output.size(),
                             "All output bytes should be consumed by frame parser");
    TEST_ASSERT_TRUE_MESSAGE(frame_count > 0, "Should have at least one output frame");
}

/* Last test frees the shared runtime to release memory for subsequent
 * test suites (e.g. wifi_test which needs large contiguous allocations). */
TEST_CASE("Cleanup shared protocol runtime", "[repl_protocol]") {
    if (proto_rt) {
        MIK_FreeRuntime(proto_rt);
        proto_rt = nullptr;
    }
    TEST_ASSERT_NULL_MESSAGE(proto_rt, "Runtime should be freed");
}
