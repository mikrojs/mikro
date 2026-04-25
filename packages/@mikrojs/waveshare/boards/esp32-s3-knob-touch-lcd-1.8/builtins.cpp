#include "mikrojs/mikrojs.h"

#include "gen/mik_waveshare_esp32_s3_knob_touch_lcd_1_8.h"

MIK_REGISTER_BUILTIN(waveshare_esp32_s3_knob,
                      "@mikrojs/waveshare/esp32-s3-knob-touch-lcd-1.8",
                      mik_waveshare_esp32_s3_knob_touch_lcd_1_8_bytecode,
                      mik_waveshare_esp32_s3_knob_touch_lcd_1_8_bytecode_size)
