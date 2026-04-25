# Test project for the mikrojs ESP-IDF component.
# MIKROJS_PROJECT_DIR must be set to the directory containing package.json.
cmake_minimum_required(VERSION 3.22)

if(NOT DEFINED MIKROJS_PROJECT_DIR)
    message(FATAL_ERROR "MIKROJS_PROJECT_DIR must be set to the directory containing package.json")
endif()

include($ENV{IDF_PATH}/tools/cmake/project.cmake)

set(_MIK_RESOLVE "${CMAKE_CURRENT_LIST_DIR}/../resolve.js")

execute_process(
    COMMAND node ${_MIK_RESOLVE} componentDir
    OUTPUT_VARIABLE _MIK_COMPONENT_DIR
    OUTPUT_STRIP_TRAILING_WHITESPACE
)
set(EXTRA_COMPONENT_DIRS "${_MIK_COMPONENT_DIR}")

set(TEST_COMPONENTS "mikrojs" CACHE STRING "List of components to test")

add_compile_options($<$<COMPILE_LANGUAGE:C>:-Wno-incompatible-pointer-types>)
add_compile_options(-Wno-format)
add_compile_options(-Wno-missing-field-initializers)

project(mikrojs_test)
