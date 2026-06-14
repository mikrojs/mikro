# ble_test.cpp references mik__ble_consume which is only defined when
# NimBLE (CONFIG_BT_ENABLED) is available. Exclude it for BT-less builds.
set(_MIK_TEST_SRCS
    abort_test.cpp
    fs_js_test.cpp
    fs_pub_test.cpp
    http_test.cpp
    http_server_test.cpp
    i2c_test.cpp
    i2s_test.cpp
    modules_extended_test.cpp
    modules_test.cpp
    pins_test.cpp
    pwm_test.cpp
    repl_protocol_test.cpp
    rtc_test.cpp
    runtime_test.cpp
    sleep_test.cpp
    sntp_test.cpp
    stdio_test.cpp
    sys_test.cpp
    text_encoding_test.cpp
    timers_js_test.cpp
    timers_test.cpp
    udp_test.cpp
    wifi_test.cpp
)
if(CONFIG_BT_ENABLED)
    list(APPEND _MIK_TEST_SRCS ble_test.cpp)
endif()

idf_component_register(SRCS ${_MIK_TEST_SRCS}
        INCLUDE_DIRS "."
        REQUIRES unity mikrojs spi_flash
)
