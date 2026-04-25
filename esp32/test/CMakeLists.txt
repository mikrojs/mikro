cmake_minimum_required(VERSION 3.22)

include($ENV{IDF_PATH}/tools/cmake/project.cmake)

# Resolve from the parent esp32/ directory which has node_modules
set(_MIK_RESOLVE "${CMAKE_CURRENT_LIST_DIR}/../node_modules/@mikrojs/firmware/resolve.js")

# Resolve mikrojs component from @mikrojs/firmware
execute_process(
    COMMAND node ${_MIK_RESOLVE} componentDir
    OUTPUT_VARIABLE _MIK_COMPONENT_DIR
    OUTPUT_STRIP_TRAILING_WHITESPACE
)
set(EXTRA_COMPONENT_DIRS "${_MIK_COMPONENT_DIR}")

# Test config lives at <firmware-package>/test/
execute_process(
    COMMAND node ${_MIK_RESOLVE} configDir
    OUTPUT_VARIABLE _MIK_CONFIG_DIR
    OUTPUT_STRIP_TRAILING_WHITESPACE
)
set(_MIK_TEST_DIR "${_MIK_CONFIG_DIR}/test")

# Copy partition table to local dir so sdkconfig.defaults relative path works
file(COPY "${_MIK_TEST_DIR}/littlefs_partition.csv" DESTINATION "${CMAKE_CURRENT_LIST_DIR}")
set(SDKCONFIG_DEFAULTS "${_MIK_TEST_DIR}/sdkconfig.defaults")

set(TEST_COMPONENTS "mikrojs" CACHE STRING "List of components to test")

add_compile_options($<$<COMPILE_LANGUAGE:C>:-Wno-incompatible-pointer-types>)
add_compile_options(-Wno-format)
add_compile_options(-Wno-missing-field-initializers)

project(mikrojs_test)
