# Pegasus reliability verification ? 2026-10-27

## Changes

- Bound synchronous timeline measurement passes across an entire animation frame, and ignore zero-size panes until their next resize. Previously the counter could reset within a nested render chain.
- Preserve the saved state file during Windows replacement contention instead of unlinking the destination. Retry transient replacement locks with a bounded backoff.
- Give Git for Windows its recognized /dev/null path when producing addition/deletion patches. Wait for aborted checkpoint processes to release their working directory, and tolerate transient Windows scratch-directory locks.
- Canonicalize the workspace root before returning extension file paths on macOS, where /tmp resolves to /private/tmp.
- Isolate visible verification from the installed remote desktop host, prevent hidden Windows test-window frame throttling, preserve launch errors, and update stale New chat/Unarchive proof selectors. Optional PI_GUI_THINKING_LEVEL enables a real reasoning run.
- Adapt Windows fixtures to supported filenames and directory junctions. POSIX executable-bit and file-symlink assertions remain on macOS; Windows does not gain that coverage by passing these fixtures.

## Evidence

Final Windows desktop unit suite: **431 passed, 3 existing skips** (434 discovered). Final isolated macOS unit suite: **433 passed, 1 existing skip**. Viewport/thinking Electron checks: **7/7 on Windows**, **8/8 on macOS including the hidden-window stress check**. The separate Windows hidden-window stress check passed. Both builds and typechecks passed; affected-file lint and architecture guards passed.

The visible real-provider journey used OpenAI / gpt-6-luna with high reasoning and passed all ten checkpoints: streaming, reading and typing during growth, completion, thread switching while a tool ran, tool completion, Stop, draft isolation, archive/unarchive, and both chats after process restart. Both owned processes exited. Source profile credentials stayed on Windows. Screenshots were inspected; the Thinking row appears collapsed in a real response. Expanded thinking is also covered by the fixture-backed Electron check.

Retained local live evidence: .artifacts/verify-pi-gui/run-codex-20261027e/. Its streaming frame sample contained 410 intervals: p95 17 ms, maximum 17.8 ms, none above 33 ms. These are short diagnostic samples, not an input-latency guarantee. Earlier failed attempts and their artifacts remain retained.

Mac verification ran from an isolated /tmp checkout copied from this source. The older dirty Mac checkout was preserved. Windows and Mac foreground builds were development Electron surfaces; the installed Pegasus package was not replaced or used as proof of these source changes.

## Limits

The original intermittent freeze was not reproduced with its original component stack. The update counter fix removes an identified unbounded-chain risk and the new stress test passes; this does not prove every possible freeze is eliminated. Native minimize/refocus and long-duration use of the installed package still need separate coverage.

Startup still has a measurable import/platform cost. Ecosystem wrappers now import the public event-stream module rather than the SDK-wide export, but the extension still loads the coding-agent SDK and Electron has its own startup work. No claim of eliminated launch pauses is made.

Memory changes live in the separate ecosystem repository: full-content term indexing, compact returned cards, worker-based tool requests, and unchanged-cache reuse. Curated notes do not need generated summaries. The existing 80-question v2 retrieval benchmark improved R@1 from 68.8% to 70.0%; ecosystem tests passed 209 with 3 existing skips. Native extension changes and their dependencies were saved in focused local Git commits.

## Follow-up: packaged startup and responsiveness (2026-10-28)

Build 057380c adds a script-free, restrictive-CSP loading shell on Windows. The shell paints before extension initialization and keeps the main chat unavailable until its runtime is ready. A deterministic test holds an extension at a file gate and confirms the visible startup status before releasing it. This improves startup feedback; it does not remove the extension import CPU cost. Inactive workspaces continue to load on selection rather than all being preloaded.

The final packaged binary passed all 11 real OpenAI checkpoints, including minimize/restore during a running tool, complete typing during output growth, Stop, archive/unarchive and both conversations after restart. Both owned processes exited. The final frame sample had 310 intervals, p95 17.2 ms, maximum 18.7 ms and none above 33 ms. Evidence: .artifacts/verify-pi-gui/run-final-package-20261028/. Final packaged runtime dependencies, typechecking, affected-file lint and architecture guards passed. Ten focused startup/viewport/thinking regressions and a separate Windows native minimize test passed.

Expanded real OpenAI thinking was inspected in the earlier packaged candidate's thinking-expanded.png. The final provider run returned no displayable reasoning text; the observation is recorded explicitly, and the product correctly showed no empty thinking row. That provider difference does not establish a renderer failure.

Startup profiling measured approximately 1.86 seconds without the managed extension and 2.95 seconds with it in one warm-machine comparison, with a 682 ms JavaScript stall attributed to extension import. A separate confirmed-active Node compile-cache experiment did not improve latency or stalls, so it was not enabled. Cold binary launches varied more and are not represented by that warm sample.

Mac native minimization remains unverified: both the app window and plain diagnostic Electron windows ignored minimization on this macOS 27.0.1 host. Changing focus/setup and using the OS accessibility control did not establish a successful minimize. The user was informed and foreground Mac runs were stopped. Earlier fixture-backed Mac checks remain distinct from this failed native lane.

The coding-principles skill now includes first-principles performance diagnosis, token/keystroke hot paths, staged warmup budgets and truthful evidence requirements. The verification skill now covers responsiveness, exact packaged identity, empty provider reasoning, bounded native diagnostics and safe activation. Both skills validate.

Activation is pending the owner's restart choice after Pegasus was reopened during the swap. The update guards left the old installation intact; the verified candidate is retained under apps/desktop/release-reliability-final-20261028/win-unpacked. No debugger was enabled and no credentials were exported to the Mac.
