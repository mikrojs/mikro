#include <cstring>
#include <string>

#include "mikrojs/mikrojs.h"
#include "mikrojs/private.h"
#include "mikrojs/utils.h"

/* Runtime-wide exclusive GPIO pin claims. Only touched from the JS task, so no
 * locking. Owners are static strings, so the table never frees anything. */

#define MIK__GPIO_MAX 64

static const char* s_owner[MIK__GPIO_MAX] = {};

static bool mik__gpio_tracked(int gpio) {
    return gpio >= 0 && gpio < MIK__GPIO_MAX;
}

bool MIK_ClaimGpio(int gpio, const char* owner) {
    if (!owner) return false;
    if (!mik__gpio_tracked(gpio)) return true;
    if (s_owner[gpio]) return false;
    s_owner[gpio] = owner;
    return true;
}

void MIK_ReleaseGpio(int gpio, const char* owner) {
    /* A stale release from one module must not free another module's claim. */
    if (owner && mik__gpio_tracked(gpio) && s_owner[gpio] && strcmp(s_owner[gpio], owner) == 0) {
        s_owner[gpio] = nullptr;
    }
}

const char* MIK_GpioOwner(int gpio) {
    return mik__gpio_tracked(gpio) ? s_owner[gpio] : nullptr;
}

/* Owners are class names ("by Pwm"), except the console ("by the console"). */
static std::string mik__gpio_in_use_message(int gpio, const char* owner) {
    std::string message = "GPIO " + std::to_string(gpio) + " is already in use by ";
    if (strcmp(owner, "console") == 0) message += "the ";
    return message + owner;
}

JSValue mik__claim_gpios(JSContext* ctx, const int* gpios, int count, const char* owner) {
    for (int i = 0; i < count; i++) {
        if (MIK_ClaimGpio(gpios[i], owner)) continue;
        const char* holder = MIK_GpioOwner(gpios[i]);
        JSValue error = JS_NewObject(ctx);
        JS_SetPropertyStr(ctx, error, "name", JS_NewString(ctx, "GpioInUse"));
        JS_SetPropertyStr(ctx, error, "owner", JS_NewString(ctx, holder));
        std::string message = mik__gpio_in_use_message(gpios[i], holder);
        JS_SetPropertyStr(ctx, error, "message",
                          JS_NewStringLen(ctx, message.data(), message.size()));
        mik__release_gpios(gpios, i, owner);
        return mik__result_err_obj(ctx, error);
    }
    return JS_UNDEFINED;
}

void mik__release_gpios(const int* gpios, int count, const char* owner) {
    for (int i = 0; i < count; i++) MIK_ReleaseGpio(gpios[i], owner);
}

JSValue mik__throw_gpio_in_use(JSContext* ctx, int gpio) {
    std::string message = mik__gpio_in_use_message(gpio, MIK_GpioOwner(gpio));
    return JS_ThrowInternalError(ctx, "%s", message.c_str());
}
