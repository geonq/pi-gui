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
