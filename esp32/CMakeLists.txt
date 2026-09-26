# The following lines of boilerplate have to be in your project's
# CMakeLists in this exact order for cmake to work correctly
cmake_minimum_required(VERSION 3.22)

if (DEFINED ENV{CLION_IDE} AND "$ENV{CLION_IDE}" STREQUAL "TRUE" AND NOT DEFINED ENV{IDF_PATH})
    message(FATAL_ERROR "Environment variable `IDF_PATH` not set. Make sure CLion is started from the terminal e.g `clion .`")
endif ()

include($ENV{IDF_PATH}/tools/cmake/project.cmake)

# The official generic image for the target chip; @mikrojs/firmware ships it
# under this name.
set(MIKROJS_BOARD_NAME "${IDF_TARGET}-generic")
set(MIKROJS_BOARD_DESCRIPTION "Generic ${IDF_TARGET} board")

# mikrojs project setup: validates ESP-IDF version, compiles in the listed native modules.
if(NOT DEFINED MikroFirmware_DIR)
    message(FATAL_ERROR "Build with `mikro idf`, which tells CMake where @mikrojs/firmware is")
endif()
find_package(MikroFirmware REQUIRED COMPONENTS esp32 NO_DEFAULT_PATH)

project(mikrojs)
