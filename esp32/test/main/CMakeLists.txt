idf_component_register(SRCS "main.cpp"
        INCLUDE_DIRS ".")

littlefs_create_partition_image(littlefs "${_MIK_TEST_DIR}/flash_data" FLASH_IN_PROJECT)
