# Better Updates

Over-the-air updates for Expo apps, on your own Cloudflare account. It speaks the open [Expo Updates protocol](https://docs.expo.dev/technical-specs/expo-updates-1/), so the `expo-updates` library already in your app works with it unchanged.

Assets live in R2, which charges nothing for downloads. Update records live in D1.

## What works today

- Release channels, one runtime version at a time
- Signed updates with update code signing
- Rollback to the update inside the binary
- A publish command for `npx expo export` output

## Deploy

You need a Cloudflare account and Bun.

```sh
git clone https://github.com/better-designs/better-updates && cd better-updates
bun install
bunx wrangler login
bun run setup                                        # database, bucket, schema, deploy, publish token
bun run setup --signing-key keys/private-key.pem     # optional: also store the update signing key
```

`setup` is safe to run again. It prints your server address and, the first time, your publish token. To sign updates, create the key pair with `npx expo-updates codesigning:generate` in your app.

## Point your app at it

In `app.json`, set `updates.url` to `https://<your-worker>/v1/projects/<project>/manifest`, then build a new binary. A build made outside EAS must send its channel itself: set `updates.requestHeaders` to `{ "expo-channel-name": "production" }`.

## Publish an update

```sh
npx expo export
BETTER_UPDATES_TOKEN=... bun cli/publish.ts --server https://<your-worker> --project <project> --channel production
```

## Build and ship from GitHub Actions

Copy the files in `templates/` into your app's `.github/workflows/`. Each file lists the secrets it needs at the top.

| File | What it does |
|---|---|
| `publish-update.yml` | Exports the app and publishes an update to your server on every push to `main` |
| `build-android.yml` | Builds a signed App Bundle and uploads it to a Google Play track |
| `build-ios.yml` | Builds on a macOS runner, signs with your App Store Connect API key and uploads to TestFlight |

If EAS holds your current Android upload key, download it with `eas credentials` first: Play rejects a bundle signed with a new key.

## Roll back

```sh
curl -X POST https://<your-worker>/v1/projects/<project>/rollbacks \
  -H "authorization: Bearer $BETTER_UPDATES_TOKEN" -H "content-type: application/json" \
  -d '{"channel":"production","runtimeVersion":"1.0.0","platform":"ios"}'
```

## Test

`bun test` starts the Worker on local workerd, publishes a fixture export, and checks every response the way the app does, including the signature.
