cmake_minimum_required(VERSION 3.22)

include($ENV{IDF_PATH}/tools/cmake/project.cmake)

# @mikrojs/firmware as the parent esp32/ project installs it, as a real path
# like project.cmake takes it
execute_process(
    COMMAND npx --no --package=@mikrojs/firmware -- mikro-fw cmake-path esp32
    WORKING_DIRECTORY ${CMAKE_CURRENT_LIST_DIR}
    OUTPUT_VARIABLE _MIK_CMAKE_PATH
    OUTPUT_STRIP_TRAILING_WHITESPACE
    COMMAND_ERROR_IS_FATAL ANY
)
get_filename_component(_MIK_FIRMWARE_DIR "${_MIK_CMAKE_PATH}" DIRECTORY)
file(REAL_PATH "${_MIK_FIRMWARE_DIR}" _MIK_FIRMWARE_DIR)
set(EXTRA_COMPONENT_DIRS "${_MIK_FIRMWARE_DIR}/components")
# The package paths the mikrojs component builds from
include("${_MIK_FIRMWARE_DIR}/resolve.cmake")

# Test config lives at <firmware-package>/test/
set(_MIK_TEST_DIR "${_MIK_FIRMWARE_DIR}/test")

# Copy partition table to local dir so sdkconfig.defaults relative path works
file(COPY "${_MIK_TEST_DIR}/littlefs_partition.csv" DESTINATION "${CMAKE_CURRENT_LIST_DIR}")
set(SDKCONFIG_DEFAULTS "${_MIK_TEST_DIR}/sdkconfig.defaults")

# Board overrides from the parent project (e.g. octal PSRAM) apply to test
# builds too; later entries win.
if(EXISTS "${CMAKE_CURRENT_LIST_DIR}/../sdkconfig.defaults")
    list(APPEND SDKCONFIG_DEFAULTS "${CMAKE_CURRENT_LIST_DIR}/../sdkconfig.defaults")
endif()
if(EXISTS "${CMAKE_CURRENT_LIST_DIR}/../sdkconfig.defaults.${IDF_TARGET}")
    list(APPEND SDKCONFIG_DEFAULTS "${CMAKE_CURRENT_LIST_DIR}/../sdkconfig.defaults.${IDF_TARGET}")
endif()

set(TEST_COMPONENTS "mikrojs" CACHE STRING "List of components to test")

add_compile_options($<$<COMPILE_LANGUAGE:C>:-Wno-incompatible-pointer-types>)
add_compile_options(-Wno-format)
add_compile_options(-Wno-missing-field-initializers)

project(mikrojs_test)
