# ── Resolve @mikrojs package paths ────────────────────────────────────
# Resolve from the driver package root (parent of this component dir)
set(_DRIVER_PKG_DIR "${CMAKE_CURRENT_LIST_DIR}/..")
execute_process(
    COMMAND node -e "import('@mikrojs/native/cmake').then(n=>import('@mikrojs/quickjs').then(q=>process.stdout.write(JSON.stringify({bytecodeCmake:n.bytecodeCmakePath,quickjsCmake:q.cmakePath,runtime:'${CMAKE_CURRENT_LIST_DIR}/../runtime'}))))"
    WORKING_DIRECTORY ${_DRIVER_PKG_DIR}
    OUTPUT_VARIABLE _DRIVER_JSON
    OUTPUT_STRIP_TRAILING_WHITESPACE
)
string(JSON _BYTECODE_CMAKE GET "${_DRIVER_JSON}" "bytecodeCmake")
string(JSON _QUICKJS_CMAKE GET "${_DRIVER_JSON}" "quickjsCmake")
string(JSON _RUNTIME_DIR GET "${_DRIVER_JSON}" "runtime")

include("${_QUICKJS_CMAKE}")

idf_component_register(
    SRCS "src/mik_sh8601.cpp" "src/esp_lcd_sh8601.c"
    INCLUDE_DIRS "src"
    REQUIRES mikrojs esp_lcd esp_driver_gpio esp_driver_spi esp_driver_ledc
)

# ── Bytecode generation ──────────────────────────────────────────────
include("${_BYTECODE_CMAKE}")

# Force linker to include self-registering module and builtin
mikrojs_force_include_modules(sh8601)
mikrojs_force_include_builtins(sh8601)
mikrojs_generate_bytecode(
    RUNTIME_DIR "${_RUNTIME_DIR}"
    MODULES sh8601
    MODULE_PREFIX "@mikrojs/driver-sh8601"
    SYMBOL_PREFIX "mik_driver_sh8601"
    TARGET gen_driver_sh8601_bytecode
    WORKING_DIRECTORY "${_DRIVER_PKG_DIR}"
)
add_dependencies(${COMPONENT_LIB} gen_driver_sh8601_bytecode)
target_include_directories(${COMPONENT_LIB} PRIVATE "${gen_driver_sh8601_bytecode_INCLUDE_DIR}")
