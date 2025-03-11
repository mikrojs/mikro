idf_component_register(
        INCLUDE_DIRS "include"
        REQUIRES quickjs
        SRCS
        "builtins.cpp"
        "dbuf.cpp"
        "fs.cpp"
        "mem.cpp"
        "microjs.cpp"
        "modules.cpp"
        "timers.cpp"
        "utils.cpp"
)

