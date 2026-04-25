#pragma once

#include <string>
#include <string_view>

/* Theme tokens — semantic categories for syntax highlighting */
enum MikThemeToken {
    MIK_TOKEN_ANNOTATION,
    MIK_TOKEN_BOOLEAN,
    MIK_TOKEN_COMMENT,
    MIK_TOKEN_DATE,
    MIK_TOKEN_ERROR,
    MIK_TOKEN_WARNING,
    MIK_TOKEN_FUNCTION,
    MIK_TOKEN_IDENTIFIER,
    MIK_TOKEN_KEYWORD,
    MIK_TOKEN_NULL,
    MIK_TOKEN_NUMBER,
    MIK_TOKEN_OTHER,
    MIK_TOKEN_REGEXP,
    MIK_TOKEN_STRING,
    MIK_TOKEN_SYMBOL,
    MIK_TOKEN_TYPE,
    MIK_TOKEN_UNDEFINED,
    MIK_TOKEN_BIGINT,
    MIK_TOKEN_RESULT,
    MIK_TOKEN__COUNT,
};

/* Colorize a string with ANSI escapes for the given theme token.
 * Returns the input unchanged if the token is invalid. */
std::string mik_colorize(MikThemeToken token, std::string_view value);
