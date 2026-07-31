# mikrojs_generate_bytecode() — Reusable CMake function for compiling TypeScript
# runtime modules to QuickJS bytecode headers.
#
# Used by the core runtime, ESP-IDF component, and board/driver packages.
#
# Usage:
#   mikrojs_generate_bytecode(
#       RUNTIME_DIR <path>         # Directory containing <mod>/<mod>.ts files
#       MODULES <mod1> <mod2>      # Module names to compile
#       MODULE_PREFIX <prefix>     # Module name prefix (e.g. "mikro" -> "mikro/pin")
#       SYMBOL_PREFIX <prefix>     # C symbol prefix (e.g. "mikrojs" -> "mikrojs_pin_bytecode")
#       TARGET <name>              # Custom target name (default: gen_bytecode)
#       WORKING_DIRECTORY <dir>    # Working dir for esbuild (default: CMAKE_CURRENT_SOURCE_DIR)
#   )
#
# After calling, the following are set in the caller's scope:
#   ${TARGET}_HEADERS  — list of generated .h file paths
#   ${TARGET}_GEN_DIR  — directory containing the generated headers (include this)

include_guard(GLOBAL)

# Resolve paths relative to this file (inside @mikrojs/native).
# Use CACHE so the path is available across all components that include this file.
get_filename_component(_MIK_BC_CMAKE_DIR "${CMAKE_CURRENT_LIST_FILE}" DIRECTORY)
set(_MIK_BC_SCRIPTS_DIR "${_MIK_BC_CMAKE_DIR}/../scripts" CACHE INTERNAL "")

function(mikrojs_generate_bytecode)
    # FREEZE_ATOMS: compile blobs against a generated frozen atom table so
    # they load zero-copy (JS_READ_OBJ_INPLACE). Core runtime only: the
    # device preloads exactly one table, so board/driver packages must
    # stay classic (they load via the copy-and-relocate fallback).
    cmake_parse_arguments(ARG "FREEZE_ATOMS" "RUNTIME_DIR;MODULE_PREFIX;SYMBOL_PREFIX;TARGET;WORKING_DIRECTORY" "MODULES" ${ARGN})

    # Defaults
    if(NOT ARG_TARGET)
        set(ARG_TARGET "gen_bytecode")
    endif()
    if(NOT ARG_WORKING_DIRECTORY)
        set(ARG_WORKING_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}")
    endif()

    # Validate required args
    if(NOT ARG_RUNTIME_DIR)
        message(FATAL_ERROR "mikrojs_generate_bytecode: RUNTIME_DIR is required")
    endif()
    if(NOT ARG_MODULES)
        message(FATAL_ERROR "mikrojs_generate_bytecode: MODULES is required")
    endif()
    if(NOT ARG_MODULE_PREFIX)
        message(FATAL_ERROR "mikrojs_generate_bytecode: MODULE_PREFIX is required")
    endif()
    if(NOT ARG_SYMBOL_PREFIX)
        message(FATAL_ERROR "mikrojs_generate_bytecode: SYMBOL_PREFIX is required")
    endif()

    # Verify qjsc exists (set by quickjs.cmake)
    if(NOT EXISTS "${QJSC_EXECUTABLE}")
        message(FATAL_ERROR "qjsc not found at ${QJSC_EXECUTABLE}. Run 'pnpm install' first.")
    endif()

    set(_GEN_DIR "${CMAKE_CURRENT_BINARY_DIR}/gen")
    set(_BUNDLE_DIR "${CMAKE_CURRENT_BINARY_DIR}/bundled")

    # Collect source files so the bundle step re-runs when they change.
    # Also track the shell scripts that drive the pipeline so changes to
    # the scripts (e.g. qjsc flag fixes) invalidate the generated outputs
    # and trigger a rebuild — otherwise ninja sees `bundle.stamp` unchanged
    # and silently reuses stale bytecode headers.
    file(GLOB_RECURSE _RUNTIME_SOURCES "${ARG_RUNTIME_DIR}/*.ts")
    set(_BUNDLE_SCRIPT "${_MIK_BC_SCRIPTS_DIR}/bundle-runtime.js")
    set(_COMPILE_SCRIPT "${_MIK_BC_SCRIPTS_DIR}/compile-bytecode.sh")

    # Optional minifier override (e.g. -DMIK_MINIFIER=terser -DMIK_MINIFY_LEVEL=max)
    set(_MINIFIER_ARGS "")
    if(DEFINED MIK_MINIFIER)
        list(APPEND _MINIFIER_ARGS "--minifier=${MIK_MINIFIER}")
    endif()
    if(DEFINED MIK_MINIFY_LEVEL)
        list(APPEND _MINIFIER_ARGS "--minify-level=${MIK_MINIFY_LEVEL}")
    endif()

    # Step 1: Bundle TypeScript runtime modules to JS with esbuild
    add_custom_command(
        OUTPUT ${_BUNDLE_DIR}/bundle.stamp
        COMMAND node ${_BUNDLE_SCRIPT}
            ${_BUNDLE_DIR} ${ARG_RUNTIME_DIR} ${ARG_MODULES} ${_MINIFIER_ARGS}
        COMMAND ${CMAKE_COMMAND} -E touch ${_BUNDLE_DIR}/bundle.stamp
        DEPENDS ${_RUNTIME_SOURCES} ${_BUNDLE_SCRIPT}
        COMMENT "Bundling runtime modules"
        WORKING_DIRECTORY ${ARG_WORKING_DIRECTORY}
    )

    # Steps 2a/2b (FREEZE_ATOMS only): pass-1 raw bytecode per module, then
    # union the atom sections into the frozen atom table (frozen_atoms.bin
    # for qjsc -A, <prefix>_frozen_atoms.h for the runtime preload).
    # Module order fixes the table order.
    set(_ATOMS_BIN "")
    set(_ATOMS_HEADER "")
    if(ARG_FREEZE_ATOMS)
        set(_EXTRACT_SCRIPT "${_MIK_BC_SCRIPTS_DIR}/extract-atoms.js")
        set(_PASS1_BLOBS "")
        foreach(mod ${ARG_MODULES})
            string(REGEX REPLACE "[^a-zA-Z0-9]" "_" _mod_safe "${mod}")
            set(_blob "${_GEN_DIR}/pass1/${_mod_safe}.bjs")
            add_custom_command(
                OUTPUT ${_blob}
                COMMAND ${CMAKE_COMMAND} -E make_directory ${_GEN_DIR}/pass1
                COMMAND sh ${_COMPILE_SCRIPT}
                    ${QJSC_EXECUTABLE}
                    ${_BUNDLE_DIR}/${mod}.js
                    ${_blob}
                    "${ARG_MODULE_PREFIX}/${mod}"
                    "unused"
                DEPENDS ${_BUNDLE_DIR}/bundle.stamp ${_COMPILE_SCRIPT} ${QJSC_EXECUTABLE}
                COMMENT "Bytecode pass 1: ${ARG_MODULE_PREFIX}/${mod}"
            )
            list(APPEND _PASS1_BLOBS ${_blob})
        endforeach()

        set(_ATOMS_BIN "${_GEN_DIR}/frozen_atoms.bin")
        set(_ATOMS_HEADER "${_GEN_DIR}/${ARG_SYMBOL_PREFIX}_frozen_atoms.h")
        add_custom_command(
            OUTPUT ${_ATOMS_BIN} ${_ATOMS_HEADER}
            COMMAND node ${_EXTRACT_SCRIPT} ${_GEN_DIR} ${ARG_SYMBOL_PREFIX} ${_PASS1_BLOBS}
            DEPENDS ${_PASS1_BLOBS} ${_EXTRACT_SCRIPT}
            COMMENT "Extracting frozen atom table"
        )
    endif()

    # Step 2c: Compile each bundled JS file to a bytecode header with qjsc,
    # against the frozen atom table so atom references are final ids
    # (enables zero-copy loading via JS_READ_OBJ_INPLACE).
    set(_HEADERS "")
    foreach(mod ${ARG_MODULES})
        # Sanitize module name for C identifiers (replace non-alphanumeric with _)
        string(REGEX REPLACE "[^a-zA-Z0-9]" "_" _mod_safe "${mod}")
        set(_header "${_GEN_DIR}/${ARG_SYMBOL_PREFIX}_${_mod_safe}.h")
        add_custom_command(
            OUTPUT ${_header}
            COMMAND ${CMAKE_COMMAND} -E make_directory ${_GEN_DIR}
            COMMAND sh ${_COMPILE_SCRIPT}
                ${QJSC_EXECUTABLE}
                ${_BUNDLE_DIR}/${mod}.js
                ${_header}
                "${ARG_MODULE_PREFIX}/${mod}"
                "${ARG_SYMBOL_PREFIX}_${_mod_safe}_bytecode"
                ${_ATOMS_BIN}
            DEPENDS ${_BUNDLE_DIR}/bundle.stamp ${_COMPILE_SCRIPT} ${QJSC_EXECUTABLE} ${_ATOMS_BIN}
            COMMENT "Compiling bytecode: ${ARG_MODULE_PREFIX}/${mod}"
        )
        list(APPEND _HEADERS ${_header})
    endforeach()
    if(_ATOMS_HEADER)
        list(APPEND _HEADERS ${_ATOMS_HEADER})
    endif()

    # Step 3: Generate builtins table header (includes + lookup table)
    set(_TABLE_HEADER "${_GEN_DIR}/${ARG_SYMBOL_PREFIX}_builtins_table.h")
    set(_TABLE_CONTENT "/* Auto-generated by mikrojs_generate_bytecode() — do not edit */\n")
    foreach(mod ${ARG_MODULES})
        string(REGEX REPLACE "[^a-zA-Z0-9]" "_" _mod_safe "${mod}")
        string(APPEND _TABLE_CONTENT "#include \"${ARG_SYMBOL_PREFIX}_${_mod_safe}.h\"\n")
    endforeach()
    string(APPEND _TABLE_CONTENT "\nstatic const mik_builtin_t ${ARG_SYMBOL_PREFIX}_builtins[] = {\n")
    foreach(mod ${ARG_MODULES})
        string(REGEX REPLACE "[^a-zA-Z0-9]" "_" _mod_safe "${mod}")
        string(APPEND _TABLE_CONTENT "    {\"${ARG_MODULE_PREFIX}/${mod}\", ${ARG_SYMBOL_PREFIX}_${_mod_safe}_bytecode, ${ARG_SYMBOL_PREFIX}_${_mod_safe}_bytecode_size},\n")
    endforeach()
    string(APPEND _TABLE_CONTENT "    {NULL, NULL, 0},\n};\n")
    file(GENERATE OUTPUT ${_TABLE_HEADER} CONTENT "${_TABLE_CONTENT}")
    list(APPEND _HEADERS ${_TABLE_HEADER})

    # Step 4: Create custom target
    add_custom_target(${ARG_TARGET} DEPENDS ${_HEADERS})

    # Export to caller's scope
    set(${ARG_TARGET}_HEADERS ${_HEADERS} PARENT_SCOPE)
    set(${ARG_TARGET}_GEN_DIR ${_GEN_DIR} PARENT_SCOPE)
    # Include the parent of gen/ so #include "gen/foo.h" works
    set(${ARG_TARGET}_INCLUDE_DIR ${CMAKE_CURRENT_BINARY_DIR} PARENT_SCOPE)
endfunction()

function(mikrojs_force_include_modules)
    foreach(id ${ARGN})
        target_link_libraries(${COMPONENT_LIB} INTERFACE "-u mik__mod_desc_${id}")
    endforeach()
endfunction()

function(mikrojs_force_include_builtins)
    foreach(id ${ARGN})
        target_link_libraries(${COMPONENT_LIB} INTERFACE "-u mik__builtin_${id}")
    endforeach()
endfunction()
