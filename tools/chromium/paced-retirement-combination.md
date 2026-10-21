# Combined frame pacing and early retirement recheck

This private experiment composes [the existing frame-pacing patch](paced-uncapped-frames.patch) and [the existing retirement-recheck patch](early-retirement-recheck.patch) on the recovered Linux foundation. Apply both patches; they modify separate files. Their sources remain identical to the separately measured components. No new parameter search or public default is introduced.

The baseline arm disables both changes. The enabled arm sets `FLASHWRIGHT_PACED_UNCAPPED_FRAMES=1` and adds `FlashwrightEarlyRetirementRecheck` to Chromium's enabled features. Both retain the existing physical renderer reuse, classic uncapped early-idle scheduling, lazy VAAPI and ordinary source-cache policy. Timing disables `FlashwrightRetirementWaitAudit`; worker controls enable audit in both arms. Preserve all original browser launch arguments before these explicit private additions.

The [combined screen](../../benchmarks/results/paced-retirement-combination-linux-2026-10-21.json) passes 28 worker/successor contexts, six motion/pixel contexts, 1,980 unchanged setup outcomes and 540 original application outcomes. Setup complete time falls 16.0–17.2% at one worker and 21.0–22.7% at four. Owner-interval charged CPU falls 23–28%; that interval excludes initial module imports and final watchdog drain.

The subsequent application gate fails. Four-worker TodoMVC improves 15.6–16.7%, but one-worker results vary. SVGOMG includes both regressions and favorable observations. The retained original reports identify `reset settings` as the longest test and much of its variation, without proving the underlying cause. Do not treat setup gains as a universal application result or multiply standalone component ratios.

Native timer-boundary/GPU/multiple-observer tests, forced worker shutdown races, broader media/artifact checks and final confidence/resource gates remain open. The original native sources and byte-identical rebuilt baseline executable are restored. This composition is not adopted.
