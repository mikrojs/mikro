# project.cmake — reusable CMake module for mikrojs firmware projects
#
# Usage in user's CMakeLists.txt:
#   cmake_minimum_required(VERSION 3.22)
#   include($ENV{IDF_PATH}/tools/cmake/project.cmake)
#   execute_process(
#       COMMAND npx --no --package=@mikrojs/firmware -- mikro-fw cmake-path esp32
#       WORKING_DIRECTORY ${CMAKE_CURRENT_LIST_DIR}
#       OUTPUT_VARIABLE _MIK_CMAKE_PATH OUTPUT_STRIP_TRAILING_WHITESPACE
#       COMMAND_ERROR_IS_FATAL ANY)
#   include(${_MIK_CMAKE_PATH})
#   project(my-firmware)

# ── Validate ESP-IDF version ─────────────────────────────────────────
if(IDF_VERSION_MAJOR LESS 6 OR
   (IDF_VERSION_MAJOR EQUAL 6 AND IDF_VERSION_MINOR LESS 1))
    message(FATAL_ERROR
        "mikrojs requires ESP-IDF >= 6.1, found ${IDF_VERSION_MAJOR}.${IDF_VERSION_MINOR}.${IDF_VERSION_PATCH}. "
        "Install a supported version via EIM: https://docs.espressif.com/projects/esp-idf/en/stable/esp32/get-started/index.html"
    )
endif()

add_compile_options($<$<COMPILE_LANGUAGE:C>:-Wno-incompatible-pointer-types>)
add_compile_options(-Wno-format)

# ── Firmware package paths ───────────────────────────────────────────
# The package is this file's directory, as a real path (node_modules links
# into the pnpm store), so its sources compile under one path.
file(REAL_PATH "${CMAKE_CURRENT_LIST_DIR}" _MIK_CONFIG_DIR)
set(_MIK_COMPONENT_DIR "${_MIK_CONFIG_DIR}/components")
set(_MIK_DEFAULT_APP_DIR "${_MIK_CONFIG_DIR}/default-app")

# ── Native modules ───────────────────────────────────────────────────
# MIKROJS_NATIVE_MODULES lists the native modules to compile in, by import
# specifier. Precedence: -D on the command line (cache) > environment > set()
# in the project.
if(DEFINED CACHE{MIKROJS_NATIVE_MODULES})
    set(_MIK_NATIVE_MODULES "$CACHE{MIKROJS_NATIVE_MODULES}")
elseif(DEFINED ENV{MIKROJS_NATIVE_MODULES})
    set(_MIK_NATIVE_MODULES "$ENV{MIKROJS_NATIVE_MODULES}")
else()
    set(_MIK_NATIVE_MODULES "${MIKROJS_NATIVE_MODULES}")
endif()

# The package paths for the mikrojs component, and the native modules
# resolved from _MIK_NATIVE_MODULES.
include("${CMAKE_CURRENT_LIST_DIR}/resolve.cmake")
# ESP-IDF names a component after its directory and keeps one of two with
# the same name, so a native module directory named like an ESP-IDF component
# (json, console, usb) would silently replace it, and one named like a
# project component would silently be replaced.
foreach(_dir IN LISTS _BOARD_COMPONENT_DIRS)
    get_filename_component(_name "${_dir}" NAME)
    if(NOT "$ENV{IDF_PATH}" STREQUAL "" AND EXISTS "$ENV{IDF_PATH}/components/${_name}")
        message(FATAL_ERROR
            "mikrojs: the native module in ${_dir} is named \"${_name}\", like an ESP-IDF "
            "component, and would replace it. Rename its directory.")
    endif()
    foreach(_own IN ITEMS "${CMAKE_SOURCE_DIR}/components/${_name}"
                          "${CMAKE_SOURCE_DIR}/managed_components/${_name}")
        if(EXISTS "${_own}")
            message(FATAL_ERROR
                "mikrojs: the native module in ${_dir} is named \"${_name}\", like the "
                "project's component ${_own}, and one would replace the other. Rename one of "
                "the directories.")
        endif()
    endforeach()
endforeach()

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

# Partition table: copy the source csv into the build dir and point the
# config at it, project-relative when possible (ESP-IDF resolves a relative
# value against the project dir). Writing the resolved package path directly
# would freeze an absolute node_modules/store path into sdkconfig — sdkconfig
# wins over defaults files, so every @mikrojs/firmware upgrade would then
# break the build with a missing-partitions.csv error pointing at a version
# that is no longer installed.
if(EXISTS "${CMAKE_SOURCE_DIR}/partitions.csv")
    set(_PARTITION_SRC "${CMAKE_SOURCE_DIR}/partitions.csv")
else()
    set(_PARTITION_SRC "${_MIK_CONFIG_DIR}/partitions.csv")
endif()
configure_file("${_PARTITION_SRC}" "${CMAKE_BINARY_DIR}/partitions.csv" COPYONLY)
file(RELATIVE_PATH _PARTITION_CSV "${CMAKE_SOURCE_DIR}" "${CMAKE_BINARY_DIR}/partitions.csv")
if(_PARTITION_CSV MATCHES "^\\.\\.")
    # Build dir outside the project (idf.py -B): absolute path, still stable
    # across package upgrades, and the heal below re-points it if it moves.
    set(_PARTITION_CSV "${CMAKE_BINARY_DIR}/partitions.csv")
endif()
set(_PARTITION_FRAGMENT "${CMAKE_BINARY_DIR}/sdkconfig.partitions")
file(WRITE "${_PARTITION_FRAGMENT}" "CONFIG_PARTITION_TABLE_CUSTOM_FILENAME=\"${_PARTITION_CSV}\"\n")
list(APPEND _SDKCONFIG_LIST "${_PARTITION_FRAGMENT}")

# Heal an sdkconfig whose frozen path points outside the project: a stale
# resolved package path, or a build dir that moved. Must fire even when the
# frozen file still exists — an older package version often is still in the
# store, and its old partition table would be built silently. Paths inside
# the project are deliberate menuconfig overrides and are left alone.
if(EXISTS "${CMAKE_SOURCE_DIR}/sdkconfig")
    file(READ "${CMAKE_SOURCE_DIR}/sdkconfig" _SDKCONFIG_CONTENT)
    string(REGEX MATCH "CONFIG_PARTITION_TABLE_CUSTOM_FILENAME=\"([^\"]*)\"" _PARTITION_MATCH "${_SDKCONFIG_CONTENT}")
    if(_PARTITION_MATCH AND NOT CMAKE_MATCH_1 STREQUAL "${_PARTITION_CSV}")
        set(_PARTITION_FROZEN "${CMAKE_MATCH_1}")
        get_filename_component(_PARTITION_FROZEN_ABS "${_PARTITION_FROZEN}" ABSOLUTE BASE_DIR "${CMAKE_SOURCE_DIR}")
        string(FIND "${_PARTITION_FROZEN_ABS}" "${CMAKE_SOURCE_DIR}/" _PARTITION_INSIDE)
        if(NOT _PARTITION_INSIDE EQUAL 0)
            string(REGEX REPLACE "CONFIG_PARTITION_TABLE_CUSTOM_FILENAME=\"[^\"]*\""
                   "CONFIG_PARTITION_TABLE_CUSTOM_FILENAME=\"${_PARTITION_CSV}\""
                   _SDKCONFIG_CONTENT "${_SDKCONFIG_CONTENT}")
            # The derived twin should be recomputed by kconfgen, but rewrite it
            # too: if it kept the saved value the build breaks the same way.
            string(REGEX REPLACE "CONFIG_PARTITION_TABLE_FILENAME=\"[^\"]*\""
                   "CONFIG_PARTITION_TABLE_FILENAME=\"${_PARTITION_CSV}\""
                   _SDKCONFIG_CONTENT "${_SDKCONFIG_CONTENT}")
            file(WRITE "${CMAKE_SOURCE_DIR}/sdkconfig" "${_SDKCONFIG_CONTENT}")
            message(WARNING
                "mikrojs: sdkconfig CONFIG_PARTITION_TABLE_CUSTOM_FILENAME pointed outside "
                "the project (\"${_PARTITION_FROZEN}\"); repointed at \"${_PARTITION_CSV}\"")
        endif()
    endif()
endif()

# Native module components, and the board's sdkconfig defaults.
if(_BOARD_COMPONENT_DIRS)
    set(EXTRA_COMPONENT_DIRS "${EXTRA_COMPONENT_DIRS};${_BOARD_COMPONENT_DIRS}")
endif()
if(_BOARD_SDKCONFIG_DEFAULTS)
    list(APPEND _SDKCONFIG_LIST "${_BOARD_SDKCONFIG_DEFAULTS}")
endif()

set(SDKCONFIG_DEFAULTS "${_SDKCONFIG_LIST}")
