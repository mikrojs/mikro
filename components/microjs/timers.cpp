#include <stdint.h>

#include <vector>

#include "quickjs.h"

#define MAX_SAFE_INTEGER (((uint32_t)1 << 31) - 1)

class UJSTimerRegistry {
   public:
    struct TimerEntry {
        uint32_t id;
        // is it an interval or a one-shot timer?
        bool is_interval;
        // original timeout (delay) value
        uint32_t timeout;
        // next deadline, based on system time
        uint32_t next_deadline;
        JSValue func;
        int argc;
        JSValue argv[];
    };

   private:
    std::vector<TimerEntry> timers;
    // note: start at 1 to avoid if (timerId) {...} bugs
    uint32_t id_counter = 0;

   public:
    size_t timerCount() const { return timers.size(); }

    int clearAll(JSContext* ctx) {
        int len = timers.size();
        for (auto timer : timers) {
            unschedule(ctx, timer.id);
        }
        return len;
    }

    void setNextDeadline(uint32_t id, uint32_t next_deadline) {
        for (auto timer : timers) {
            if (timer.id == id) {
                timer.next_deadline = next_deadline;
                return;
            }
        }
    }

    std::vector<TimerEntry> timersDue(uint32_t now) {
        std::vector<TimerEntry> due;
        for (auto timer : timers) {
            if (timer.next_deadline <= now) {
                due.push_back(timer);
            }
        }
        return due;
    }

    uint32_t schedule(JSContext* ctx, JSValue func, int argc, JSValue* argv, uint32_t timeout,
                      bool is_interval, uint32_t next_deadline) {
        id_counter++;

        if (id_counter > MAX_SAFE_INTEGER)
            id_counter = 1;

        auto entry = TimerEntry{
            id_counter, is_interval, timeout, next_deadline, JS_DupValue(ctx, func), argc};

        for (int i = 0; i < argc; i++) entry.argv[i] = JS_DupValue(ctx, argv[i]);

        timers.push_back(entry);
        return entry.id;
    }

    bool unschedule(JSContext* ctx, const uint32_t id) {
        for (auto it = timers.begin(); it != timers.end(); ++it) {
            if (it->id == id) {
                JS_FreeValue(ctx, it->func);
                for (int i = 0; i < it->argc; i++) JS_FreeValue(ctx, it->argv[i]);
                timers.erase(it);
                return true;
            }
        }

        return false;
    }
};
