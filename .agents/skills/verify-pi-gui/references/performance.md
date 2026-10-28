# Responsiveness verification

Measure cold start separately from interaction. Record time to the loading shell, time to the active workspace, and main-thread stalls. Paint the shell before expensive initialization; prepare the active workspace first. Optional warmup must be bounded and deduplicated and must not compete with input. Deferring synchronous CPU work does not make it nonblocking. Enable a cache only after measuring improvement with the cache confirmed active.

When a native extension imports its own SDK or compiler, measure it separately. A visible workspace can hide a failed extension: assert its registered tools and diagnostics too. Only share matching SDK versions, and test startup-hook cancellation after upgrades. For compilation caches, verify cold and warm paths, source invalidation and concurrent publication; keep compilation off the main thread.

For typing lag, reproduce with a growing real-provider response and a representative long transcript. Record text growth while running, the complete typed draft, frame intervals and main/renderer stalls. Use delta updates and narrowly scoped persistence on token/keystroke paths. Report the actual sample and its limits.

The conversation recipe accepts PI_GUI_EXECUTABLE for an exact packaged/installed executable, PI_GUI_MINIMIZE_PROOF=1 for minimize during a real tool run, and PI_GUI_THINKING_LEVEL for provider reasoning. Doctor output must prove executable identity, packaged state, isolated userData, no test hooks and native focus. Reasoning text is provider-dependent: record absent text explicitly; expand and inspect a real row when one is emitted.

Before opening foreground windows on the owner's other machine, announce the run and serialize input. Native automation requires actual window state; a screenshot of a hidden renderer does not prove OS minimization. If ordinary native windows fail the same operation, stop that lane and report the boundary. Avoid repeated disruptive runs that never reach the behavior being tested.

Packaged Windows proof must retain native frame scheduling. Do not pass timing flags that disable occlusion or frame throttling: they can hide installed-app startup hangs. Initialization must not wait for animation frames or visibility; a minimized window may never deliver them.

A failed test remains failed even when later checkpoints completed. Preserve failure artifacts. A fixture mistake must be corrected around the real product contract, without retries, skips, or timeout increases to obtain green.

For deployment, build and verify the concrete package before activation, preserve rollback and the managed installation's original directory permissions, verify its security-readiness check after activation, and use a normal shutdown that flushes drafts. Do not enable a debugger or terminate an unrelated/running agent to install an update. Report packaged proof separately from activation of the installed app.
