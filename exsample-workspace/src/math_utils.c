#include "../include/math_utils.h"
#include <stdio.h>
#include <math.h>

// 加算関数の実装
int add(int a, int b) {
    return a + b;
}

// 乗算関数の実装  
int multiply(int a, int b) {
    return a * b;
}

// 円の面積を計算
double calculate_area(double radius) {
    return PI * radius * radius;
}

// 結果を出力
void print_result(const char* operation, double result) {
    printf("%s result: %.2f\n", operation, result);
}

// 2点間の距離を計算
double distance(Point p1, Point p2) {
    double dx = p2.x - p1.x;
    double dy = p2.y - p1.y;
    return sqrt(dx * dx + dy * dy);
}

// 複合計算関数（他の関数を参照）
double complex_calculation(int x, int y) {
    int sum = add(x, y);
    int product = multiply(x, y);
    double combined = (double)sum + (double)product;
    
    if (combined > MAX_VALUE) {
        combined = MAX_VALUE;
    }
    
    return combined;
}