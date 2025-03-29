idf_component_register(
        INCLUDE_DIRS "include"
        REQUIRES quickjs littlefs driver
        SRCS
        "builtins.cpp"
        "dbuf.cpp"
        "ujs_fs.cpp"
        "ujs_gpio.cpp"
        "fs.cpp"
        "mem.cpp"
        "microjs.cpp"
        "modules.cpp"
        "timers.cpp"
        "utils.cpp"
)

