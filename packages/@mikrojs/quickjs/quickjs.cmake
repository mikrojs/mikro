# quickjs.cmake — shared CMake module for QuickJS-NG
#
# Provides:
#   Target mode (normal CMake):
#     - `quickjs` static library target
#   Variable mode (ESP-IDF / source inclusion):
#     - QUICKJS_SOURCES       — list of source files
#     - QUICKJS_INCLUDE_DIR   — include directory
#     - QUICKJS_COMPILE_OPTIONS — compiler flags for QuickJS sources
#   Both modes:
#     - QJSC_EXECUTABLE       — path to the qjsc bytecode compiler
#
# Usage in normal CMake:
#   include(<path>/quickjs.cmake)
#   target_link_libraries(mylib PUBLIC quickjs)
#
# Usage in ESP-IDF component:
#   include(<path>/quickjs.cmake)
#   idf_component_register(SRCS ${QUICKJS_SOURCES} ...)
#   target_include_directories(${COMPONENT_LIB} SYSTEM PUBLIC ${QUICKJS_INCLUDE_DIR})

# Include guard — safe for multiple includes
if(TARGET quickjs)
    return()
endif()

# Resolve paths relative to this file
get_filename_component(_QUICKJS_CMAKE_DIR "${CMAKE_CURRENT_LIST_FILE}" DIRECTORY)
set(QUICKJS_INCLUDE_DIR "${_QUICKJS_CMAKE_DIR}/deps/quickjs")

# Sync the patched QuickJS tree AND the qjsc compiler before anything
# compiles or generates bytecode. postinstall covers `pnpm install`, but a
# patch file added or edited after install was previously a silent no-op:
# the tree built unpatched and the full test suite ran against code the
# patch never touched. Running postinstall (not just apply-patches) matters
# because qjsc is compiled FROM the patched sources: a stale qjsc paired
# with a fresh runtime emits bytecode the runtime rejects at import time
# (frozen atom table mismatch) — a runtime failure born from a green build.
# Both steps are stamp-guarded, so the no-change case is cheap; the GLOB's
# CONFIGURE_DEPENDS reruns configure when the patch set changes, and
# CMAKE_CONFIGURE_DEPENDS reruns it when patch contents change.
#
# Guarded for CMake script mode: ESP-IDF's early component-requirements
# pass includes component CMakeLists (and through them this file) via
# script-mode CMake, where CONFIGURE_DEPENDS globs and directory
# properties are hard errors. The real project-mode configure that
# follows runs the sync; the requirements pass only needs the variables.
if(NOT CMAKE_SCRIPT_MODE_FILE)
    file(GLOB _QUICKJS_PATCHES CONFIGURE_DEPENDS "${_QUICKJS_CMAKE_DIR}/patches/*.patch")
    set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS ${_QUICKJS_PATCHES})
    execute_process(
        COMMAND node "${_QUICKJS_CMAKE_DIR}/postinstall.js"
        RESULT_VARIABLE _QUICKJS_PATCH_RC
    )
    if(NOT _QUICKJS_PATCH_RC EQUAL 0)
        message(FATAL_ERROR "quickjs.cmake: syncing QuickJS patches/qjsc failed (see output above)")
    endif()
endif()

# Source files
set(QUICKJS_SOURCES
    "${QUICKJS_INCLUDE_DIR}/quickjs.c"
    "${QUICKJS_INCLUDE_DIR}/dtoa.c"
    "${QUICKJS_INCLUDE_DIR}/libunicode.c"
    "${QUICKJS_INCLUDE_DIR}/libregexp.c"
)

# Compiler flags for QuickJS sources.
#
# -fno-strict-aliasing defends against latent aliasing UB in the QuickJS
# sources miscompiling on 32-bit embedded targets. One real instance of
# this bit us: a `(int *)&uint32_t_var` cast in js_string_iterator_next
# was silently optimized away when uint32_t was typedef'd as
# `unsigned long` (as it is on riscv32-esp-elf), producing a String
# Iterator that never advanced. With strict aliasing off, GCC can't
# assume the pointer write through a differently-typed pointer misses
# the storage, so it reloads from memory and the code behaves as
# intended. Small codegen cost, predictable correctness — worth it for
# third-party code we don't audit exhaustively.
# MSVC understands neither GCC-style -W flags nor -fno-strict-aliasing; its
# default codegen also doesn't strict-alias (no /Oa equivalent in cl), so
# leaving the options empty for MSVC is the right call.
if(MSVC)
    set(QUICKJS_COMPILE_OPTIONS "")
else()
    set(QUICKJS_COMPILE_OPTIONS -Wno-implicit-fallthrough -Wno-sign-compare -fno-strict-aliasing)
endif()

# qjsc executable path (built by postinstall)
if(WIN32)
    set(QJSC_EXECUTABLE "${_QUICKJS_CMAKE_DIR}/bin/qjsc.exe")
else()
    set(QJSC_EXECUTABLE "${_QUICKJS_CMAKE_DIR}/bin/qjsc")
endif()

# ── Target mode: create a static library ────────────────────────────
# Only create the target if not in ESP-IDF component context
# (ESP-IDF uses idf_component_register with SRCS instead)
if(NOT ESP_PLATFORM)
    add_library(quickjs STATIC ${QUICKJS_SOURCES})
    set_target_properties(quickjs PROPERTIES POSITION_INDEPENDENT_CODE ON)
    target_include_directories(quickjs SYSTEM PUBLIC "${QUICKJS_INCLUDE_DIR}")
    target_compile_options(quickjs PRIVATE ${QUICKJS_COMPILE_OPTIONS})

    # cutils.h has inline functions with C-style void* implicit conversions that are
    # errors in C++. -fpermissive (GCC) downgrades them to warnings, then SYSTEM suppresses.
    # Clang doesn't need this since QuickJS headers are SYSTEM includes; MSVC doesn't
    # ship the flag and is silent on these anyway.
    if(CMAKE_CXX_COMPILER_ID STREQUAL "GNU")
        target_compile_options(quickjs INTERFACE $<$<COMPILE_LANGUAGE:CXX>:-fpermissive>)
    endif()
endif()
