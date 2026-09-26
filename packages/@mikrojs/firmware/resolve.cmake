# resolve.cmake — the firmware configure's one Node call
#
# `mikro-fw inputs` (src/cli.ts) finds @mikrojs/quickjs and @mikrojs/native
# with Node's package resolution and resolves the declared native modules
# (src/inputs.ts).
# project.cmake includes this file. A project that uses the mikrojs component
# without project.cmake (the on-device test apps) includes it itself.
#
# Reads _MIK_NATIVE_MODULES; unset means no native modules. Sets the MIK_*
# paths for the mikrojs component, and _BOARD_* for project.cmake.

# Resolve from the consuming project (CMAKE_SOURCE_DIR), not this file's
# directory — while include()d, CMAKE_CURRENT_LIST_DIR is the @mikrojs/firmware
# package inside node_modules.
execute_process(
    COMMAND node "${CMAKE_CURRENT_LIST_DIR}/bin/mikro-fw.js" inputs "${CMAKE_SOURCE_DIR}"
            "--native-modules=${_MIK_NATIVE_MODULES}"
    OUTPUT_VARIABLE _MIK_INPUTS
    ERROR_VARIABLE _MIK_INPUTS_ERROR
    RESULT_VARIABLE _MIK_INPUTS_RESULT
    OUTPUT_STRIP_TRAILING_WHITESPACE
)
if(NOT _MIK_INPUTS_RESULT EQUAL 0)
    message(FATAL_ERROR "mikrojs: native module resolution failed:\n${_MIK_INPUTS_ERROR}")
endif()
string(JSON MIK_QUICKJS_CMAKE GET "${_MIK_INPUTS}" quickjsCmake)
string(JSON MIK_INCLUDE_DIR GET "${_MIK_INPUTS}" native include)
string(JSON MIK_SRC_DIR GET "${_MIK_INPUTS}" native src)
string(JSON MIK_RUNTIME_DIR GET "${_MIK_INPUTS}" native runtime)
string(JSON MIK_SCRIPTS_DIR GET "${_MIK_INPUTS}" native scripts)
string(JSON MIK_BYTECODE_CMAKE GET "${_MIK_INPUTS}" native bytecodeCmake)
string(JSON _BOARD_COMPONENT_DIRS GET "${_MIK_INPUTS}" components)
string(JSON _BOARD_INPUTS GET "${_MIK_INPUTS}" configureDepends)
# Re-run the resolution when a file it read changes: a reinstall that moved a
# package, or an export that now points elsewhere.
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS ${_BOARD_INPUTS})
