# The following lines of boilerplate have to be in your project's
# CMakeLists in this exact order for cmake to work correctly
cmake_minimum_required(VERSION 3.16)
set(CMAKE_CXX_STANDARD 20)

if (DEFINED ENV{CLION_IDE} AND "$ENV{CLION_IDE}" STREQUAL "TRUE" AND NOT DEFINED ENV{IDF_PATH})
    message(FATAL_ERROR "Environment variable `IDF_PATH` not set. Make sure CLion is started from the terminal e.g `clion .`")
endif ()

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
add_compile_options(-Wno-incompatible-pointer-types)
add_compile_options(-Wno-format)

project(microjs)
