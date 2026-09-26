cmake_minimum_required(VERSION 3.22)

include($ENV{IDF_PATH}/tools/cmake/project.cmake)

# The native modules to compile in, by the names that apps import.
set(MIKROJS_NATIVE_MODULES "@mikrojs-examples/chip-temperature")

# The packages are installed in the example's folder, one level up.
execute_process(
    COMMAND node ${CMAKE_CURRENT_LIST_DIR}/../node_modules/@mikrojs/firmware/resolve.js projectCmakePath
    OUTPUT_VARIABLE _MIK_CMAKE
    OUTPUT_STRIP_TRAILING_WHITESPACE
)
include(${_MIK_CMAKE})

project(chip-temperature)
