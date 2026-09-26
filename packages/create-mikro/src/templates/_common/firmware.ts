/** CMakeLists.txt next to package.json: the app is its own firmware project,
 *  built with ESP-IDF. The name is a valid npm name ([a-z0-9.-]), which
 *  CMake's project() accepts. */
export function firmwareCmakeLists(projectName: string) {
  return `\
cmake_minimum_required(VERSION 3.22)

include($ENV{IDF_PATH}/tools/cmake/project.cmake)

# The native modules to compile in, by the names that apps import. Separate
# several with ;.
# set(MIKROJS_NATIVE_MODULES "@my-scope/epaper/panel")

if(NOT DEFINED MikroFirmware_DIR)
    message(FATAL_ERROR "Build with \`mikro idf\`, which tells CMake where @mikrojs/firmware is")
endif()
find_package(MikroFirmware REQUIRED COMPONENTS esp32 NO_DEFAULT_PATH)

project(${projectName})
`
}

/** What ESP-IDF writes into the project folder. */
export const firmwareGitignore = `\
managed_components/
dependencies.lock
sdkconfig
sdkconfig.old
`
