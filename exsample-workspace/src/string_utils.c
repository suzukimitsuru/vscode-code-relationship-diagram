#include "../include/string_utils.h"
#include "../include/math_utils.h"
#include <stdio.h>
#include <string.h>

// 文字列の長さを取得
size_t string_length(const char* str) {
    if (str == NULL) return 0;
    return strlen(str);
}

// 文字列をコピー
char* string_copy(char* dest, const char* src) {
    if (dest == NULL || src == NULL) return NULL;
    return strcpy(dest, src);
}

// 文字列を比較
int string_compare(const char* str1, const char* str2) {
    if (str1 == NULL || str2 == NULL) return -1;
    return strcmp(str1, str2);
}

// 文字列情報を出力（math_utils.hの関数を参照）
void print_string_info(const char* str) {
    if (str == NULL) {
        printf("String is NULL\n");
        return;
    }
    
    size_t len = string_length(str);
    printf("String: \"%s\"\n", str);
    printf("Length: %zu\n", len);
    
    // math_utils.hの関数を使用
    int doubled_length = multiply((int)len, 2);
    print_result("Doubled length", (double)doubled_length);
}

// 文字列処理の統計情報
void string_statistics(const char* strings[], int count) {
    if (strings == NULL || count <= 0) return;
    
    int total_length = 0;
    for (int i = 0; i < count; i++) {
        if (strings[i] != NULL) {
            total_length = add(total_length, (int)string_length(strings[i]));
        }
    }
    
    print_result("Total length", (double)total_length);
    
    if (count > 0) {
        double average = (double)total_length / count;
        print_result("Average length", average);
    }
}