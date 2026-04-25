idf_component_register(SRCS "main_test.cpp"
        INCLUDE_DIRS ".")

littlefs_create_partition_image(littlefs ../flash_data FLASH_IN_PROJECT)