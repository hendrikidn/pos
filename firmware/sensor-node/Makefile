# Membangun alat uji untuk inti firmware di komputer (tanpa perangkat keras).
BUILD ?= build
CC ?= cc
CFLAGS ?= -std=c99 -Wall -Wextra -Werror -O1 -g
CORE = core/sha256.c core/ld2410.c core/detector.c core/chain.c core/b64.c core/spki.c core/fw.c

all: $(BUILD)/gen_events $(BUILD)/replay $(BUILD)/sigtool

$(BUILD)/gen_events: tools/gen_events.c $(CORE)
	@mkdir -p $(BUILD)
	$(CC) $(CFLAGS) -o $@ tools/gen_events.c $(CORE)

$(BUILD)/replay: tools/replay.c $(CORE)
	@mkdir -p $(BUILD)
	$(CC) $(CFLAGS) -o $@ tools/replay.c $(CORE)

clean:
	rm -rf $(BUILD)

# micro-ecc (khusus uji; pihak ketiga, tanpa -Werror) dan alat uji tanda tangan/OTA.
$(BUILD)/uecc.o: test-vendor/micro-ecc/uECC.c
	@mkdir -p $(BUILD)
	$(CC) -std=c99 -O1 -w -c -o $@ test-vendor/micro-ecc/uECC.c

$(BUILD)/sigtool: tools/sigtool.c $(CORE) $(BUILD)/uecc.o
	@mkdir -p $(BUILD)
	$(CC) $(CFLAGS) -o $@ tools/sigtool.c $(CORE) $(BUILD)/uecc.o
