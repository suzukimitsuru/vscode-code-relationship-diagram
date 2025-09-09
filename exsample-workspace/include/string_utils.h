#ifndef STRING_UTILS_H
#define STRING_UTILS_H

#include <stddef.h>

// 文字列操作関数の宣言
size_t string_length(const char* str);
char* string_copy(char* dest, const char* src);
int string_compare(const char* str1, const char* str2);
void print_string_info(const char* str);

// 文字列バッファサイズ
#define MAX_STRING_LENGTH 256

#endif // STRING_UTILS_H