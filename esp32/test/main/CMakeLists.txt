idf_component_register(SRCS "main.cpp"
        INCLUDE_DIRS ".")

littlefs_create_partition_image(littlefs ../../node_modules/@mikrojs/firmware/test/flash_data FLASH_IN_PROJECT)
