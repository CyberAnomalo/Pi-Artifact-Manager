# iOS Artifact Adapter

## Entry point

Import the adapter from `pi-artifact-manager/ios`.
Use the `ios` branch for the CameraMan integration.

The adapter does not load Pi's desktop extension.
It does not import Node file storage or SQLite.
The desktop entry point remains separate.

## Storage port

Implement [CameraManArtifactStorePort](../src/ios/types.ts) in the host app.
The port supplies these operations:

- `ingest`: store a photo and return its metadata
- `get`: find one stored record
- `list`: list records for one session
- `setStatus`: change lifecycle state
- `addToSession`: associate a record with a session

The host owns image bytes, hashes, files, persistence, and storage concurrency.
The adapter checks returned IDs.
The host must check full hashes before reusing a short ID.

The CameraMan iOS host uses Swift storage.
Its JSON metadata and sandbox layout are host details, not adapter guarantees.

## Manager

[CameraManArtifactManager](../src/ios/manager.ts) manages durable photos.
Supported sources are `agent-capture`, `photo-retouch`, and `user-input`.
Live preview frames do not belong in this API.

Ingestion checks required strings and adds session membership.
Activation rejects invalid IDs, missing records, and archived records.
It restores active status when needed and adds the current session.

The reference contains ID, source, MIME type, size, and optional summary.
It does not contain image bytes or a file URI.

## Tools

[createCameraManArtifactTools](../src/ios/tools.ts) defines two tools:

| Tool | Behavior |
| --- | --- |
| `artifact.list` | List active session records by default. |
| `artifact.get` | Activate a record and call the host's activation callback. |

`includeConsumed: true` currently includes all session records.
That includes archived records.
Activation still rejects an archived record.

The host callback selects the photo for scoring or retouch.
The tool does not inject image bytes into a model request.
The host retains its normal tool permissions and execution checks.

## Desktop boundary

The adapter does not install input hooks, context hooks, or a provider payload guard.
It does not provide desktop `artifact_get` byte restoration.
It does not replace the host's agent loop or context policy.

## Checks

Run these commands from this repository:

```sh
bun test tests/unit/ios-adapter.test.ts
bun run typecheck
```

Adapter tests use a controlled store.
They do not prove Swift persistence or iPhone capture.
Test those host operations on the actual device.

## Integration commit

Include adapter source, its test, package exports, and the lockfile in the adapter commit.
Record that commit before preparing the host app commit.
The host's current local file dependency does not pin a source revision.

Do not claim a reproducible release from a local sibling checkout alone.
