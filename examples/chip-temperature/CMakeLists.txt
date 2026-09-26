cmake_minimum_required(VERSION 3.22)

include($ENV{IDF_PATH}/tools/cmake/project.cmake)

# The native modules to compile in, by the names that apps import.
set(MIKROJS_NATIVE_MODULES "@mikrojs-examples/chip-temperature")

if(NOT DEFINED MikroFirmware_DIR)
    message(FATAL_ERROR "Build with `mikro idf`, which tells CMake where @mikrojs/firmware is")
endif()
find_package(MikroFirmware REQUIRED COMPONENTS esp32 NO_DEFAULT_PATH)

project(chip-temperature)
