# Workflow construction contract · v3

This is the production contract for an agent that **returns a workflow**, without executing it. Read this document, `workflow.schema.json`, and `operations.json` together. The output is the existing Studio workflow format **version 2**. Contract version 3 is documentation/tooling versioning; do not add it to the workflow.

## Responsibility and input

The user may give the task in ordinary language. They do not have to mention cards, Steps, edges, operation IDs or JSON fields, or provide a prebuilt plan. Model IDs, constraints and available asset descriptions/bindings can come from the application context. Translate the requested operations, repetition and data dependencies into the schema yourself; choose IDs and Step grouping when unspecified. Do not require the user to supply internal graph structure. Represent repeated operations explicitly in the DAG, preserving the requested sequence and sources. Do not add review pauses by default.

Storyboarding and model-specific prompt skills can supply creative decisions when needed; their internal format is not prescribed here. When the user already supplies prompts, use those decisions directly. Preserve supplied final prompts, parameters, reference order, grouping and counts. Do not invent model capabilities, assets, result URLs, additional generations, pauses, or editing/assembly operations to make a request appear feasible. If essential semantic information is missing or constraints conflict, report that problem to the caller instead of returning a fabricated workflow. An error message is not an importable workflow.

An asset description is context, not a usable source. A supplied HTTPS URL can be bound directly. An ordinary local input requires explicit reattachment after portable import. DataCard assets are the exception: supplied stable file IDs can reconnect to files already registered in the target Studio; unavailable files require reattachment. A future generated asset must be connected to its generating card. Models are exact API identifiers supplied by the caller/model skill, not display names. The operation registry describes Studio wiring; it does not certify every provider/model combination, duration, resolution or reference limit. Do not infer a model supports a port merely because a generic operation exposes it.

## Output

Return exactly one UTF-8 JSON object, with no Markdown fences, explanations or wrapper. Required root fields: `version: 2`, `name`, `steps`. Optional fields: `dataCards` and `view` (`"steps"` or `"flow"`, default `"steps"`). Do not emit a workflow `id`: import creates a new one. No runtime state, history, outputs, editor state, credentials or pricing guesses. No legacy `groups`, `media`, `params` or positional template syntax. The schema is a deliberately strict, loss-resistant authoring profile of the existing importer, not a replacement import format.

Maximum file size: 3 MiB. JSON traversal depth: 64. At most 100 Steps and 100 executable API cards across the workflow. DataCards are not executable cards; the existing file-size and depth limits still apply to their metadata. Names/IDs must follow the schema. Step IDs and node IDs are unique within their respective workflow-wide namespaces; edge IDs must also be unique. References use IDs, never array positions or labels. A requested decision key that is already a valid unique ID may be used unchanged.

## Steps and cards

Each Step has `id`, `name`, `enabled`, `continueOnSuccess`, `view`, `nodes`, `edges`. Defaults for generated workflows are explicit `enabled: true`, `continueOnSuccess: true`, `view: "cards"`. Respect other values only when requested. `continueOnSuccess: false` pauses **after** that Step, not before it. A Step may mix Image, Video, Audio, Text and API cards. Dependencies inside it determine execution order; independent cards do not imply parallel execution. Step boundaries are grouping/execution boundaries, not automatically film shots or temporal phases in a prompt.

Each node has `id`, `kind`, `operationId`, `op`, `parameters`, `inputs`, and normally `model`. Use the exact `operationId`/`kind`/`op` tuple from `operations.json`. Put `model` on the node, other API parameters in `parameters`. `fields` in the registry are editor suggestions, **not all required fields or an exhaustive API whitelist**. Preserve supplied optional/provider-specific parameters. Empty `parameters: {}` is valid for an unfinished draft; execution readiness is a separate check.

Omit optional `advanced`, `quoteFacts`, `reuse`, `wait` unless needed for compatibility; their permitted contract values are false, empty object, `{ "mode": "latest" }`, and true respectively. Do not bypass async completion with `wait: false`. No pinned run IDs: portable import has no imported execution history.

## CharacterCards, LocationCards, and supplied local assets

`DataCard` is a non-executing base with two supported subtypes: `kind: "character"` and `kind: "location"`. Put selected snapshots in the root `dataCards` array, never in a Step. Include each card ID once per workflow across both kinds. Distinct identities, places, or independent scenario variants use distinct IDs; names are not identity keys. An absent collection is equivalent to an empty one.

The application supplies context from **Characters or Locations → Export agent context**, or `GET /local/data-cards/context`. Its shape remains `{version: 1, cards: [...], files: [{id, type}, ...]}`. `cards` includes both kinds and their full descriptions; `files` lists currently available registered file IDs and MIME types. This is agent input, not a workflow wrapper. Copy only selected snapshots into `dataCards`, preserving their IDs and metadata. A context without locations does not imply that a location source exists; never invent a library card, file ID, or reference to cover that gap.

Both kinds contain `id`, `kind`, `name`, and `assets`. Optional common text fields are `description`, `appearance`, and `scenario`. CharacterCards additionally support `age`. LocationCards instead support `layout`, a free-form description of spatial relationships and continuity. A location is an arbitrary reusable place: one house can contain exterior and room assets; one stadium can contain multiple viewpoints. Rooms and viewpoints may be described assets of the same card, without a required hierarchy or geographic classification. Do not attach character age or identity fields to a location.

Each asset contains `id`, `name`, `description`, `type`, and `role`, plus a supplied `fileId` when bound. Both kinds accept `image/reference` and `video/base-video`. Audio uses `audio/voice` for characters and `audio/ambience` for locations. Optional positive `width`, `height`, and `duration` describe known media properties. `missing: true` records an unavailable local file. Asset IDs are unique within each card; registered file IDs identify local bytes and are distinct from logical asset IDs. Metadata and roles do not establish any additional model capability.

Keep character identity and location identity separate. Select the character sources needed for who appears and the location sources needed for where they appear; combine them in the actual API input array when the model supports that combination. A character reference's incidental background does not automatically define the location. A location reference's incidental people do not establish cast identity. Descriptions inform creative decisions, but Studio does not automatically inject them into prompts. DataCards do not generate assets, run API operations, incur charges, or supply future Step outputs.

For either kind, select an asset with `{ "dataCardId": <card ID>, "assetId": <logical asset ID> }` in the destination typed input array. The referenced card must be included in this workflow and the media type must match the port. This direct binding is not a Step edge. Preserve source roles and ordering when combining character assets, location assets, URLs, and generated results. Do not bind DataCards through arbitrary API parameters or text interpolation. Generated scene images still connect through normal edges in the destination Step.

Snapshots are independent of their library entries. Library edits/deletion do not rewrite existing workflows, and importing a workflow does not create or overwrite library cards. File bytes are not embedded; filesystem paths are never accepted as workflow bindings. Use only supplied file IDs. Import reconnects available files with compatible MIME types; missing files retain descriptions and logical references for reattachment. Filenames alone do not reconnect assets. Unused missing assets do not block unrelated execution.

## Typed inputs and edges

Every `inputs` key must be a declared input port of that operation. Its value is **always an array**, including single-value ports. Store media wiring only in `inputs`/`edges`, not duplicated in `parameters`. `inputs: {}` is valid when there are no direct bindings, including a card supplied entirely by edges.

For an existing external asset, a slot contains `{ "url": <supplied HTTPS URL> }`. For an explicitly acknowledged local file awaiting reattachment, it contains `{ "missing": true, "name": <actual file name> }`. This is the Studio's real unbound-input representation, not a fictitious usable asset. A `null` slot reserves a position supplied by an edge. Never fabricate a URL/asset ID, embed bytes/data URIs, insert a filesystem path, or use an asset description as a URL. Do not mark a required reference missing just to hide incomplete planning; report the unresolved input unless reattachment was explicitly allowed.

An edge belongs to the **destination Step's `edges` array**, even when its source is in another Step:

- `id`: unique edge ID.
- `from`: `stepId`, `nodeId`, `port`, `outputIndex`.
- `to`: `nodeId`, `port`, `slot`.

`from.port` is the source output port (`images`, `videos`, `audio`, `text`, `raw`, according to registry). `to.port` is the destination operation's input name, such as `input_references` or `start_image_url`. The source output kind must match that input's type. These port names are not interchangeable.

`outputIndex` and `slot` are **zero-based**. Output index 1 selects the second image from a card explicitly configured with `parameters.n >= 2`; it does not mean “card 1”. For one generated result use index 0. `n` requests a count; the provider still must actually return that result before execution can consume it. Single-value ports allow only slot 0. Multiple references must occupy consecutive effective slots starting at 0. If slot 0 is generated and slot 1 is a URL, use an edge to slot 0 and `inputs[port]: [null, {"url": ...}]`. If all slots come from edges, the direct array may be absent or empty. A slot has exactly one source: an edge OR a non-null direct binding. Do not create duplicate edges for the same destination slot.

Sources may come from the same Step or an earlier Step. No cycles, self-dependencies, dangling IDs, future-Step sources or incompatible media types. Cards can have multiple dependents; different Steps can consume the same output. Preserve the supplied reference order. Do not infer final-frame support or a relationship between image count and number of movements in a video.

## Raw response dependencies

For non-media values in API parameters, the supported expression is `{ "$node": { "nodeId": <source ID>, "path": <dot-separated response path> } }`. A numeric array segment is allowed; empty path means the entire response. The value must be the whole JSON object, not string interpolation inside a prompt. Only use a response path known from the caller/API contract. This expression also creates a dependency; same-Step/earlier-Step and no-cycle rules apply. Use typed edges for media, not `$media`, raw response URLs, or `{{1...}}` templates. For an `api` card, use an exact HTTP route ID from the Studio API catalog; do not invent routes or WebSocket cards.

## Imported execution state

Import creates a fresh saved workflow without calling generation APIs. It does not attach another workflow's outputs. Disabled Steps with no history skip; downstream references to their absent outputs can be omitted or cause dependent cards to skip. Therefore, never disable a source on the assumption that the imported copy will inherit its previous result. Reusing an existing result in a fresh portable workflow requires an explicitly supplied usable URL as an asset. Ordinary locally stored inputs must be selected again; DataCard file references follow the reconnection rules above. Do not change enabled flags to compensate silently.

## Check before returning

Validate output against the schema and graph/operation rules. Confirm all supplied prompts/settings, card counts, Step grouping, flags and ordered sources survived construction. Unknown ordinary API parameter names are not rejected merely for being absent from the registry's suggested fields. The JSON keys `__proto__`, `constructor`, `prototype` are prohibited anywhere by the existing importer.

The local read-only checker uses the real importer and compiler:

```sh
node contracts/workflow/validate.mjs /absolute/path/workflow.json
node contracts/workflow/validate.mjs /absolute/path/workflow.json --ready
node contracts/workflow/validate.mjs /absolute/path/workflow.json --ready --asset-context /absolute/path/asset-context.json
```

Without `--ready`, success means the contract and import checks passed; the separate `executionPreflight` field reports known missing execution inputs. `--ready` also requires the existing local execution preflight to pass. DataCard bindings can pass structural validation without an asset context, but readiness then reports that availability is unverified. With `--asset-context FILE`, readiness checks referenced files and media types against that context snapshot. Unused missing character assets do not block execution. The server checks actual local files again before execution. Neither mode performs HTTP, uploads, generation, pricing, database writes or output-quality evaluation. Local checks cannot certify provider acceptance, asset URL availability or generation quality. Use bounded correction during debugging; do not generate media to validate this construction contract.

`operations.json` is a snapshot of the repository registry. Regenerate after changing operations with `node contracts/workflow/registry.mjs --write`; `node contracts/workflow/registry.mjs --check` detects drift. Both are offline. Mock briefs and agent responses live under `tests/fixtures/workflow-contract/` and are **not part of this production contract**.
