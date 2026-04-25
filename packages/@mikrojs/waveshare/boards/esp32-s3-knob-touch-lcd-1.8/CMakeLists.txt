# Waveshare ESP32-S3-Knob-Touch-LCD-1.8 board component
set(_BOARD_PKG_DIR "${CMAKE_CURRENT_LIST_DIR}/../..")
execute_process(
    COMMAND node -e "import('@mikrojs/native/cmake').then(n=>import('@mikrojs/quickjs').then(q=>process.stdout.write(JSON.stringify({bytecodeCmake:n.bytecodeCmakePath,quickjsCmake:q.cmakePath,runtime:'${CMAKE_CURRENT_LIST_DIR}'}))))"
    WORKING_DIRECTORY ${_BOARD_PKG_DIR}
    OUTPUT_VARIABLE _BOARD_JSON
    OUTPUT_STRIP_TRAILING_WHITESPACE
)
string(JSON _BYTECODE_CMAKE GET "${_BOARD_JSON}" "bytecodeCmake")
string(JSON _QUICKJS_CMAKE GET "${_BOARD_JSON}" "quickjsCmake")
string(JSON _RUNTIME_DIR GET "${_BOARD_JSON}" "runtime")

include("${_QUICKJS_CMAKE}")

idf_component_register(
    SRCS "builtins.cpp"
    REQUIRES driver_sh8601 mikrojs
)

include("${_BYTECODE_CMAKE}")
mikrojs_generate_bytecode(
    RUNTIME_DIR "${_RUNTIME_DIR}"
    MODULES esp32-s3-knob-touch-lcd-1.8
    MODULE_PREFIX "@mikrojs/waveshare"
    SYMBOL_PREFIX "mik_waveshare"
    TARGET gen_waveshare_knob_bytecode
    WORKING_DIRECTORY "${_BOARD_PKG_DIR}"
)
add_dependencies(${COMPONENT_LIB} gen_waveshare_knob_bytecode)
target_include_directories(${COMPONENT_LIB} PRIVATE "${gen_waveshare_knob_bytecode_INCLUDE_DIR}")

mikrojs_force_include_builtins(waveshare_esp32_s3_knob)
