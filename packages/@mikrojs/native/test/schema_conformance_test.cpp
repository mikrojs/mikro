/* mikro/schema, checked against the other implementation.
 *
 * Every case here was run through @mikrojs/schema by
 * scripts/gen-schema-fixtures.js and its outcome recorded, then replayed
 * through native:mikro/schema. core.ts is the host implementation (the CLI
 * evaluating mikro.config.ts, the registry, vitest) and mik_schema.cpp is the
 * device one; the two implement one contract and their own suites cannot see
 * each other. The check-in wire had exactly this shape and drifted while both
 * suites stayed green (see ota_wire_fixtures_test.cpp), so the fixtures are
 * regenerated on every test build and a divergence breaks a test here. */

#include <fstream>
#include <sstream>
#include <string>

#include <quickjs.h>

#include <mikrojs/mikrojs.h>

#include "doctest.h"

namespace {

std::string ReadFile(const std::string& path) {
    std::ifstream file(path, std::ios::binary);
    if (!file) FAIL("cannot read fixture: " << path);
    std::ostringstream buf;
    buf << file.rdbuf();
    return buf.str();
}

/* The fixture file declares `const cases = [...]`, so it is concatenated
 * between the import and the driver rather than imported: no module loader,
 * and the cases carry undefined and NaN, which JSON could not represent. */
const char* kDriver = R"JS(
function eq(a, b) {
  if (a === b) return true
  if (typeof a === 'number' && typeof b === 'number') {
    return Number.isNaN(a) && Number.isNaN(b)
  }
  if (a === null || b === null) return false
  if (typeof a !== 'object' || typeof b !== 'object') return false
  const aArr = Array.isArray(a)
  if (aArr !== Array.isArray(b)) return false
  if (aArr) return a.length === b.length && a.every((v, i) => eq(v, b[i]))
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  return ka.every((k) => Object.hasOwn(b, k) && eq(a[k], b[k]))
}

function show(v) {
  if (v === undefined) return 'undefined'
  const text = JSON.stringify(v)
  return text === undefined ? String(v) : text
}

const failures = []

for (const c of cases) {
  if (c.kind === 'construct') {
    let got
    let threw = null
    try {
      got = S[c.call](...c.args)
    } catch (e) {
      threw = e.message
    }
    if (Object.hasOwn(c, 'throws')) {
      if (threw !== c.throws) {
        failures.push(`${c.name}: expected throw ${show(c.throws)}, got ${show(threw)}`)
      }
    } else if (threw !== null) {
      failures.push(`${c.name}: unexpected throw ${show(threw)}`)
    } else if (!eq(got, c.expect)) {
      failures.push(`${c.name}: built ${show(got)}, want ${show(c.expect)}`)
    }
  } else if (c.kind === 'validate') {
    const r = S.validate(c.schema, c.value, '')
    const got = r === null ? null : {message: r.error.message, path: r.error.path}
    if (!eq(got, c.expect)) {
      failures.push(`${c.name}: got ${show(got)}, want ${show(c.expect)}`)
    }
  } else if (c.kind === 'applyDefaults') {
    const got = S.applyDefaults(c.schema, c.value)
    if (!eq(got, c.expect)) {
      failures.push(`${c.name}: got ${show(got)}, want ${show(c.expect)}`)
    }
  } else {
    failures.push(`${c.name}: unknown case kind ${c.kind}`)
  }
}

globalThis.__total = cases.length
globalThis.__failed = failures.length
globalThis.__report = failures.slice(0, 12).join('\n')
)JS";

int32_t ReadGlobalInt(JSContext* ctx, const char* name) {
    JSValue global = JS_GetGlobalObject(ctx);
    JSValue v = JS_GetPropertyStr(ctx, global, name);
    int32_t out = -1;
    JS_ToInt32(ctx, &out, v);
    JS_FreeValue(ctx, v);
    JS_FreeValue(ctx, global);
    return out;
}

std::string ReadGlobalString(JSContext* ctx, const char* name) {
    JSValue global = JS_GetGlobalObject(ctx);
    JSValue v = JS_GetPropertyStr(ctx, global, name);
    const char* text = JS_ToCString(ctx, v);
    std::string out = text ? text : "";
    if (text) JS_FreeCString(ctx, text);
    JS_FreeValue(ctx, v);
    JS_FreeValue(ctx, global);
    return out;
}

}  // namespace

TEST_CASE("schema: the native module agrees with core.ts" * doctest::test_suite("schema")) {
    MIKRuntime* rt = MIK_NewRuntime();
    REQUIRE(rt != nullptr);
    JSContext* ctx = MIK_GetJSContext(rt);

    std::string source = "import * as S from 'native:mikro/schema'\n";
    source += ReadFile(std::string(MIK_SCHEMA_FIXTURE_DIR) + "/schema-fixtures.js");
    source += kDriver;

    JSValue rv = JS_Eval(ctx, source.c_str(), source.size(), "mikro/schema-conformance",
                         JS_EVAL_TYPE_MODULE);
    if (JS_IsException(rv)) {
        JSValue e = JS_GetException(ctx);
        const char* text = JS_ToCString(ctx, e);
        std::string message = text ? text : "?";
        if (text) JS_FreeCString(ctx, text);
        JS_FreeValue(ctx, e);
        FAIL("driver threw: " << message);
    }
    REQUIRE(JS_PromiseState(ctx, rv) == JS_PROMISE_FULFILLED);
    JS_FreeValue(ctx, rv);

    int32_t total = ReadGlobalInt(ctx, "__total");
    int32_t failed = ReadGlobalInt(ctx, "__failed");
    CHECK_MESSAGE(failed == 0, "of " << total << " cases:\n" << ReadGlobalString(ctx, "__report"));
    CHECK(total > 0);

    MIK_FreeRuntime(rt);
}
