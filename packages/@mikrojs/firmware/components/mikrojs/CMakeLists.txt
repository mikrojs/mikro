# ── Package paths ────────────────────────────────────────────────────
# MIKROJS_PROJECT_DIR is the directory containing package.json and node_modules.
# Defaults to CMAKE_SOURCE_DIR which works for both:
#   - Monorepo: CMAKE_SOURCE_DIR is esp32/ (has package.json with workspace deps)
#   - External: CMAKE_SOURCE_DIR is the user's project root
if(NOT DEFINED MIKROJS_PROJECT_DIR)
    set(MIKROJS_PROJECT_DIR "${CMAKE_SOURCE_DIR}")
endif()

# The MIK_* paths come from resolve.cmake, which project.cmake includes.
# ESP-IDF first runs this file in a separate script-mode pass that only
# collects REQUIRES, where they are unset. That pass reads no SRCS, so only
# the include below needs a guard; REQUIRES must never depend on them.
if(MIK_SRC_DIR)
    # Include quickjs.cmake for QUICKJS_SOURCES, QUICKJS_INCLUDE_DIR, etc.
    include("${MIK_QUICKJS_CMAKE}")
elseif(NOT CMAKE_BUILD_EARLY_EXPANSION)
    message(FATAL_ERROR
        "mikrojs: the @mikrojs/native paths are not set. Include @mikrojs/firmware's "
        "project.cmake in the project's CMakeLists.txt, before project().")
endif()

# nanocbor lives inside the native package
set(MIK_NANOCBOR_DIR "${MIK_SRC_DIR}/../deps/nanocbor")

# BLE sources and the `ble` native module only compile when NimBLE is
# available. Test builds disable Bluetooth via `CONFIG_BT_ENABLED=n` in
# their sdkconfig.defaults, so this component has to skip BLE there.
set(_MIK_BLE_SRCS "")
if(CONFIG_BT_ENABLED)
    list(APPEND _MIK_BLE_SRCS "mik_ble.cpp" "mik_ble_c_shim.c")
endif()

# The WiFi driver and the `wifi` native module only compile under
# CONFIG_MIKROJS_WIFI. Nothing else references esp_wifi, so leaving
# mik_wifi.cpp out is what drops net80211, pp and wpa_supplicant from the
# link (about 20 KB of static RAM). `esp_wifi` stays in REQUIRES
# unconditionally: IDF expands REQUIRES before sdkconfig is loaded, so a
# CONFIG_-gated entry would always be empty there.
set(_MIK_WIFI_SRCS "")
if(CONFIG_MIKROJS_WIFI)
    list(APPEND _MIK_WIFI_SRCS "mik_wifi.cpp")
endif()

# mik_ota.cpp includes <miniz.h> for tinfl (gunzip). On the esp32c6 the
# implementation is in the chip mask ROM and the header comes from the
# always-available `esp_rom` common dependency, so no REQUIRES entry is needed.
# A target without ROM miniz needs the `miniz` managed component adding to
# idf_component.yml.
idf_component_register(
    INCLUDE_DIRS "include" "${MIK_INCLUDE_DIR}"
    REQUIRES bt littlefs esp_adc esp_app_format esp_driver_gpio esp_driver_i2c esp_driver_i2s esp_driver_ledc esp_driver_rmt esp_driver_spi esp_psram esp_timer esp_http_client esp_http_server esp-tls esp_netif esp_event esp_wifi nvs_flash esp_driver_uart esp_driver_usb_serial_jtag spi_flash
    SRCS
    # QuickJS engine
    ${QUICKJS_SOURCES}
    # Standalone library portable sources
    "${MIK_SRC_DIR}/cutils_compat.c"
    "${MIK_SRC_DIR}/builtins.cpp"
    "${MIK_SRC_DIR}/eval_bytecode.cpp"
    "${MIK_SRC_DIR}/mik_abort.cpp"
    "${MIK_SRC_DIR}/mik_http_client.cpp"
    "${MIK_SRC_DIR}/mik_wifi_client.cpp"
    "${MIK_SRC_DIR}/fs.cpp"
    "${MIK_SRC_DIR}/gpio_claim.cpp"
    "${MIK_SRC_DIR}/mem.cpp"
    "${MIK_SRC_DIR}/mik_app_config.cpp"
    "${MIK_SRC_DIR}/mik_app_store.cpp"
    "${MIK_SRC_DIR}/mik_color.cpp"
    "${MIK_SRC_DIR}/mik_console.cpp"
    "${MIK_SRC_DIR}/mik_inspect.cpp"
    "${MIK_SRC_DIR}/mik_repl.cpp"
    "${MIK_SRC_DIR}/mik_stdio.cpp"
    "${MIK_SRC_DIR}/mik_sys.cpp"
    "${MIK_SRC_DIR}/mik_text_encoding.cpp"
    "${MIK_SRC_DIR}/mik_cbor.cpp"
    "${MIK_SRC_DIR}/mik_schema.cpp"
    "${MIK_SRC_DIR}/mik_sys_codec.cpp"
    "${MIK_SRC_DIR}/mik_result.cpp"
    "${MIK_SRC_DIR}/mik_udp.cpp"
    "${MIK_SRC_DIR}/mik_watchdog.cpp"
    "${MIK_SRC_DIR}/mik_observable.cpp"
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
    "mik_http_server.cpp"
    "mik_i2c.cpp"
    "mik_i2s.cpp"
    "mik_logfile.cpp"
    "mik_neopixel.cpp"
    "mik_gpio.cpp"
    "mik_pwm.cpp"
    "mik_nvs_kv.cpp"
    "mik_ota.cpp"
    # The OTA check-in client and config reader: policy, state machine and slot
    # store in the portable library, platform seam and JS surface here.
    "${MIK_SRC_DIR}/mik_ota_policy.cpp"
    "${MIK_SRC_DIR}/mik_ota_slots.cpp"
    "${MIK_SRC_DIR}/mik_ota_config.cpp"
    "${MIK_SRC_DIR}/mik_ota_js_hooks.cpp"
    "${MIK_SRC_DIR}/mik_ota_client.cpp"
    "mik_ota_env.cpp"
    "mik_ota_client_module.cpp"
    "mik_recovery.cpp"
    "mik_rtc.cpp"
    "mik_serial_io.cpp"
    "mik_sleep.cpp"
    "mik_spi.cpp"
    "mik_sntp.cpp"
    "mik_uart.cpp"
    ${_MIK_WIFI_SRCS}
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

# NDEBUG for the QuickJS sources only: without it quickjs.c enables
# ENABLE_DUMPS, which adds a list_head (+8 bytes) to every JSString, links
# each string into rt->string_list, and keeps assert() live in the
# interpreter. ESP-IDF keeps assertions enabled globally, so NDEBUG is not
# set project-wide; scoping it here leaves IDF and mikrojs asserts intact.
# -Wno-unused-but-set-variable: several quickjs.c variables are only read
# inside assert(), which NDEBUG compiles away.
set_source_files_properties(${QUICKJS_SOURCES} PROPERTIES
    COMPILE_DEFINITIONS "NDEBUG;${QUICKJS_COMPILE_DEFINITIONS}"
    COMPILE_OPTIONS "-Wno-unused-but-set-variable")

# ── Board and version metadata ──────────────────────────────────────
file(READ "${CMAKE_CURRENT_LIST_DIR}/../../package.json" _MIK_PACKAGE)
string(JSON _MIK_VERSION GET "${_MIK_PACKAGE}" version)
target_compile_definitions(${COMPONENT_LIB} PRIVATE "MIK_FW_VERSION=\"${_MIK_VERSION}\"")
# Core runtime owns the bare `native:mikro/*` namespace. MIK_PACKAGE_NAME makes
# MIK_REGISTER_MODULE enforce that every native module here is named
# "native:mikro/<module>"; a package's native module sets its package name.
target_compile_definitions(${COMPONENT_LIB} PRIVATE "MIK_PACKAGE_NAME=\"mikro\"")
# The version is read at configure time, so configure must re-run when the
# firmware package version changes — otherwise an incremental idf.py build
# flashes a binary that still reports the stale MIK_FW_VERSION.
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS
    "${CMAKE_CURRENT_LIST_DIR}/../../package.json")

# Firmware identity: the name in the nearest package.json at or above the
# project (the app's, for a firmware folder inside an app), reported in
# MSG_READY as `fw`. The CLI only auto-flashes its bundled prebuilt over a
# device whose identity matches the prebuilt's own recorded name, so custom
# firmware is protected from the auto-reflash without any project marker.
# Absent (no package.json, or no name in the nearest one) the field is omitted.
set(_MIK_FW_NAME "")
set(_MIK_FW_DIR "${CMAKE_SOURCE_DIR}")
while(NOT EXISTS "${_MIK_FW_DIR}/package.json")
    get_filename_component(_MIK_FW_PARENT "${_MIK_FW_DIR}" DIRECTORY)
    if(_MIK_FW_PARENT STREQUAL _MIK_FW_DIR)
        break()
    endif()
    set(_MIK_FW_DIR "${_MIK_FW_PARENT}")
endwhile()
if(EXISTS "${_MIK_FW_DIR}/package.json")
    file(READ "${_MIK_FW_DIR}/package.json" _MIK_PROJECT_PACKAGE)
    string(JSON _MIK_FW_NAME ERROR_VARIABLE _MIK_FW_NAME_ERROR
        GET "${_MIK_PROJECT_PACKAGE}" name)
    if(_MIK_FW_NAME_ERROR)
        set(_MIK_FW_NAME "")
    endif()
    set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS
        "${_MIK_FW_DIR}/package.json")
endif()
# STREQUAL, not if(_MIK_FW_NAME): a project named "0", "off", or "false"
# would read as a false constant and silently lose its identity.
if(NOT _MIK_FW_NAME STREQUAL "")
    target_compile_definitions(${COMPONENT_LIB} PRIVATE "MIK_FW_NAME=\"${_MIK_FW_NAME}\"")
endif()

# UTC build timestamp. `string(TIMESTAMP ... UTC)` honors SOURCE_DATE_EPOCH
# when set. Refreshes on re-configure only (idf.py triggers this on each
# build via its own reconfigure step, so in practice it's close to
# build-fresh on ESP-IDF).
string(TIMESTAMP _MIK_BUILD_DATE_UTC "%Y-%m-%dT%H:%M:%SZ" UTC)
target_compile_definitions(${COMPONENT_LIB} PRIVATE "MIK_BUILD_DATE_UTC=\"${_MIK_BUILD_DATE_UTC}\"")

# Board name from MIKROJS_BOARD env var (set by CI or developer)
if(DEFINED ENV{MIKROJS_BOARD})
    # The registry rejects a check-in whose board name has another shape, and
    # the device keeps it in a 48-byte buffer: a bad name means no OTA updates.
    string(LENGTH "$ENV{MIKROJS_BOARD}" _MIK_BOARD_NAME_LEN)
    if(NOT "$ENV{MIKROJS_BOARD}" MATCHES "^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$" OR _MIK_BOARD_NAME_LEN GREATER 47)
        message(FATAL_ERROR
            "mikrojs: MIKROJS_BOARD is \"$ENV{MIKROJS_BOARD}\". A board name has at most 47 "
            "characters: lowercase letters, digits, '.' and '-', and it starts and ends with a "
            "letter or digit.")
    endif()
    target_compile_definitions(${COMPONENT_LIB} PRIVATE "MIK_BOARD_NAME=\"$ENV{MIKROJS_BOARD}\"")
endif()

# ── Module lists derived from runtime/modules.json ───────────────────
# Feature gating for the derived lists: ble-gated modules compile only when
# NimBLE is available (see _MIK_BLE_SRCS above), wifi-gated ones only under
# CONFIG_MIKROJS_WIFI (see _MIK_WIFI_SRCS).
if(CONFIG_BT_ENABLED)
    set(_MIK_BLE_FLAG "--ble=on")
else()
    set(_MIK_BLE_FLAG "--ble=off")
endif()
if(CONFIG_MIKROJS_WIFI)
    set(_MIK_WIFI_FLAG "--wifi=on")
else()
    set(_MIK_WIFI_FLAG "--wifi=off")
endif()

execute_process(
    COMMAND node "${MIK_SCRIPTS_DIR}/modules-list.js" ${_MIK_BLE_FLAG} ${_MIK_WIFI_FLAG}
    OUTPUT_VARIABLE _MIK_LISTS
    OUTPUT_STRIP_TRAILING_WHITESPACE
    RESULT_VARIABLE _MIK_LISTS_RESULT
)
if(NOT _MIK_LISTS_RESULT EQUAL 0)
    message(FATAL_ERROR "modules-list.js failed")
endif()
string(JSON _MIK_FEATURES GET "${_MIK_LISTS}" features)
string(JSON _MIK_MODULES GET "${_MIK_LISTS}" native)
string(JSON _MIK_BYTECODE_MODULES GET "${_MIK_LISTS}" bytecode)

# Firmware feature list (e.g. "wifi,i2s,ble"), reported in MSG_READY so the
# host knows which feature-gated builtins this firmware carries.
string(REPLACE ";" "," _MIK_FEATURES "${_MIK_FEATURES}")
target_compile_definitions(${COMPONENT_LIB} PRIVATE "MIK_FW_FEATURES=\"${_MIK_FEATURES}\"")
# The lists are read at configure time, so configure must re-run when the
# table or the script changes.
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS
    "${MIK_RUNTIME_DIR}/modules.json"
    "${MIK_SCRIPTS_DIR}/modules-list.js")

# ── Bytecode generation ──────────────────────────────────────────────
include("${MIK_BYTECODE_CMAKE}")

# Force linker to include self-registering native modules
mikrojs_force_include_modules(${_MIK_MODULES})
mikrojs_generate_bytecode(
    RUNTIME_DIR "${MIK_RUNTIME_DIR}"
    MODULES ${_MIK_BYTECODE_MODULES}
    MODULE_PREFIX "mikro"
    SYMBOL_PREFIX "mikro"
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
