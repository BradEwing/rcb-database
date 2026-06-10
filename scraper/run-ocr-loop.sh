#!/usr/bin/env bash
# Run `history-ocr` in fresh-process batches so the tesseract.js per-recognize
# memory leak (which is NOT released by worker-pool teardown and grows the V8 main
# heap to OOM/GC-thrash over a long run) is fully reclaimed by *process exit*
# between batches. Each batch processes OCR_BATCH not-yet-attempted reports, flushes
# mar_history.csv + ocr_attempted.txt, then exits; this loop relaunches a fresh
# process that resumes from disk. The final batch (todo=0) runs the QA gate and
# emits history.ocr.done. Resumable and idempotent.
#
# Usage: scraper/run-ocr-loop.sh   (typically: nohup … &, with a caffeinate -ism attached)
set -uo pipefail
export PATH="$HOME/.local/node/bin:$PATH"
cd "$(dirname "$0")/.."

BATCH="${OCR_BATCH:-1000}"
HEAP="${OCR_HEAP_MB:-8192}"
ATT=data/history/ocr_attempted.txt

prev=-1
for i in $(seq 1 500); do
  cur=$( [ -f "$ATT" ] && sort -u "$ATT" | wc -l | tr -d ' ' || echo 0 )
  echo "=== [$(date '+%Y-%m-%d %H:%M:%S')] batch $i — $cur handles attempted so far ==="
  if [ "$cur" -eq "$prev" ]; then
    echo "no new handles attempted in the last batch → OCR complete"
    break
  fi
  prev=$cur
  NODE_OPTIONS="--max-old-space-size=${HEAP}" OCR_WORKERS="${OCR_WORKERS:-10}" \
    npm run scraper -- history-ocr "$BATCH"
  echo "--- batch $i exited (rc=$?) at $(date '+%H:%M:%S') ---"
done
echo "=== ocr-loop finished at $(date) ==="
