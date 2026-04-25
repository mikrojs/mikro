cmake_minimum_required(VERSION 3.20)

# cmake-js sets CMAKE_JS_VERSION when invoked
cmake_policy(SET CMP0091 NEW)
cmake_policy(SET CMP0042 NEW)

project(mikrojs_node LANGUAGES C CXX)

set(CMAKE_C_STANDARD 11)
set(CMAKE_CXX_STANDARD 23)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# ── Build libmikrojs.a from the parent directory ─────────────────────
set(BUILD_TESTING OFF CACHE BOOL "" FORCE)
add_subdirectory("${CMAKE_CURRENT_SOURCE_DIR}/.." "${CMAKE_CURRENT_BINARY_DIR}/mikrojs")

# ── Node-API addon ──────────────────────────────────────────────────
# cmake-js provides these variables:
#   CMAKE_JS_INC  - node-addon-api + Node.js headers
#   CMAKE_JS_LIB  - link libraries (empty on most platforms)
#   CMAKE_JS_SRC  - empty (we don't need the default sources)

add_library(mikrojs_node SHARED
    binding.cpp
    runtime_wrap.cpp
    platform_node.cpp
)

# .node extension (required for Node.js to dlopen it)
set_target_properties(mikrojs_node PROPERTIES
    PREFIX ""
    SUFFIX ".node"
)

target_include_directories(mikrojs_node PRIVATE
    ${CMAKE_JS_INC}
    "${CMAKE_CURRENT_SOURCE_DIR}"
)

target_link_libraries(mikrojs_node PRIVATE
    mikrojs
    ${CMAKE_JS_LIB}
)

# node-addon-api: find the include directory
execute_process(
    COMMAND node -p "require('node-addon-api').include"
    WORKING_DIRECTORY ${CMAKE_SOURCE_DIR}
    OUTPUT_VARIABLE NODE_ADDON_API_DIR
    OUTPUT_STRIP_TRAILING_WHITESPACE
)
# Strip surrounding quotes if present
string(REPLACE "\"" "" NODE_ADDON_API_DIR ${NODE_ADDON_API_DIR})
target_include_directories(mikrojs_node PRIVATE ${NODE_ADDON_API_DIR})

# Use Node-API (not nan)
target_compile_definitions(mikrojs_node PRIVATE
    NAPI_VERSION=9
    NODE_ADDON_API_DISABLE_DEPRECATED
)

# Suppress warnings from QuickJS headers
target_compile_options(mikrojs_node PRIVATE -Wall -Wextra -Wno-unused-parameter)

# On macOS, Node-API symbols are resolved at runtime from the Node.js executable
if(APPLE)
    set_target_properties(mikrojs_node PROPERTIES
        LINK_FLAGS "-undefined dynamic_lookup"
    )
endif()
