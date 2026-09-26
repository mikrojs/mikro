# Test project for the mikrojs ESP-IDF component.
# MIKROJS_PROJECT_DIR must be set to the directory containing package.json.
cmake_minimum_required(VERSION 3.22)

if(NOT DEFINED MIKROJS_PROJECT_DIR)
    message(FATAL_ERROR "MIKROJS_PROJECT_DIR must be set to the directory containing package.json")
endif()

include($ENV{IDF_PATH}/tools/cmake/project.cmake)

file(REAL_PATH "${CMAKE_CURRENT_LIST_DIR}/.." _MIK_FIRMWARE_DIR)
set(EXTRA_COMPONENT_DIRS "${_MIK_FIRMWARE_DIR}/components")
# The package paths the mikrojs component builds from
include("${_MIK_FIRMWARE_DIR}/resolve.cmake")

set(TEST_COMPONENTS "mikrojs" CACHE STRING "List of components to test")

add_compile_options($<$<COMPILE_LANGUAGE:C>:-Wno-incompatible-pointer-types>)
add_compile_options(-Wno-format)
add_compile_options(-Wno-missing-field-initializers)

project(mikrojs_test)
