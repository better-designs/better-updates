# Better Updates

Over-the-air updates for Expo apps, on your own Cloudflare account. It speaks the open [Expo Updates protocol](https://docs.expo.dev/technical-specs/expo-updates-1/), so the `expo-updates` library already in your app works with it unchanged.

Assets live in R2, which charges nothing for downloads. Update records live in D1.

## What works today

- Release channels, one runtime version at a time
- Signed updates with update code signing
- Rollback to the update inside the binary
- A publish command for `npx expo export` output

## Deploy

```sh
bun install
bunx wrangler d1 create better-updates      # copy the id into wrangler.toml
bunx wrangler r2 bucket create better-updates-assets
bun run migrate
bunx wrangler secret put PUBLISH_TOKEN
bunx wrangler secret put SIGNING_PRIVATE_KEY  # optional: keys/private-key.pem from `npx expo-updates codesigning:generate`
bun run deploy
```

## Point your app at it

In `app.json`, set `updates.url` to `https://<your-worker>/v1/projects/<project>/manifest`, then build a new binary. A build made outside EAS must send its channel itself: set `updates.requestHeaders` to `{ "expo-channel-name": "production" }`.

## Publish an update

```sh
npx expo export
BETTER_UPDATES_TOKEN=... bun cli/publish.ts --server https://<your-worker> --project <project> --channel production
```

## Roll back

```sh
curl -X POST https://<your-worker>/v1/projects/<project>/rollbacks \
  -H "authorization: Bearer $BETTER_UPDATES_TOKEN" -H "content-type: application/json" \
  -d '{"channel":"production","runtimeVersion":"1.0.0","platform":"ios"}'
```

## Test

`bun test` starts the Worker on local workerd, publishes a fixture export, and checks every response the way the app does, including the signature.
