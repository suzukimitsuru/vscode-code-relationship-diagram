CC = gcc
CFLAGS = -g -std=c11 -Wall -Wextra
INCLUDES = -Iinclude
SRCDIR = src
BUILDDIR = build
SOURCES = $(wildcard $(SRCDIR)/*.c)
OBJECTS = $(SOURCES:$(SRCDIR)/%.c=$(BUILDDIR)/%.o)
TARGET = $(BUILDDIR)/main

.PHONY: all clean debug

all: $(TARGET)

$(TARGET): $(OBJECTS) | $(BUILDDIR)
	$(CC) $(OBJECTS) -o $@ -lm

$(BUILDDIR)/%.o: $(SRCDIR)/%.c | $(BUILDDIR)
	$(CC) $(CFLAGS) $(INCLUDES) -c $< -o $@

$(BUILDDIR):
	mkdir -p $(BUILDDIR)

debug: CFLAGS += -DDEBUG
debug: $(TARGET)

clean:
	rm -rf $(BUILDDIR)

run: $(TARGET)
	./$(TARGET)

# 依存関係を自動生成
-include $(OBJECTS:.o=.d)

$(BUILDDIR)/%.d: $(SRCDIR)/%.c | $(BUILDDIR)
	@$(CC) $(INCLUDES) -MM $< | sed 's|^|$(BUILDDIR)/|' > $@