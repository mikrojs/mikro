/* The OTA boot reconcile against a directory and an in-memory state store.
 * The build unpack is a stand-in (ota_stubs.cpp); the state machine is real. */

#include <cstdio>
#include <cstring>
#include <map>
#include <string>

#include <sys/stat.h>
#include <unistd.h>

#include <mikrojs/device_store.h>
#include <mikrojs/ota.h>
#include <mikrojs/platform.h>
#include <mikrojs/private.h>

#include <doctest.h>

#include "ota_stubs.h"
#include "temp_dir.h"

namespace {

std::map<std::string, uint32_t> s_nums;
std::map<std::string, std::string> s_strs;
const char* s_reset_reason = "power-on";
const char* s_fw_hash = "fw-1";

void* fake_state_open(bool) {
    return &s_nums;
}
void fake_state_close(void*) {}
bool fake_state_commit(void*) {
    return true;
}
bool fake_get_u8(void*, const char* key, uint8_t* out) {
    auto it = s_nums.find(key);
    if (it == s_nums.end()) return false;
    *out = static_cast<uint8_t>(it->second);
    return true;
}
bool fake_set_u8(void*, const char* key, uint8_t value) {
    s_nums[key] = value;
    return true;
}
bool fake_get_u32(void*, const char* key, uint32_t* out) {
    auto it = s_nums.find(key);
    if (it == s_nums.end()) return false;
    *out = it->second;
    return true;
}
bool fake_set_u32(void*, const char* key, uint32_t value) {
    s_nums[key] = value;
    return true;
}
bool fake_get_str(void*, const char* key, char* out, size_t cap) {
    auto it = s_strs.find(key);
    if (it == s_strs.end() || it->second.empty() || it->second.size() >= cap) {
        out[0] = '\0';
        return false;
    }
    memcpy(out, it->second.c_str(), it->second.size() + 1);
    return true;
}
bool fake_set_str(void*, const char* key, const char* value) {
    s_strs[key] = value;
    return true;
}
void fake_erase(void*, const char* key) {
    s_nums.erase(key);
    s_strs.erase(key);
}

const char* fake_firmware_hash(void) {
    return s_fw_hash;
}
const char* fake_reset_reason(void) {
    return s_reset_reason;
}

struct OtaFixture {
    std::string root;
    MIKDeviceStore store = {};
    const MIKPlatform* orig = nullptr;
    MIKPlatform fake;

    OtaFixture() {
        root = mik_test_temp_dir("mik_ota");
        s_nums.clear();
        s_strs.clear();
        s_reset_reason = "power-on";
        s_fw_hash = "fw-1";
        s_strs["fwHash"] = "fw-1";
        g_ota_stub_install_ok = true;
        g_ota_stub_installs = 0;
        g_ota_stub_sha = nullptr;

        store.fs_base = root.c_str();
        store.firmware_hash = fake_firmware_hash;
        store.state_open = fake_state_open;
        store.state_close = fake_state_close;
        store.state_commit = fake_state_commit;
        store.state_get_u8 = fake_get_u8;
        store.state_set_u8 = fake_set_u8;
        store.state_get_u32 = fake_get_u32;
        store.state_set_u32 = fake_set_u32;
        store.state_get_str = fake_get_str;
        store.state_set_str = fake_set_str;
        store.state_erase = fake_erase;
        MIK_SetDeviceStore(&store);

        orig = MIK_GetPlatform();
        fake = *orig;
        fake.get_reset_reason = fake_reset_reason;
        MIK_SetPlatform(&fake);
    }

    ~OtaFixture() {
        MIK_SetPlatform(orig);
        MIK_SetDeviceStore(nullptr);
        std::string cmd = "rm -rf '" + root + "'";
        (void)system(cmd.c_str());
    }

    void touch(const char* rel) const {
        FILE* f = fopen((root + rel).c_str(), "w");
        REQUIRE(f != nullptr);
        fputs("build", f);
        fclose(f);
    }

    bool exists(const char* rel) const {
        struct stat st;
        return stat((root + rel).c_str(), &st) == 0;
    }

    /* A trial of build "new" over build "old", two boots left. */
    void in_trial() const {
        s_nums["state"] = 1;
        s_nums["trialLeft"] = 2;
        s_strs["pendChk"] = "new";
        s_strs["instChk"] = "old";
    }
};

}  // namespace

TEST_CASE_FIXTURE(OtaFixture, "a crash reset ends the trial" * doctest::test_suite("ota_install")) {
    for (const char* reason : {MIK_RESET_PANIC, MIK_RESET_WATCHDOG, MIK_RESET_INT_WATCHDOG,
                               MIK_RESET_TASK_WATCHDOG}) {
        CAPTURE(reason);
        s_nums.clear();
        in_trial();
        s_reset_reason = reason;

        CHECK_FALSE(MIK_OtaBootReconcile());
        CHECK(s_nums["state"] == 0);
        CHECK(s_nums["oRevert"] == 1);
        CHECK(s_strs["oRsn"] == reason);
        /* No revert target on disk: the trial build stays and is the installed one. */
        CHECK(s_strs["instChk"] == "new");
    }
}

TEST_CASE_FIXTURE(OtaFixture, "a crash reset rolls back to the last-good build" *
                                  doctest::test_suite("ota_install")) {
    in_trial();
    touch("/.ota-last-good.tgz");
    s_reset_reason = MIK_RESET_PANIC;

    CHECK_FALSE(MIK_OtaBootReconcile());
    CHECK(g_ota_stub_installs == 1);
    CHECK(s_nums["state"] == 0);
    CHECK(s_strs["instChk"] == "old");
    CHECK(s_strs["oDetail"] == "reverted to last-good build");
}

TEST_CASE_FIXTURE(OtaFixture, "a brownout is absorbed without counting the boot" *
                                  doctest::test_suite("ota_install")) {
    in_trial();
    s_reset_reason = MIK_RESET_BROWNOUT;

    CHECK_FALSE(MIK_OtaBootReconcile());
    CHECK(s_nums["state"] == 1);
    CHECK(s_nums["trialLeft"] == 2);
    CHECK(s_nums["neutLeft"] == 2);
}

TEST_CASE_FIXTURE(OtaFixture, "any other reset counts as a clean trial boot" *
                                  doctest::test_suite("ota_install")) {
    for (const char* reason : {"power-on", "software", "deep-sleep", "power-glitch", "unknown"}) {
        CAPTURE(reason);
        s_nums.clear();
        in_trial();
        s_reset_reason = reason;

        CHECK_FALSE(MIK_OtaBootReconcile());
        CHECK(s_nums["state"] == 1);
        CHECK(s_nums["trialLeft"] == 1);
        CHECK(s_nums.count("neutLeft") == 0);
    }
}

TEST_CASE_FIXTURE(OtaFixture, "a trial that used its boots becomes the revert target" *
                                  doctest::test_suite("ota_install")) {
    in_trial();
    s_nums["trialLeft"] = 0;
    touch("/.ota-pending.tgz");

    CHECK_FALSE(MIK_OtaBootReconcile());
    CHECK(s_nums["state"] == 0);
    CHECK(s_strs["instChk"] == "new");
    CHECK(exists("/.ota-last-good.tgz"));
    CHECK_FALSE(exists("/.ota-pending.tgz"));
}

TEST_CASE_FIXTURE(OtaFixture, "a pending build is installed and enters its trial" *
                                  doctest::test_suite("ota_install")) {
    s_nums["pending"] = 1;
    s_nums["trialN"] = 3;
    s_strs["pendChk"] = "new";
    touch("/.ota-pending.tgz");

    CHECK(MIK_OtaBootReconcile());
    CHECK(g_ota_stub_installs == 1);
    CHECK(s_nums["state"] == 1);
    CHECK(s_nums["trialLeft"] == 3);
    CHECK(s_nums["pending"] == 0);
    CHECK(s_strs["oInst"] == "new");
    CHECK(mik__ota_in_trial());
}

TEST_CASE_FIXTURE(OtaFixture, "a failed install is charged and kept for the next boot" *
                                  doctest::test_suite("ota_install")) {
    s_nums["pending"] = 1;
    s_strs["pendChk"] = "new";
    touch("/.ota-pending.tgz");
    g_ota_stub_install_ok = false;

    CHECK_FALSE(MIK_OtaBootReconcile());
    CHECK(s_nums["state"] == 0);
    CHECK(s_nums["pending"] == 1);
    CHECK(s_nums["instLeft"] == 2);
    CHECK(s_strs["oRsn"] == "install-failed");
    CHECK(exists("/.ota-pending.tgz"));
}

TEST_CASE_FIXTURE(OtaFixture, "new firmware drops a pending build" *
                                  doctest::test_suite("ota_install")) {
    s_nums["pending"] = 1;
    s_strs["pendChk"] = "new";
    touch("/.ota-pending.tgz");
    s_fw_hash = "fw-2";

    CHECK_FALSE(MIK_OtaBootReconcile());
    CHECK(g_ota_stub_installs == 0);
    CHECK(s_nums["pending"] == 0);
    CHECK(s_strs["fwHash"] == "fw-2");
    CHECK_FALSE(exists("/.ota-pending.tgz"));
}

/* The payload of the MIK_CMD_DEPLOY_RESULT reply. */
static std::string deploy_result_reply() {
    std::string out;
    MIKReplTransport transport = {};
    transport.read = [](uint8_t*, size_t, void*) { return -1; };
    transport.write = [](const void* buf, size_t len, void* ctx) {
        static_cast<std::string*>(ctx)->append(static_cast<const char*>(buf), len);
    };
    transport.ctx = &out;
    MIK_OtaHandleDeployResult(&transport, 0);
    REQUIRE(out.size() >= MIK_PROTO_HEADER_SIZE);
    REQUIRE(static_cast<uint8_t>(out[0]) == MIK_MSG_OK);
    return out.substr(MIK_PROTO_HEADER_SIZE);
}

TEST_CASE_FIXTURE(OtaFixture, "a cable deploy is installed at boot and reports its result" *
                                  doctest::test_suite("ota_install")) {
    touch("/upload.tgz");
    const char* err = nullptr;
    REQUIRE(MIK_OtaStageAdopt((root + "/upload.tgz").c_str(), "", &err));
    CHECK(exists("/.ota-pending.tgz"));

    CHECK(MIK_OtaBootReconcile());
    CHECK(g_ota_stub_installs == 1);
    CHECK_FALSE(mik__ota_in_trial());

    /* u8 status | three empty u16le-length strings; read once, then cleared. */
    CHECK(deploy_result_reply() == std::string("\x01\0\0\0\0\0\0", 7));
    CHECK(deploy_result_reply() == std::string(7, '\0'));
}

static const std::string kChecksum(64, 'a');
static const std::string kOtherChecksum(64, 'b');

TEST_CASE_FIXTURE(OtaFixture, "a staged download is verified and left pending" *
                                  doctest::test_suite("ota_install")) {
    MIKOtaEnv env = {};
    mik__ota_fill_install_ops(&env);
    char err[96] = "";
    size_t resume = 99;
    REQUIRE(env.stage_begin(nullptr, kChecksum.c_str(), 5, &resume, err, sizeof(err)));
    CHECK(resume == 0);
    REQUIRE(env.stage_write(nullptr, reinterpret_cast<const uint8_t*>("build"), 5, err,
                            sizeof(err)));
    /* More than the declared size is refused. */
    CHECK_FALSE(env.stage_write(nullptr, reinterpret_cast<const uint8_t*>("x"), 1, err,
                                sizeof(err)));

    int kind = -1;
    g_ota_stub_sha = kChecksum.c_str();
    REQUIRE(env.stage_finish(nullptr, 2, false, false, err, sizeof(err), &kind));
    CHECK(s_nums["pending"] == 1);
    CHECK(s_nums["trialN"] == 2);
    CHECK(s_strs["pendChk"] == kChecksum);
    CHECK(exists("/.ota-pending.tgz"));
    CHECK_FALSE(exists("/.ota-staging.tgz"));
    CHECK(g_ota_stub_installs == 0);
}

TEST_CASE_FIXTURE(OtaFixture, "a staged download with the wrong checksum is corrupt" *
                                  doctest::test_suite("ota_install")) {
    MIKOtaEnv env = {};
    mik__ota_fill_install_ops(&env);
    char err[96] = "";
    size_t resume = 0;
    REQUIRE(env.stage_begin(nullptr, kChecksum.c_str(), 5, &resume, err, sizeof(err)));
    REQUIRE(env.stage_write(nullptr, reinterpret_cast<const uint8_t*>("build"), 5, err,
                            sizeof(err)));

    int kind = -1;
    g_ota_stub_sha = kOtherChecksum.c_str();
    CHECK_FALSE(env.stage_finish(nullptr, 2, false, false, err, sizeof(err), &kind));
    CHECK(kind == MIK_OTA_ERR_CORRUPT);
    CHECK(s_nums.count("pending") == 0);
    CHECK_FALSE(exists("/.ota-pending.tgz"));
}

TEST_CASE_FIXTURE(OtaFixture, "a cable deploy with the wrong checksum is refused" *
                                  doctest::test_suite("ota_install")) {
    touch("/upload.tgz");
    g_ota_stub_sha = kOtherChecksum.c_str();
    const char* err = nullptr;
    CHECK_FALSE(MIK_OtaStageAdopt((root + "/upload.tgz").c_str(), kChecksum.c_str(), &err));
    CHECK(std::string(err ? err : "").find("checksum mismatch") != std::string::npos);
    CHECK(s_nums.count("pending") == 0);

    g_ota_stub_sha = kChecksum.c_str();
    CHECK(MIK_OtaStageAdopt((root + "/upload.tgz").c_str(), kChecksum.c_str(), &err));
    CHECK(s_strs["pendChk"] == kChecksum);
}

TEST_CASE("OTA does nothing without a store or an app filesystem" *
          doctest::test_suite("ota_install")) {
    MIK_SetDeviceStore(nullptr);
    CHECK_FALSE(MIK_OtaBootReconcile());

    MIKDeviceStore store = {};
    store.state_open = fake_state_open;
    MIK_SetDeviceStore(&store);
    CHECK_FALSE(MIK_OtaBootReconcile());
    CHECK_FALSE(mik__ota_in_trial());
    MIK_SetDeviceStore(nullptr);
}
