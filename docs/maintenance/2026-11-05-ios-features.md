# iOS music features and verification

## Scope

This change implements the agreed iOS feature set. Android and Android Auto remain deferred.
No account or cross-device synchronization service has been introduced.

| Feature | Implementation |
| --- | --- |
| Remote playlists | QQ Music and NetEase URL/ID parsing, complete-list validation, preview before saving, update/copy/merge |
| Playlist refresh | Refresh and more controls beside each remote playlist; pending/check/error states; detail-page refresh |
| Preservation | Custom names/covers and local additions survive updates; unmarked legacy QQ data migrates conservatively |
| Lyrics | Platform-specific fetch, original/bilingual/translation-only modes, timing offset and font controls |
| Comments | QQ and NetEase read-only popular/latest lists, pagination, retry, stale-response isolation |
| Search | QQ songs/artists/albums/playlists with debounce, cancellation, paging and collection details |
| Sources | File/URL import, selection, enable/disable, ordering, reload, URL update and serialized URL tests |
| Playback | Serial source fallback, strict NetEase-to-QQ matching, atomic/deduplicated next-file caching, native queue handoff |
| Bluetooth lyrics | Opt-in current-line projection through RNTP metadata; original titles restored when disabled |
| CarPlay | Native library browser, queue snapshots, durable selection events and Now Playing navigation |

## UI entries

- Favorites: remote playlist rows expose refresh and more. A checkmark is temporary success feedback, not a selection switch.
- Playlist import: choose create/import, select automatic/QQ/NetEase, preview, then confirm update/copy/merge.
- Player: the comment bubble is beside song options; the same action is available in song menus and on the lyric page.
- Lyrics: four equal controls for return, font size, translation mode and timing offset. Missing translations fall back to original text.
- Settings: Music Sources opens the standalone manager. Next-track caching and Bluetooth lyric compatibility have separate settings.

## Data and playback rules

Remote playlist identity is platform plus remote ID. New local playlist IDs use
`remote:<platform>:<remoteId>`; old numeric QQ IDs are migrated when refreshed.
Incomplete or failed remote requests do not replace saved songs. A verified empty
playlist is a valid update. On the first update of legacy playlists without a
remote snapshot, unknown old songs are kept as local additions rather than deleted.

Next-track caching prepares one file after current playback becomes ready. Queue,
quality, source, cache and preload changes retire obsolete work. Downloads use
temporary files and nonempty HTTP-success validation before rename. A prepared
native item replaces the future placeholder. Its transition is adopted without
resetting audio; a late or failed preparation retains the original fallback.
Pause/Stop and transition ownership are covered by mock regression tests.

This is not overlapping crossfade. Audible gap length depends on codec, source
and native playback behavior and has not been measured on an iPhone here.

Playback scripts retain their existing URL-resolver contract. Metadata search
uses QQ, while playlist and lyric retrieval support their respective platforms.
NetEase tracks are matched conservatively to QQ for tx-only source scripts;
ambiguous matches fail rather than silently choosing a different recording.

## Validation in this environment

The workspace is Linux with Node 22.22.0 and Corepack Yarn 1.22.22.
The locked dependency installation and patch application succeeded. TypeScript
checking and iOS Metro export with `--no-bytecode` succeeded. The normal Hermes
compiler executable could not run on this host architecture.

The following executable JS checks pass:

```sh
node scripts/check-remote-playlist.mjs
node scripts/check-netease-comments.mjs
node scripts/check-search-management.mjs
node scripts/check-player-preparation.mjs
node scripts/check-prepared-handoff.mjs
node scripts/check-carplay.mjs
node scripts/check-rntp-player.mjs
node scripts/check-local-files.mjs
node scripts/check-file-downloads.mjs
```

The new native module is visible to Expo Apple autolinking. Plist/entitlement
syntax and scene references are checked; these are not a substitute for Swift
compilation. Targeted lint passes. Whole-repository lint still reports pre-existing
errors in legacy SDK/utilities outside this feature change.

## Required iOS acceptance

Rebuild the native app on macOS using the existing development instructions.
Do not run Expo prebuild over the retained iOS project. Regenerate Pods for the
new Expo module. A JS-only update of an old binary cannot add CarPlay scenes.

CarPlay signing needs a provisioning profile authorized for
`com.apple.developer.carplay-audio`. The app identity and App Group are unchanged.

Verify these device behaviors before describing the release as accepted:

1. Phone cold start, share extension, deep links, background/foreground and reconnect after the new scene configuration.
2. CarPlay cold start, browse/paginate favorites and playlists, choose a song, play/pause/next/previous and disconnect/reconnect.
3. MP3/FLAC handoff, rapid navigation, pause/Stop at the boundary, buffering, failed sources and low/no network.
4. Bluetooth lyric opt-in, line changes, seek, title restoration, Lock Screen progress and accessory compatibility.
5. Narrow-screen and large-text layout for import previews, playlist controls, comments and the four-button lyric toolbar.

Bluetooth compatibility mode changes the system track title, including Lock
Screen and CarPlay. It is off by default and cannot guarantee lyric display on
every accessory. NetEase anonymous comment endpoints may expose only historical
or partial comments; the UI discloses this limitation. Third-party interfaces may
change independently of the app.
