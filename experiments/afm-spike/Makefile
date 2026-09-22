# The Apple Foundation Models spike.
#
#   make selftest     the whole Python side, proven with no model anywhere
#   make coverage     the frame's ceiling over the 434 gold canonicals
#   make vocab        regenerate Vocab.swift / Doctrine.swift from the lexicon
#   make build        swift build -c release   (macOS 26 + Xcode 26 only)
#   make teacher      the teacher-forced run, rendered and scored
#   make free         the free-running run, rendered and scored
#
# Every path is relative to this directory. `run-model` is the repository's
# own scorer and is run through cargo from the repository root, unchanged.

REPO    := ../..
MAP     := $(REPO)/crates/evalsuite/grammar/map.json
PY      := python3
BIN     := .build/release/afm-spike
CORPUS  := all
SCORE    = cd $(REPO) && cargo run --release -q -p centraid-candidates \
             --bin run-model -- --corpus all --outputs

.PHONY: all selftest coverage vocab build teacher free clean

all: coverage selftest

coverage:
	$(PY) frame.py

vocab:
	$(PY) gen_vocab.py

check-vocab:
	$(PY) gen_vocab.py --check

selftest: out
	$(PY) render_frames.py --selftest
	$(SCORE) experiments/afm-spike/out/_selftest-gold.jsonl

build:
	swift build -c release

teacher: out
	$(BIN) --map $(MAP) --mode teacher --corpus $(CORPUS) \
	    --out out/afm.teacher.raw.jsonl
	$(PY) render_frames.py --in out/afm.teacher.raw.jsonl \
	    --out out/afm.teacher.jsonl
	$(SCORE) experiments/afm-spike/out/afm.teacher.jsonl
	$(PY) summarise.py --raw out/afm.teacher.raw.jsonl \
	    --rendered out/afm.teacher.jsonl --out out/summary.teacher.md

free: out
	$(BIN) --map $(MAP) --mode free --corpus $(CORPUS) \
	    --renderer render_frames.py --out out/afm.free.raw.jsonl
	$(PY) render_frames.py --in out/afm.free.raw.jsonl \
	    --out out/afm.free.jsonl
	$(SCORE) experiments/afm-spike/out/afm.free.jsonl
	$(PY) summarise.py --raw out/afm.free.raw.jsonl \
	    --rendered out/afm.free.jsonl --out out/summary.free.md

out:
	mkdir -p out

clean:
	rm -rf .build out/*.jsonl out/*.md
