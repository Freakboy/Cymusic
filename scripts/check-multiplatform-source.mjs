import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createDecipheriv, createHash } from 'node:crypto'
import { createSourceFixture, script } from './source-runtime-fixture.mjs'

const require = createRequire(import.meta.url)
const h = createSourceFixture({
	imports: {
		axios: require('axios'),
		'crypto-js': require('crypto-js'),
		'crypto-js/sha256': require('crypto-js/sha256'),
	},
})
const platforms = h.load('src/player/sourceResolver/platforms')
for (const platform of platforms.RESOLUTION_PLATFORMS) {
	assert.equal(platforms.supportsPlatform({ scriptType: 'cymusic' }, platform), platform === 'tx')
	assert.equal(platforms.supportsPlatform({ scriptType: 'lxmusic' }, platform), false)
	assert.equal(platforms.supportsPlatform({ sources: { [platform]: false } }, platform), false)
}
// Verify the encrypted WY payload independently of CryptoJS and transport mocks.
const wyRequest = platforms.platformSearchRequest('wy', 'Song Artist')
const decipher = createDecipheriv('aes-128-ecb', Buffer.from('e82ckenh8dichen8'), null)
const plaintext = Buffer.concat([
	decipher.update(Buffer.from(wyRequest.data.slice(7), 'hex')),
	decipher.final(),
]).toString()
const [wyPath, wyBody, digest] = plaintext.split('-36cd479b6b5-')
assert.equal(wyPath, '/api/search/song/list/page')
assert.equal(JSON.parse(wyBody).keyword, 'Song Artist')
assert.equal(
	digest,
	createHash('md5').update(`nobody${wyPath}use${wyBody}md5forencrypt`).digest('hex'),
)
const item = { id: 'qq', title: 'Song', artist: 'Artist', album: 'Album', duration: 200 }
const raw = {
	tx: {
		code: 0,
		req_1: {
			code: 0,
			data: {
				body: {
					song: {
						list: [
							{
								mid: '004IArbh3ytHgR',
								id: 12,
								title: 'Song',
								singer: [{ name: 'Artist' }],
								album: { name: 'Album' },
								interval: 200,
								file: { media_mid: 'media' },
							},
						],
					},
				},
			},
		},
	},
	wy: {
		code: 200,
		data: {
			resources: [
				{
					baseInfo: {
						simpleSongData: {
							id: 123,
							name: 'Song',
							ar: [{ name: 'Artist' }],
							al: { name: 'Album', id: 1 },
							dt: 200000,
						},
					},
				},
			],
		},
	},
	kg: {
		error_code: 0,
		data: {
			lists: [
				{
					Audioid: 45,
					FileHash: 'a'.repeat(32),
					HQFileHash: 'b'.repeat(32),
					SQFileHash: 'c'.repeat(32),
					OriSongName: 'Song',
					Singers: [{ name: 'Artist' }],
					AlbumName: 'Album',
					Duration: 200,
				},
			],
		},
	},
	kw: {
		TOTAL: '1',
		SHOW: '1',
		abslist: [
			{ MUSICRID: 'MUSIC_67', SONGNAME: 'Song', ARTIST: 'Artist', ALBUM: 'Album', DURATION: '200' },
		],
	},
	mg: {
		code: '000000',
		songResultData: {
			resultList: [
				[
					{
						songId: '89',
						copyrightId: '6001',
						name: 'Song',
						singerList: [{ name: 'Artist' }],
						album: 'Album',
						duration: 200,
					},
				],
			],
		},
	},
}
for (const platform of platforms.RESOLUTION_PLATFORMS) {
	const candidates = platforms.decodeCandidates(platform, raw[platform])
	assert.equal(candidates.length, 1)
	const match = platforms.selectPlatformMatch(item, candidates)
	assert.equal(match.source, platform)
	assert.equal(platforms.selectPlatformMatch({ ...item, title: 'Song (Live)' }, candidates), null)
	assert.equal(platforms.selectPlatformMatch({ ...item, artist: 'Other' }, candidates), null)
	assert.equal(platforms.selectPlatformMatch({ ...item, duration: 210 }, candidates), null)
	assert.equal(platforms.selectPlatformMatch({ ...item, album: 'Other' }, candidates), null)
	assert.equal(
		platforms.selectPlatformMatch(item, [
			...candidates,
			{ ...candidates[0], id: 'another', songmid: 'another' },
		]),
		null,
	)
	if (platform !== 'tx') assert.notEqual(match.songmid, '004IArbh3ytHgR')
	const ready = h.adapter.adaptLxMusicScript(script(platform))
	h.native.init(undefined, {
		info: { sources: { [platform]: { type: 'music', actions: ['musicUrl'], qualitys: ['128k'] } } },
	})
	const api = await ready
	const sentCount = h.native.sent.length
	await assert.rejects(
		api.getMusicUrl('Song', 'Artist', 'qqmid', '320k', { platform, musicInfo: match }),
		/not supported/,
	)
	assert.equal(h.native.sent.length, sentCount)
	const controller = new AbortController()
	const promise = api.getMusicUrl(item.title, item.artist, '004IArbh3ytHgR', '128k', {
		platform,
		musicInfo: match,
		signal: controller.signal,
	})
	const sent = h.native.sent.at(-1).data
	assert.equal(sent.data.source, platform)
	assert.equal(sent.data.info.musicInfo.songmid, match.songmid)
	if (platform !== 'kg') assert.equal(sent.data.info.musicInfo.hash, undefined)
	h.native.emit('response', {
		requestKey: sent.requestKey,
		status: true,
		result: {
			action: 'musicUrl',
			data: { url: 'https://audio.test/a', headers: { Referer: 'test' } },
		},
	})
	assert.equal((await promise).headers.Referer, 'test')
	const aborted = api.getMusicUrl('Song', 'Artist', 'qqmid', '128k', {
		platform,
		musicInfo: match,
		signal: controller.signal,
	})
	controller.abort()
	await assert.rejects(aborted, /CANCELLED/)
	h.adapter.disposeLxMusicScript()
}
console.log('PASS five platform schemas, strict matching, lx envelopes, headers and abort')
