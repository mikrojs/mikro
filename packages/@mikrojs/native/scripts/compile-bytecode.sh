#!/bin/sh
# Compile a bundled JS module to a C bytecode header using qjsc.
#
# Usage: compile-bytecode.sh <qjsc> <input.js> <output.h> <module_name> <symbol_name> [atoms.bin]
#
# Reads <input>.externals for external module declarations.
# If <output> ends in .bjs, emits raw bytecode instead of a C header
# (pass 1 of the frozen-atom pipeline; see extract-atoms.js).
# If [atoms.bin] is given, compiles against that frozen atom table (-A).

set -e

QJSC="$1"
INPUT="$2"
OUTPUT="$3"
MODULE_NAME="$4"
SYMBOL_NAME="$5"
ATOMS_BIN="$6"

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
A_FLAGS=""
if [ -n "$ATOMS_BIN" ]; then
    A_FLAGS="-A $ATOMS_BIN"
fi

case "$OUTPUT" in
*.bjs)
    # Raw bytecode (frozen-atom pass 1). Must use the same flags as the
    # header pass so the atom set matches, minus -N (no C symbol).
    # shellcheck disable=SC2086
    "$QJSC" -b -m -s -n "$MODULE_NAME" $M_FLAGS $A_FLAGS -o "$OUTPUT" "$INPUT"
    ;;
*)
    # shellcheck disable=SC2086
    "$QJSC" -m -s -N "$SYMBOL_NAME" -n "$MODULE_NAME" $M_FLAGS $A_FLAGS -o "$OUTPUT" "$INPUT"
    ;;
esac
