# ESP-IDF component for the @mikrojs-examples/chip-temperature module. A firmware
# includes it when the firmware project lists it in MIKROJS_NATIVE_MODULES.
idf_component_register(
    SRCS "chiptemp.cpp"
    INCLUDE_DIRS "."
    REQUIRES mikrojs esp_driver_tsens
)
# The module registers itself from a static library. Without this, the linker
# drops the object file. The argument is the first argument of
# MIK_REGISTER_PUBLIC_MODULE.
mikrojs_force_include_modules(chiptemp)
target_compile_definitions(${COMPONENT_LIB} PRIVATE "MIK_PACKAGE_NAME=\"@mikrojs-examples/chip-temperature\"")
