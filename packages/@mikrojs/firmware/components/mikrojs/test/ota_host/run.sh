#!/usr/bin/env bash
# Host test for the pure OTA unpack path in ../../mik_ota.cpp. Compiles the REAL
# unpack_tgz()/sha256_file() on the host, runs them through a tinfl shim that
# models the esp32c6 ROM over-reading the gzip trailer, and asserts:
#   - a real `tar -czf` build unpacks byte-identical to `tar -xzf`
#   - the ROM over-read actually fires (test isn't vacuous)
#   - truncated and corrupt builds are rejected (kind=corrupt)
#   - a member that escapes dest_dir is rejected and writes nothing
#   - sha256_file matches a known vector
#
# Needs: a C/C++ compiler, tar, gzip, and miniz (auto-fetched into .cache/, or
# set MINIZ_DIR to a dir containing miniz.c + miniz.h).
set -euo pipefail

# Stop macOS tar from injecting AppleDouble (._*) resource-fork entries, so the
# fixture archive matches what `mikro app pack` produces on any platform.
export COPYFILE_DISABLE=1

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$DIR/../../mik_ota.cpp"
CACHE="${MINIZ_DIR:-$DIR/.cache}"
BUILD="$DIR/.build"
CXX="${CXX:-c++}"
CC="${CC:-cc}"
MINIZ_URL="https://github.com/richgel999/miniz/releases/download/3.0.2/miniz-3.0.2.zip"
# Pinned so a test that hardens decompression does not itself run an unverified
# decompression library. This is the digest of the 3.0.2 release asset as first
# fetched; re-pin deliberately when bumping the version.
MINIZ_SHA256="ada38db0b703a56d3dd6d57bf84a9c5d664921d870d8fea4db153979fb5332c5"

mkdir -p "$BUILD"

# ---- miniz ----
if [ ! -f "$CACHE/miniz.c" ] || [ ! -f "$CACHE/miniz.h" ]; then
    echo "miniz not found in $CACHE — fetching $MINIZ_URL"
    mkdir -p "$CACHE"
    curl -sSL --max-time 60 -o "$CACHE/miniz.zip" "$MINIZ_URL"
    GOT_ZIP="$(shasum -a 256 "$CACHE/miniz.zip" | cut -d' ' -f1)"
    if [ "$GOT_ZIP" != "$MINIZ_SHA256" ]; then
        rm -f "$CACHE/miniz.zip"
        echo "FAIL: miniz checksum mismatch (got $GOT_ZIP, want $MINIZ_SHA256)"; exit 1
    fi
    (cd "$CACHE" && unzip -o miniz.zip >/dev/null)
    [ -f "$CACHE/miniz.c" ] || { echo "FAIL: could not obtain miniz (set MINIZ_DIR)"; exit 1; }
fi

# miniz is C — build it once as a C object (it isn't valid C++), then link.
"$CC" -O2 -I"$CACHE" -c "$CACHE/miniz.c" -o "$BUILD/miniz.o"
"$CXX" -std=c++17 -O2 -Wall -Wno-unused-function -Wno-unneeded-internal-declaration \
    -I"$CACHE" "$DIR/gunzip_host_test.cpp" "$BUILD/miniz.o" -o "$BUILD/test"

TEST="$BUILD/test"

# ---- fixtures, packed exactly like `mikro app pack` (tar -C build app) ----
make_fixture() { # <name> <payload-bytes>
    rm -rf "$BUILD/src_$1" "$BUILD/ref_$1" "$BUILD/out_$1"
    mkdir -p "$BUILD/src_$1/app/nested"
    head -c "$2" /dev/urandom | base64 > "$BUILD/src_$1/app/blob.txt"
    printf 'export const x = 42\n' > "$BUILD/src_$1/app/index.js"
    printf 'nested\n' > "$BUILD/src_$1/app/nested/n.txt"
    tar -czf "$BUILD/$1.tgz" -C "$BUILD/src_$1" app
    mkdir -p "$BUILD/ref_$1"
    tar -xzf "$BUILD/$1.tgz" -C "$BUILD/ref_$1"   # reference extraction
}
# small: compresses to one read so the trailer sits in tinfl's final buffer —
# the over-read definitely fires.
make_fixture small 256
# large: multiple 4 KiB reads, exercising the window-wrapping decode path and
# the 512-byte tar-block reassembly across inflate-output boundaries.
make_fixture large 60000

run_unpack() { # <name> <require-overread:0|1>
    local name="$1" require="$2"
    echo "== $name fixture ($(wc -c < "$BUILD/$name.tgz" | tr -d ' ') byte .tgz) =="
    local out
    out="$("$TEST" unpack "$BUILD/$name.tgz" "$BUILD/out_$name")" || {
        echo "  $out"; echo "FAIL: unpack_tgz rejected a valid build under the ROM shim"; exit 1; }
    echo "  $out"
    diff -r "$BUILD/out_$name/app" "$BUILD/ref_$name/app" || {
        echo "FAIL: streaming unpack differs from tar -xzf"; exit 1; }
    if [ "$require" = 1 ] && ! printf '%s' "$out" | grep -qE 'rom_shim_ate=[1-9]'; then
        echo "FAIL: the ROM over-read never fired — test would be vacuous"; exit 1
    fi
    echo "  output matches tar -xzf (byte-identical) ✓"
}

run_unpack small 1
run_unpack large 0

# ---- rejection cases ----
echo "== corrupt/truncated rejection =="
# Truncated: drop the last 16 bytes (trailer + tail of deflate).
head -c "$(( $(wc -c < "$BUILD/small.tgz") - 16 ))" "$BUILD/small.tgz" > "$BUILD/trunc.tgz"
"$TEST" expect-fail "$BUILD/trunc.tgz" "$BUILD/out_trunc" >/dev/null && echo "  truncated rejected ✓" \
    || { echo "FAIL: truncated build was accepted"; exit 1; }
# Corrupt: flip a byte in the deflate body.
cp "$BUILD/large.tgz" "$BUILD/corrupt.tgz"
printf '\xff' | dd of="$BUILD/corrupt.tgz" bs=1 seek=64 count=1 conv=notrunc 2>/dev/null
"$TEST" expect-fail "$BUILD/corrupt.tgz" "$BUILD/out_corrupt" >/dev/null && echo "  corrupt rejected ✓" \
    || { echo "FAIL: corrupt build was accepted"; exit 1; }
# Not gzip at all.
head -c 200 /dev/urandom > "$BUILD/garbage.tgz"
"$TEST" expect-fail "$BUILD/garbage.tgz" "$BUILD/out_garbage" >/dev/null && echo "  non-gzip rejected ✓" \
    || { echo "FAIL: non-gzip build was accepted"; exit 1; }

# ---- no leaked handle on a mid-member failure ----
# Half a .tgz: enough deflate output to open app/blob.txt, then the input runs
# out while it is still open. That is the shape that strands the handle; the
# corrupt.tgz above fails at byte 64, before any member exists.
echo "== no fd leak on mid-member failure =="
head -c "$(( $(wc -c < "$BUILD/large.tgz") / 2 ))" "$BUILD/large.tgz" > "$BUILD/midtrunc.tgz"
LEAK_OUT="$("$TEST" leak "$BUILD/midtrunc.tgz" "$BUILD/out_midtrunc")" || {
    echo "  $LEAK_OUT"; echo "FAIL: aborted unpack leaks the open member handle"; exit 1; }
echo "  $LEAK_OUT"
echo "  aborted unpack releases the member handle ✓"

# ---- path traversal rejection ----
# The checksum is no defence here: it ships in the same offer as the URL, so
# whoever serves the offer controls both. A member that escapes dest_dir would
# land on the live app or the rollback baseline during boot reconcile.
echo "== path traversal rejection =="
rm -rf "$BUILD/src_evil" "$BUILD/out_evil" "$BUILD/zz.txt"
mkdir -p "$BUILD/src_evil/app"
printf 'pwned\n' > "$BUILD/src_evil/app/zz.txt"
tar -cf "$BUILD/evil.tar" -C "$BUILD/src_evil" app
# Rewrite the member name in place: `app/zz.txt` -> `..//zz.txt`, same length so
# every other header field (including the size) stays valid. tar itself refuses
# to create such a member, hence the patch. The header checksum is left stale,
# which is fine: untar_block doesn't verify it, and if it ever does this test
# will fail loudly rather than silently stop testing traversal.
OFF="$(grep -abo 'app/zz.txt' "$BUILD/evil.tar" | head -1 | cut -d: -f1)"
[ -n "$OFF" ] || { echo "FAIL: could not locate the member name to patch"; exit 1; }
printf '../' | dd of="$BUILD/evil.tar" bs=1 seek="$OFF" count=3 conv=notrunc 2>/dev/null
gzip -c "$BUILD/evil.tar" > "$BUILD/evil.tgz"
"$TEST" expect-fail "$BUILD/evil.tgz" "$BUILD/out_evil" >/dev/null && echo "  ../ member rejected ✓" \
    || { echo "FAIL: a build with a ../ member was accepted"; exit 1; }
[ ! -e "$BUILD/zz.txt" ] || { echo "FAIL: the ../ member escaped dest_dir"; exit 1; }
echo "  nothing written outside dest_dir ✓"

# ---- deep nesting rejection ----
# Every level created here is a level rmtree recurses over during boot reconcile,
# where a stack overflow reboots into the same call and never clears the tree.
# `a/` twice per level fits ~49 levels in the 100-byte name field, so the cap is
# what keeps a hostile build from bricking the device rather than just failing.
echo "== deep nesting rejection =="
rm -rf "$BUILD/src_deep" "$BUILD/out_deep"
DEEP="$BUILD/src_deep/app"; for _ in $(seq 1 12); do DEEP="$DEEP/a"; done
mkdir -p "$DEEP"
printf 'deep\n' > "$DEEP/x.txt"
tar -czf "$BUILD/deep.tgz" -C "$BUILD/src_deep" app
"$TEST" expect-fail "$BUILD/deep.tgz" "$BUILD/out_deep" >/dev/null && echo "  deep member rejected ✓" \
    || { echo "FAIL: a build nested past the depth cap was accepted"; exit 1; }
# A shallow build must still unpack, or the cap has just broken every real build.
rm -rf "$BUILD/src_ok" "$BUILD/out_ok"
mkdir -p "$BUILD/src_ok/app/a/b"
printf 'ok\n' > "$BUILD/src_ok/app/a/b/x.txt"
tar -czf "$BUILD/okdepth.tgz" -C "$BUILD/src_ok" app
"$TEST" unpack "$BUILD/okdepth.tgz" "$BUILD/out_ok" >/dev/null \
    && [ -f "$BUILD/out_ok/app/a/b/x.txt" ] && echo "  ordinary nesting still accepted ✓" \
    || { echo "FAIL: the depth cap rejected an ordinary build"; exit 1; }

# ---- SHA-256 known vector ----
echo "== sha256 vector =="
# echo -n "abc" | sha256sum -> ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
printf 'abc' > "$BUILD/abc.bin"
GOT="$("$TEST" sha256 "$BUILD/abc.bin")"
WANT="ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
[ "$GOT" = "$WANT" ] && echo "  sha256('abc') = $GOT ✓" \
    || { echo "FAIL: sha256 mismatch: got $GOT want $WANT"; exit 1; }

echo
echo "PASS: unpack_tgz unpacks valid builds byte-identical (even when tinfl eats the"
echo "      gzip trailer), rejects corrupt/truncated builds and path traversal, and"
echo "      SHA-256 is correct."
