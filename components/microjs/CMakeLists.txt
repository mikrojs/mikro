idf_component_register(
        INCLUDE_DIRS "include"
        REQUIRES quickjs littlefs
        SRCS
        "builtins.cpp"
        "dbuf.cpp"
        "ujs_fs.cpp"
        "fs.cpp"
        "mem.cpp"
        "microjs.cpp"
        "modules.cpp"
        "timers.cpp"
        "utils.cpp"
)

