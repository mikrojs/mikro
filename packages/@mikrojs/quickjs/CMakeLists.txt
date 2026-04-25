cmake_minimum_required(VERSION 3.20)
project(quickjs_tools LANGUAGES C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)

# Include the shared quickjs module
include("${CMAKE_CURRENT_SOURCE_DIR}/quickjs.cmake")

# ── qjsc bytecode compiler ──────────────────────────────────────────
add_executable(qjsc
    "${QUICKJS_INCLUDE_DIR}/qjsc.c"
    "${QUICKJS_INCLUDE_DIR}/quickjs-libc.c"
)
target_compile_definitions(qjsc PRIVATE _GNU_SOURCE)
target_link_libraries(qjsc PRIVATE quickjs m)
target_compile_options(qjsc PRIVATE ${QUICKJS_COMPILE_OPTIONS})
