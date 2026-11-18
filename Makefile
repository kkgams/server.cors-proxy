NODE ?= node

.PHONY: all serve test clean
all: serve

serve:
	$(NODE) src/local.mjs

test:
	$(NODE) --test test/*.test.mjs

clean:
	$(NODE) scripts/clean.mjs
