/* The deploy and config handlers against a directory and an in-memory key
 * store: the same code every device runs, with no device. */

#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <map>
#include <string>
#include <vector>

#include <sys/stat.h>
#include <unistd.h>

#include <mikrojs/device_store.h>
#include <mikrojs/mikrojs.h>
#include <mikrojs/private.h>

#include <doctest.h>

#include "temp_dir.h"

/* ── Mock transport: canned input, captured output ───────────────── */

struct StoreTransportCtx {
    std::vector<uint8_t> input;
    size_t pos = 0;
    std::vector<uint8_t> output;
};

static int store_read(uint8_t* buf, size_t size, void* opaque) {
    auto* t = static_cast<StoreTransportCtx*>(opaque);
    if (t->pos >= t->input.size()) {
        errno = 0;
        return -1;
    }
    size_t n = std::min(size, t->input.size() - t->pos);
    memcpy(buf, t->input.data() + t->pos, n);
    t->pos += n;
    return static_cast<int>(n);
}

static void store_write(const void* buf, size_t len, void* opaque) {
    auto* t = static_cast<StoreTransportCtx*>(opaque);
    auto* bytes = static_cast<const uint8_t*>(buf);
    t->output.insert(t->output.end(), bytes, bytes + len);
}

struct Reply {
    uint8_t type = 0;
    std::string payload;
};

static void put_u16(std::string& s, size_t v) {
    s.push_back(static_cast<char>(v & 0xFF));
    s.push_back(static_cast<char>((v >> 8) & 0xFF));
}

static void put_u32(std::string& s, size_t v) {
    put_u16(s, v & 0xFFFF);
    put_u16(s, (v >> 16) & 0xFFFF);
}

/* Hands one command's payload to a handler and returns its single reply. */
template <typename Handler>
static Reply send(Handler handler, uint8_t cmd, const std::string& payload) {
    StoreTransportCtx ctx;
    ctx.input.assign(payload.begin(), payload.end());
    MIKReplTransport transport = {};
    transport.read = store_read;
    transport.write = store_write;
    transport.ctx = &ctx;
    handler(&transport, cmd, static_cast<uint32_t>(payload.size()));

    Reply reply;
    if (ctx.output.size() >= MIK_PROTO_HEADER_SIZE) {
        reply.type = ctx.output[0];
        uint32_t len = ctx.output[1] | (ctx.output[2] << 8) | (ctx.output[3] << 16) |
                       (static_cast<uint32_t>(ctx.output[4]) << 24);
        reply.payload.assign(reinterpret_cast<const char*>(ctx.output.data()) +
                                 MIK_PROTO_HEADER_SIZE,
                             len);
    }
    return reply;
}

static Reply deploy(uint8_t cmd, const std::string& payload = "") {
    return send(MIK_HandleDeployCommand, cmd, payload);
}

static Reply config(uint8_t cmd, const std::string& payload = "") {
    return send(MIK_HandleConfigCommand, cmd, payload);
}

/* ── A store over a temp directory and a map ─────────────────────── */

struct EnvEntry {
    std::string value;
    bool secret;
};

static std::map<std::string, EnvEntry> s_env;
static std::map<std::string, std::string> s_kv;

static void fake_env_each(MIKEnvEachFn fn, void* ud) {
    for (auto& [key, entry] : s_env) {
        fn(key.c_str(), entry.value.c_str(), entry.secret, ud);
    }
}

static bool fake_env_set(const char* key, const char* value, bool secret, bool* out_changed) {
    auto it = s_env.find(key);
    bool changed = it == s_env.end() || it->second.value != value || it->second.secret != secret;
    s_env[key] = {value, secret};
    if (out_changed) *out_changed = changed;
    return true;
}

static bool fake_env_delete(const char* key) {
    return s_env.erase(key) > 0;
}

static bool fake_kv_set(const char* ns, const char* key, const uint8_t* blob, size_t len) {
    s_kv[std::string(ns) + "/" + key].assign(reinterpret_cast<const char*>(blob), len);
    return true;
}

static int fake_kv_delete(const char* ns, const char* key) {
    return s_kv.erase(std::string(ns) + "/" + key) > 0 ? 1 : 0;
}

static const char* s_fw_hash = nullptr;

static const char* fake_firmware_hash(void) {
    return s_fw_hash;
}

static std::string s_staged_path;
static std::string s_staged_checksum;
static std::string s_staged_body;
static const char* s_stage_error = nullptr;

static bool fake_stage_build(const char* tgz_path, const char* checksum, const char** err) {
    s_staged_path = tgz_path;
    s_staged_checksum = checksum;
    s_staged_body.clear();
    if (FILE* f = fopen(tgz_path, "r")) {
        char buf[64];
        size_t n = fread(buf, 1, sizeof(buf), f);
        s_staged_body.assign(buf, n);
        fclose(f);
    }
    if (s_stage_error) {
        *err = s_stage_error;
        return false;
    }
    return true;
}

struct StoreFixture {
    std::string root;
    MIKDeviceStore store = {};

    StoreFixture() {
        root = mik_test_temp_dir("mik_store");
        s_env.clear();
        s_kv.clear();
        s_fw_hash = nullptr;
        s_stage_error = nullptr;
        store.fs_base = root.c_str();
        store.env_each = fake_env_each;
        store.env_set = fake_env_set;
        store.env_delete = fake_env_delete;
        store.kv_set = fake_kv_set;
        store.kv_delete = fake_kv_delete;
        MIK_SetDeviceStore(&store);
    }

    ~StoreFixture() {
        MIK_DeploySessionReset();
        MIK_SetDeviceStore(nullptr);
        std::string cmd = "rm -rf '" + root + "'";
        (void)system(cmd.c_str());
    }

    std::string read(const std::string& rel) const {
        std::string out;
        FILE* f = fopen((root + rel).c_str(), "r");
        if (!f) return "<missing>";
        char buf[256];
        size_t n;
        while ((n = fread(buf, 1, sizeof(buf), f)) > 0) out.append(buf, n);
        fclose(f);
        return out;
    }

    bool exists(const std::string& rel) const {
        struct stat st;
        return stat((root + rel).c_str(), &st) == 0;
    }

    /* PUT + one chunk, the way the CLI sends a file. */
    void put(const std::string& name, const std::string& body) {
        std::string header;
        put_u16(header, name.size());
        header += name;
        put_u32(header, body.size());
        REQUIRE(deploy(MIK_CMD_DEPLOY_PUT, header).type == MIK_MSG_OK);
        if (!body.empty()) {
            REQUIRE(deploy(MIK_CMD_DEPLOY_PUT_CHUNK, body).type == MIK_MSG_OK);
        }
    }
};

/* ── Deploy ──────────────────────────────────────────────────────── */

TEST_CASE_FIXTURE(StoreFixture, "deploy stages files under fs_base and commits them" *
                                    doctest::test_suite("device_store")) {
    put("/app/main.js", "export default 1\n");
    put("/app/lib/util.js", "export const x = 2\n");
    /* Nothing is live until DONE. */
    CHECK_FALSE(exists("/app/main.js"));

    CHECK(deploy(MIK_CMD_DEPLOY_DONE).type == MIK_MSG_OK);
    CHECK(read("/app/main.js") == "export default 1\n");
    CHECK(read("/app/lib/util.js") == "export const x = 2\n");
    CHECK_FALSE(exists("/.deploy-tmp"));
}

TEST_CASE_FIXTURE(StoreFixture, "a second deploy replaces the app as a whole" *
                                    doctest::test_suite("device_store")) {
    put("/app/old.js", "old\n");
    REQUIRE(deploy(MIK_CMD_DEPLOY_DONE).type == MIK_MSG_OK);

    CHECK(deploy(MIK_CMD_DEPLOY_ERASE).type == MIK_MSG_OK);
    put("/app/new.js", "new\n");
    REQUIRE(deploy(MIK_CMD_DEPLOY_DONE).type == MIK_MSG_OK);

    CHECK(read("/app/new.js") == "new\n");
    CHECK_FALSE(exists("/app/old.js"));
    CHECK_FALSE(exists("/.deploy-old"));
}

TEST_CASE_FIXTURE(StoreFixture, "abort leaves the live app untouched" *
                                    doctest::test_suite("device_store")) {
    put("/app/main.js", "live\n");
    REQUIRE(deploy(MIK_CMD_DEPLOY_DONE).type == MIK_MSG_OK);

    put("/app/main.js", "half a deploy\n");
    CHECK(deploy(MIK_CMD_DEPLOY_ABORT).type == MIK_MSG_OK);
    CHECK(read("/app/main.js") == "live\n");
    CHECK_FALSE(exists("/.deploy-tmp"));
}

TEST_CASE_FIXTURE(StoreFixture, "a chunk past the declared size is refused" *
                                    doctest::test_suite("device_store")) {
    std::string header;
    put_u16(header, strlen("/app/a.js"));
    header += "/app/a.js";
    put_u32(header, 4);
    REQUIRE(deploy(MIK_CMD_DEPLOY_PUT, header).type == MIK_MSG_OK);

    Reply reply = deploy(MIK_CMD_DEPLOY_PUT_CHUNK, "too many bytes");
    CHECK(reply.type == MIK_MSG_ERR);
}

TEST_CASE_FIXTURE(StoreFixture, "a store without stage_build refuses builds" *
                                    doctest::test_suite("device_store")) {
    std::string payload;
    put_u16(payload, 4);
    payload += "abcd";
    Reply reply = deploy(MIK_CMD_DEPLOY_BUILD, payload);
    CHECK(reply.type == MIK_MSG_ERR);
    CHECK(reply.payload.find("not supported") != std::string::npos);
}

static std::string build_payload(const std::string& checksum) {
    std::string payload;
    put_u16(payload, checksum.size());
    return payload + checksum;
}

TEST_CASE_FIXTURE(StoreFixture, "a build is handed to the store's stage_build" *
                                    doctest::test_suite("device_store")) {
    store.stage_build = fake_stage_build;
    put("/.build.tgz", "tgz bytes");

    CHECK(deploy(MIK_CMD_DEPLOY_BUILD, build_payload("abcd")).type == MIK_MSG_OK);
    CHECK(s_staged_path == root + "/.deploy-tmp/.build.tgz");
    CHECK(s_staged_checksum == "abcd");
    CHECK(s_staged_body == "tgz bytes");
}

TEST_CASE_FIXTURE(StoreFixture, "a build the store rejects reports the store's reason" *
                                    doctest::test_suite("device_store")) {
    store.stage_build = fake_stage_build;
    s_stage_error = "checksum mismatch (corrupt build)";
    put("/.build.tgz", "tgz bytes");

    Reply reply = deploy(MIK_CMD_DEPLOY_BUILD, build_payload("abcd"));
    CHECK(reply.type == MIK_MSG_ERR);
    CHECK(reply.payload.find("checksum mismatch") != std::string::npos);
}

/* ── Checksums manifest ──────────────────────────────────────────── */

static const std::string kManifestLine = std::string(64, 'a') + "  /app/main.js\n";

/* Entries the device still vouches for, as CHECKSUM_LIST reports them. */
static std::string listed_manifest() {
    Reply reply = deploy(MIK_CMD_DEPLOY_CHECKSUM_LIST);
    REQUIRE(reply.type == MIK_MSG_OK);
    REQUIRE(reply.payload.size() >= 2);
    REQUIRE(deploy(MIK_CMD_DEPLOY_ABORT).type == MIK_MSG_OK);
    return reply.payload.substr(2);
}

TEST_CASE_FIXTURE(StoreFixture, "the manifest is stamped with the firmware hash" *
                                    doctest::test_suite("device_store")) {
    store.firmware_hash = fake_firmware_hash;
    s_fw_hash = "fw-1";
    put("/app/main.js", "export default 1\n");
    put("/app/.checksums", kManifestLine);
    REQUIRE(deploy(MIK_CMD_DEPLOY_DONE).type == MIK_MSG_OK);

    CHECK(read("/app/.checksums") == kManifestLine + "#firmware:fw-1\n");
    CHECK(listed_manifest() == kManifestLine);

    /* Other firmware: nothing the manifest says can be trusted. */
    s_fw_hash = "fw-2";
    CHECK(listed_manifest().empty());
}

TEST_CASE_FIXTURE(StoreFixture, "a store without a firmware hash keeps the manifest unstamped" *
                                    doctest::test_suite("device_store")) {
    put("/app/main.js", "export default 1\n");
    put("/app/.checksums", kManifestLine);
    REQUIRE(deploy(MIK_CMD_DEPLOY_DONE).type == MIK_MSG_OK);

    CHECK(read("/app/.checksums") == kManifestLine);
    CHECK(listed_manifest() == kManifestLine);
}

TEST_CASE("deploy commands need a store" * doctest::test_suite("device_store")) {
    MIK_SetDeviceStore(nullptr);
    Reply reply = deploy(MIK_CMD_DEPLOY_ERASE);
    CHECK(reply.type == MIK_MSG_ERR);
    CHECK(reply.payload.find("no app filesystem") != std::string::npos);
}

/* ── Config and kv ───────────────────────────────────────────────── */

static std::string config_set_payload(uint8_t flags, const std::string& key,
                                      const std::string& value) {
    std::string p(1, static_cast<char>(flags));
    put_u16(p, key.size());
    p += key;
    put_u16(p, value.size());
    p += value;
    return p;
}

TEST_CASE_FIXTURE(StoreFixture, "config set reports whether the value changed" *
                                    doctest::test_suite("device_store")) {
    Reply first = config(MIK_CMD_CONFIG_SET, config_set_payload(0, "WIFI_SSID", "home"));
    REQUIRE(first.type == MIK_MSG_OK);
    CHECK(first.payload == std::string(1, '\x01'));

    Reply same = config(MIK_CMD_CONFIG_SET, config_set_payload(0, "WIFI_SSID", "home"));
    CHECK(same.payload == std::string(1, '\x00'));
    CHECK(s_env["WIFI_SSID"].value == "home");
}

TEST_CASE_FIXTURE(StoreFixture, "config list never sends a secret's value" *
                                    doctest::test_suite("device_store")) {
    config(MIK_CMD_CONFIG_SET, config_set_payload(0, "PLAIN", "visible-value"));
    config(MIK_CMD_CONFIG_SET,
           config_set_payload(MIK_ENV_FLAG_SECRET, "TOKEN", "hidden-value"));

    Reply list = config(MIK_CMD_CONFIG_LIST);
    REQUIRE(list.type == MIK_MSG_CONFIG_ENTRIES);
    CHECK(list.payload.find("PLAIN") != std::string::npos);
    CHECK(list.payload.find("visible-value") != std::string::npos);
    CHECK(list.payload.find("TOKEN") != std::string::npos);
    CHECK(list.payload.find("hidden-value") == std::string::npos);
}

TEST_CASE_FIXTURE(StoreFixture, "config delete reports whether the key existed" *
                                    doctest::test_suite("device_store")) {
    config(MIK_CMD_CONFIG_SET, config_set_payload(0, "GONE", "x"));
    std::string payload;
    put_u16(payload, 4);
    payload += "GONE";

    CHECK(config(MIK_CMD_CONFIG_DELETE, payload).payload == std::string(1, '\x01'));
    CHECK(config(MIK_CMD_CONFIG_DELETE, payload).payload == std::string(1, '\x00'));
}

TEST_CASE_FIXTURE(StoreFixture, "env names longer than the NVS limit are refused everywhere" *
                                    doctest::test_suite("device_store")) {
    Reply reply =
        config(MIK_CMD_CONFIG_SET, config_set_payload(0, "SIXTEEN_CHARS_XX", "v"));
    CHECK(reply.type == MIK_MSG_ERR);
    CHECK(s_env.empty());
}

TEST_CASE("config commands need a store" * doctest::test_suite("device_store")) {
    MIK_SetDeviceStore(nullptr);
    Reply reply = config(MIK_CMD_CONFIG_LIST);
    CHECK(reply.type == MIK_MSG_ERR);
    CHECK(reply.payload.find("no key store") != std::string::npos);
}

static std::string kv_payload(uint8_t ns, const std::string& key) {
    std::string p(1, static_cast<char>(ns));
    put_u16(p, key.size());
    return p + key;
}

TEST_CASE_FIXTURE(StoreFixture, "kv set stores the value as a CBOR text string" *
                                    doctest::test_suite("device_store")) {
    std::string set = kv_payload(0, "greeting");
    put_u16(set, 2);
    set += "hi";
    CHECK(config(MIK_CMD_KV_SET, set).type == MIK_MSG_OK);
    CHECK(s_kv["mik.kv/greeting"] == "\x62hi");

    std::string sys = kv_payload(1, "name");
    put_u16(sys, 2);
    sys += "hi";
    CHECK(config(MIK_CMD_KV_SET, sys).type == MIK_MSG_OK);
    CHECK(s_kv.count("mik.sys/name") == 1);
}

TEST_CASE_FIXTURE(StoreFixture, "kv delete reports whether the key existed" *
                                    doctest::test_suite("device_store")) {
    s_kv["mik.sys/name"] = "x";
    CHECK(config(MIK_CMD_KV_DELETE, kv_payload(1, "name")).payload == std::string(1, '\x01'));
    CHECK(config(MIK_CMD_KV_DELETE, kv_payload(1, "name")).payload == std::string(1, '\x00'));
    CHECK(s_kv.empty());
}

TEST_CASE_FIXTURE(StoreFixture, "a command whose hook the store leaves out is refused" *
                                    doctest::test_suite("device_store")) {
    store.env_set = nullptr;
    store.env_delete = nullptr;
    store.kv_set = nullptr;
    store.kv_delete = nullptr;
    const std::string payload = config_set_payload(0, "KEY", "value");

    for (uint8_t cmd : {MIK_CMD_CONFIG_SET, MIK_CMD_CONFIG_DELETE, MIK_CMD_KV_SET,
                        MIK_CMD_KV_DELETE}) {
        CAPTURE(cmd);
        Reply reply = config(cmd, payload);
        CHECK(reply.type == MIK_MSG_ERR);
        CHECK(reply.payload.find("not supported") != std::string::npos);
    }
    CHECK(config(MIK_CMD_CONFIG_LIST).type == MIK_MSG_CONFIG_ENTRIES);
}

/* ── Test supervisor ─────────────────────────────────────────────── */

struct Frame {
    uint8_t type;
    std::string payload;
};

static std::vector<Frame> frames(const std::vector<uint8_t>& out) {
    std::vector<Frame> result;
    size_t pos = 0;
    while (pos + MIK_PROTO_HEADER_SIZE <= out.size()) {
        uint32_t len = out[pos + 1] | (out[pos + 2] << 8) | (out[pos + 3] << 16) |
                       (static_cast<uint32_t>(out[pos + 4]) << 24);
        pos += MIK_PROTO_HEADER_SIZE;
        result.push_back({out[pos - MIK_PROTO_HEADER_SIZE],
                          std::string(reinterpret_cast<const char*>(out.data()) + pos, len)});
        pos += len;
    }
    return result;
}

TEST_CASE_FIXTURE(StoreFixture, "the test manifest runs each file in a fresh runtime" *
                                    doctest::test_suite("device_store")) {
    put("/app/pass.test.js", "globalThis.seen = (globalThis.seen ?? 0) + 1\n"
                             "if (globalThis.seen !== 1) throw new Error('runtime was reused')\n"
                             "setTimeout(() => __testFileDone(), 0)\n");
    put("/app/throws.test.js", "throw new Error('boom')\n");
    REQUIRE(deploy(MIK_CMD_DEPLOY_DONE).type == MIK_MSG_OK);

    StoreTransportCtx ctx;
    MIKReplTransport transport = {};
    transport.read = store_read;
    transport.write = store_write;
    transport.ctx = &ctx;
    MIK_ProtocolOpen(&transport);

    int created = 0;
    struct Opaque {
        const std::string* root;
        int* created;
    } opaque = {&root, &created};
    char pass[] = "/app/pass.test.js";
    char throws[] = "/app/throws.test.js";
    char missing[] = "/app/missing.test.js";
    char* paths[] = {pass, pass, throws, missing};
    MIK_RunTestManifest(
        &transport, paths, 4,
        [](void* ud) {
            auto* o = static_cast<Opaque*>(ud);
            (*o->created)++;
            MIKRuntime* rt = MIK_NewRuntime();
            MIK_SetFSBasePath(rt, o->root->c_str());
            return rt;
        },
        &opaque);
    MIK_ProtocolClose();

    CHECK(created == 4);
    std::string tests;
    std::string debug;
    std::vector<Frame> all = frames(ctx.output);
    for (const Frame& f : all) {
        if (f.type == MIK_MSG_TEST) tests += f.payload + "\n";
        if (f.type == MIK_MSG_DEBUG) debug += f.payload + "\n";
    }
    CHECK(debug.find("running 4/4: /app/missing.test.js") != std::string::npos);
    CHECK(tests.find("runtime was reused") == std::string::npos);
    CHECK(tests.find("Evaluation threw") != std::string::npos);
    CHECK(tests.find("boom") != std::string::npos);
    CHECK(tests.find("Test file not found") != std::string::npos);
    REQUIRE_FALSE(all.empty());
    CHECK(all.back().type == MIK_MSG_MANIFEST_DONE);
}
