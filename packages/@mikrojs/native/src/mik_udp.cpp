#include "mikrojs/udp.h"

#include "mikrojs/mikrojs.h"
#include "mikrojs/platform.h"
#include "mikrojs/utils.h"

#include <arpa/inet.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <cerrno>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <vector>

/* ── Per-socket state ────────────────────────────────────────────────
 *
 * One of these per open UDP socket. Lifetime is tied to the JS UdpSocket
 * object; the finalizer (mik__udp_finalizer) closes the OS socket and
 * removes the entry from g_open_sockets.
 *
 * Closed sockets are kept in g_open_sockets with closed=true until the
 * GC actually finalizes the JS object — mik__udp_consume skips them.
 */
struct UdpSocketState {
    JSContext* ctx;          /* weak ref; do not free */
    int fd;
    int family;              /* AF_INET, AF_INET6 (dual via V6ONLY=0) */
    bool dual;               /* true => v6 socket with V6ONLY=0 */
    int port;                /* actual bound port */
    JSValue on_message;      /* duped JSValue, JS_UNDEFINED if not set */
    uint32_t dropped;
    int recv_queue;          /* per-tick drain limit */
    bool closed;
    bool dead;               /* finalized; pending sweep (see consume) */
};

static JSClassID udp_socket_class_id;

/* Global registry of open sockets across all runtimes. The loop consumer
 * filters by ctx, so multi-runtime scenarios are handled even though the
 * vector is process-wide. Single-threaded access is assumed (one tick at
 * a time per runtime; sockets aren't shared across runtimes). */
static std::vector<UdpSocketState*> g_open_sockets;

/* Runtimes that have had the loop consumer registered. Tracking per-
 * runtime rather than process-global lets multiple runtimes coexist
 * and lets new runtimes get a fresh consumer after old ones are freed.
 * A vector with linear scan is sufficient: typical N=1, never more
 * than a handful, and avoids pulling in std::unordered_set's hash-
 * table machinery just for membership checks. */
static std::vector<MIKRuntime*> g_consumer_registered_runtimes;

/* Re-entrance guard for mik__udp_consume. A user onMessage callback can
 * synchronously trigger a UdpSocket finalizer (e.g. by dropping the last
 * reference to a sibling socket). Erasing from g_open_sockets mid-iteration
 * would invalidate indices; deleting `s` for the currently-iterating socket
 * would be a UAF. While iterating, the finalizer marks `s->dead = true` and
 * defers cleanup; consume sweeps dead entries when the depth returns to 0. */
static int g_iteration_depth = 0;

/* ── Forward declarations ────────────────────────────────────────────*/
static void mik__udp_consume(JSContext* ctx);
static void mik__udp_destroy(JSContext* ctx);
static JSValue mik__udp_err(JSContext* ctx, const char* name, const char* fmt, ...)
    __attribute__((format(printf, 3, 4)));

/* ── Helpers ────────────────────────────────────────────────────────*/

static JSValue mik__udp_err(JSContext* ctx, const char* name, const char* fmt, ...) {
    char buf[160];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(buf, sizeof(buf), fmt, ap);
    va_end(ap);
    return mik__result_err_named(ctx, name, "%s", buf);
}

static JSValue mik__udp_err_tag(JSContext* ctx, const char* name) {
    return mik__result_err_tag(ctx, name);
}

/* Parse an address string + port into a sockaddr_storage. Returns 0 on
 * success, -1 on parse failure. Family hint: AF_UNSPEC tries v4 first
 * then v6; AF_INET / AF_INET6 are forced. */
static int mik__parse_addr(const char* address, int port, int family_hint,
                           struct sockaddr_storage* out, socklen_t* out_len) {
    memset(out, 0, sizeof(*out));

    /* IPv4 attempt */
    if (family_hint == AF_UNSPEC || family_hint == AF_INET) {
        struct sockaddr_in* sin = (struct sockaddr_in*)out;
        if (inet_pton(AF_INET, address, &sin->sin_addr) == 1) {
            sin->sin_family = AF_INET;
            sin->sin_port = htons((uint16_t)port);
            *out_len = sizeof(*sin);
            return 0;
        }
        if (family_hint == AF_INET) return -1;
    }

    /* IPv6 attempt — strip optional %scope suffix */
    char tmp[80];
    const char* pct = strchr(address, '%');
    const char* a = address;
    uint32_t scope_id = 0;
    if (pct) {
        size_t n = (size_t)(pct - address);
        if (n >= sizeof(tmp)) return -1;
        memcpy(tmp, address, n);
        tmp[n] = '\0';
        a = tmp;
        scope_id = (uint32_t)strtoul(pct + 1, nullptr, 10);
    }

    struct sockaddr_in6* sin6 = (struct sockaddr_in6*)out;
    if (inet_pton(AF_INET6, a, &sin6->sin6_addr) == 1) {
        sin6->sin6_family = AF_INET6;
        sin6->sin6_port = htons((uint16_t)port);
        sin6->sin6_scope_id = scope_id;
        *out_len = sizeof(*sin6);
        return 0;
    }

    return -1;
}

/* Format sockaddr_storage into address string + port. v4-mapped v6
 * addresses are normalized back to plain v4 form. Returns the family
 * tag ('ipv4' / 'ipv6') for the JS object. */
static const char* mik__format_addr(const struct sockaddr_storage* sa, char* buf, size_t buflen,
                                    int* out_port) {
    if (sa->ss_family == AF_INET) {
        const struct sockaddr_in* sin = (const struct sockaddr_in*)sa;
        inet_ntop(AF_INET, &sin->sin_addr, buf, buflen);
        *out_port = ntohs(sin->sin_port);
        return "ipv4";
    }
    const struct sockaddr_in6* sin6 = (const struct sockaddr_in6*)sa;

    /* v4-mapped: ::ffff:x.x.x.x → x.x.x.x */
    if (IN6_IS_ADDR_V4MAPPED(&sin6->sin6_addr)) {
        struct in_addr v4;
        memcpy(&v4, ((const uint8_t*)&sin6->sin6_addr) + 12, sizeof(v4));
        inet_ntop(AF_INET, &v4, buf, buflen);
        *out_port = ntohs(sin6->sin6_port);
        return "ipv4";
    }

    inet_ntop(AF_INET6, &sin6->sin6_addr, buf, buflen);
    /* Append %scope if present */
    if (sin6->sin6_scope_id) {
        size_t cur = strlen(buf);
        snprintf(buf + cur, buflen - cur, "%%%u", sin6->sin6_scope_id);
    }
    *out_port = ntohs(sin6->sin6_port);
    return "ipv6";
}

/* Build a PeerAddress JS object: {address, port, family} */
static JSValue mik__make_peer(JSContext* ctx, const char* address, int port, const char* family) {
    JSValue obj = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, obj, "address", JS_NewString(ctx, address));
    JS_SetPropertyStr(ctx, obj, "port", JS_NewInt32(ctx, port));
    JS_SetPropertyStr(ctx, obj, "family", JS_NewString(ctx, family));
    return obj;
}

/* Read {address, port} (and optional family) from a JS PeerAddress. */
static int mik__read_peer(JSContext* ctx, JSValue obj, char* addr_out, size_t addr_size,
                          int* port_out) {
    JSValue addr_val = JS_GetPropertyStr(ctx, obj, "address");
    JSValue port_val = JS_GetPropertyStr(ctx, obj, "port");
    int rc = -1;

    if (JS_IsString(addr_val) && JS_IsNumber(port_val)) {
        const char* s = JS_ToCString(ctx, addr_val);
        if (s) {
            size_t len = strlen(s);
            if (len < addr_size) {
                memcpy(addr_out, s, len + 1);
                int32_t p;
                if (JS_ToInt32(ctx, &p, port_val) == 0) {
                    *port_out = (int)p;
                    rc = 0;
                }
            }
            JS_FreeCString(ctx, s);
        }
    }

    JS_FreeValue(ctx, addr_val);
    JS_FreeValue(ctx, port_val);
    return rc;
}

static UdpSocketState* mik__socket_get(JSContext* ctx, JSValue obj) {
    return (UdpSocketState*)JS_GetOpaque2(ctx, obj, udp_socket_class_id);
}

/* ── Methods ─────────────────────────────────────────────────────────*/

static JSValue mik__udp_send(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    UdpSocketState* s = mik__socket_get(ctx, this_val);
    if (!s) {
        JSValue err = mik__udp_err_tag(ctx, "Closed");
        return MIK_NewResolvedPromise(ctx, 1, &err);
    }
    if (s->closed) {
        JSValue err = mik__udp_err_tag(ctx, "Closed");
        return MIK_NewResolvedPromise(ctx, 1, &err);
    }
    if (argc < 2) {
        return JS_ThrowTypeError(ctx, "send: expected (data, to)");
    }

    /* Get bytes */
    size_t data_len;
    uint8_t* data = JS_GetUint8Array(ctx, &data_len, argv[0]);
    if (!data) {
        return JS_ThrowTypeError(ctx, "send: expected data to be Uint8Array");
    }

    /* Get peer address */
    char addr[80];
    int port;
    if (mik__read_peer(ctx, argv[1], addr, sizeof(addr), &port) != 0) {
        return JS_ThrowTypeError(ctx, "send: invalid peer address");
    }

    struct sockaddr_storage dst;
    socklen_t dst_len = 0;
    int hint = AF_UNSPEC;
    if (s->family == AF_INET) hint = AF_INET;
    else if (s->family == AF_INET6 && !s->dual) hint = AF_INET6;

    if (mik__parse_addr(addr, port, hint, &dst, &dst_len) != 0) {
        JSValue err = mik__udp_err(ctx, "SendFailed", "invalid address: %s", addr);
        return MIK_NewResolvedPromise(ctx, 1, &err);
    }

    /* For dual-stack v6 socket sending to an IPv4 peer, convert to v4-mapped. */
    if (s->dual && dst.ss_family == AF_INET) {
        struct sockaddr_in6 mapped;
        memset(&mapped, 0, sizeof(mapped));
        mapped.sin6_family = AF_INET6;
        mapped.sin6_port = ((struct sockaddr_in*)&dst)->sin_port;
        /* ::ffff:0:0 + the v4 address */
        uint8_t* p = (uint8_t*)&mapped.sin6_addr;
        p[10] = 0xff;
        p[11] = 0xff;
        memcpy(p + 12, &((struct sockaddr_in*)&dst)->sin_addr, 4);
        memcpy(&dst, &mapped, sizeof(mapped));
        dst_len = sizeof(mapped);
    }

    ssize_t n = sendto(s->fd, data, data_len, 0, (struct sockaddr*)&dst, dst_len);
    if (n < 0) {
        const char* name = "SendFailed";
        if (errno == EMSGSIZE) name = "MessageTooLarge";
        else if (errno == ENETUNREACH || errno == EHOSTUNREACH) name = "NotReachable";
        else if (errno == ENOMEM || errno == ENOBUFS) name = "OutOfMemory";
        JSValue err = mik__udp_err(ctx, name, "sendto: %s", strerror(errno));
        return MIK_NewResolvedPromise(ctx, 1, &err);
    }

    JSValue ok = mik__result_ok_void(ctx);
    return MIK_NewResolvedPromise(ctx, 1, &ok);
}

static JSValue mik__udp_join_group(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    UdpSocketState* s = mik__socket_get(ctx, this_val);
    if (!s || s->closed) return mik__udp_err_tag(ctx, "Closed");
    if (argc < 1 || !JS_IsString(argv[0])) {
        return JS_ThrowTypeError(ctx, "joinMulticastGroup: expected address string");
    }
    const char* addr = JS_ToCString(ctx, argv[0]);
    if (!addr) return JS_EXCEPTION;

    int rc;
    if (s->family == AF_INET) {
        struct ip_mreq req;
        memset(&req, 0, sizeof(req));
        if (inet_pton(AF_INET, addr, &req.imr_multiaddr) != 1) {
            JS_FreeCString(ctx, addr);
            return mik__udp_err(ctx, "JoinGroupFailed", "invalid IPv4 group");
        }
        req.imr_interface.s_addr = htonl(INADDR_ANY);
        rc = setsockopt(s->fd, IPPROTO_IP, IP_ADD_MEMBERSHIP, &req, sizeof(req));
    } else {
        struct ipv6_mreq req;
        memset(&req, 0, sizeof(req));
        if (inet_pton(AF_INET6, addr, &req.ipv6mr_multiaddr) != 1) {
            JS_FreeCString(ctx, addr);
            return mik__udp_err(ctx, "JoinGroupFailed", "invalid IPv6 group");
        }
        req.ipv6mr_interface = 0;
        rc = setsockopt(s->fd, IPPROTO_IPV6, IPV6_JOIN_GROUP, &req, sizeof(req));
    }
    JS_FreeCString(ctx, addr);

    if (rc < 0) {
        return mik__udp_err(ctx, "JoinGroupFailed", "%s", strerror(errno));
    }
    return mik__result_ok_void(ctx);
}

static JSValue mik__udp_leave_group(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    UdpSocketState* s = mik__socket_get(ctx, this_val);
    if (!s || s->closed) return mik__udp_err_tag(ctx, "Closed");
    if (argc < 1 || !JS_IsString(argv[0])) {
        return JS_ThrowTypeError(ctx, "leaveMulticastGroup: expected address string");
    }
    const char* addr = JS_ToCString(ctx, argv[0]);
    if (!addr) return JS_EXCEPTION;

    int rc;
    if (s->family == AF_INET) {
        struct ip_mreq req;
        memset(&req, 0, sizeof(req));
        if (inet_pton(AF_INET, addr, &req.imr_multiaddr) != 1) {
            JS_FreeCString(ctx, addr);
            return mik__udp_err(ctx, "LeaveGroupFailed", "invalid IPv4 group");
        }
        req.imr_interface.s_addr = htonl(INADDR_ANY);
        rc = setsockopt(s->fd, IPPROTO_IP, IP_DROP_MEMBERSHIP, &req, sizeof(req));
    } else {
        struct ipv6_mreq req;
        memset(&req, 0, sizeof(req));
        if (inet_pton(AF_INET6, addr, &req.ipv6mr_multiaddr) != 1) {
            JS_FreeCString(ctx, addr);
            return mik__udp_err(ctx, "LeaveGroupFailed", "invalid IPv6 group");
        }
        req.ipv6mr_interface = 0;
        rc = setsockopt(s->fd, IPPROTO_IPV6, IPV6_LEAVE_GROUP, &req, sizeof(req));
    }
    JS_FreeCString(ctx, addr);

    if (rc < 0) {
        return mik__udp_err(ctx, "LeaveGroupFailed", "%s", strerror(errno));
    }
    return mik__result_ok_void(ctx);
}

static JSValue mik__udp_close(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    UdpSocketState* s = mik__socket_get(ctx, this_val);
    if (!s || s->closed) return JS_UNDEFINED;
    s->closed = true;
    if (s->fd >= 0) {
        close(s->fd);
        s->fd = -1;
    }
    return JS_UNDEFINED;
}

static JSValue mik__udp_set_on_message(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    UdpSocketState* s = mik__socket_get(ctx, this_val);
    if (!s) return JS_UNDEFINED;
    JS_FreeValue(ctx, s->on_message);
    s->on_message = (argc > 0 && JS_IsFunction(ctx, argv[0])) ? JS_DupValue(ctx, argv[0])
                                                              : JS_UNDEFINED;
    return JS_UNDEFINED;
}

/* port / family are written as values at bind time (see install_methods),
 * not as live getters — they don't change after bind. dropped IS a live
 * getter/setter because the loop consumer increments it. */

static JSValue mik__udp_get_dropped(JSContext* ctx, JSValue this_val) {
    UdpSocketState* s = mik__socket_get(ctx, this_val);
    if (!s) return JS_NewInt32(ctx, 0);
    return JS_NewUint32(ctx, s->dropped);
}

static JSValue mik__udp_set_dropped(JSContext* ctx, JSValue this_val, JSValue val) {
    UdpSocketState* s = mik__socket_get(ctx, this_val);
    if (!s) return JS_UNDEFINED;
    uint32_t v;
    if (JS_ToUint32(ctx, &v, val) == 0) s->dropped = v;
    return JS_UNDEFINED;
}

/* ── Class definition ────────────────────────────────────────────────*/

static void mik__udp_finalizer(JSRuntime* rt, JSValue val) {
    UdpSocketState* s = (UdpSocketState*)JS_GetOpaque(val, udp_socket_class_id);
    if (!s) return;

    if (!s->closed && s->fd >= 0) {
        close(s->fd);
        s->fd = -1;
    }
    JS_FreeValueRT(rt, s->on_message);
    s->on_message = JS_UNDEFINED;
    s->closed = true;

    if (g_iteration_depth > 0) {
        /* Inside consume: defer erase + delete to the post-iteration sweep
         * so we don't shift indices or free `s` while it's being walked. */
        s->dead = true;
        return;
    }

    for (auto it = g_open_sockets.begin(); it != g_open_sockets.end(); ++it) {
        if (*it == s) {
            g_open_sockets.erase(it);
            break;
        }
    }
    delete s;
}

/* Cycle-collector hook: expose the held onMessage closure so QuickJS can
 * traverse through the opaque socket. Without this, a closure that captures
 * the socket (e.g. via globalThis) creates a cycle the GC can't break. */
static void mik__udp_gc_mark(JSRuntime* rt, JSValue val, JS_MarkFunc* mark_func) {
    UdpSocketState* s = (UdpSocketState*)JS_GetOpaque(val, udp_socket_class_id);
    if (!s) return;
    JS_MarkValue(rt, s->on_message, mark_func);
}

static JSClassDef mik__udp_socket_class = {
    .class_name = "UdpSocket",
    .finalizer = mik__udp_finalizer,
    .gc_mark = mik__udp_gc_mark,
};

/* Methods are installed directly on each socket object (not via proto) —
 * ESP-IDF's 32-bit QuickJS NaN-boxed build did not reliably resolve
 * proto-installed accessors on JS_NewObjectClass instances, even though
 * JS_GetOpaque2 and the class registration both worked. Putting methods
 * directly on the object sidesteps the class-proto resolution path. */
static void mik__udp_install_methods(JSContext* ctx, JSValue obj, UdpSocketState* s) {
    JS_DefinePropertyValueStr(ctx, obj, "send",
                              JS_NewCFunction(ctx, mik__udp_send, "send", 2),
                              JS_PROP_C_W_E);
    JS_DefinePropertyValueStr(ctx, obj, "joinMulticastGroup",
                              JS_NewCFunction(ctx, mik__udp_join_group, "joinMulticastGroup", 1),
                              JS_PROP_C_W_E);
    JS_DefinePropertyValueStr(ctx, obj, "leaveMulticastGroup",
                              JS_NewCFunction(ctx, mik__udp_leave_group, "leaveMulticastGroup", 1),
                              JS_PROP_C_W_E);
    JS_DefinePropertyValueStr(ctx, obj, "close",
                              JS_NewCFunction(ctx, mik__udp_close, "close", 0),
                              JS_PROP_C_W_E);
    JS_DefinePropertyValueStr(ctx, obj, "setOnMessage",
                              JS_NewCFunction(ctx, mik__udp_set_on_message, "setOnMessage", 1),
                              JS_PROP_C_W_E);
    /* port / family are stable for the socket's lifetime — set as values */
    JS_DefinePropertyValueStr(ctx, obj, "port", JS_NewInt32(ctx, s->port), JS_PROP_C_W_E);
    if (s->dual) {
        JS_DefinePropertyValueStr(ctx, obj, "family", JS_NewString(ctx, "dual"), JS_PROP_C_W_E);
    } else {
        JS_DefinePropertyValueStr(
            ctx, obj, "family",
            JS_NewString(ctx, s->family == AF_INET ? "ipv4" : "ipv6"), JS_PROP_C_W_E);
    }
    /* dropped is a live getter/setter onto s->dropped; install via the
     * function-list helper so the type-erased function casts go through
     * the same path the rest of the codebase uses. */
    static const JSCFunctionListEntry dropped_entry[] = {
        MIK_CGETSET_DEF("dropped", mik__udp_get_dropped, mik__udp_set_dropped),
    };
    JS_SetPropertyFunctionList(ctx, obj, dropped_entry, 1);
}

/* ── bind() factory ──────────────────────────────────────────────────*/

static JSValue mik__udp_bind(JSContext* ctx, JSValue this_val, int argc, JSValue* argv) {
    if (argc < 1 || !JS_IsObject(argv[0])) {
        return JS_ThrowTypeError(ctx, "bind: expected options object");
    }

    JSValue opts = argv[0];

    /* port: number (required) */
    JSValue port_val = JS_GetPropertyStr(ctx, opts, "port");
    int32_t port = 0;
    if (JS_ToInt32(ctx, &port, port_val)) {
        JS_FreeValue(ctx, port_val);
        return JS_ThrowTypeError(ctx, "bind: port must be a number");
    }
    JS_FreeValue(ctx, port_val);

    /* family: 'ipv4' | 'ipv6' (optional, default dual) */
    JSValue family_val = JS_GetPropertyStr(ctx, opts, "family");
    int family = AF_INET6;
    bool dual = true;
    if (JS_IsString(family_val)) {
        const char* fs = JS_ToCString(ctx, family_val);
        if (fs && strcmp(fs, "ipv4") == 0) {
            family = AF_INET;
            dual = false;
        } else if (fs && strcmp(fs, "ipv6") == 0) {
            family = AF_INET6;
            dual = false;
        }
        if (fs) JS_FreeCString(ctx, fs);
    }
    JS_FreeValue(ctx, family_val);

    /* address: string (optional) */
    JSValue address_val = JS_GetPropertyStr(ctx, opts, "address");
    const char* address = nullptr;
    if (JS_IsString(address_val)) {
        address = JS_ToCString(ctx, address_val);
    }

    /* recvQueue: number (optional, default 8) */
    JSValue rq_val = JS_GetPropertyStr(ctx, opts, "recvQueue");
    int32_t recv_queue = 8;
    if (JS_IsNumber(rq_val)) {
        JS_ToInt32(ctx, &recv_queue, rq_val);
    }
    JS_FreeValue(ctx, rq_val);
    if (recv_queue < 1) recv_queue = 1;

    /* Create socket */
    int fd = socket(family, SOCK_DGRAM, 0);
    if (fd < 0) {
        if (address) JS_FreeCString(ctx, address);
        JS_FreeValue(ctx, address_val);
        JSValue err = mik__udp_err(ctx, "BindFailed", "socket: %s", strerror(errno));
        return MIK_NewResolvedPromise(ctx, 1, &err);
    }

    /* Set non-blocking */
    int flags = fcntl(fd, F_GETFL, 0);
    fcntl(fd, F_SETFL, flags | O_NONBLOCK);

    /* Configure dual-stack on v6 */
    if (family == AF_INET6) {
        int v6only = dual ? 0 : 1;
        setsockopt(fd, IPPROTO_IPV6, IPV6_V6ONLY, &v6only, sizeof(v6only));
    }

    /* Bind. Route through mik__parse_addr so the same scope-id handling
     * (`fe80::1%2`) used on send applies on bind too. */
    struct sockaddr_storage local;
    socklen_t local_len;
    memset(&local, 0, sizeof(local));
    if (family == AF_INET) {
        struct sockaddr_in* sin = (struct sockaddr_in*)&local;
        sin->sin_family = AF_INET;
        sin->sin_port = htons((uint16_t)port);
        if (address) {
            if (mik__parse_addr(address, port, AF_INET, &local, &local_len) != 0) {
                close(fd);
                JS_FreeCString(ctx, address);
                JS_FreeValue(ctx, address_val);
                JSValue err = mik__udp_err(ctx, "BindFailed", "invalid address");
                return MIK_NewResolvedPromise(ctx, 1, &err);
            }
        } else {
            sin->sin_addr.s_addr = htonl(INADDR_ANY);
            local_len = sizeof(*sin);
        }
    } else {
        struct sockaddr_in6* sin6 = (struct sockaddr_in6*)&local;
        sin6->sin6_family = AF_INET6;
        sin6->sin6_port = htons((uint16_t)port);
        if (address) {
            if (mik__parse_addr(address, port, AF_INET6, &local, &local_len) != 0) {
                close(fd);
                JS_FreeCString(ctx, address);
                JS_FreeValue(ctx, address_val);
                JSValue err = mik__udp_err(ctx, "BindFailed", "invalid address");
                return MIK_NewResolvedPromise(ctx, 1, &err);
            }
        } else {
            /* in6addr_any */
            local_len = sizeof(*sin6);
        }
    }

    if (address) JS_FreeCString(ctx, address);
    JS_FreeValue(ctx, address_val);

    if (bind(fd, (struct sockaddr*)&local, local_len) < 0) {
        const char* err_name = (errno == EADDRINUSE) ? "AddressInUse" : "BindFailed";
        int saved_errno = errno;
        close(fd);
        JSValue err = mik__udp_err(ctx, err_name, "bind: %s", strerror(saved_errno));
        return MIK_NewResolvedPromise(ctx, 1, &err);
    }

    /* Read back actual port (handles port 0 / ephemeral) */
    struct sockaddr_storage actual;
    socklen_t actual_len = sizeof(actual);
    int actual_port = port;
    if (getsockname(fd, (struct sockaddr*)&actual, &actual_len) == 0) {
        if (actual.ss_family == AF_INET) {
            actual_port = ntohs(((struct sockaddr_in*)&actual)->sin_port);
        } else if (actual.ss_family == AF_INET6) {
            actual_port = ntohs(((struct sockaddr_in6*)&actual)->sin6_port);
        }
    }

    /* Build state + JS object */
    UdpSocketState* s = new UdpSocketState();
    s->ctx = ctx;
    s->fd = fd;
    s->family = family;
    s->dual = dual;
    s->port = actual_port;
    s->on_message = JS_UNDEFINED;
    s->dropped = 0;
    s->recv_queue = recv_queue;
    s->closed = false;
    s->dead = false;

    JSValue obj = JS_NewObjectClass(ctx, udp_socket_class_id);
    if (JS_IsException(obj)) {
        close(fd);
        delete s;
        return obj;
    }
    JS_SetOpaque(obj, s);

    /* Install methods and properties directly on the object */
    mik__udp_install_methods(ctx, obj, s);

    /* Register loop consumer once per runtime; first bind triggers it. */
    MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
    if (mik_rt) {
        bool already = false;
        for (auto* rt : g_consumer_registered_runtimes) {
            if (rt == mik_rt) {
                already = true;
                break;
            }
        }
        if (!already) {
            g_consumer_registered_runtimes.push_back(mik_rt);
            MIK_RegisterLoopConsumer(mik_rt, mik__udp_consume, mik__udp_destroy);
        }
    }

    g_open_sockets.push_back(s);

    JSValue ok = mik__result_ok(ctx, obj);
    return MIK_NewResolvedPromise(ctx, 1, &ok);
}

/* ── Loop consumer ───────────────────────────────────────────────────*/

static void mik__udp_consume(JSContext* ctx) {
    g_iteration_depth++;

    /* Walk by current size each iteration: callbacks may bind new sockets
     * (push_back at the end — drained next tick) and finalize others
     * (marked dead, swept after the loop). Indexed access stays valid
     * because nothing is erased while g_iteration_depth > 0. */
    for (size_t i = 0; i < g_open_sockets.size(); i++) {
        UdpSocketState* s = g_open_sockets[i];
        if (!s || s->dead) continue;
        if (s->ctx != ctx) continue;
        if (s->closed) continue;

        for (int drained = 0; drained < s->recv_queue; drained++) {
            /* 1500 bytes covers the unfragmented Ethernet MTU, which is
             * the realistic ceiling for the listed targets (CoAP, mDNS,
             * SNTP, DNS). MSG_TRUNC reports the original length so larger
             * datagrams are observable as drops rather than silent
             * truncation. */
            uint8_t buf[1500];
            struct sockaddr_storage src;
            socklen_t src_len = sizeof(src);
            ssize_t r = recvfrom(s->fd, buf, sizeof(buf), MSG_TRUNC,
                                 (struct sockaddr*)&src, &src_len);
            if (r < 0) {
                /* EAGAIN/EWOULDBLOCK — buffer empty, move on */
                break;
            }
            if ((size_t)r > sizeof(buf)) {
                /* Datagram larger than our recv buffer; drop it rather
                 * than deliver a truncated payload. */
                s->dropped++;
                continue;
            }

            if (!JS_IsFunction(ctx, s->on_message)) {
                s->dropped++;
                continue;
            }

            char addr_str[80];
            int port;
            const char* family = mik__format_addr(&src, addr_str, sizeof(addr_str), &port);

            /* Allocate fresh Uint8Array per packet (no buffer reuse) */
            uint8_t* data = (uint8_t*)js_malloc(ctx, (size_t)r);
            if (!data) {
                s->dropped++;
                continue;
            }
            memcpy(data, buf, (size_t)r);

            JSValue msg = MIK_NewUint8Array(ctx, data, (size_t)r);
            JSValue peer = mik__make_peer(ctx, addr_str, port, family);

            JSValue args[2] = {msg, peer};
            JSValue ret = JS_Call(ctx, s->on_message, JS_UNDEFINED, 2, args);
            JS_FreeValue(ctx, msg);
            JS_FreeValue(ctx, peer);
            if (JS_IsException(ret)) {
                /* Clear the pending exception so it doesn't leak into the
                 * next callback / native call, and surface it via the
                 * runtime's error path. One bad callback shouldn't tear
                 * the loop down. */
                mik_dump_error(ctx);
            }
            JS_FreeValue(ctx, ret);

            /* The callback may have closed or finalized this socket. */
            if (s->dead || s->closed || s->fd < 0) break;
        }
    }

    g_iteration_depth--;

    /* Sweep entries marked dead during this (outermost) iteration. */
    if (g_iteration_depth == 0) {
        for (auto it = g_open_sockets.begin(); it != g_open_sockets.end();) {
            if ((*it)->dead) {
                delete *it;
                it = g_open_sockets.erase(it);
            } else {
                ++it;
            }
        }
    }
}

static void mik__udp_destroy(JSContext* ctx) {
    MIKRuntime* mik_rt = MIK_GetRuntime(ctx);
    if (mik_rt) {
        for (auto it = g_consumer_registered_runtimes.begin();
             it != g_consumer_registered_runtimes.end(); ++it) {
            if (*it == mik_rt) {
                g_consumer_registered_runtimes.erase(it);
                break;
            }
        }
    }

    /* Close OS fds for sockets belonging to this runtime. The JS objects
     * are about to be freed by GC, which calls mik__udp_finalizer for each;
     * the finalizer also closes if not already closed, so this is just to
     * release fds promptly during shutdown. */
    for (auto* s : g_open_sockets) {
        if (s->ctx != ctx) continue;
        if (!s->closed && s->fd >= 0) {
            close(s->fd);
            s->fd = -1;
            s->closed = true;
        }
    }
}

/* ── Module init ─────────────────────────────────────────────────────*/

static int mik__udp_module_init(JSContext* ctx, JSModuleDef* m) {
    JS_SetModuleExport(ctx, m, "bind", JS_NewCFunction(ctx, mik__udp_bind, "bind", 1));
    return 0;
}

JSModuleDef* mik__udp_init(JSContext* ctx) {
    JSRuntime* rt = JS_GetRuntime(ctx);

    /* The class only carries the opaque pointer, finalizer, and gc_mark.
     * Methods/properties go directly on each socket object (see
     * mik__udp_install_methods). No class prototype is set. */
    JS_NewClassID(rt, &udp_socket_class_id);
    JS_NewClass(rt, udp_socket_class_id, &mik__udp_socket_class);

    JSModuleDef* m = JS_NewCModule(ctx, "native:udp", mik__udp_module_init);
    if (!m) return nullptr;
    JS_AddModuleExport(ctx, m, "bind");
    return m;
}
