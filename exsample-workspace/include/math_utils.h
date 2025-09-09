#ifndef MATH_UTILS_H
#define MATH_UTILS_H

// 基本的な数学関数の宣言
int add(int a, int b);
int multiply(int a, int b);
double calculate_area(double radius);
void print_result(const char* operation, double result);

// マクロ定義
#define PI 3.14159265359
#define MAX_VALUE 1000

// 構造体定義
typedef struct {
    double x;
    double y;
} Point;

// 点の距離を計算
double distance(Point p1, Point p2);

#endif // MATH_UTILS_H