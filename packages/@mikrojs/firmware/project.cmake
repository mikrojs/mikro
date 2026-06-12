# project.cmake — reusable CMake module for mikrojs firmware projects
#
# Usage in user's CMakeLists.txt:
#   cmake_minimum_required(VERSION 3.22)
#   include($ENV{IDF_PATH}/tools/cmake/project.cmake)
#   execute_process(
#       COMMAND node <path-to>/resolve.js projectCmakePath
#       OUTPUT_VARIABLE _MIK_CMAKE OUTPUT_STRIP_TRAILING_WHITESPACE)
#   include(${_MIK_CMAKE})
#   project(my-firmware)

# ── Validate ESP-IDF version ─────────────────────────────────────────
if(IDF_VERSION_MAJOR LESS 6 OR
   (IDF_VERSION_MAJOR EQUAL 6 AND IDF_VERSION_MINOR EQUAL 0 AND IDF_VERSION_PATCH LESS 1))
    message(FATAL_ERROR
        "mikrojs requires ESP-IDF >= 6.0.1, found ${IDF_VERSION_MAJOR}.${IDF_VERSION_MINOR}.${IDF_VERSION_PATCH}. "
        "Install a supported version via EIM: https://docs.espressif.com/projects/esp-idf/en/stable/esp32/get-started/index.html"
    )
endif()

add_compile_options($<$<COMPILE_LANGUAGE:C>:-Wno-incompatible-pointer-types>)
add_compile_options(-Wno-format)

# resolve.js is next to this file
get_filename_component(_MIK_RESOLVE "${CMAKE_CURRENT_LIST_FILE}" DIRECTORY)
set(_MIK_RESOLVE "${_MIK_RESOLVE}/resolve.js")

# ── Resolve firmware package paths ───────────────────────────────────
execute_process(
    COMMAND node ${_MIK_RESOLVE} componentDir
    OUTPUT_VARIABLE _MIK_COMPONENT_DIR
    OUTPUT_STRIP_TRAILING_WHITESPACE
)

if(NOT _MIK_COMPONENT_DIR)
    message(FATAL_ERROR "@mikrojs/firmware not found. Run 'pnpm install' or 'npm install' first.")
endif()

execute_process(
    COMMAND node ${_MIK_RESOLVE} configDir
    OUTPUT_VARIABLE _MIK_CONFIG_DIR
    OUTPUT_STRIP_TRAILING_WHITESPACE
)
execute_process(
    COMMAND node ${_MIK_RESOLVE} defaultAppDir
    OUTPUT_VARIABLE _MIK_DEFAULT_APP_DIR
    OUTPUT_STRIP_TRAILING_WHITESPACE
)

# ── Board and driver package discovery ───────────────────────────────
# Scan the consuming project's package.json (CMAKE_SOURCE_DIR), not this
# file's directory — while include()d, CMAKE_CURRENT_LIST_DIR is the
# @mikrojs/firmware package inside node_modules.
execute_process(
    COMMAND node ${_MIK_RESOLVE} discover ${CMAKE_SOURCE_DIR}
    OUTPUT_VARIABLE _BOARD_JSON
    OUTPUT_STRIP_TRAILING_WHITESPACE
)

# Start with the mikrojs component dir and default main
set(EXTRA_COMPONENT_DIRS "${_MIK_COMPONENT_DIR}")

# Use the firmware package's default main/ component unless the project has its own
if(NOT EXISTS "${CMAKE_SOURCE_DIR}/main/CMakeLists.txt")
    set(EXTRA_COMPONENT_DIRS "${EXTRA_COMPONENT_DIRS};${_MIK_DEFAULT_APP_DIR}")
endif()

# ── Default sdkconfig and partition table from firmware package ───────
# CMAKE_CURRENT_LIST_DIR is the firmware package (where this file lives).
# CMAKE_SOURCE_DIR is the consuming project (e.g. esp32/).
set(_SDKCONFIG_LIST "")
list(APPEND _SDKCONFIG_LIST "${_MIK_CONFIG_DIR}/sdkconfig.defaults")
if(EXISTS "${_MIK_CONFIG_DIR}/sdkconfig.defaults.${IDF_TARGET}")
    list(APPEND _SDKCONFIG_LIST "${_MIK_CONFIG_DIR}/sdkconfig.defaults.${IDF_TARGET}")
endif()
# Project-level overrides come after firmware defaults (later = higher priority).
if(EXISTS "${CMAKE_SOURCE_DIR}/sdkconfig.defaults")
    list(APPEND _SDKCONFIG_LIST "${CMAKE_SOURCE_DIR}/sdkconfig.defaults")
endif()
if(EXISTS "${CMAKE_SOURCE_DIR}/sdkconfig.defaults.${IDF_TARGET}")
    list(APPEND _SDKCONFIG_LIST "${CMAKE_SOURCE_DIR}/sdkconfig.defaults.${IDF_TARGET}")
endif()

# Partition table: generate a sdkconfig fragment with the absolute path
if(EXISTS "${CMAKE_SOURCE_DIR}/partitions.csv")
    set(_PARTITION_CSV "${CMAKE_SOURCE_DIR}/partitions.csv")
else()
    set(_PARTITION_CSV "${_MIK_CONFIG_DIR}/partitions.csv")
endif()
set(_PARTITION_FRAGMENT "${CMAKE_SOURCE_DIR}/build/sdkconfig.partitions")
file(WRITE "${_PARTITION_FRAGMENT}" "CONFIG_PARTITION_TABLE_CUSTOM_FILENAME=\"${_PARTITION_CSV}\"\n")
list(APPEND _SDKCONFIG_LIST "${_PARTITION_FRAGMENT}")

if(_BOARD_JSON)
    string(JSON _BOARD_COMPONENT_DIRS GET "${_BOARD_JSON}" "components")
    string(JSON _BOARD_SDKCONFIG_DEFAULTS GET "${_BOARD_JSON}" "sdkconfigs")
    if(_BOARD_COMPONENT_DIRS)
        set(EXTRA_COMPONENT_DIRS "${EXTRA_COMPONENT_DIRS};${_BOARD_COMPONENT_DIRS}")
    endif()
    if(_BOARD_SDKCONFIG_DEFAULTS)
        list(APPEND _SDKCONFIG_LIST "${_BOARD_SDKCONFIG_DEFAULTS}")
    endif()
endif()

set(SDKCONFIG_DEFAULTS "${_SDKCONFIG_LIST}")
