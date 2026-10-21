# Private uncapped-frame pacing probe

This unadopted patch changes only `BackToBackBeginFrameSource` timer selection in Chromium revision `8625e066febc721e015ea99842da12901eb7ed73`. The [Linux setup screen](../../benchmarks/results/paced-uncapped-frames-linux-2026-10-21.json) uses the existing private renderer-reuse, classic early-idle and lazy-VAAPI composition. It is not a standalone browser distribution.

`FLASHWRIGHT_PACED_UNCAPPED_FRAMES=1` selects a one-millisecond timer grid; the default keeps the original zero interval. The source is used by both root Viz and Blink widgets. It retains observer demand, acknowledgements, sequence ownership, classic action ordering and the existing vsync/max-VRR metadata. The timer's 500-microsecond alignment guard produces a nominal 0.5–1.5 ms rearm wait, plus scheduling delay. Initial requested frames also wait; GPU-availability callbacks can bypass a fresh timer wait.

Both arms pass six total motion/storage/rAF/screenshot control contexts and 60 preflight tests. Eight timed captures pass another 1,920 unchanged setup tests. At four workers, pacing reduces complete time by 22.4% and 24.2%, and charged CPU by 23.3% and 23.8%. At one worker, elapsed time regresses 0.8% in one block and improves 0.2% in the other, despite CPU reductions of 25.1% and 26.7%.

The prospective rule required at least 10% less elapsed time in both blocks at both worker counts, plus at least 20% less charged CPU in both four-worker blocks. It fails at one worker. No application expansion or adoption follows. The source and rebuilt executable were restored to their exact baseline hashes.

The parallel benefit motivates investigating demand-aware scheduling; it does not prove that every no-output frame is redundant. Such acknowledgements release required dependencies. Enabled-policy native alignment/multiple-observer/GPU-recovery tests, wider rendering/lifecycle/media/artifact controls and the final performance campaign remain open. All raw captures, source backups and the initial compiler-diagnostic correction are retained privately in ignored `workbench/`.
