#pragma once

/* Host fake for the OTA platform seam: scripted HTTP, an in-memory kv store,
 * fake install ops and a virtual clock. The equivalent of the vitest suite's
 * `harness()` io fakes, with one difference that matters — the transport is
 * genuinely asynchronous. Nothing is delivered until Tick() runs, so a client
 * that read a response straight after issuing the request would fail here the
 * same way it fails on device.
 *
 * The rule for everything in here: a boundary fake must be able to produce
 * every shape the real peer produces, not only the ones the test author
 * imagined. CheckinResponse below can only build a map, which is why a
 * registry answering a quiet round with CBOR null went unnoticed by this whole
 * suite. Response fixtures generated from the reference registry
 * (test/ota_wire_fixtures_test.cpp) are the enforcement for the check-in
 * wire. */

#include <nanocbor/nanocbor.h>

#include <cstdarg>
#include <cstdlib>
#include <cstdio>
#include <cstring>
#include <functional>
#include <map>
#include <set>
#include <string>
#include <vector>

#include "mikrojs/cbor_helpers.h"
#include "mikrojs/ota_client.h"
#include "mikrojs/ota_env.h"

namespace mikrojs::test {

// ── CBOR helpers ─────────────────────────────────────────────────────────────

inline std::vector<uint8_t> BuildCbor(const std::function<void(nanocbor_encoder_t*)>& fn) {
    /* Non-null measuring base: zero-length appends still reach memcpy. */
    static uint8_t measure_base;
    nanocbor_encoder_t enc;
    nanocbor_encoder_init(&enc, &measure_base, 0);
    fn(&enc);
    std::vector<uint8_t> out(nanocbor_encoded_len(&enc));
    nanocbor_encoder_init(&enc, out.data(), out.size());
    fn(&enc);
    return out;
}

/* A `{interval: n}` document: the shape the config tests deliver. */
inline std::vector<uint8_t> DocInterval(int n) {
    return BuildCbor([n](nanocbor_encoder_t* enc) {
        nanocbor_fmt_map(enc, 1);
        nanocbor_put_tstr(enc, "interval");
        nanocbor_fmt_int(enc, n);
    });
}

/* Position a decoder at a dotted path: map keys, or a numeric array index. */
inline bool CborSeek(const std::vector<uint8_t>& bytes, const std::string& path,
                     nanocbor_value_t* out) {
    nanocbor_value_t it;
    nanocbor_decoder_init(&it, bytes.data(), bytes.size());
    size_t pos = 0;
    while (pos <= path.size()) {
        size_t dot = path.find('.', pos);
        std::string seg =
            path.substr(pos, dot == std::string::npos ? std::string::npos : dot - pos);
        if (seg.empty()) return false;
        bool numeric = seg.find_first_not_of("0123456789") == std::string::npos;

        nanocbor_value_t inner;
        if (numeric) {
            if (nanocbor_enter_array(&it, &inner) < 0) return false;
            for (size_t i = 0; i < static_cast<size_t>(atoi(seg.c_str())); i++) {
                if (nanocbor_at_end(&inner) || mik__cbor_skip_value(&inner) < 0) return false;
            }
            if (nanocbor_at_end(&inner)) return false;
        } else {
            if (nanocbor_enter_map(&it, &inner) < 0) return false;
            bool found = false;
            while (!nanocbor_at_end(&inner)) {
                const uint8_t* key = nullptr;
                size_t key_len = 0;
                if (nanocbor_get_tstr(&inner, &key, &key_len) < 0) return false;
                if (std::string(reinterpret_cast<const char*>(key), key_len) == seg) {
                    found = true;
                    break;
                }
                if (mik__cbor_skip_value(&inner) < 0) return false;
            }
            if (!found) return false;
        }
        it = inner;
        if (dot == std::string::npos) break;
        pos = dot + 1;
    }
    *out = it;
    return true;
}

inline bool CborHas(const std::vector<uint8_t>& bytes, const std::string& path) {
    nanocbor_value_t it;
    return CborSeek(bytes, path, &it);
}

inline std::string CborStr(const std::vector<uint8_t>& bytes, const std::string& path) {
    nanocbor_value_t it;
    if (!CborSeek(bytes, path, &it)) return "<missing>";
    const uint8_t* ptr = nullptr;
    size_t len = 0;
    if (nanocbor_get_tstr(&it, &ptr, &len) < 0) return "<not-a-string>";
    return std::string(reinterpret_cast<const char*>(ptr), len);
}

inline int64_t CborInt(const std::vector<uint8_t>& bytes, const std::string& path) {
    nanocbor_value_t it;
    if (!CborSeek(bytes, path, &it)) return -1;
    int32_t value = 0;
    if (nanocbor_get_int32(&it, &value) < 0) return -1;
    return value;
}

inline bool CborBool(const std::vector<uint8_t>& bytes, const std::string& path) {
    nanocbor_value_t it;
    if (!CborSeek(bytes, path, &it)) return false;
    bool value = false;
    nanocbor_get_bool(&it, &value);
    return value;
}

/* The raw CBOR span of the value at `path`, for comparing a stored document
 * against the bytes that were delivered. */
inline std::vector<uint8_t> CborRaw(const std::vector<uint8_t>& bytes, const std::string& path) {
    nanocbor_value_t it;
    if (!CborSeek(bytes, path, &it)) return {};
    const uint8_t* start = it.cur;
    if (mik__cbor_skip_value(&it) < 0) return {};
    return std::vector<uint8_t>(start, it.cur);
}

// ── Check-in response builder ────────────────────────────────────────────────

/* The CBOR a check-in response carries. Every field is optional, mirroring the
 * wire: what is not set is not sent. */
struct CheckinResponse {
    bool has_offer = false;
    std::string url;
    std::string checksum;
    int64_t size = 0;
    bool omit_checksum = false;
    bool omit_size = false;

    bool has_name = false;
    int name_rev = 0;
    std::string name;  // empty with has_name = the cleared [rev] pair
    bool name_junk = false;

    bool has_config = false;
    bool config_omit_version = false;
    std::string config_rev;
    std::string config_version = "1.0.0";
    std::vector<uint8_t> config_doc;  // empty = the clear
    bool config_doc_null = false;

    std::vector<uint8_t> Encode() const {
        return BuildCbor([this](nanocbor_encoder_t* enc) {
            size_t size_count = 0;
            if (has_offer) {
                size_count += 1;
                if (!omit_checksum) size_count++;
                if (!omit_size) size_count++;
            }
            if (has_name) size_count++;
            if (has_config) size_count++;
            nanocbor_fmt_map(enc, size_count);

            if (has_offer) {
                nanocbor_put_tstr(enc, "url");
                nanocbor_put_tstr(enc, url.c_str());
                if (!omit_checksum) {
                    nanocbor_put_tstr(enc, "checksum");
                    nanocbor_put_tstr(enc, checksum.c_str());
                }
                if (!omit_size) {
                    nanocbor_put_tstr(enc, "size");
                    nanocbor_fmt_int(enc, size);
                }
            }
            if (has_name) {
                nanocbor_put_tstr(enc, "name");
                if (name_junk) {
                    nanocbor_put_tstr(enc, "kitchen");
                } else if (name.empty()) {
                    nanocbor_fmt_array(enc, 1);
                    nanocbor_fmt_int(enc, name_rev);
                } else {
                    nanocbor_fmt_array(enc, 2);
                    nanocbor_fmt_int(enc, name_rev);
                    nanocbor_put_tstr(enc, name.c_str());
                }
            }
            if (has_config) {
                nanocbor_put_tstr(enc, "config");
                size_t cfg_count = 0;
                if (!config_omit_version) cfg_count++;
                if (!config_rev.empty()) cfg_count++;
                if (!config_doc.empty() || config_doc_null) cfg_count++;
                nanocbor_fmt_map(enc, cfg_count);
                if (!config_omit_version) {
                    nanocbor_put_tstr(enc, "version");
                    nanocbor_put_tstr(enc, config_version.c_str());
                }
                if (!config_rev.empty()) {
                    nanocbor_put_tstr(enc, "rev");
                    nanocbor_put_tstr(enc, config_rev.c_str());
                }
                if (config_doc_null) {
                    nanocbor_put_tstr(enc, "doc");
                    nanocbor_fmt_null(enc);
                } else if (!config_doc.empty()) {
                    nanocbor_put_tstr(enc, "doc");
                    // Raw append: the document goes on the wire as-is.
                    enc->len += config_doc.size();
                    if (enc->fits(enc, enc->context, config_doc.size())) {
                        enc->append(enc, enc->context, config_doc.data(), config_doc.size());
                    }
                }
            }
        });
    }
};

// ── The fake env ─────────────────────────────────────────────────────────────

struct LogEntry {
    int level;
    std::string message;
};

/* One scripted exchange. status 0 means the request never completed. */
struct FakeExchange {
    int status = 200;
    std::string error;
    std::vector<std::vector<uint8_t>> chunks;
    /* Skip the headers callback, for a transport that only knows the status at
     * the end. The client must still cope. */
    bool skip_headers = false;
    /* Deliver the chunks and then never finish, the way a server that dribbles
     * a body does. Only a cancel gets the client out of this. */
    bool never_completes = false;
};

class FakeOtaEnv {
public:
    FakeOtaEnv() {
        memset(&c_env_, 0, sizeof(c_env_));
        c_env_.opaque = this;

        c_env_.http_request = [](void* op, const MIKOtaHttpRequest* req,
                                 const MIKOtaHttpCallbacks* cbs) -> void* {
            return static_cast<FakeOtaEnv*>(op)->HttpRequest(req, cbs);
        };
        c_env_.http_cancel = [](void* op, void* handle) {
            static_cast<FakeOtaEnv*>(op)->HttpCancel(handle);
        };

        c_env_.kv_get_blob = [](void* op, const char* k, uint8_t* out,
                                size_t* len) -> MIKOtaKvStatus {
            return static_cast<FakeOtaEnv*>(op)->KvGetBlob(k, out, len);
        };
        c_env_.kv_set_blob = [](void* op, const char* k, const uint8_t* d, size_t l) -> bool {
            return static_cast<FakeOtaEnv*>(op)->KvSetBlob(k, d, l);
        };
        c_env_.kv_get_str = [](void* op, const char* k, char* out, size_t max_len) -> bool {
            return static_cast<FakeOtaEnv*>(op)->KvGetStr(k, out, max_len);
        };
        c_env_.kv_set_str = [](void* op, const char* k, const char* val) -> bool {
            return static_cast<FakeOtaEnv*>(op)->KvSetStr(k, val);
        };
        c_env_.kv_get_i32 = [](void* op, const char* k, int32_t* out) -> bool {
            return static_cast<FakeOtaEnv*>(op)->KvGetI32(k, out);
        };
        c_env_.kv_set_i32 = [](void* op, const char* k, int32_t val) -> bool {
            return static_cast<FakeOtaEnv*>(op)->KvSetI32(k, val);
        };
        c_env_.kv_remove = [](void* op, const char* k) -> bool {
            return static_cast<FakeOtaEnv*>(op)->KvRemove(k);
        };

        c_env_.stage_begin = [](void* op, const char* csum, size_t sz, size_t* out_off, char* eb,
                                size_t el) -> bool {
            return static_cast<FakeOtaEnv*>(op)->StageBegin(csum, sz, out_off, eb, el);
        };
        c_env_.stage_write = [](void* op, const uint8_t* d, size_t l, char* eb, size_t el) -> bool {
            return static_cast<FakeOtaEnv*>(op)->StageWrite(d, l, eb, el);
        };
        c_env_.stage_finish = [](void* op, int tb, bool rc, bool in, char* eb, size_t el,
                                 int* ek) -> bool {
            return static_cast<FakeOtaEnv*>(op)->StageFinish(tb, rc, in, eb, el, ek);
        };
        c_env_.stage_abort = [](void* op) { static_cast<FakeOtaEnv*>(op)->StageAbort(); };
        c_env_.mark_valid = [](void* op) { static_cast<FakeOtaEnv*>(op)->MarkValid(); };
        c_env_.revert = [](void* op, char* eb, size_t el) -> bool {
            return static_cast<FakeOtaEnv*>(op)->Revert(eb, el);
        };
        c_env_.running = [](void* op, MIKOtaRunningBuild* out) -> bool {
            return static_cast<FakeOtaEnv*>(op)->Running(out);
        };
        c_env_.reconcile = [](void* op, MIKOtaReconcileOutcome* out) {
            static_cast<FakeOtaEnv*>(op)->Reconcile(out);
        };

        c_env_.identity = [](void* op, MIKDeviceIdentity* out) -> bool {
            return static_cast<FakeOtaEnv*>(op)->Identity(out);
        };
        c_env_.storage_free = [](void* op, size_t* out) -> bool {
            return static_cast<FakeOtaEnv*>(op)->StorageFree(out);
        };
        c_env_.get_device_name = [](void* op, int* rev, char* name, size_t len) -> bool {
            return static_cast<FakeOtaEnv*>(op)->GetDeviceName(rev, name, len);
        };
        c_env_.set_device_name = [](void* op, int rev, const char* name) {
            static_cast<FakeOtaEnv*>(op)->SetDeviceName(rev, name);
        };
        c_env_.restart = [](void* op) { static_cast<FakeOtaEnv*>(op)->Restart(); };
        c_env_.monotonic_ms = [](void* op) -> int64_t {
            return static_cast<FakeOtaEnv*>(op)->now_ms;
        };
        c_env_.random_fraction = [](void* op) -> double {
            return static_cast<FakeOtaEnv*>(op)->random_fraction;
        };
        c_env_.log = FakeLog;
        c_env_.read_app_version = [](void* op, char* out, size_t len) -> bool {
            return static_cast<FakeOtaEnv*>(op)->ReadAppVersion(out, len);
        };
        c_env_.read_manifest = [](void* op) -> char* {
            return static_cast<FakeOtaEnv*>(op)->ReadManifest();
        };

        // Enrolled by default; a test drops either key to un-enroll.
        kv_strings["ota.registry"] = "https://reg.example";
        kv_strings["ota.updateKey"] = "duk_secret";
    }

    const MIKOtaEnv* env() const { return &c_env_; }

    static void FakeLog(void* op, int lvl, const char* fmt, ...) {
        va_list args;
        va_start(args, fmt);
        char buf[512];
        vsnprintf(buf, sizeof(buf), fmt, args);
        va_end(args);
        static_cast<FakeOtaEnv*>(op)->logs.push_back({lvl, buf});
    }

    bool LoggedContaining(const std::string& needle) const {
        for (const LogEntry& entry : logs) {
            if (entry.message.find(needle) != std::string::npos) return true;
        }
        return false;
    }

    size_t CountLoggedContaining(const std::string& needle) const {
        size_t count = 0;
        for (const LogEntry& entry : logs) {
            if (entry.message.find(needle) != std::string::npos) count++;
        }
        return count;
    }

    // ── HTTP ───────────────────────────────────────────────────────────────
    struct RecordedRequest {
        std::string url;
        std::string method;
        std::map<std::string, std::string> headers;
        std::vector<uint8_t> body;
        uint32_t timeout_ms = 0;
    };
    std::vector<RecordedRequest> requests;
    std::vector<FakeExchange> scripted;
    size_t unexpected_requests = 0;

    void ReplyWith(int status, const std::vector<uint8_t>& body) {
        FakeExchange ex;
        ex.status = status;
        if (!body.empty()) ex.chunks.push_back(body);
        scripted.push_back(ex);
    }
    void ReplyWith(const CheckinResponse& response) { ReplyWith(200, response.Encode()); }
    void ReplyWithChunks(int status, const std::vector<std::vector<uint8_t>>& chunks) {
        FakeExchange ex;
        ex.status = status;
        ex.chunks = chunks;
        scripted.push_back(ex);
    }
    /* A response that starts normally and then dies mid-body. */
    void ReplyWithTruncated(int status, const std::vector<std::vector<uint8_t>>& chunks,
                            const std::string& message) {
        FakeExchange ex;
        ex.status = status;
        ex.chunks = chunks;
        ex.error = message;
        scripted.push_back(ex);
    }

    /* A response that keeps streaming and never ends. */
    void ReplyWithStall(int status, const std::vector<std::vector<uint8_t>>& chunks) {
        FakeExchange ex;
        ex.status = status;
        ex.chunks = chunks;
        ex.never_completes = true;
        scripted.push_back(ex);
    }

    void ReplyWithFailure(const std::string& message) {
        FakeExchange ex;
        ex.status = 0;
        ex.error = message;
        scripted.push_back(ex);
    }

    /* Deliver the oldest issued request. Returns false when none is waiting. */
    bool Tick() {
        if (pending_.empty()) return false;
        Pending p = pending_.front();
        pending_.erase(pending_.begin());
        if (!p.exchange.skip_headers && p.exchange.status != 0 && p.cbs.headers) {
            p.cbs.headers(p.cbs.user_data, p.exchange.status);
        }
        for (const std::vector<uint8_t>& chunk : p.exchange.chunks) {
            if (p.cbs.data && !chunk.empty()) {
                p.cbs.data(p.cbs.user_data, chunk.data(), chunk.size());
            }
        }
        if (p.exchange.never_completes) return true;
        if (p.cbs.done) {
            p.cbs.done(p.cbs.user_data, p.exchange.status,
                       p.exchange.error.empty() ? nullptr : p.exchange.error.c_str());
        }
        return true;
    }

    bool has_pending_request() const { return !pending_.empty(); }

    void* HttpRequest(const MIKOtaHttpRequest* req, const MIKOtaHttpCallbacks* cbs) {
        RecordedRequest recorded;
        recorded.url = req->url ? req->url : "";
        recorded.method = req->method ? req->method : "GET";
        recorded.timeout_ms = req->timeout_ms;
        if (req->body && req->body_len > 0) {
            recorded.body.assign(req->body, req->body + req->body_len);
        }
        for (size_t i = 0; i < req->header_count; i++) {
            recorded.headers[req->header_keys[i]] = req->header_values[i];
        }
        requests.push_back(recorded);

        Pending p;
        p.cbs = *cbs;
        if (scripted.empty()) {
            unexpected_requests++;
            p.exchange.status = 0;
            p.exchange.error = "unexpected request";
        } else {
            p.exchange = scripted.front();
            scripted.erase(scripted.begin());
        }
        pending_.push_back(p);
        return reinterpret_cast<void*>(next_handle_++);
    }

    void HttpCancel(void* handle) {
        cancelled.push_back(handle);
        pending_.clear();
    }
    std::vector<void*> cancelled;

    const RecordedRequest& request(size_t index) const { return requests.at(index); }
    std::string HeaderOf(size_t index, const std::string& key) const {
        const auto& headers = requests.at(index).headers;
        auto it = headers.find(key);
        return it == headers.end() ? "" : it->second;
    }

    // ── kv ─────────────────────────────────────────────────────────────────
    std::map<std::string, std::vector<uint8_t>> kv_blobs;
    std::map<std::string, std::string> kv_strings;
    std::map<std::string, int32_t> kv_i32s;

    /* Set to make every blob read fail the way a heap-starved nvs_open does,
     * so a caller that confuses "could not read" with "nothing stored" is
     * caught here rather than on a device mid-handshake. */
    bool fail_blob_reads = false;

    /* The same, for one key only: a read that fails while its neighbours still
     * answer, which is what heap pressure actually looks like. */
    std::set<std::string> fail_blob_keys;

    MIKOtaKvStatus KvGetBlob(const char* k, uint8_t* out, size_t* len) {
        if (fail_blob_reads || fail_blob_keys.count(k)) return MIK_OTA_KV_ERROR;
        auto it = kv_blobs.find(k);
        if (it == kv_blobs.end()) return MIK_OTA_KV_ABSENT;
        if (!out) {
            *len = it->second.size();
            return MIK_OTA_KV_OK;
        }
        size_t to_copy = (*len < it->second.size()) ? *len : it->second.size();
        memcpy(out, it->second.data(), to_copy);
        *len = it->second.size();
        return MIK_OTA_KV_OK;
    }
    bool KvSetBlob(const char* k, const uint8_t* d, size_t l) {
        kv_blobs[k] = std::vector<uint8_t>(d, d + l);
        return true;
    }
    bool KvGetStr(const char* k, char* out, size_t max_len) {
        auto it = kv_strings.find(k);
        if (it == kv_strings.end()) return false;
        snprintf(out, max_len, "%s", it->second.c_str());
        return true;
    }
    bool KvSetStr(const char* k, const char* val) {
        /* The device encodes into a 320-byte buffer and fails past it rather
         * than truncating (mik_ota_env.cpp). A fake that quietly accepts more
         * hides every "this value does not round-trip" bug. */
        std::string value = val ? val : "";
        if (value.size() + 8 > 320) return false;
        kv_strings[k] = value;
        return true;
    }
    bool KvGetI32(const char* k, int32_t* out) {
        auto it = kv_i32s.find(k);
        if (it == kv_i32s.end()) return false;
        *out = it->second;
        return true;
    }
    bool KvSetI32(const char* k, int32_t val) {
        kv_i32s[k] = val;
        return true;
    }
    bool KvRemove(const char* k) {
        kv_blobs.erase(k);
        kv_strings.erase(k);
        kv_i32s.erase(k);
        return true;
    }

    bool HasBlob(const char* key) const { return kv_blobs.count(key) > 0; }
    std::vector<uint8_t> Blob(const char* key) const {
        auto it = kv_blobs.find(key);
        return it == kv_blobs.end() ? std::vector<uint8_t>() : it->second;
    }

    /* Seed a config slot in the shape the client and runtime/ota/shared.ts agree
     * on: a CBOR map of version, optional rev, and the document verbatim. */
    void SeedConfig(const char* key, const std::string& rev, const std::string& version,
                    const std::vector<uint8_t>& doc) {
        std::vector<uint8_t> bytes = BuildCbor([&](nanocbor_encoder_t* enc) {
            size_t count = 1 + (rev.empty() ? 0 : 1) + (doc.empty() ? 0 : 1);
            nanocbor_fmt_map(enc, count);
            nanocbor_put_tstr(enc, "version");
            nanocbor_put_tstr(enc, version.c_str());
            if (!rev.empty()) {
                nanocbor_put_tstr(enc, "rev");
                nanocbor_put_tstr(enc, rev.c_str());
            }
            if (!doc.empty()) {
                nanocbor_put_tstr(enc, "doc");
                enc->len += doc.size();
                if (enc->fits(enc, enc->context, doc.size())) {
                    enc->append(enc, enc->context, doc.data(), doc.size());
                }
            }
        });
        kv_blobs[key] = bytes;
    }

    void SeedConfigTrial(int left, bool read) {
        kv_blobs["ota.cfgTrial"] = BuildCbor([left, read](nanocbor_encoder_t* enc) {
            nanocbor_fmt_map(enc, 2);
            nanocbor_put_tstr(enc, "left");
            nanocbor_fmt_int(enc, left);
            nanocbor_put_tstr(enc, "read");
            nanocbor_fmt_bool(enc, read);
        });
    }

    void SeedConfigError(const std::string& rev, const std::string& message) {
        kv_blobs["ota.cfgErr"] = BuildCbor([&](nanocbor_encoder_t* enc) {
            nanocbor_fmt_map(enc, 2);
            nanocbor_put_tstr(enc, "rev");
            nanocbor_put_tstr(enc, rev.c_str());
            nanocbor_put_tstr(enc, "message");
            nanocbor_put_tstr(enc, message.c_str());
        });
    }

    // ── install ops ────────────────────────────────────────────────────────
    size_t stage_begin_resume_offset = 0;
    bool stage_begin_ok = true;
    std::string stage_begin_err;

    bool stage_write_ok = true;
    std::string stage_write_err;
    std::vector<uint8_t> stage_written_bytes;

    bool stage_finish_ok = true;
    std::string stage_finish_err;
    int stage_finish_err_kind = 0;
    int stage_finish_calls = 0;
    int last_stage_finish_trial_boots = 1;
    bool last_stage_finish_require_confirm = false;
    bool last_stage_finish_install_now = false;

    int stage_abort_calls = 0;
    int mark_valid_calls = 0;
    bool revert_ok = true;
    std::string revert_err;
    int revert_calls = 0;

    MIKOtaRunningBuild running_build = {"oldsum", "1.0.0", false};
    MIKOtaReconcileOutcome reconcile_outcome = {"", false, false, {"", ""}};
    int reconcile_calls = 0;

    bool StageBegin(const char*, size_t, size_t* out_off, char* eb, size_t el) {
        if (out_off) *out_off = stage_begin_resume_offset;
        if (!stage_begin_ok) {
            snprintf(eb, el, "%s", stage_begin_err.c_str());
            return false;
        }
        return true;
    }

    bool StageWrite(const uint8_t* d, size_t l, char* eb, size_t el) {
        if (!stage_write_ok) {
            snprintf(eb, el, "%s", stage_write_err.c_str());
            return false;
        }
        stage_written_bytes.insert(stage_written_bytes.end(), d, d + l);
        return true;
    }

    bool StageFinish(int tb, bool rc, bool in, char* eb, size_t el, int* ek) {
        stage_finish_calls++;
        last_stage_finish_trial_boots = tb;
        last_stage_finish_require_confirm = rc;
        last_stage_finish_install_now = in;
        if (!stage_finish_ok) {
            snprintf(eb, el, "%s", stage_finish_err.c_str());
            if (ek) *ek = stage_finish_err_kind;
            return false;
        }
        return true;
    }

    void StageAbort() { stage_abort_calls++; }
    /* Marking the running build valid resolves its trial, as it does on device:
     * an offer that arrived during the trial can then stage in the same pass. */
    void MarkValid() {
        mark_valid_calls++;
        running_build.trial = false;
    }

    bool Revert(char* eb, size_t el) {
        revert_calls++;
        if (!revert_ok) {
            snprintf(eb, el, "%s", revert_err.c_str());
            return false;
        }
        return true;
    }

    /* Assigning the struct only works from string literals, so tests that pass
     * a pointer set it through here. */
    void SetRunning(const char* checksum, const char* version, bool trial) {
        running_build = {};
        snprintf(running_build.checksum, sizeof(running_build.checksum), "%s", checksum);
        snprintf(running_build.version, sizeof(running_build.version), "%s", version);
        running_build.trial = trial;
    }

    bool Running(MIKOtaRunningBuild* out) {
        if (out) *out = running_build;
        return true;
    }

    void Reconcile(MIKOtaReconcileOutcome* out) {
        reconcile_calls++;
        if (out) *out = reconcile_outcome;
    }

    // ── system ─────────────────────────────────────────────────────────────
    MIKDeviceIdentity dev_id = {"dev-1", "0.16.0", "fwhash", 42};
    bool has_storage_free = true;
    size_t storage_free_val = 900000;
    int name_rev = 1;
    std::string device_name = "shed";
    bool has_device_name = true;
    std::vector<std::pair<int, std::string>> names_set;
    int restart_calls = 0;
    int64_t now_ms = 0;
    double random_fraction = 0.5;
    std::vector<LogEntry> logs;
    std::string app_version = "1.0.0";

    bool Identity(MIKDeviceIdentity* out) {
        if (out) *out = dev_id;
        return true;
    }

    bool StorageFree(size_t* out) {
        if (!has_storage_free) return false;
        if (out) *out = storage_free_val;
        return true;
    }

    bool GetDeviceName(int* rev, char* name, size_t len) {
        if (!has_device_name) return false;
        if (rev) *rev = name_rev;
        if (name) snprintf(name, len, "%s", device_name.c_str());
        return true;
    }

    void SetDeviceName(int rev, const char* name) {
        names_set.push_back({rev, name ? name : ""});
        has_device_name = name != nullptr;
        name_rev = rev;
        device_name = name ? name : "";
    }

    void Restart() { restart_calls++; }

    /* The running build's manifest. `has_manifest` false models a build that
     * never went through deploy, which is the only case that reads as "no
     * complete config can exist yet". */
    bool has_manifest = false;
    std::string manifest;
    int manifest_reads = 0;

    char* ReadManifest() {
        manifest_reads++;
        if (!has_manifest) return nullptr;
        return strdup(manifest.c_str());
    }

    bool ReadAppVersion(char* out, size_t len) {
        if (app_version.empty()) return false;
        snprintf(out, len, "%s", app_version.c_str());
        return true;
    }

private:
    struct Pending {
        MIKOtaHttpCallbacks cbs = {};
        FakeExchange exchange;
    };
    std::vector<Pending> pending_;
    uintptr_t next_handle_ = 1;
    MIKOtaEnv c_env_;
};

/* The `beforeCheck` hook pair. Both halves settle on the first poll unless a
 * pending count says otherwise, so a test can hold a round open mid-hook. */
class FakeRoundHooks : public MIKOtaRoundHooks {
public:
    bool has_before_check = true;
    bool before_check_fails = false;
    int before_check_pending_polls = 0;
    bool has_teardown = true;
    bool teardown_fails = false;
    int teardown_pending_polls = 0;
    std::vector<std::string> order;

    bool BeginBeforeCheck() override {
        if (!has_before_check) return false;
        order.push_back("before");
        before_polls_ = 0;
        return true;
    }

    MIKOtaHookState PollBeforeCheck() override {
        if (before_polls_++ < before_check_pending_polls) return MIKOtaHookState::kPending;
        return before_check_fails ? MIKOtaHookState::kFailed : MIKOtaHookState::kOk;
    }

    bool BeginTeardown() override {
        if (!has_teardown) return false;
        order.push_back("teardown");
        teardown_polls_ = 0;
        return true;
    }

    MIKOtaHookState PollTeardown() override {
        if (teardown_polls_++ < teardown_pending_polls) return MIKOtaHookState::kPending;
        return teardown_fails ? MIKOtaHookState::kFailed : MIKOtaHookState::kOk;
    }

private:
    int before_polls_ = 0;
    int teardown_polls_ = 0;
};

}  // namespace mikrojs::test
