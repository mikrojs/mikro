#include "mikrojs/mik_color.h"

struct AnsiCode {
    const char* open;
    const char* close;
};

/* ANSI color codes matching colors.ts ANSI_COLORS */
static const AnsiCode THEME_CODES[] = {
    [MIK_TOKEN_ANNOTATION] = {"36", "0"},     // cyan
    [MIK_TOKEN_BOOLEAN] = {"35", "0"},         // magenta
    [MIK_TOKEN_COMMENT] = {"90", "39"},        // grey
    [MIK_TOKEN_DATE] = {"35", "0"},            // magenta (stylize uses 'date' -> magenta in STYLES)
    [MIK_TOKEN_ERROR] = {"31;1", "0"},         // bright_red
    [MIK_TOKEN_WARNING] = {"33", "0"},         // yellow
    [MIK_TOKEN_FUNCTION] = {"36", "0"},        // cyan
    [MIK_TOKEN_IDENTIFIER] = {"32;1", "0"},    // bright_green
    [MIK_TOKEN_KEYWORD] = {"37;1", "0"},       // bright_white
    [MIK_TOKEN_NULL] = {"1", "22"},            // bold
    [MIK_TOKEN_NUMBER] = {"33", "0"},          // yellow
    [MIK_TOKEN_OTHER] = {"37", "0"},           // white
    [MIK_TOKEN_REGEXP] = {"31", "0"},          // red
    [MIK_TOKEN_STRING] = {"32", "0"},          // green
    [MIK_TOKEN_SYMBOL] = {"32", "0"},          // green
    [MIK_TOKEN_TYPE] = {"35;1", "0"},          // bright_magenta
    [MIK_TOKEN_UNDEFINED] = {"90", "39"},      // grey
    [MIK_TOKEN_BIGINT] = {"33", "0"},          // yellow (bigint -> yellow in STYLES)
    [MIK_TOKEN_RESULT] = {"90", "39"},         // grey
};

std::string mik_colorize(MikThemeToken token, std::string_view value) {
    if (token < 0 || token >= MIK_TOKEN__COUNT) {
        return std::string(value);
    }
    const auto& code = THEME_CODES[token];
    std::string result;
    result.reserve(value.size() + 12);
    result += "\033[";
    result += code.open;
    result += 'm';
    result += value;
    result += "\033[";
    result += code.close;
    result += 'm';
    return result;
}
