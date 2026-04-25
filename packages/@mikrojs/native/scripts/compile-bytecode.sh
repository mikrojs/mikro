#!/bin/sh
# Compile a bundled JS module to a C bytecode header using qjsc.
#
# Usage: compile-bytecode.sh <qjsc> <input.js> <output.h> <module_name> <symbol_name>
#
# Reads <input>.externals for external module declarations.

set -e

QJSC="$1"
INPUT="$2"
OUTPUT="$3"
MODULE_NAME="$4"
SYMBOL_NAME="$5"

EXTERNALS_FILE="${INPUT%.js}.externals"

# Build -M flags for external modules
M_FLAGS=""
if [ -f "$EXTERNALS_FILE" ]; then
    while IFS= read -r ext || [ -n "$ext" ]; do
        [ -n "$ext" ] && M_FLAGS="$M_FLAGS -M $ext"
    done < "$EXTERNALS_FILE"
fi

# Compile with qjsc: ES module, strip source, custom name and script name.
#
# We use -s (strip source), NOT -ss (strip source + debug info). Stripping
# debug info via -ss drops b->filename from every function bytecode
# (quickjs.c writes filename inside `if (s->allow_debug)` — see
# JS_WriteFunctionBytecode). Once filename is gone, JS_GetScriptOrModuleName
# returns JS_ATOM_NULL for any function in the deserialized module, and
# js_import_meta fails with "import.meta not supported in this context" —
# so any runtime module that reads `import.meta.*` (e.g. mikrojs/env
# accessing import.meta.env) breaks at runtime. The ~1 KB heap saving
# from stripping debug isn't worth crippling a spec-standard module API.
# shellcheck disable=SC2086
"$QJSC" -m -s -N "$SYMBOL_NAME" -n "$MODULE_NAME" $M_FLAGS -o "$OUTPUT" "$INPUT"
