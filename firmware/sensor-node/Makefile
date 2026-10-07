# Membangun alat uji untuk inti firmware di komputer (tanpa perangkat keras).
BUILD ?= build
CC ?= cc
CFLAGS ?= -std=c99 -Wall -Wextra -Werror -O1 -g
CORE = core/sha256.c core/ld2410.c core/detector.c core/chain.c

all: $(BUILD)/gen_events $(BUILD)/replay

$(BUILD)/gen_events: tools/gen_events.c $(CORE)
	@mkdir -p $(BUILD)
	$(CC) $(CFLAGS) -o $@ tools/gen_events.c $(CORE)

$(BUILD)/replay: tools/replay.c $(CORE)
	@mkdir -p $(BUILD)
	$(CC) $(CFLAGS) -o $@ tools/replay.c $(CORE)

clean:
	rm -rf $(BUILD)
