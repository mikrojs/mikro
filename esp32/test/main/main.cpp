#include <stdio.h>

#include "unity.h"

extern "C" void app_main(void) {
    printf("\n#### Running all tests #####\n");
    UNITY_BEGIN();
    unity_run_all_tests();
    UNITY_END();
}
