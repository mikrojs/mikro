# ── Resolve package paths via Node.js ────────────────────────────────
# MIKROJS_PROJECT_DIR is the directory containing package.json and node_modules.
# Defaults to CMAKE_SOURCE_DIR which works for both:
#   - Monorepo: CMAKE_SOURCE_DIR is esp32/ (has package.json with workspace deps)
#   - External: CMAKE_SOURCE_DIR is the user's project root
if(NOT DEFINED MIKROJS_PROJECT_DIR)
    set(MIKROJS_PROJECT_DIR "${CMAKE_SOURCE_DIR}")
endif()

# resolve.js lives in the firmware package root, two levels up from this component
set(_MIK_RESOLVE "${CMAKE_CURRENT_LIST_DIR}/../../resolve.js")

execute_process(
    COMMAND node ${_MIK_RESOLVE} quickjs
    OUTPUT_VARIABLE QUICKJS_CMAKE_PATH
    OUTPUT_STRIP_TRAILING_WHITESPACE
)
execute_process(
    COMMAND node ${_MIK_RESOLVE} native
    OUTPUT_VARIABLE _NATIVE_JSON
    OUTPUT_STRIP_TRAILING_WHITESPACE
)
# Parse JSON output
string(JSON MIK_INCLUDE_DIR GET "${_NATIVE_JSON}" "include")
string(JSON MIK_SRC_DIR GET "${_NATIVE_JSON}" "src")
string(JSON MIK_RUNTIME_DIR GET "${_NATIVE_JSON}" "runtime")
string(JSON MIK_SCRIPTS_DIR GET "${_NATIVE_JSON}" "scripts")
string(JSON MIK_BYTECODE_CMAKE GET "${_NATIVE_JSON}" "bytecodeCmake")

# Include quickjs.cmake for QUICKJS_SOURCES, QUICKJS_INCLUDE_DIR, etc.
include("${QUICKJS_CMAKE_PATH}")

# nanocbor lives inside the native package
set(MIK_NANOCBOR_DIR "${MIK_SRC_DIR}/../deps/nanocbor")

# BLE sources and the `ble` native module only compile when NimBLE is
# available. Test builds disable Bluetooth via `CONFIG_BT_ENABLED=n` in
# their sdkconfig.defaults, so this component has to skip BLE there.
set(_MIK_BLE_SRCS "")
if(CONFIG_BT_ENABLED)
    list(APPEND _MIK_BLE_SRCS "mik_ble.cpp" "mik_ble_c_shim.c")
endif()

idf_component_register(
    INCLUDE_DIRS "include" "${MIK_INCLUDE_DIR}"
    REQUIRES bt littlefs esp_adc esp_app_format esp_driver_gpio esp_driver_i2c esp_driver_ledc esp_driver_rmt esp_driver_spi esp_psram esp_timer esp_http_client esp-tls esp_netif esp_event esp_wifi nvs_flash esp_driver_uart esp_driver_usb_serial_jtag spi_flash
    SRCS
    # QuickJS engine
    ${QUICKJS_SOURCES}
    # Standalone library portable sources
    "${MIK_SRC_DIR}/cutils_compat.c"
    "${MIK_SRC_DIR}/builtins.cpp"
    "${MIK_SRC_DIR}/eval_bytecode.cpp"
    "${MIK_SRC_DIR}/mik_abort.cpp"
    "${MIK_SRC_DIR}/fs.cpp"
    "${MIK_SRC_DIR}/mem.cpp"
    "${MIK_SRC_DIR}/mik_app_config.cpp"
    "${MIK_SRC_DIR}/mik_color.cpp"
    "${MIK_SRC_DIR}/mik_console.cpp"
    "${MIK_SRC_DIR}/mik_inspect.cpp"
    "${MIK_SRC_DIR}/mik_repl.cpp"
    "${MIK_SRC_DIR}/mik_stdio.cpp"
    "${MIK_SRC_DIR}/mik_sys.cpp"
    "${MIK_SRC_DIR}/mik_text_encoding.cpp"
    "${MIK_SRC_DIR}/mik_cbor.cpp"
    "${MIK_SRC_DIR}/mik_result.cpp"
    "${MIK_SRC_DIR}/mik_udp.cpp"
    "${MIK_SRC_DIR}/mikrojs.cpp"
    # nanocbor CBOR codec
    "${MIK_NANOCBOR_DIR}/src/encoder.c"
    "${MIK_NANOCBOR_DIR}/src/decoder.c"
    "${MIK_SRC_DIR}/modules.cpp"
    "${MIK_SRC_DIR}/timers.cpp"
    "${MIK_SRC_DIR}/utils.cpp"
    # ESP32 platform implementation (replaces platform_posix.cpp)
    "platform_esp32.cpp"
    # Default firmware entry point
    "mik_main.cpp"
    # ESP32-specific modules and protocols
    ${_MIK_BLE_SRCS}
    "mik_config.cpp"
    "mik_deploy.cpp"
    "mik_http.cpp"
    "mik_i2c.cpp"
    "mik_neopixel.cpp"
    "mik_pin.cpp"
    "mik_pwm.cpp"
    "mik_nvs_kv.cpp"
    "mik_recovery.cpp"
    "mik_rtc.cpp"
    "mik_serial_io.cpp"
    "mik_sleep.cpp"
    "mik_spi.cpp"
    "mik_sntp.cpp"
    "mik_uart.cpp"
    "mik_wifi.cpp"
)

# QuickJS headers as SYSTEM includes (suppresses warnings)
target_include_directories(${COMPONENT_LIB} SYSTEM PUBLIC "${QUICKJS_INCLUDE_DIR}")
# nanocbor headers
target_include_directories(${COMPONENT_LIB} PRIVATE "${MIK_NANOCBOR_DIR}/include")
target_compile_options(${COMPONENT_LIB} PUBLIC $<$<COMPILE_LANGUAGE:CXX>:-fpermissive>)
# -fno-strict-aliasing: see comment in quickjs.cmake. Applied component-wide
# (same posture as the Linux kernel) so neither QuickJS sources nor our
# own C/C++ can be bitten by aliasing UB during optimization.
target_compile_options(${COMPONENT_LIB} PRIVATE -Wno-implicit-fallthrough -Wno-maybe-uninitialized -Wno-missing-field-initializers -fno-strict-aliasing)

# ── Board and version metadata ──────────────────────────────────────
execute_process(
    COMMAND node ${_MIK_RESOLVE} version
    OUTPUT_VARIABLE _MIK_VERSION
    OUTPUT_STRIP_TRAILING_WHITESPACE
)
target_compile_definitions(${COMPONENT_LIB} PRIVATE "MIK_FW_VERSION=\"${_MIK_VERSION}\"")

# UTC build timestamp. `string(TIMESTAMP ... UTC)` honors SOURCE_DATE_EPOCH
# when set. Refreshes on re-configure only (idf.py triggers this on each
# build via its own reconfigure step, so in practice it's close to
# build-fresh on ESP-IDF).
string(TIMESTAMP _MIK_BUILD_DATE_UTC "%Y-%m-%dT%H:%M:%SZ" UTC)
target_compile_definitions(${COMPONENT_LIB} PRIVATE "MIK_BUILD_DATE_UTC=\"${_MIK_BUILD_DATE_UTC}\"")

# Board name from MIKROJS_BOARD env var (set by CI or developer)
if(DEFINED ENV{MIKROJS_BOARD})
    target_compile_definitions(${COMPONENT_LIB} PRIVATE "MIK_BOARD_NAME=\"$ENV{MIKROJS_BOARD}\"")
endif()

# ── Bytecode generation ──────────────────────────────────────────────
include("${MIK_BYTECODE_CMAKE}")

# Force linker to include self-registering native modules
set(_MIK_MODULES cbor pin i2c spi http wifi rtc nvs_kv sntp sleep neopixel pwm uart)
set(_MIK_BYTECODE_MODULES cbor env result schema fs http/helpers http/request i2c kv/nvs kv/rtc kv/shared neopixel pin pwm reader sleep spi sntp stdio stream sys test uart udp wifi)
if(CONFIG_BT_ENABLED)
    list(APPEND _MIK_MODULES ble)
    list(APPEND _MIK_BYTECODE_MODULES ble)
endif()
mikrojs_force_include_modules(${_MIK_MODULES})
mikrojs_generate_bytecode(
    RUNTIME_DIR "${MIK_RUNTIME_DIR}"
    MODULES ${_MIK_BYTECODE_MODULES}
    MODULE_PREFIX "mikrojs"
    SYMBOL_PREFIX "mikrojs"
    TARGET gen_bytecode
    WORKING_DIRECTORY "${MIKROJS_PROJECT_DIR}"
)
add_dependencies(${COMPONENT_LIB} gen_bytecode)
target_include_directories(${COMPONENT_LIB} PRIVATE "${gen_bytecode_INCLUDE_DIR}")

# ── Symbol map for offline panic-trace decoding ──────────────────────
# Runs after the ELF is linked. Toolchain prefix derived from the C
# compiler path so this works for any binutils target (xtensa, riscv,
# arm — anything a future port might add).
get_filename_component(_MIK_TC_DIR "${CMAKE_C_COMPILER}" DIRECTORY)
get_filename_component(_MIK_TC_NAME "${CMAKE_C_COMPILER}" NAME)
string(REGEX REPLACE "gcc(\\.exe)?$" "" _MIK_TC_NAME_PREFIX "${_MIK_TC_NAME}")
set(_MIK_TC_PREFIX "${_MIK_TC_DIR}/${_MIK_TC_NAME_PREFIX}")

# The ${project}.elf target is created by ESP-IDF inside `project()`, in the
# source-root CMake scope. Component CMakeLists run before that target
# exists, so defer to end-of-source-dir processing. cmake_language(DEFER)
# expands ${...} args in the *target* directory's scope at fire time, so
# component-local variables won't survive — stash them as GLOBAL properties
# and read them back inside the deferred function.
set_property(GLOBAL PROPERTY MIKROJS_TOOLCHAIN_PREFIX "${_MIK_TC_PREFIX}")
set_property(GLOBAL PROPERTY MIKROJS_SCRIPTS_DIR "${MIK_SCRIPTS_DIR}")

function(_mik_install_symbol_map_hook)
    get_property(tc_prefix GLOBAL PROPERTY MIKROJS_TOOLCHAIN_PREFIX)
    get_property(scripts_dir GLOBAL PROPERTY MIKROJS_SCRIPTS_DIR)
    idf_build_get_property(project_name PROJECT_NAME)
    idf_build_get_property(target IDF_TARGET)
    add_custom_command(
        TARGET "${project_name}.elf" POST_BUILD
        COMMAND node "${scripts_dir}/generate-symbol-map.js"
            "$<TARGET_FILE:${project_name}.elf>"
            "${CMAKE_BINARY_DIR}/${project_name}.symbols.json"
            "${tc_prefix}"
            "${target}"
        BYPRODUCTS "${CMAKE_BINARY_DIR}/${project_name}.symbols.json"
        COMMENT "Generating symbol map for panic-trace decoding"
        VERBATIM
    )
endfunction()

cmake_language(DEFER DIRECTORY "${CMAKE_SOURCE_DIR}"
    CALL _mik_install_symbol_map_hook)
