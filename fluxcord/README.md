# Fluxer with the Fluxcord patch

This branch is upstream Fluxer with one small patch for
[Fluxcord](https://github.com/DrewCarlson/Fluxcord), a Discord bridge. The patch lets an admin API
key import messages with their original time, so that a bridge can copy older history into a
channel. Only the `fluxer-api` image changes. Use the upstream images for all other services.

## What the patch changes

| File | Change |
| --- | --- |
| `fluxer_api/src/api/admin/controllers/MessageImportAdminController.ts` | New admin route `POST /v1/admin/channels/{channel_id}/messages/import`. |
| `fluxer_api/src/api/admin/controllers/index.ts` | Registers the route. |
| `fluxer_api/src/api/channel/services/message/MessagePersistenceService.ts` | `skipAuthorAck`: an imported message does not move the read state of its author. |
| `fluxer_api/src/api/channel/repositories/message/MessageDataRepository.ts` | `channel_state.created_bucket` is set when the row is made and is never raised again. `lowerCreatedBucket` lowers it for imported messages. |
| `fluxer_api/src/api/channel/repositories/MessageRepository.ts` | `lowerCreatedBucket`. |
| `fluxer_api/src/api/channel/repositories/message/MessageImport.fluxcord.test.ts` | Tests. |
| `.github/workflows/fluxcord-api.yaml`, `fluxcord/` | The build of this image, and this file. |

Without the patch, every new message sets `created_bucket` to the bucket of the channel. The
history scan of the API stops at that bucket, so a message older than its channel is not found.
A normal message is never older than its channel, so for normal messages nothing changes.

## The import route

`POST /v1/admin/channels/{channel_id}/messages/import`, with an admin API key that has the
`message:import` ACL (or `*`).

```json
{
  "message_id": "1146583523252240445",
  "author_id": "1571805229760905216",
  "content": "hello",
  "flags": 0,
  "reply_to": null,
  "edited_timestamp": null,
  "attachments": []
}
```

- `message_id` gives the message its place in the history. Discord ids use the same epoch and the
  same layout as Fluxer ids, so a Discord message id keeps its original time.
- `author_id` must be a recipient of the channel when the channel is a DM.
- `attachments` are files that the author uploaded first with
  `POST /v1/channels/{channel_id}/attachments` (the presigned upload flow), as in a normal send.
- The route sends no gateway event, no notification and no push. It does not change read states.
- A message with the same id is not stored again. The response is `{"id": "...", "created": false}`.

## Deploy

CI publishes `ghcr.io/drewcarlson/fluxer-api:<version>-fluxcord`, where `<version>` is in
`fluxcord/base-version`. With the Compose bundle, set the image of the two services that use
`fluxer-api` in your override file:

```yaml
services:
  api:
    image: ghcr.io/drewcarlson/fluxer-api:2026.1114.190951-fluxcord
  worker:
    image: ghcr.io/drewcarlson/fluxer-api:2026.1114.190951-fluxcord
```

Then `docker compose up -d`. To go back to upstream, remove the two `image` lines and run
`docker compose up -d` again. Imported messages are normal messages, so they stay valid.

The version must be the version of your other Fluxer images. When you update the Fluxer bundle,
build this image for the new version first (see below), then change the tag in the override.

## Update to a new Fluxer release

```bash
fluxcord/rebase.sh 2026.1120.123456   # the version in the fluxer-api@<version> tag
pnpm --filter fluxer_api run typecheck
git push --force-with-lease origin fluxcord
```

CI then builds and publishes the image for that version. A rebase conflict means that upstream
changed a file that the patch changes; the table above lists them.

## License

Fluxer and this patch are under the AGPL-3.0-or-later license. See `LICENSE`.
