// node scripts/check-netease-lyrics.mjs
import fs from 'node:fs'
import { assert, checks, deferred, flush, loadModule } from './native-services-fixture.mjs'
import { fakeClock } from './request-fixture.mjs'

const { check, finish } = checks()
const lyric = '[00:01.00]original'
function fixture(reply = { code: 200, lrc: { lyric } }, qqBody = { code: 0, lyric: 'QQ old lyric' }) {
	const clock = fakeClock()
	const calls = []
	class ClockDate extends Date { static now() { return clock.now } }
	const globals = { ...clock, Date: ClockDate, fetch: async (url, init) => {
		calls.push({ url, init })
		return typeof reply === 'function' ? reply(url, init, calls.length) : { ok: true, json: async () => reply }
	} }
	const helper = fs.existsSync('src/helpers/userApi/neteaseLyrics.ts')
		? loadModule('src/helpers/userApi/neteaseLyrics.ts', {}, globals) : {}
	const api = loadModule('src/helpers/userApi/getMusicSource.ts', {
		'./neteaseLyrics': helper,
		'@/components/utils': { b64DecodeUnicode: (s) => s, decodeName: (s) => s },
		'@/components/utils/musicSdk/options.js': {},
		'@/components/utils/musicSdk/utils': {},
		'@/components/utils/request': { httpFetch: (url) => {
			calls.push({ url })
			return { promise: Promise.resolve({ body: qqBody }) }
		} },
		'@/constants/images': {}, '@/helpers/userApi/qq-music-api': {},
		'@/locales/commentsFeature': { t: () => 'no lyrics' },
		axios: {}, 'react-native': {}, '../logger': { logError() {}, logInfo() {} },
	}, globals)
	return { ...api, clock, calls }
}
const item = (id = '186016', platform = 'Netease') => ({ id, platform })

await check('real myGetLyric normalizes all NetEase aliases without sending native ID to QQ', async () => {
	for (const platform of ['Netease', 'netease', 'wy', '163', ' NETEASE ']) {
		const f = fixture()
		const result = await f.myGetLyric(item('186016', platform))
		assert.equal(result.lyric, lyric)
		assert.equal(result.status, 'available')
		assert.match(f.calls[0].url, /music\.163\.com\/api\//)
	}
})

await check('invalid native IDs stay out of QQ and make no request; numeric native IDs work', async () => {
	const f = fixture()
	for (const id of ['qq-mid', '', '0', '-1', '1.5', '9007199254740992', undefined]) {
		assert.equal((await f.myGetLyric({ id, platform: 'wy' })).status, 'error')
	}
	assert.equal(f.calls.length, 0)
	assert.equal((await f.myGetLyric(item(186016, '163'))).lyric, lyric)
})

await check('QQ old success and placeholder failure behavior is preserved', async () => {
	const f = fixture()
	const result = await f.myGetLyric(item('qq-mid', 'QQ'))
	assert.equal(result.lyric, 'QQ old lyric')
	assert.equal(result.status, undefined)
	assert.match(f.calls[0].url, /c\.y\.qq\.com/)
	const failed = fixture(undefined, { code: 1 })
	assert.equal((await failed.myGetLyric(item('qq-mid', 'QQ'))).lyric, '[00:00.00]no lyrics')
})

await check('business failure, empty response and network failure never return fake lyrics', async () => {
	for (const reply of [null, { code: 301, lrc: { lyric } }, { code: 200 }, { code: 200, lrc: { lyric: ' \n' } }, () => { throw new Error('offline') }]) {
		const f = fixture(reply)
		const result = await f.myGetLyric(item())
		assert.equal(result.lyric, '')
		assert.equal(result.status, 'error')
		assert.ok(f.calls.length <= 2)
		const count = f.calls.length
		await f.myGetLyric(item())
		assert.ok(f.calls.length > count)
	}
})

await check('explicit instrumental and uncollected return distinct empty states with short caching', async () => {
	for (const [flag, status] of [['nolyric', 'instrumental'], ['pureMusic', 'instrumental'], ['uncollected', 'unavailable']]) {
		const f = fixture({ code: 200, [flag]: true, lrc: { lyric: '[00:00]placeholder from API' } })
		const result = await f.myGetLyric(item())
		assert.equal(result.status, status)
		assert.equal(result.lyric, '')
		assert.equal(result.tlyric, '')
		await f.myGetLyric(item())
		assert.equal(f.calls.length, 1)
		f.clock.advance(30001)
		await f.myGetLyric(item())
		assert.equal(f.calls.length, 2)
	}
})

await check('fallback uses official legacy endpoint and returns old, LRC or converted YRC lyrics', async () => {
	for (const data of [{ lyric }, { lrc: { lyric } }, { yrc: { lyric: '[1000,2000](1000,500,0)word' } }]) {
		const f = fixture(async (_url, _init, count) => ({ ok: true, json: async () => count === 1 ? { code: 200 } : { code: 200, ...data } }))
		const result = await f.myGetLyric(item())
		assert.equal(result.status, 'available')
		assert.equal(result.lyric, data.yrc ? '[00:01.000]word' : lyric)
		assert.equal(f.calls.length, 2)
		assert.match(f.calls[0].url, /\/api\/song\/lyric\/v1\?id=186016&lv=-1&kv=-1&tv=-1&rv=-1&yv=-1$/)
		assert.match(f.calls[1].url, /\/api\/song\/lyric\?id=186016&/)
	}
})

// Mock payload with the public YRC schema; not a captured public API response.
const yrcFixture = {
	code: 200,
	lrc: { version: 1, lyric: '' },
	yrc: { version: 4, lyric: [
		'{"t":0,"c":[{"tx":"metadata credit"}]}',
		'[61234,2500](61250,500,0)Hello (61750,1234,0)world (again)',
		'[123456,2000](123456,1000,0)Second (124456,1000,0)line',
	].join('\n') },
	tlyric: { version: 1, lyric: '[01:01.234]translation\n[02:03.456]second translation' },
}
await check('structured YRC becomes LRC at original millisecond line starts and works in the real parser', async () => {
	const f = fixture(yrcFixture)
	const result = await f.myGetLyric(item())
	assert.equal(result.status, 'available')
	assert.equal(result.lyric, '[01:01.234]Hello world (again)\n[02:03.456]Second line')
	assert.equal(result.tlyric, yrcFixture.tlyric.lyric)
	const Parser = loadModule('src/utils/lrcParser.ts', {}).default
	const parsed = new Parser({ rawLrc: result.lyric }).getLyric()
	assert.equal(parsed.length, 2)
	assert.equal(parsed[0].time, 61.234)
	assert.equal(parsed[0].lrc, 'Hello world (again)')
	assert.equal(parsed[1].time, 123.456)
	assert.equal(f.calls.length, 1)
})

await check('YRC without valid complete word structure is retryable, empty and never cached', async () => {
	for (const raw of [
		'raw yrc', '[61234,2500]untagged text', '[61234,2500](61234,500,0)',
		'[61234,2500](61234,500,0)   ', '[61234,2500](61234,bad,0)word',
		'[61234,2500]prefix(61234,500,0)word', '[61234,2500](61234,500,0)word(61734,bad,0)bad',
		'[-1,2500](0,500,0)word', '[9007199254740992,2500](0,500,0)word',
		'[61234,2500](9007199254740992,500,0)word', '[61234,2500](61234,-500,0)word',
		'[61234,2500](61234,500,0)[ar:tag only]', '{"t":0,"c":[{"tx":"metadata only"}]}',
	]) {
		const f = fixture({ code: 200, yrc: { lyric: raw } })
		const result = await f.myGetLyric(item())
		assert.equal(result.status, 'error', raw)
		assert.equal(result.retryable, true, raw)
		assert.equal(result.lyric, '', raw)
		assert.equal(result.tlyric, '', raw)
		assert.equal(f.calls.length, 2)
		await f.myGetLyric(item())
		assert.equal(f.calls.length, 4)
	}
})

await check('valid LRC or legacy flat lyrics win over YRC and retain object translation', async () => {
	for (const field of [{ lrc: { lyric } }, { lyric }]) {
		const f = fixture({ ...yrcFixture, ...field })
		const result = await f.myGetLyric(item())
		assert.equal(result.lyric, lyric)
		assert.equal(result.tlyric, yrcFixture.tlyric.lyric)
	}
	const f = fixture({ ...yrcFixture, lrc: { lyric: '[ar:artist]\n[00:00.00] ' } })
	assert.equal((await f.myGetLyric(item())).lyric, '[01:01.234]Hello world (again)\n[02:03.456]Second line')
})

await check('metadata is removed, lyric credits preserved, LRC preferred over YRC, translation retained', async () => {
	const metadata = '{"t":0,"c":[{"tx":"metadata"}]}'
	const credit = '[00:00.00]Lyrics by: writer'
	const f = fixture({ code: 200, lrc: { lyric: `${metadata}\n${credit}\n${lyric}` }, yrc: { lyric: 'raw yrc' }, tlyric: { lyric: `${metadata}\n[00:01.00]translation` } })
	const result = await f.myGetLyric(item())
	assert.equal(result.lyric, `${credit}\n${lyric}`)
	assert.equal(result.tlyric, '[00:01.00]translation')
	const empty = fixture({ code: 200, lrc: { lyric: `${metadata}\n[ar:artist]\n[00:00.00] ` } })
	assert.equal((await empty.myGetLyric(item())).status, 'error')
})

await check('business codes and HTTP failures are classified before payload and never cached', async () => {
	for (const code of [301, 403, 404, 408, 429, 500, undefined]) {
		const f = fixture({ code, lrc: { lyric } })
		const result = await f.myGetLyric(item())
		const retryable = code === undefined || code === 408 || code === 429 || code >= 500
		assert.equal(result.status, 'error')
		assert.equal(result.retryable, retryable)
		assert.equal(f.calls.length, retryable ? 2 : 1)
		await f.myGetLyric(item())
		assert.equal(f.calls.length, retryable ? 4 : 2)
	}
	for (const status of [403, 429, 503]) {
		const f = fixture(() => ({ ok: false, status, json: async () => ({ code: 200, lrc: { lyric } }) }))
		const result = await f.myGetLyric(item())
		assert.equal(result.status, 'error')
		assert.equal(result.retryable, status !== 403)
		assert.equal(f.clock.pending, 0)
	}
})

await check('temporary network/JSON errors get only one retry and can recover', async () => {
	for (const mode of ['network', 'json']) {
		const f = fixture((_url, _init, count) => {
			if (count === 1 && mode === 'network') throw new Error('offline')
			return { ok: true, json: async () => {
				if (count === 1) throw new Error('invalid JSON')
				return { code: 200, lrc: { lyric } }
			} }
		})
		assert.equal((await f.myGetLyric(item())).status, 'available')
		assert.equal(f.calls.length, 2)
		assert.equal(f.clock.pending, 0)
	}
})

await check('timeout bounds fetch AND body, aborts transport, releases dedup and caches no failure', async () => {
	for (const body of [false, true]) {
		const f = fixture(() => body ? { ok: true, json: () => new Promise(() => {}) } : new Promise(() => {}))
		const task = f.myGetLyric(item())
		await flush()
		f.clock.advance(3000)
		await flush()
		assert.equal(f.calls.length, 2)
		assert.equal(f.calls[0].init.signal.aborted, true)
		f.clock.advance(3000)
		const result = await task
		assert.equal(result.status, 'error')
		assert.equal(result.retryable, true)
		assert.equal(f.calls[1].init.signal.aborted, true)
		assert.equal(f.clock.pending, 0)
		const again = f.myGetLyric(item())
		await flush()
		assert.equal(f.calls.length, 3)
		// A delayed JS resume must respect the total deadline rather than start another attempt.
		f.clock.advance(10000)
		assert.equal((await again).status, 'error')
		assert.equal(f.calls.length, 3)
	}
})

await check('same-ID work deduplicates across aliases; other IDs and caller aborts are independent', async () => {
	const response = deferred()
	const f = fixture(() => response.promise)
	const caller = new AbortController()
	const a = f.myGetLyric({ ...item(), signal: caller.signal })
	const b = f.myGetLyric(item('186016', 'wy'))
	const c = f.myGetLyric(item('186017'))
	assert.equal(f.calls.length, 2)
	caller.abort()
	assert.equal(f.calls[0].init.signal.aborted, false)
	response.resolve({ ok: true, json: async () => ({ code: 200, lrc: { lyric } }) })
	for (const result of await Promise.all([a, b, c])) assert.equal(result.status, 'available')
	assert.equal(f.clock.pending, 0)
})

await check('a timed-out transport settling late cannot overwrite a newer cached result', async () => {
	const old = deferred()
	const f = fixture((_url, _init, count) => count === 1 ? old.promise : { ok: true, json: async () => ({ code: 200, lrc: { lyric } }) })
	const first = f.myGetLyric(item())
	f.clock.advance(6001)
	assert.equal((await first).status, 'error')
	assert.equal((await f.myGetLyric(item())).lyric, lyric)
	old.resolve({ ok: true, json: async () => ({ code: 200, lrc: { lyric: 'stale' } }) })
	await flush()
	assert.equal((await f.myGetLyric(item())).lyric, lyric)
	assert.equal(f.calls.length, 2)
})

await check('success cache has TTL and 128-ID bound; results cannot mutate shared cache', async () => {
	const f = fixture()
	const result = await f.myGetLyric(item())
	result.lyric = 'mutated'
	assert.equal((await f.myGetLyric(item())).lyric, lyric)
	assert.equal(f.calls.length, 1)
	f.clock.advance(600001)
	await f.myGetLyric(item())
	assert.equal(f.calls.length, 2)
	for (let id = 1; id <= 128; id++) await f.myGetLyric(item(String(id)))
	await f.myGetLyric(item())
	assert.equal(f.calls.length, 131)
	assert.equal(f.clock.pending, 0)
})
if (process.argv.includes('--live')) {
	await check('LIVE real myGetLyric returns available and instrumental with original native IDs', async () => {
		const f = fixture((url, init) => fetch(url, init))
		for (const [id, expected] of [['186016', 'available'], ['5308028', 'instrumental']]) {
			const result = await f.myGetLyric(item(id, 'wy'))
			console.log(JSON.stringify({ id, status: result.status, lines: result.lyric.split('\n').filter(Boolean).length }))
			assert.equal(result.status, expected)
		}
	})
}
finish()
