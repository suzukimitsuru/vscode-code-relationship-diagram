#include "../include/math_utils.h"
#include "../include/string_utils.h"
#include <stdio.h>
#include <stdlib.h>

int main() {
    printf("=== C Language Reference Test ===\n\n");
    
    // 数学関数のテスト
    printf("Math Operations:\n");
    int a = 10, b = 5;
    int sum = add(a, b);
    int product = multiply(a, b);
    
    printf("a = %d, b = %d\n", a, b);
    print_result("Addition", (double)sum);
    print_result("Multiplication", (double)product);
    
    // 円の面積計算
    double radius = 3.5;
    double area = calculate_area(radius);
    print_result("Circle area (radius=3.5)", area);
    
    // 点の距離計算
    Point p1 = {0.0, 0.0};
    Point p2 = {3.0, 4.0};
    double dist = distance(p1, p2);
    print_result("Distance between points", dist);
    
    // 複合計算
    double complex_result = complex_calculation(15, 25);
    print_result("Complex calculation", complex_result);
    
    printf("\nString Operations:\n");
    
    // 文字列操作のテスト
    const char* test_string = "Hello, World!";
    print_string_info(test_string);
    
    // 複数文字列の統計
    const char* strings[] = {
        "apple",
        "banana", 
        "cherry",
        "date"
    };
    int string_count = sizeof(strings) / sizeof(strings[0]);
    
    printf("\nString Statistics:\n");
    string_statistics(strings, string_count);
    
    // 文字列比較
    printf("\nString Comparison:\n");
    int comparison = string_compare("apple", "banana");
    printf("Compare \"apple\" vs \"banana\": %d\n", comparison);
    
    return 0;
}