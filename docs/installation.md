[← Documentation](README.md)

# Installation & updates

Grab the signed `stasharr-<version>.xpi` from [Releases](https://github.com/brewing8309/stasharr/releases)
and drag it into Firefox. That's it — from 1.3.0 on it **updates itself**: Firefox periodically
checks [`updates.json`](../updates.json) in this repo and pulls newer releases like any other
add-on. To check right away: `about:addons` → gear icon → **Check for Updates**.

> [!NOTE]
> **Updating to 1.9.0 from an older version:** 1.9.0 replaced the access to every website with
> access to just your Prowlarr and Stash. Right after the update the preferences open once; press
> **Save settings** and allow the access Firefox asks for.

<details>
<summary><b>Temporary — for trying out a branch</b> (gone on restart)</summary>

1. Clone or download this repo.
2. Open `about:debugging#/runtime/this-firefox`.
3. **Load Temporary Add-on…** → pick `manifest.json`.

</details>

<details>
<summary><b>Signing your own build</b> (for forks)</summary>

Firefox refuses to permanently install unsigned extensions on Release and Beta. An add-on ID can
only ever be signed by the AMO account that owns it, so a fork first needs its own `gecko.id` in
`manifest.json` — and its own `update_url`, or it'll keep polling this repo. Then sign it as an
unlisted add-on, which never goes on the public store or through Mozilla's review:

```bash
npm ci --ignore-scripts          # web-ext, at the version in package-lock.json
npx --no-install web-ext sign --channel=unlisted \
  --ignore-files tests docs updates.json package.json package-lock.json \
  --api-key="$AMO_JWT_ISSUER" \
  --api-secret="$AMO_JWT_SECRET"
```

Get the credentials at [addons.mozilla.org → Developer Hub → API Keys](https://addons.mozilla.org/developers/addon/api/key/).
The signed `.xpi` lands in `web-ext-artifacts/`.

</details>

> Firefox Developer Edition, Nightly and ESR can skip signing entirely by setting
> `xpinstall.signatures.required` to `false` in `about:config`.
