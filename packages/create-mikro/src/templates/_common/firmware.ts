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

# Ask @mikrojs/firmware for the path of its project.cmake
execute_process(
    COMMAND npx --no --package=@mikrojs/firmware -- mikro-fw cmake-path esp32
    WORKING_DIRECTORY \${CMAKE_CURRENT_LIST_DIR}
    OUTPUT_VARIABLE _MIK_CMAKE_PATH
    OUTPUT_STRIP_TRAILING_WHITESPACE
    COMMAND_ERROR_IS_FATAL ANY
)
include(\${_MIK_CMAKE_PATH})

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
