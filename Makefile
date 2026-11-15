NODE ?= node

.PHONY: serve test clean
serve:
	$(NODE) src/local.mjs

test:
	$(NODE) --test test/*.test.mjs

clean:
	$(NODE) scripts/clean.mjs
