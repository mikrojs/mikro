/* native:mikro/schema — the device half of the schema DSL.
 *
 * A faithful port of @mikrojs/schema, which stays as the host
 * implementation (the CLI evaluating mikro.config.ts, the registry, vitest).
 * Two implementations of one contract, so they are checked against a generated
 * corpus rather than two independent suites: scripts/gen-schema-fixtures.js
 * records what core.ts does and test/schema_conformance_test.cpp replays it
 * here. Change behaviour in core.ts first, then here, and let the corpus say
 * whether they still agree.
 *
 * validate() covers shape and every numeric and length bound. `format` and
 * `unit` stay host-side in @mikrojs/schema/config: format needs expressions there is
 * no engine for here, and unit is a display hint that constrains nothing.
 *
 * parse() is not here: it wraps validate() in a Result and lives in the JS
 * facade, which keeps this module free of any Result coupling. */

#include <cmath>
#include <cstdio>
#include <cstring>
#include <string>

#include <quickjs.h>

#include "mikrojs/mikrojs.h"
#include "mikrojs/utils.h"

namespace {

/* ── Node kinds ─────────────────────────────────────────────────────── */

enum class Kind {
    String,
    Number,
    Boolean,
    Unknown,
    Literal,
    Array,
    Object,
    Optional,
    Tuple,
    Union,
    TaggedUnion,
    Invalid,
};

Kind ParseKind(const char* k) {
    if (!k) return Kind::Invalid;
    if (!strcmp(k, "string")) return Kind::String;
    if (!strcmp(k, "number")) return Kind::Number;
    if (!strcmp(k, "boolean")) return Kind::Boolean;
    if (!strcmp(k, "unknown")) return Kind::Unknown;
    if (!strcmp(k, "literal")) return Kind::Literal;
    if (!strcmp(k, "array")) return Kind::Array;
    if (!strcmp(k, "object")) return Kind::Object;
    if (!strcmp(k, "optional")) return Kind::Optional;
    if (!strcmp(k, "tuple")) return Kind::Tuple;
    if (!strcmp(k, "union")) return Kind::Union;
    if (!strcmp(k, "taggedUnion")) return Kind::TaggedUnion;
    return Kind::Invalid;
}

/* Reads `kind` and keeps the raw text, which the fallthrough error reports. */
struct NodeKind {
    Kind kind = Kind::Invalid;
    std::string raw;
};

NodeKind KindOf(JSContext* ctx, JSValueConst schema) {
    NodeKind out;
    JSValue kv = JS_GetPropertyStr(ctx, schema, "kind");
    const char* text = JS_ToCString(ctx, kv);
    if (text) {
        out.raw = text;
        out.kind = ParseKind(text);
        JS_FreeCString(ctx, text);
    }
    JS_FreeValue(ctx, kv);
    return out;
}

/* ── Own-property access ────────────────────────────────────────────── */

/* Object.hasOwn. JS_GetPropertyStr walks the prototype chain, which would let
 * an inherited member stand in for a required field or a union branch — a
 * value of {} would satisfy object({constructor: unknown()}), and a tag of
 * "constructor" would dispatch to Object.prototype.constructor. core.ts guards
 * the same three sites for the same reason. */
bool HasOwn(JSContext* ctx, JSValueConst obj, JSAtom key) {
    JSPropertyDescriptor desc;
    int found = JS_GetOwnProperty(ctx, &desc, obj, key);
    if (found != 1) return false;
    JS_FreeValue(ctx, desc.value);
    JS_FreeValue(ctx, desc.getter);
    JS_FreeValue(ctx, desc.setter);
    return true;
}

/* Own enumerable string keys, in insertion order — Object.keys(). */
struct OwnKeys {
    JSPropertyEnum* tab = nullptr;
    uint32_t len = 0;
    JSContext* ctx = nullptr;

    OwnKeys(JSContext* c, JSValueConst obj) : ctx(c) {
        if (JS_GetOwnPropertyNames(c, &tab, &len, obj, JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY) !=
            0) {
            tab = nullptr;
            len = 0;
        }
    }
    ~OwnKeys() {
        if (tab) JS_FreePropertyEnum(ctx, tab, len);
    }
    OwnKeys(const OwnKeys&) = delete;
    OwnKeys& operator=(const OwnKeys&) = delete;
};

/* ── typeOf() ───────────────────────────────────────────────────────── */

const char* TypeOf(JSContext* ctx, JSValueConst value) {
    if (JS_IsNull(value)) return "null";
    if (JS_IsArray(value)) return "array";
    if (JS_IsUndefined(value)) return "undefined";
    if (JS_IsBool(value)) return "boolean";
    if (JS_IsNumber(value)) return "number";
    if (JS_IsString(value)) return "string";
    if (JS_IsSymbol(value)) return "symbol";
    if (JS_IsBigInt(value)) return "bigint";
    if (JS_IsFunction(ctx, value)) return "function";
    return "object";
}

/* JSON.stringify, as the literal messages use it. Undefined and functions
 * stringify to nothing, which a template literal renders as "undefined". */
std::string JsonText(JSContext* ctx, JSValueConst value) {
    JSValue json = JS_JSONStringify(ctx, value, JS_UNDEFINED, JS_UNDEFINED);
    if (JS_IsException(json)) {
        JS_FreeValue(ctx, JS_GetException(ctx));
        return "undefined";
    }
    const char* text = JS_ToCString(ctx, json);
    std::string out = text ? text : "undefined";
    if (text) JS_FreeCString(ctx, text);
    JS_FreeValue(ctx, json);
    return out;
}

/* ── Validation ─────────────────────────────────────────────────────── */

/* An absent or non-numeric annotation means unconstrained, matching the
 * `!== undefined` guards in core.ts. */
bool NumberAnnotation(JSContext* ctx, JSValueConst schema, const char* key, double* out) {
    JSValue v = JS_GetPropertyStr(ctx, schema, key);
    bool present = JS_IsNumber(v) && JS_ToFloat64(ctx, out, v) == 0;
    JS_FreeValue(ctx, v);
    return present;
}

bool IsTrue(JSContext* ctx, JSValueConst schema, const char* key) {
    JSValue v = JS_GetPropertyStr(ctx, schema, key);
    bool yes = JS_IsBool(v) && JS_ToBool(ctx, v) == 1;
    JS_FreeValue(ctx, v);
    return yes;
}

/* A number the way JS renders it in a template literal. Deferred to the engine
 * rather than reimplemented: ECMAScript's Number::toString is shortest-
 * round-trip with its own exponent thresholds, and %g gets 10 wrong (1e+01). */
std::string NumText(JSContext* ctx, double v) {
    JSValue num = JS_NewFloat64(ctx, v);
    const char* text = JS_ToCString(ctx, num);
    std::string out = text ? text : "";
    if (text) JS_FreeCString(ctx, text);
    JS_FreeValue(ctx, num);
    return out;
}

/* `bound` separates "the wrong shape" from "the right shape, out of range",
 * which only the union case needs: it reports a member's bound rather than the
 * generic no-member-matched line, because "above the maximum of 100" is what
 * an operator can act on. */
struct Failure {
    std::string message;
    std::string path;
    bool bound = false;
};

bool FailAs(Failure* out, bool is_bound, const std::string& path, const char* fmt, va_list args) {
    char buf[256];
    vsnprintf(buf, sizeof(buf), fmt, args);
    out->message = buf;
    out->path = path;
    out->bound = is_bound;
    return false;
}

bool Fail(Failure* out, const std::string& path, const char* fmt, ...) {
    va_list args;
    va_start(args, fmt);
    bool r = FailAs(out, false, path, fmt, args);
    va_end(args);
    return r;
}

bool FailBound(Failure* out, const std::string& path, const char* fmt, ...) {
    va_list args;
    va_start(args, fmt);
    bool r = FailAs(out, true, path, fmt, args);
    va_end(args);
    return r;
}

bool ValidateNode(JSContext* ctx, JSValueConst schema, JSValueConst value, const std::string& path,
                  Failure* fail);

/* Every field of an object node, in shape order. Optional fields may be
 * absent; a required field that is absent is the error, not a bad value. */
bool ValidateObjectFields(JSContext* ctx, JSValueConst schema, JSValueConst value,
                          const std::string& path, Failure* fail) {
    JSValue shape = JS_GetPropertyStr(ctx, schema, "shape");
    OwnKeys keys(ctx, shape);
    bool ok = true;
    for (uint32_t i = 0; ok && i < keys.len; i++) {
        JSAtom key = keys.tab[i].atom;
        const char* key_text = JS_AtomToCString(ctx, key);
        std::string field_path = path + "." + (key_text ? key_text : "");
        if (key_text) JS_FreeCString(ctx, key_text);

        JSValue field = JS_GetProperty(ctx, shape, key);
        NodeKind fk = KindOf(ctx, field);
        bool present = HasOwn(ctx, value, key);

        if (fk.kind == Kind::Optional) {
            if (present) {
                JSValue held = JS_GetProperty(ctx, value, key);
                ok = ValidateNode(ctx, field, held, field_path, fail);
                JS_FreeValue(ctx, held);
            }
        } else if (!present) {
            ok = Fail(fail, field_path, "missing required field");
        } else {
            JSValue held = JS_GetProperty(ctx, value, key);
            ok = ValidateNode(ctx, field, held, field_path, fail);
            JS_FreeValue(ctx, held);
        }
        JS_FreeValue(ctx, field);
    }
    JS_FreeValue(ctx, shape);
    return ok;
}

bool ValidateTaggedUnion(JSContext* ctx, JSValueConst schema, JSValueConst value,
                         const std::string& path, Failure* fail) {
    if (!JS_IsObject(value) || JS_IsNull(value) || JS_IsArray(value)) {
        return Fail(fail, path, "expected object, got %s", TypeOf(ctx, value));
    }
    JSValue key_val = JS_GetPropertyStr(ctx, schema, "key");
    const char* key_text = JS_ToCString(ctx, key_val);
    std::string key_name = key_text ? key_text : "";
    if (key_text) JS_FreeCString(ctx, key_text);
    JS_FreeValue(ctx, key_val);

    std::string tag_path = path + "." + key_name;
    /* Plain read, matching core.ts: an inherited member here is not a hole,
     * it fails the primitive check below. */
    JSValue tag = JS_GetPropertyStr(ctx, value, key_name.c_str());
    if (JS_IsUndefined(tag)) {
        JS_FreeValue(ctx, tag);
        return Fail(fail, tag_path, "missing discriminator field");
    }
    if (!JS_IsString(tag) && !JS_IsNumber(tag) && !JS_IsBool(tag)) {
        std::string got = TypeOf(ctx, tag);
        JS_FreeValue(ctx, tag);
        return Fail(fail, tag_path, "expected primitive discriminator, got %s", got.c_str());
    }

    JSValue branches = JS_GetPropertyStr(ctx, schema, "branches");
    JSAtom tag_atom = JS_ValueToAtom(ctx, tag);
    bool known = tag_atom != JS_ATOM_NULL && HasOwn(ctx, branches, tag_atom);
    bool ok;
    if (!known) {
        std::string text = JsonText(ctx, tag);
        ok = Fail(fail, tag_path, "unknown tag %s", text.c_str());
    } else {
        JSValue branch = JS_GetProperty(ctx, branches, tag_atom);
        ok = ValidateNode(ctx, branch, value, path, fail);
        JS_FreeValue(ctx, branch);
    }
    if (tag_atom != JS_ATOM_NULL) JS_FreeAtom(ctx, tag_atom);
    JS_FreeValue(ctx, branches);
    JS_FreeValue(ctx, tag);
    return ok;
}

bool ValidateNode(JSContext* ctx, JSValueConst schema, JSValueConst value, const std::string& path,
                  Failure* fail) {
    NodeKind nk = KindOf(ctx, schema);
    switch (nk.kind) {
        case Kind::String: {
            if (!JS_IsString(value)) {
                return Fail(fail, path, "expected string, got %s", TypeOf(ctx, value));
            }
            double bound = 0;
            /* .length, not a byte count: JS measures strings in UTF-16 code
             * units and core.ts compares against that. */
            int64_t chars = 0;
            JS_GetLength(ctx, value, &chars);
            if (NumberAnnotation(ctx, schema, "minLength", &bound) && (double)chars < bound) {
                return FailBound(fail, path, "shorter than %s characters", NumText(ctx, bound).c_str());
            }
            if (NumberAnnotation(ctx, schema, "maxLength", &bound) && (double)chars > bound) {
                return FailBound(fail, path, "longer than %s characters", NumText(ctx, bound).c_str());
            }
            return true;
        }

        case Kind::Number: {
            /* NaN is rejected, and reports as a number: core.ts builds the
             * message from typeOf(), which does not special-case it. */
            double d = 0;
            if (!JS_IsNumber(value) || JS_ToFloat64(ctx, &d, value) != 0 || std::isnan(d)) {
                return Fail(fail, path, "expected number, got %s", TypeOf(ctx, value));
            }
            double bound = 0;
            if (IsTrue(ctx, schema, "integer") && (!std::isfinite(d) || d != std::trunc(d))) {
                return FailBound(fail, path, "expected a whole number, got %s", NumText(ctx, d).c_str());
            }
            if (NumberAnnotation(ctx, schema, "min", &bound) && d < bound) {
                return FailBound(fail, path, "below the minimum of %s", NumText(ctx, bound).c_str());
            }
            if (NumberAnnotation(ctx, schema, "max", &bound) && d > bound) {
                return FailBound(fail, path, "above the maximum of %s", NumText(ctx, bound).c_str());
            }
            return true;
        }

        case Kind::Boolean:
            if (!JS_IsBool(value)) {
                return Fail(fail, path, "expected boolean, got %s", TypeOf(ctx, value));
            }
            return true;

        case Kind::Unknown:
            return true;

        case Kind::Literal: {
            JSValue expected = JS_GetPropertyStr(ctx, schema, "value");
            bool same = JS_IsStrictEqual(ctx, value, expected);
            bool ok = true;
            if (!same) {
                std::string want = JsonText(ctx, expected);
                std::string got = JsonText(ctx, value);
                ok = Fail(fail, path, "expected %s, got %s", want.c_str(), got.c_str());
            }
            JS_FreeValue(ctx, expected);
            return ok;
        }

        case Kind::Array: {
            if (!JS_IsArray(value)) {
                return Fail(fail, path, "expected array, got %s", TypeOf(ctx, value));
            }
            int64_t len = 0;
            JS_GetLength(ctx, value, &len);
            double bound = 0;
            if (NumberAnnotation(ctx, schema, "minItems", &bound) && (double)len < bound) {
                return FailBound(fail, path, "fewer than %s items", NumText(ctx, bound).c_str());
            }
            if (NumberAnnotation(ctx, schema, "maxItems", &bound) && (double)len > bound) {
                return FailBound(fail, path, "more than %s items", NumText(ctx, bound).c_str());
            }
            JSValue element = JS_GetPropertyStr(ctx, schema, "element");
            bool ok = true;
            for (int64_t i = 0; ok && i < len; i++) {
                JSValue item = JS_GetPropertyInt64(ctx, value, i);
                ok = ValidateNode(ctx, element, item, path + "[" + std::to_string(i) + "]", fail);
                JS_FreeValue(ctx, item);
            }
            JS_FreeValue(ctx, element);
            return ok;
        }

        case Kind::Object:
            if (!JS_IsObject(value) || JS_IsNull(value) || JS_IsArray(value)) {
                return Fail(fail, path, "expected object, got %s", TypeOf(ctx, value));
            }
            return ValidateObjectFields(ctx, schema, value, path, fail);

        case Kind::Tuple: {
            if (!JS_IsArray(value)) {
                return Fail(fail, path, "expected array, got %s", TypeOf(ctx, value));
            }
            JSValue elements = JS_GetPropertyStr(ctx, schema, "elements");
            int64_t want = 0;
            int64_t got = 0;
            JS_GetLength(ctx, elements, &want);
            JS_GetLength(ctx, value, &got);
            if (want != got) {
                JS_FreeValue(ctx, elements);
                return Fail(fail, path, "expected %lld elements, got %lld", (long long)want,
                            (long long)got);
            }
            bool ok = true;
            for (int64_t i = 0; ok && i < want; i++) {
                JSValue node = JS_GetPropertyInt64(ctx, elements, i);
                JSValue item = JS_GetPropertyInt64(ctx, value, i);
                ok = ValidateNode(ctx, node, item, path + "[" + std::to_string(i) + "]", fail);
                JS_FreeValue(ctx, item);
                JS_FreeValue(ctx, node);
            }
            JS_FreeValue(ctx, elements);
            return ok;
        }

        case Kind::Optional: {
            if (JS_IsUndefined(value)) return true;
            JSValue inner = JS_GetPropertyStr(ctx, schema, "inner");
            bool ok = ValidateNode(ctx, inner, value, path, fail);
            JS_FreeValue(ctx, inner);
            return ok;
        }

        case Kind::Union: {
            JSValue members = JS_GetPropertyStr(ctx, schema, "members");
            int64_t len = 0;
            JS_GetLength(ctx, members, &len);
            /* A union accepts what ANY member accepts, bounds included: in
             * union([number({max: 10}), number({min: 100})]), 150 matches the
             * first member's shape, breaks its bound, and the second member
             * exists for exactly that value. When nothing passes, a member
             * that only broke a bound gives the better message; a member of
             * the wrong shape says nothing useful about a mixed union. */
            bool matched = false;
            bool have_range = false;
            Failure out_of_range;
            for (int64_t i = 0; !matched && i < len; i++) {
                JSValue member = JS_GetPropertyInt64(ctx, members, i);
                Failure member_fail;
                matched = ValidateNode(ctx, member, value, path, &member_fail);
                if (!matched && member_fail.bound && !have_range) {
                    out_of_range = member_fail;
                    have_range = true;
                }
                JS_FreeValue(ctx, member);
            }
            JS_FreeValue(ctx, members);
            if (matched) return true;
            if (have_range) {
                *fail = out_of_range;
                return false;
            }
            return Fail(fail, path, "value did not match any union member");
        }

        case Kind::TaggedUnion:
            return ValidateTaggedUnion(ctx, schema, value, path, fail);

        case Kind::Invalid:
            break;
    }
    return Fail(fail, path, "unknown schema kind: %s", nk.raw.c_str());
}

JSValue ValidationError(JSContext* ctx, const Failure& fail) {
    JSValue error = JS_NewObject(ctx);
    JS_DefinePropertyValueStr(ctx, error, "name", JS_NewString(ctx, "ValidationFailed"),
                              JS_PROP_C_W_E);
    JS_DefinePropertyValueStr(ctx, error, "message", JS_NewString(ctx, fail.message.c_str()),
                              JS_PROP_C_W_E);
    JS_DefinePropertyValueStr(ctx, error, "path", JS_NewString(ctx, fail.path.c_str()),
                              JS_PROP_C_W_E);
    /* The plain {ok, error} shape core.ts's local err() builds, not a
     * mikro/result Result: parse() in the JS facade wraps this. */
    JSValue out = JS_NewObject(ctx);
    JS_DefinePropertyValueStr(ctx, out, "ok", JS_FALSE, JS_PROP_C_W_E);
    JS_DefinePropertyValueStr(ctx, out, "error", error, JS_PROP_C_W_E);
    return out;
}

JSValue js_validate(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    JSValueConst schema = argc > 0 ? argv[0] : JS_UNDEFINED;
    JSValueConst value = argc > 1 ? argv[1] : JS_UNDEFINED;
    std::string path;
    if (argc > 2 && JS_IsString(argv[2])) {
        const char* text = JS_ToCString(ctx, argv[2]);
        if (text) {
            path = text;
            JS_FreeCString(ctx, text);
        }
    }
    Failure fail;
    bool ok = ValidateNode(ctx, schema, value, path, &fail);
    /* A malformed schema (a Symbol kind, a missing shape) can leave an
     * exception pending mid-walk; surface it here rather than at whatever
     * unrelated call runs next. */
    if (JS_HasException(ctx)) return JS_EXCEPTION;
    if (ok) return JS_NULL;
    return ValidationError(ctx, fail);
}

/* ── applyDefaults ──────────────────────────────────────────────────── */

JSValue ApplyDefaults(JSContext* ctx, JSValueConst schema, JSValueConst value) {
    NodeKind nk = KindOf(ctx, schema);
    switch (nk.kind) {
        case Kind::Object: {
            /* A present non-object stays as-is so validation rejects it. */
            if (!JS_IsUndefined(value) &&
                (!JS_IsObject(value) || JS_IsNull(value) || JS_IsArray(value))) {
                return JS_DupValue(ctx, value);
            }
            JSValue shape = JS_GetPropertyStr(ctx, schema, "shape");
            JSValue out = JS_NewObject(ctx);
            OwnKeys keys(ctx, shape);
            for (uint32_t i = 0; i < keys.len; i++) {
                JSAtom key = keys.tab[i].atom;
                JSValue field = JS_GetProperty(ctx, shape, key);
                bool present = !JS_IsUndefined(value) && HasOwn(ctx, value, key);
                JSValue raw = present ? JS_GetProperty(ctx, value, key) : JS_UNDEFINED;

                NodeKind fk = KindOf(ctx, field);
                if (fk.kind == Kind::Optional) {
                    if (!JS_IsUndefined(raw)) {
                        JS_DefinePropertyValue(ctx, out, key, JS_DupValue(ctx, raw),
                                               JS_PROP_C_W_E);
                    }
                } else {
                    JSValue child = ApplyDefaults(ctx, field, raw);
                    if (!JS_IsUndefined(child)) {
                        JS_DefinePropertyValue(ctx, out, key, child, JS_PROP_C_W_E);
                    } else {
                        JS_FreeValue(ctx, child);
                    }
                }
                JS_FreeValue(ctx, raw);
                JS_FreeValue(ctx, field);
            }
            JS_FreeValue(ctx, shape);
            return out;
        }

        case Kind::Array: {
            if (!JS_IsUndefined(value)) return JS_DupValue(ctx, value);
            JSValue fallback = JS_GetPropertyStr(ctx, schema, "default");
            if (!JS_IsUndefined(fallback)) return fallback;
            JS_FreeValue(ctx, fallback);
            return JS_NewArray(ctx);
        }

        case Kind::Unknown:
        case Kind::Optional:
            return JS_DupValue(ctx, value);

        default: {
            if (!JS_IsUndefined(value)) return JS_DupValue(ctx, value);
            return JS_GetPropertyStr(ctx, schema, "default");
        }
    }
}

JSValue js_apply_defaults(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    JSValueConst schema = argc > 0 ? argv[0] : JS_UNDEFINED;
    JSValueConst value = argc > 1 ? argv[1] : JS_UNDEFINED;
    JSValue out = ApplyDefaults(ctx, schema, value);
    if (JS_HasException(ctx)) {
        JS_FreeValue(ctx, out);
        return JS_EXCEPTION;
    }
    return out;
}

/* ── Constructors ───────────────────────────────────────────────────── */

/* Every annotation any constructor accepts, in the order core.ts copies them,
 * so a schema serializes to the same JSON from either implementation. */
const char* const kAnnotationKeys[] = {"title",  "description", "mask",     "minLength",
                                       "maxLength", "min",      "max",      "integer",
                                       "minItems",  "maxItems", "format",   "unit"};

bool HasDefault(JSContext* ctx, JSValueConst node) {
    JSValue d = JS_GetPropertyStr(ctx, node, "default");
    bool present = !JS_IsUndefined(d);
    JS_FreeValue(ctx, d);
    return present;
}

/* Defaults below a wholesale unit never fill, so they are rejected where they
 * are written rather than at the validation that later misses the field. */
bool RejectInnerDefaults(JSContext* ctx, JSValueConst node, const std::string& path,
                         const char* unit, const char* self) {
    if (HasDefault(ctx, node)) {
        JS_ThrowTypeError(ctx,
                          "a default under %s never applies; give %s itself a whole-value "
                          "default instead (found at %s)",
                          unit, self, path.c_str());
        return false;
    }
    NodeKind nk = KindOf(ctx, node);
    if (nk.kind == Kind::Object) {
        JSValue shape = JS_GetPropertyStr(ctx, node, "shape");
        OwnKeys keys(ctx, shape);
        bool ok = true;
        for (uint32_t i = 0; ok && i < keys.len; i++) {
            const char* key_text = JS_AtomToCString(ctx, keys.tab[i].atom);
            std::string child_path = path + "." + (key_text ? key_text : "");
            if (key_text) JS_FreeCString(ctx, key_text);
            JSValue field = JS_GetProperty(ctx, shape, keys.tab[i].atom);
            ok = RejectInnerDefaults(ctx, field, child_path, unit, self);
            JS_FreeValue(ctx, field);
        }
        JS_FreeValue(ctx, shape);
        return ok;
    }
    if (nk.kind == Kind::Optional) {
        /* optional() rejects an inner default itself, so this only reaches
         * what it wraps without reporting the same node twice. */
        JSValue inner = JS_GetPropertyStr(ctx, node, "inner");
        bool ok = RejectInnerDefaults(ctx, inner, path, unit, self);
        JS_FreeValue(ctx, inner);
        return ok;
    }
    return true;
}

/* Copies the annotations onto the node and rejects a default whose shape the
 * node would not accept. Consumes `node`; returns it, or an exception. */
JSValue Annotate(JSContext* ctx, JSValue node, JSValueConst options) {
    if (JS_IsUndefined(options) || JS_IsNull(options)) return node;

    for (const char* key : kAnnotationKeys) {
        JSValue v = JS_GetPropertyStr(ctx, options, key);
        if (JS_IsUndefined(v)) {
            JS_FreeValue(ctx, v);
            continue;
        }
        JS_DefinePropertyValueStr(ctx, node, key, v, JS_PROP_C_W_E);
    }

    JSValue fallback = JS_GetPropertyStr(ctx, options, "default");
    if (JS_IsUndefined(fallback)) {
        JS_FreeValue(ctx, fallback);
        return node;
    }
    Failure fail;
    bool ok = ValidateNode(ctx, node, fallback, "", &fail);
    JS_DefinePropertyValueStr(ctx, node, "default", fallback, JS_PROP_C_W_E);
    if (!ok) {
        JS_FreeValue(ctx, node);
        JS_ThrowTypeError(ctx, "schema default does not match the schema: %s",
                          fail.message.c_str());
        return JS_EXCEPTION;
    }
    return node;
}

JSValue NewNode(JSContext* ctx, const char* kind) {
    JSValue node = JS_NewObject(ctx);
    JS_DefinePropertyValueStr(ctx, node, "kind", JS_NewString(ctx, kind), JS_PROP_C_W_E);
    return node;
}

JSValueConst ArgAt(int argc, JSValueConst* argv, int i) {
    return i < argc ? argv[i] : JS_UNDEFINED;
}

JSValue js_string(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    return Annotate(ctx, NewNode(ctx, "string"), ArgAt(argc, argv, 0));
}

JSValue js_number(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    return Annotate(ctx, NewNode(ctx, "number"), ArgAt(argc, argv, 0));
}

JSValue js_boolean(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    return Annotate(ctx, NewNode(ctx, "boolean"), ArgAt(argc, argv, 0));
}

JSValue js_unknown(JSContext* ctx, JSValueConst, int, JSValueConst*) {
    return NewNode(ctx, "unknown");
}

JSValue js_literal(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    JSValue node = NewNode(ctx, "literal");
    JS_DefinePropertyValueStr(ctx, node, "value", JS_DupValue(ctx, ArgAt(argc, argv, 0)),
                              JS_PROP_C_W_E);
    return Annotate(ctx, node, ArgAt(argc, argv, 1));
}

JSValue js_array(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    JSValueConst element = ArgAt(argc, argv, 0);
    if (!RejectInnerDefaults(ctx, element, "[]", "an array", "the array")) return JS_EXCEPTION;
    JSValue node = NewNode(ctx, "array");
    JS_DefinePropertyValueStr(ctx, node, "element", JS_DupValue(ctx, element), JS_PROP_C_W_E);
    return Annotate(ctx, node, ArgAt(argc, argv, 1));
}

JSValue js_object(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    JSValueConst options = ArgAt(argc, argv, 1);
    if (JS_IsObject(options)) {
        JSValue fallback = JS_GetPropertyStr(ctx, options, "default");
        bool has = !JS_IsUndefined(fallback);
        JS_FreeValue(ctx, fallback);
        if (has) {
            return JS_ThrowTypeError(
                ctx, "an object's defaults compose from its fields; declare defaults on the "
                     "fields");
        }
    }
    JSValue node = NewNode(ctx, "object");
    JS_DefinePropertyValueStr(ctx, node, "shape", JS_DupValue(ctx, ArgAt(argc, argv, 0)),
                              JS_PROP_C_W_E);
    return Annotate(ctx, node, options);
}

JSValue js_tuple(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    JSValueConst elements = ArgAt(argc, argv, 0);
    int64_t len = 0;
    JS_GetLength(ctx, elements, &len);
    for (int64_t i = 0; i < len; i++) {
        JSValue item = JS_GetPropertyInt64(ctx, elements, i);
        bool ok = RejectInnerDefaults(ctx, item, "[" + std::to_string(i) + "]", "a tuple",
                                      "the tuple");
        JS_FreeValue(ctx, item);
        if (!ok) return JS_EXCEPTION;
    }
    JSValue node = NewNode(ctx, "tuple");
    JS_DefinePropertyValueStr(ctx, node, "elements", JS_DupValue(ctx, elements), JS_PROP_C_W_E);
    return Annotate(ctx, node, ArgAt(argc, argv, 1));
}

JSValue js_optional(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    JSValueConst inner = ArgAt(argc, argv, 0);
    if (HasDefault(ctx, inner)) {
        return JS_ThrowTypeError(ctx, "optional() cannot wrap a schema with a default");
    }
    JSValue node = NewNode(ctx, "optional");
    JS_DefinePropertyValueStr(ctx, node, "inner", JS_DupValue(ctx, inner), JS_PROP_C_W_E);
    return node;
}

JSValue js_union(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    JSValueConst members = ArgAt(argc, argv, 0);
    int64_t len = 0;
    JS_GetLength(ctx, members, &len);
    for (int64_t i = 0; i < len; i++) {
        JSValue item = JS_GetPropertyInt64(ctx, members, i);
        bool ok =
            RejectInnerDefaults(ctx, item, "[" + std::to_string(i) + "]", "a union", "the union");
        JS_FreeValue(ctx, item);
        if (!ok) return JS_EXCEPTION;
    }
    JSValue node = NewNode(ctx, "union");
    JS_DefinePropertyValueStr(ctx, node, "members", JS_DupValue(ctx, members), JS_PROP_C_W_E);
    return Annotate(ctx, node, ArgAt(argc, argv, 1));
}

/* Sugar, not a node kind: a union of annotated literals, so nothing
 * downstream has to learn about it. */
JSValue js_enum_of(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    JSValueConst entries = ArgAt(argc, argv, 0);
    int64_t len = 0;
    JS_GetLength(ctx, entries, &len);
    JSValue members = JS_NewArray(ctx);
    for (int64_t i = 0; i < len; i++) {
        JSValue entry = JS_GetPropertyInt64(ctx, entries, i);
        JSValue node = NewNode(ctx, "literal");
        JSValue value = JS_GetPropertyStr(ctx, entry, "value");
        JS_DefinePropertyValueStr(ctx, node, "value", value, JS_PROP_C_W_E);
        for (const char* key : {"title", "description"}) {
            JSValue v = JS_GetPropertyStr(ctx, entry, key);
            if (JS_IsUndefined(v)) {
                JS_FreeValue(ctx, v);
                continue;
            }
            JS_DefinePropertyValueStr(ctx, node, key, v, JS_PROP_C_W_E);
        }
        JS_FreeValue(ctx, entry);
        JS_SetPropertyInt64(ctx, members, i, node);
    }
    JSValue out = NewNode(ctx, "union");
    JS_DefinePropertyValueStr(ctx, out, "members", members, JS_PROP_C_W_E);
    return Annotate(ctx, out, ArgAt(argc, argv, 1));
}

JSValue js_tagged_union(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    JSValueConst key = ArgAt(argc, argv, 0);
    JSValueConst branches = ArgAt(argc, argv, 1);
    {
        OwnKeys tags(ctx, branches);
        for (uint32_t i = 0; i < tags.len; i++) {
            const char* tag_text = JS_AtomToCString(ctx, tags.tab[i].atom);
            std::string tag_path = std::string(".") + (tag_text ? tag_text : "");
            if (tag_text) JS_FreeCString(ctx, tag_text);
            JSValue branch = JS_GetProperty(ctx, branches, tags.tab[i].atom);
            bool ok = RejectInnerDefaults(ctx, branch, tag_path, "a taggedUnion", "the union");
            JS_FreeValue(ctx, branch);
            if (!ok) return JS_EXCEPTION;
        }
    }
    JSValue node = NewNode(ctx, "taggedUnion");
    JS_DefinePropertyValueStr(ctx, node, "key", JS_DupValue(ctx, key), JS_PROP_C_W_E);
    JS_DefinePropertyValueStr(ctx, node, "branches", JS_DupValue(ctx, branches), JS_PROP_C_W_E);
    return Annotate(ctx, node, ArgAt(argc, argv, 2));
}

/* SchemaError.ValidationFailed(message, path) — the error factory the public
 * surface exposes, distinct from the {ok, error} envelope validate() returns. */
JSValue js_validation_failed(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    JSValue error = JS_NewObject(ctx);
    JS_DefinePropertyValueStr(ctx, error, "name", JS_NewString(ctx, "ValidationFailed"),
                              JS_PROP_C_W_E);
    JS_DefinePropertyValueStr(ctx, error, "message", JS_DupValue(ctx, ArgAt(argc, argv, 0)),
                              JS_PROP_C_W_E);
    JS_DefinePropertyValueStr(ctx, error, "path", JS_DupValue(ctx, ArgAt(argc, argv, 1)),
                              JS_PROP_C_W_E);
    return error;
}

/* ── Module registration ────────────────────────────────────────────── */

constexpr const char* kModuleName = "native:mikro/schema";
MIK__REQUIRE_NATIVE_NS("native:mikro/schema");

/* One table drives both JS_AddModuleExport and JS_SetModuleExport. Declaring a
 * name in only one of the two resolves to undefined at the import site, which
 * is why they are not written out separately here. */
struct SchemaExport {
    const char* name;
    JSCFunction* func; /* null for SchemaError, which is a namespace object */
    int arity;
};

const SchemaExport kSchemaExports[] = {
    {"string", js_string, 1},
    {"number", js_number, 1},
    {"boolean", js_boolean, 1},
    {"unknown", js_unknown, 0},
    {"literal", js_literal, 2},
    {"array", js_array, 2},
    {"object", js_object, 2},
    {"tuple", js_tuple, 2},
    {"optional", js_optional, 1},
    {"union", js_union, 2},
    {"enumOf", js_enum_of, 2},
    {"taggedUnion", js_tagged_union, 3},
    {"applyDefaults", js_apply_defaults, 2},
    {"validate", js_validate, 3},
    {"SchemaError", nullptr, 0},
};

JSValue NewSchemaErrorNamespace(JSContext* ctx) {
    JSValue ns = JS_NewObject(ctx);
    JS_DefinePropertyValueStr(ctx, ns, "ValidationFailed",
                              JS_NewCFunction(ctx, js_validation_failed, "ValidationFailed", 2),
                              JS_PROP_C_W_E);
    return ns;
}

int mik__schema_module_init(JSContext* ctx, JSModuleDef* m) {
    for (const SchemaExport& e : kSchemaExports) {
        JSValue value = e.func ? JS_NewCFunction(ctx, e.func, e.name, e.arity)
                               : NewSchemaErrorNamespace(ctx);
        JS_SetModuleExport(ctx, m, e.name, value);
    }
    return 0;
}

JSModuleDef* mik__schema_init(JSContext* ctx) {
    JSModuleDef* m = JS_NewCModule(ctx, kModuleName, mik__schema_module_init);
    if (!m) return nullptr;
    for (const SchemaExport& e : kSchemaExports) JS_AddModuleExport(ctx, m, e.name);
    return m;
}

}  // namespace

/* Lazy: the descriptor goes on the global registry and mik__schema_init runs
 * on first import of native:mikro/schema, so an app that never imports
 * mikro/schema pays nothing. Declaring the module eagerly instead cost every
 * runtime about 4 KB, most of it an atom-table resize triggered by the export
 * names. MIK_REGISTER_MODULE would give the same laziness, but its constructor
 * attribute does not survive static-library linking into the Node addon —
 * mik_cbor.cpp registers explicitly for the same reason. */
void mik__schema_register(void) {
    static mik_module_desc_t desc = {kModuleName, mik__schema_init, nullptr, nullptr, nullptr};
    static bool registered = false;
    if (registered) return;
    registered = true;
    desc.next = mik__module_registry_head;
    mik__module_registry_head = &desc;
}
