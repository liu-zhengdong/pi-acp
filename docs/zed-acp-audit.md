# Zed ACP audit (2026-09-15)

**Known limitation: ambiguous nested parent identity.** The current parser cannot distinguish raw Parent `<uuid> step 1` (no step metadata) from raw Parent `<uuid>` with step index 0. Stock permits both and renders identical headers. Earlier canonical-ancestry claims below describe the intended check, not proof against this collision. The normal stock nested route remains enabled; rejecting all step-decorated headers would silently remove that demonstrated route. No authority change or universal public-API impossibility claim is made. The separately corrected stale-control handling does not resolve this ambiguity. Publication proceeds with this risk acknowledged and the upstream proposal deferred; strict ownership safety for malformed metadata is not claimed.

## Implemented adapter corrections (bounded verified cancellation)

- Pi's `abort` continues native steering/follow-up queues. Cancellation now clears them before abort, separately from the adapter FIFO.
- Async `subagent` tool results previously ended their ACP prompt before background completion. Their later Pi synthesis was suppressed as unowned output. The adapter now loads its bundled companion extension, retaining the prompt through the optional harness's authoritative liveness callback, pending notification delivery, Pi queue consumption and synthesis settlement. No timing grace window or invented ACP task capability is used.
- Cancellation and teardown request stop for exact captured async root IDs and interrupt canonically verified nested descendants through the public v1 bridge. A terminal root is **not** delivery/descendant quiescence. IDs remain owned until a read-only check after native abort proves terminal records, aggregate host inactivity, native idle, and no pending Pi messages. Stops and late work reconcile within the existing ten-second budget. Unconfirmed cancellation emits an explicit detached-work warning and quarantines Pi; the fallback ACP `cancelled` response is **not** proof that detached workers stopped. The demonstrated terminal-root/nested-child route is now handled; universal cancellation is not claimed (limitations below).
- Fresh preflight-only sessions previously vanished after cancellation quarantined Pi: default Pi sessions are not persisted until their first assistant message. New sessions now give Pi an exclusively created empty file in its configured session directory, which Pi initializes eagerly with its authoritative identity. No existing session file is overwritten. Header-only files are intentionally retained across quarantine to preserve fresh-session identity; only still-empty files are removed.
- Extension permissions announce a pending tool card before requesting permission and complete it before prompt settlement. Cancellation while card delivery is blocked never opens a late permission request.
- Fire-and-forget UI methods receive no bogus `extension_ui_response`. Notifications remain visible; terminal status/widget/title/editor mutations without ACP equivalents are intentionally not synthesized into fake tools. The private lifecycle widget is consumed internally.
- Summarization retry events are decoded and shown as owned progress without replacing `agent_settled` as the Pi settlement boundary.
- ACP SDK updated to 1.4.0. The repository already used the current builder API.

## Optional harness contract

The companion is bundled as `dist/acp-extension.js` and explicitly loaded only into adapter-owned Pi subprocesses. It does not edit Pi, install packages, or change user settings. Ordinary Pi works without a subagents package. Internal commands are hidden from the advertised command list and cannot be invoked as user prompts. In Pi 0.85.1, handled extension commands return from `AgentSession.prompt` before message creation/persistence; these bridge commands do not become replayed user messages.

The verified optional implementation is **pi-subagents 0.67.0**, specifically:

- `src/integrations/pi-web-session-liveness.ts`: version-1 registry at `Symbol.for('@agegr/pi-web/session-liveness/v1')`, provider name `pi-subagents`, exact session ID/file, `isActive()`.
- `src/extension/index.ts`: registration includes both live work and `completionNotifier.hasPendingDelivery()`. RPC has UI, so its headless `agent_end` auto-drain does not apply.
- `src/extension/rpc.ts`: `subagents:rpc:v1:request` and correlated reply events, `status` with version-1 async snapshot, exact-ID `stop`, and exact nested `interrupt`.
- `src/runs/background/async-execution.ts` writes the same `id` as persisted `runId` and returned `details.asyncId`; `src/runs/shared/async-status-projection.ts` projects `job.asyncId` as snapshot `runs[].id`. Its terminal states (used to avoid invalid root stop requests, not as sole quiescence proof) are: `complete`, `failed`, `partial`, `paused`, `stopped`, `rejected`. There is no model-prose parsing or filesystem discovery of other runs. Nested identity uses narrowly verified package-generated targeted status headers, described below.

Compatible existing host registries are composed and restored on shutdown, not overwritten. Registration occurs in extension factories before Pi invokes session-start handlers. Providers from other session IDs/files are ignored. A session with pre-existing or restored background work is rejected explicitly rather than adopting/stopping it. After a failed cancellation, restored jobs from the same session can trigger this gate: wait for them to finish or open a new session. The adapter cannot prove their origin or adopt previous-turn ownership. Unknown Pi runs retain the existing fail-closed ownership rules.

Older packages without these contracts fail explicitly if they launch an async subagent. Arbitrary extensions that start delayed work without an async run identity/liveness contract cannot safely be held or cancelled by this integration. The obsolete globally installed pi-subagents 0.25.0 is not evidence of current host support.

## ACP / comparison disposition

Stable ACP v1 has ordered session updates, tools, permissions, plans and usage; it does **not** define a stable native task/subagent lifecycle. Existing session new/load/resume/list/close/delete, model/thinking configuration, commands, usage, diff/tool output, request cancellation and negotiated Zed terminal metadata are retained. Plans, modes, forks and native subagent sessions are not fabricated from data Pi does not supply. Elicitation remains capability-gated.

Codex ACP's richer plan/mode/permission stream does not establish Pi parity. Claude ACP's useful principle is to retain an active prompt through required background-subagent delivery while cancelling request lifetimes independently. This integration applies that principle through Pi's actual harness contract rather than copying Claude's private task protocol.

Source revisions examined: ACP `0910a2199dbf4ea14a1134d59e29a9610be54dac`, Zed `ba7da93e5ccc2b630077b2ae26c7581f3c21f984`, codex-acp `296069e841634cd4bb9bc4515602d836e49231ec`, claude-agent-acp `543a9a2f97429659bb28d09691a71e4c99e41ed5`.

Two initial audit claims were disproved by current source and execution: preacceptance extension dialogs already had ownership, and the adapter already used the SDK builder. Zed upserts permission cards itself; preannouncement is an ordering improvement, not repair of a missing Zed record.

## Reproduce

```sh
npm run validate
npm run smoke
PI_ACP_EVAL_LOG_DIR=/tmp/pi-acp-evaluation npm run eval:acp
```

`eval:acp` launches the **built ACP stdio adapter and real installed Pi**, with a temporary HOME/agent directory, an explicit temporary extension, and a deterministic no-network provider. It exercises preacceptance confirm/form UI, exactly scoped cancellation and FIFO draining, native Pi queue cancellation, repeated cancel/restore before any assistant message, pending completion plus synthesis, compaction UI cancellation, session close and connection teardown. Optional `PI_ACP_EVAL_PI` selects the Pi executable. Raw isolated ACP/Pi traces and assertion results are saved only when a log directory is supplied.

The provider and harness are deterministic in-process contract fixtures: this is **not** a real model/subagent fleet run. Unit/component tests separately cover malformed/foreign ownership, registry coexistence, progress, failures, cancellation during streaming/tools/retries and process exit. No live Zed UI was driven. Installed Zed 1.19.2 resolves Pi to a Nix-built adapter, not this checkout's `dist`; validating the UI against this build requires a separately authorized client configuration change.

## Independent review correction pass

- Reproduced the coalesced idle-acceptance/background-settlement race. A per-turn ever-observed-run flag now protects the initial acceptance probe and both asynchronous callbacks, independently of the flag reset to admit synthesis runs.
- Pi catches extension command handler exceptions and still returns RPC success. Internal `begin` and `cancel` now require correlated companion acknowledgements. A rejected begin never sends user text or kills unrelated work; missing/fatal acknowledgements fail closed. Observation failures retain owned IDs and continue authoritative observation rather than forgetting live work; a recovered provider can prove drain and permit a later begin.
- All cancellation phases share one 10-second deadline, passed into status/stop/drain. R4 replaces the earlier reserved-last-second/fixed-two-stop sequence with bounded stop → clear queue → native abort → read-only check reconciliation. Virtual-clock tests cover slow success and failure without lengthening shutdown budgets.
- Evaluation recovery checks assert `end_turn`; fresh extension-only cancellation checks unchanged Pi session ID/file, retained pre-assistant contents and a changed subprocess PID. Critical background waits correlate lifecycle/terminal/stop events; the deterministic fixture releases pending delivery only after the held-turn assertion. Real Pi rejection/recovery is exercised without launching external workers.
- Review suggestions to accept void unsubscribe, trim internal commands, silently degrade a missing bridge, or delete header-only sessions were not applied: actual Pi guarantees unsubscribe, parses raw leading slash commands, and missing lifecycle support must fail closed. Trusted local extensions remain trusted. No healthy-channel transient `get_commands` failure was demonstrated; its cache behavior is unchanged. No speculative timeout injection or shorter background hold was added.

These checks still do not constitute a live Zed UI test or a real external model/subagent fleet run.

## R2 review corrections (cancellation proof superseded by R4 below)

- Cancellation preserves the turn token even before background activation. Native abort first waits for final tool results, then exact-owner cancellation drains their IDs; close/disconnect can upgrade an ownerless in-flight abort without resetting its ten-second deadline. Queue clearing/native abort and a final owned drain also reconcile work launched by stop-triggered synthesis. Ordinary no-background cancellation remains immediate.
- The host starts async tracking as `queued` (`async-job-tracker.ts:handleStarted`) after the runner launch and before returning `details.asyncId` (`async-execution.ts`). `stop` accepts only `running`; missing status files and queued-to-running races are bounded retryable transitions. Wrong-session `not_found`, permission errors, malformed replies and unsupported states fail visibly rather than retrying blindly.
- R2 removed exact IDs after terminal snapshot records. R3 review disproved this as cancellation proof: terminal roots can retain pending delivery or live descendants. R4 retains IDs and uses aggregate inactivity only as read-only sufficient proof. Aggregate busy is ambiguous (possibly unrelated), never authority to stop more IDs; unresolved ambiguity reaches the unchanged deadline and visible fallback. Initial unrelated-work begin rejection remains intentional. Normal completion still holds through session-wide pending delivery and synthesis.
- **Host snapshot ceiling:** snapshots may omit terminal IDs. Such IDs remain unknown until the cancellation deadline: the diagnostic says termination could not be confirmed, Pi is quarantined, and ACP still returns `cancelled`. This is not a claim that detached workers stopped. Targeted headers prove nested identity only; no text parsing or invented per-ID terminal API fills the quiescence gap.
- Executable regressions cover late activation/FIFO, owner upgrades at both queue-clear and native-abort boundaries including disposal, queued `not_found`/`invalid_state`, unrelated liveness, omitted IDs, wrong-session/permission/malformed errors, reserved public commands and internal command hiding. Real-Pi evaluation additionally delays a tool result until native abort, exercises late close/disconnect, and retries queued stops while unrelated work stays live. Cancellation failures retain visible diagnostics and the `cancelled` stop reason.

## R4: adapter proof correction and verified stock nested interrupt

The default unit regressions reproduce the formerly false companion acknowledgement for a terminal root with pending delivery, stop-created synthesis, and a live nested descendant. Process tests require a **read-only** `check` after every final native abort, including a second pass when the last stop admitted new work. Cancellation widgets cannot release ACP before that transaction settles. Every transaction rejection quarantines immediately so disposal cannot start a second ten-second abort. Close/shutdown also publish unconfirmed cancellation before releasing the prompt.

These are adapter fixes using stock public controls, not changes to upstream execution. Nesting and ordinary async delivery remain enabled. No package code, package version, global configuration, deployment, or Zed settings were changed.

### Real stock-host evaluation

```sh
npm run build
PI_ACP_EVAL_LOG_DIR=/tmp/pi-acp-stock-evidence node scripts/eval-subagents-cancel.mjs
```

This separate opt-in evaluation reuses the ACP smoke client and loads **unmodified installed Pi 0.85.1 and pi-subagents 0.67.0**. A deterministic local provider launches actual Pi child sessions through the stock `subagent` tool. Temporary HOME, agent definitions, and TMPDIR/TMP/TEMP isolate test jobs; no network model, external fleet, or user workload is invoked. `PI_ACP_EVAL_SUBAGENTS` can identify the installed 0.67.0 package directory. Test artifacts are retained locally. All recorded test Pi/runner PIDs must exit before the check returns.

Asserted observations:

- A real async root's persisted status is terminal while the stock host still reports activity and ACP remains open. Its finite pending completion/native synthesis drains without an uncertainty warning. In-memory snapshots can lag disk status until notification delivery; the test does not invent a per-root delivery flag.
- Before ACP cancel, an actual root snapshot is `complete` with a nested child still `running`; aggregate liveness is true and the nested provider has entered gated execution. The **production companion**, not a fixture controller, verifies targeted status and issues public `interrupt` for that exact descendant. The leaf settles with `aborted: true` before the ACP response and without gate release, the host/native drain completes within the unchanged cancellation budget, and no uncertainty warning appears.
- PID checks cover the adapter's Pi, actual child Pi sessions, and runner PIDs read from the explicitly returned test-owned isolated status paths. Gate release exists only as finite failure cleanup, never as cancellation proof.

`stock-checks.json`, `stock-trace.jsonl`, and `stock-acp-trace.jsonl` include exact requests/replies, runtime settlement timestamps, ACP results and PID-exit proof. This actual-stock route has one nested descendant below the owned async root (adapter Pi → async root Pi → nested leaf Pi). Deeper chains and independent sibling route roots are regression-tested with the real companion and a fake host, not claimed as actual-stock depth coverage. `eval-zed-acp.mjs` remains **real Pi + a fake subagents host**; it separately verifies delayed synthesis, UI, FIFO, and quarantine/recovery. Neither script drives live Zed.

### Nested authority and remaining limits

Stock 0.67.0 snapshot IDs pass display normalization/truncation and the tree is bounded. Snapshot nodes are **candidates only**, not authority. The companion requires a full lowercase canonical UUID below a captured root, strictly below the snapshot string cap, then requests public targeted `status(id)`. It accepts only the stock ordered machine-generated header grammar (`Status target`, budget/capacity, `Nested run`, `Root`, `Parent`, `State`); no trimming/coercion, duplicate/injected headers or control characters are allowed.

The canonical `Parent` identifies ancestry: direct Parent must exactly equal this turn's captured async root; deeper Parent must already be proven in the same pass and preserve that branch's canonical route `Root`. Stock `Root` is a nested route namespace, **not necessarily the owned async ID**; different direct branches need not share it. Canonically verified terminal ancestors prove lineage but are not interrupted. Cycles, conflicting route roots, missing intermediates, malformed/normalized IDs, omitted candidates and format drift grant no control authority. Candidate traversal is bounded at 256 display nodes per root; incomplete traversal is unknown. Tests include stale targets, wrong ancestry, normalized/truncated/injected headers, terminal intermediate parents, deeper live parents, sibling route roots and unrelated siblings.

Source seams: `src/runs/background/run-status.ts` (`inspectSubagentStatus`) generates the raw Nested run/Root/Parent/State headers; `src/runs/foreground/subagent-executor.ts` prepends targeted status and budget headers and dispatches nested interrupt; `src/runs/shared/spawn-budget.ts` formats its budget line. `src/runs/background/run-id-resolver.ts` and `src/runs/shared/nested-events.ts` resolve retained nested routes and canonical parent chains, including terminal roots in `state.asyncJobs`; `src/runs/shared/async-status-projection.ts` and `src/shared/display-text.ts` define the bounded display projection. The exact relied-on installed source is captured with final evidence, not treated as a stable typed nested DTO.

`interrupt` is a **pause/abort request**, not permanent stop: the adapter never auto-resumes it. An ACK alone cannot settle ACP. Final success still requires retained root terminal snapshots, aggregate host inactivity, native idle/no pending messages and a read-only check after native abort. Busy aggregate liveness is never stop authority. Omission/identity ambiguity or retained work that cannot quiesce within the existing ten-second budget yields an explicit unconfirmed-cancellation warning and quarantine; this does not prove every detached worker stopped. Arbitrary deep/omitted routes and delayed or externally resumed work are residual limits, not asserted absent public controls.

### R5 reconciliation corrections and bounded residuals

- Stock targeted nested `status` and `interrupt` report tool failures as `execution_failed`, including normal completion races. These are unconfirmed outcomes: other owned descendants and root stops still run, failed candidates are re-observed on the next pass, and only the post-abort read-only check can establish quiescence. The last control failure is retained in pending diagnostics and included in a deadline/failure warning. Malformed replies, unsupported methods, explicit denial/session errors and transport failures still fail visibly; no error is termination proof.
- An acknowledged interrupt is not retried during the turn. If execution remains live, aggregate liveness holds cancellation pending until the existing deadline; repeated ACKs would not establish execution proof. Failed interrupts can be retried after fresh status/ancestry checks. No automatic resume occurs.
- Non-UUID owned async IDs still receive exact root `stop`, but cannot authorize nested traversal. Recognized malformed/ambiguous headers, omitted candidates and unsupported formatting remain unknown and may reach bounded quarantine. The unrecognized Parent-suffix collision above is an unresolved exception to the intended identity rejection, not a safely handled fallback.
- Normal background delivery has no adapter-wide runtime cap. The removed 30-minute timer measured from the first async result across subsequent work and synthesis, prematurely terminating healthy long-running turns. Work remains governed by harness/run deadlines and explicit cancellation. The prompt stays open until host inactivity, native idle and empty pending queues prove quiescence; if a provider remains active indefinitely, Cancel, close or disconnect is required. These paths retain bounded cancellation and quarantine, not a claim that every detached worker stopped.
- Adapter disconnect/shutdown allows up to 13 seconds: the unchanged 10-second cancellation deadline, 2 seconds for SIGTERM-to-SIGKILL escalation, and 1 second bookkeeping. This does not extend the cancellation deadline.
- Stock `nested-render.ts` renders intermediate children with arrow-prefixed rows and `Status:` hints, not duplicate `Root`/`Parent`/`State` header lines. Source inspection did not reproduce the proposed deeper-header-count conflict; the strict injection check is unchanged. Actual-stock depth coverage remains one nested descendant.

### LOCAL upstream note/reproducer — not posted

**Correction to the earlier draft:** `stop(root)` rejects terminal roots (`invalid_state`), but this is **not** evidence that all public cancellation routes fail. A separate exact test-owned nested `interrupt(id)` probe succeeded, and the production adapter now uses that demonstrated route. The prior claim that terminal-root/live-child cancellation was upstream-unaddressable is withdrawn.

**Reproduce the corrected behavior:** run the stock evaluation above. Its provider launches `eval-root` asynchronously, which launches gated `eval-leaf`; wait for the terminal-root/live-descendant snapshot, then cancel ACP. Inspect the adapter's targeted public status headers, exact nested interrupt request, leaf `aborted: true` before gate release, native/host drain, warning-free ACP cancellation, and exited PIDs.

**Potential upstream API improvement, not a newly reproduced no-control bug:** a typed canonical nested identity/ancestry DTO plus exhaustive exact-root tree/delivery quiescence (including unknown) would remove the narrowly version-dependent status-header check and clarify bounded snapshot omissions. An exact-root fence/drain could simplify handling retained delivery and new descendant launches without touching unrelated work. The current aggregate liveness contract is sufficient read-only drain proof when idle, but does not identify ownership when busy. No blanket claim is made that other public routes cannot work without reproducing their rejection/absence.
