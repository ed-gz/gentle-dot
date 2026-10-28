# Structured conversation steps

`agent_step({ prompt })` asks the real on-device Foundation Model to generate one
decision. `prompt` contains the app's bounded conversation context, authorized tool
catalog and observed tool results. Rust, Swift and TypeScript cap it at 8000 Unicode
code points. Swift builds a new session for each step; hidden native history never
duplicates the visible conversation or retains a cancelled partial generation.

The result is `{ ok, decision?: { kind, text, toolName, argumentsJSON }, error?, message? }`.
`kind` is `answer` or `tool`. `@Generable` constrains the envelope and enum;
`argumentsJSON` remains a generated JSON string whose exact object schema the
TypeScript tool registry must validate before execution. The plugin additionally
rejects malformed JSON, non-object arguments, invalid names, oversized output and
answers that also request a tool. Output is bounded to 768 generated tokens, 2400
text characters and 4000 argument characters. A truncated or invalid output is an
error, never permission to execute a partial operation.

This is model-directed inference, not a keyword router. It does not expose raw
HTTP or credentials to the model. The app supplies an extensible catalog and owns
tool execution, result observations, maximum loop steps, retry limits, deduplication
and exact-content approval of external mutations. A tool result cannot grant
approval. The model receives external documents/OCR/results as untrusted content.

One native generation can run at a time. Cancellation and leaving foreground use
the same gate as `respond`; no late result may resolve a cancelled invocation.
Unavailable models, missing native bridge and generation errors remain visible.
The existing `respond` command remains for compatibility; it is not a silent
fallback when structured generation fails.

The implementation uses the iOS 26 guided-generation APIs documented by Apple:
[generating Swift data structures](https://developer.apple.com/documentation/foundationmodels/generating-swift-data-structures-with-guided-generation)
and [tool calling](https://developer.apple.com/documentation/foundationmodels/expanding-generation-with-tool-calling).
Apple's latest tool-calling article also includes newer API variants; this bridge
uses `@Generable`, `@Guide`, `LanguageModelSession` and `respond(to:generating:options:)`
available in the iOS 26 SDK. The execution loop runs in the existing TypeScript
conversation so that app storage and user approvals remain its source of truth.

Linux tests cover envelope validation and Unicode budgets. They do not prove model
accuracy, native macro compilation, local tool selection or offline inference on
the installed iPhone. Those require Xcode compilation and on-device conversations
with tool successes, denied approvals, unavailable tools, cancellation and restart.
