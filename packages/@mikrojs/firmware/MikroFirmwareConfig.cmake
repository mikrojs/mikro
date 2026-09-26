# find_package(MikroFirmware COMPONENTS esp32 NO_DEFAULT_PATH); `mikro idf` sets MikroFirmware_DIR.
# Without a component the package is only found (esp32/test uses its files itself).

foreach(_mik_family IN LISTS MikroFirmware_FIND_COMPONENTS)
    if(NOT _mik_family STREQUAL "esp32")
        set(MikroFirmware_FOUND FALSE)
        set(MikroFirmware_NOT_FOUND_MESSAGE
            "@mikrojs/firmware has no component \"${_mik_family}\". It builds for: esp32")
        return()
    endif()
endforeach()

if("esp32" IN_LIST MikroFirmware_FIND_COMPONENTS)
    include("${CMAKE_CURRENT_LIST_DIR}/project.cmake")
endif()
