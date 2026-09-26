# The following lines of boilerplate have to be in your project's
# CMakeLists in this exact order for cmake to work correctly
cmake_minimum_required(VERSION 3.22)

if (DEFINED ENV{CLION_IDE} AND "$ENV{CLION_IDE}" STREQUAL "TRUE" AND NOT DEFINED ENV{IDF_PATH})
    message(FATAL_ERROR "Environment variable `IDF_PATH` not set. Make sure CLion is started from the terminal e.g `clion .`")
endif ()

include($ENV{IDF_PATH}/tools/cmake/project.cmake)

# mikrojs project setup: validates ESP-IDF version, compiles in the listed native modules.
# Ask @mikrojs/firmware for the path of its project.cmake
execute_process(
    COMMAND npx --no --package=@mikrojs/firmware -- mikro-fw cmake-path esp32
    WORKING_DIRECTORY ${CMAKE_CURRENT_LIST_DIR}
    OUTPUT_VARIABLE _MIK_CMAKE_PATH
    OUTPUT_STRIP_TRAILING_WHITESPACE
    COMMAND_ERROR_IS_FATAL ANY
)
include(${_MIK_CMAKE_PATH})

project(mikrojs)
