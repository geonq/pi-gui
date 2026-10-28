# Pegasus reliability verification ? 2026-10-28

## Changes

- Replaced whole-state work on streamed-token paths and bounded timeline measurement passes across a complete animation frame. Zero-size panes wait for resize instead of re-entering layout.
- Preserved Windows state files during replacement contention, corrected Git-for-Windows addition/deletion patch paths, and waited for aborted Git processes before scratch cleanup. Windows fixtures use supported paths; POSIX assertions remain on macOS.
- Aligned the GUI and native extension on Pi SDK 1.3.0. The extension reuses host modules only when installed versions match, with resolution limited to its source and compiled runtime. Packaged Anthropic SDK is the version required by Pi.
- Moved Claude provider compilation to a short-lived worker. Complete compiled directories are published atomically, keyed by source contents, Node version and resolved SDK imports. Tests cover cold/warm caches, source changes, concurrent publication, failed transforms and real default provider registration.
- Kept Stop responsive during pending startup hooks. Cancellation is applied when the provider run starts, and subsequent messages complete normally.
- Displayed a restrictive-CSP loading shell while the selected workspace prepares. Initialization no longer waits for animation frames: an occluded Windows window can stop receiving them. Packaged verification now retains native frame scheduling.
- Preserved original managed directory permissions during installation, retained rollback packages, verified the installed asar hash and checked managed-state readiness. Normal installed launch now reaches its saved workspace and host API.
- Preserved rotated OAuth credentials from isolated conversation verification under the source file lock, with a comparison against the original credential. Newer logins and other providers are preserved. Four synthetic regressions pass.
- Updated coding-principles and desktop-verification skills with performance budgets, off-thread compilation, SDK compatibility, native scheduling, accurate extension-loaded checks and permission-preserving activation.

## Verification

| Lane                                                            | Result                                            |
| --------------------------------------------------------------- | ------------------------------------------------- |
| Windows desktop units                                           | 431 passed, 3 existing skips                      |
| SDK driver integration                                          | 173 passed                                        |
| Ecosystem regression suite                                      | 215 passed, 3 skips; 218 discovered               |
| Proof credential-preservation tests                             | 4 passed                                          |
| Final Windows hidden-window/viewport/thinking Electron checks   | 8 passed                                          |
| Deterministic startup loading-shell regression                  | Passed                                            |
| Packaged native-scheduling startup with real extension defaults | Passed; 18 registered tools, no error diagnostics |
| Final package runtime dependency graph                          | Passed                                            |
| Desktop types, affected-file lint, architecture guards          | Passed                                            |
| Earlier isolated macOS desktop units                            | 433 passed, 1 existing skip                       |
| Earlier macOS viewport/thinking/hidden Electron checks          | 8 passed                                          |
| Both updated skills                                             | Validated                                         |

The preceding packaged OpenAI journey passed all 11 checkpoints, including typing during output growth, native Windows minimize/restore, tools, Stop, thread switching, archive/restore and persistence after restart. Both owned processes exited. Its 310 frame intervals had p95 17.2 ms, maximum 18.7 ms and none above 33 ms. Evidence: .artifacts/verify-pi-gui/run-final-package-20261028/. Real expanded reasoning was visually inspected in the earlier packaged candidate; a later response contained no displayable reasoning, which correctly produced no empty Thinking row.

The final Pi 1.3 live-provider recheck stopped at authentication: its designated source returned OAuth invalid_grant. No provider fallback was used. Recovery of this task's earlier refreshed login is awaiting explicit authorization after automatic approval review rejected searching temporary credential profiles. The credential-preservation fix prevents this verification recipe from stranding its designated source on future refreshes.

## Startup evidence

Earlier warm profiling found a 682 ms JavaScript import stall. With the real extension's 18 tools and diagnostics checked, cold-cache startup measured 2.694 s versus 2.240 s without the extension; warm-cache startup measured 2.464 s versus 2.198 s. Neither recorded a main-thread stall. Evidence: .artifacts/startup-valid-cold-20261028/ and .artifacts/startup-valid-warm-20261028/.

The final native-scheduling package reached its extension-enabled workspace in 2.433 s in an isolated profile. Its first plain binary launch took 5.302 s, illustrating cold binary variability. Evidence: .artifacts/native-scheduling-startup-20261028/.

Normal installed launch, including managed-profile preparation and the saved workspace, logged shell loaded at 2.376 s, store initialized at 4.617 s and renderer loaded at 5.116 s. The local host API confirmed all nine saved workspaces and no running sessions. A separate native Windows probe minimized and restored this normal installed window, checked its actual OS minimized state and confirmed it remained responsive; no update-depth errors were recorded. The old build had remained at its startup shell until one native minimize/restore released its awaited animation frames; the installed fix removes that gate. These samples distinguish binary/platform work, workspace preparation and blocking; they are not a universal latency guarantee.

The installed runtime corresponds to 6366146 at D:/Pi/app. Original and subsequent packages remain under D:/Pi/rollback/. Local hash, activation and normal-launch evidence are retained in D:/Pi/tasks/pegasus-native-startup-deployment-20261028.json and installed-native-startup-proof.json.

## Other scope and evidence limits

Memory implementation and the native extension are committed in the separate ecosystem repository. Search now covers full chat and note bodies while returning compact cards; the 693 curated notes do not need generated summaries to expose their deeper text. The held-out 80-question evaluation improved rank-one retrieval from 68.8% to 70.0% and rank-three from 80.0% to 81.3%, with scope probes still rejected. Full-text coverage removes the summary-only limitation; it does not imply perfect retrieval.

The original intermittent render-loop stack was not recovered. Its identified unbounded measurement chain is fixed, and the hidden-window stress regression passes. Long-duration real usage remains useful evidence for any other cause.

On the macOS 27.0.1 host, minimization failed for both Electron and a normally launched standalone AppKit app, including after restarting Dock. The desktop was on-console and unlocked. This native lane remains inconclusive at the OS boundary; it is not presented as a Pegasus-specific regression or a passing minimize test. The Mac's older dirty checkout was preserved, and no credentials were exported there.
