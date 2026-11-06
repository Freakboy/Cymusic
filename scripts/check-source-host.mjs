// Run: node scripts/check-source-host.mjs
// Executes the real typed facade/adapter. Native delivery and time are controlled
// here; check-source-runtime.mjs separately executes the real Foundation/JSC core.
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { createSourceFixture, assertRetired, deferred, flush, script } from './source-runtime-fixture.mjs'

const checks = []
const test = async (name, action) => {
	try { await action(); checks.push({ name, passed: true }) }
	catch (error) { checks.push({ name, passed: false, error: error.stack }) }
}
const observe = promise => {
	const result = { count: 0, status: 'pending' }
	result.done = promise.then(value => {
		result.count++; result.status = 'fulfilled'; result.value = value
	}, error => {
		result.count++; result.status = 'rejected'; result.error = error
	})
	return result
}
const info = (id, allowShowUpdateAlert = false) => ({
	id, name: `source ${id}`, description: 'fixture', version: '1', author: '', homepage: '',
	script: script(id), allowShowUpdateAlert,
})
const success = (requestKey, url) => ({
	requestKey, status: true, result: { action: 'musicUrl', data: { url } },
})
const request = (requestKey, options = {}, url = 'https://example.test') => ({
	requestKey, url, options: { method: 'GET', timeout: 1000, headers: {}, binary: false, ...options },
})
const waitFor = async predicate => {
	const until = Date.now() + 3000
	while (!predicate()) {
		if (Date.now() >= until) throw new Error('Fixture observation timed out')
		await new Promise(resolve => setTimeout(resolve, 5))
	}
}

await test('final delivery filters generations before JSON/metadata; raw events are not mutated', async () => {
	const f = createSourceFixture()
	const events = []
	const remove = f.facade.onScriptAction(event => events.push(event))
	const other = []
	const removeOther = f.facade.onScriptAction(event => other.push(event))
	assert.equal(f.facade.loadScript(info('A')), undefined)
	const a = f.native.generation
	const late = f.native.queue({ action: 'init', data: 'invalid JSON from A', generation: a })
	f.facade.loadScript(info('B'))
	late()
	f.native.raw({ action: 'request', data: 'invalid JSON from A', generation: a })
	assert.equal(events.length, 0)
	const raw = Object.freeze({ action: 'init', generation: f.native.generation,
		data: JSON.stringify({ status: true, info: { sources: { tx: {} } } }) })
	f.native.raw(raw)
	assert.equal(typeof raw.data, 'string')
	assert.equal(events[0].data.info.id, 'B')
	assert.equal(other[0].data.info.name, 'source B')
	assert.equal('generation' in events[0], false)
	f.native.emit('showUpdateAlert', { log: 'hidden' })
	assert.equal(events.length, 1)
	f.facade.loadScript(info('C', true))
	f.native.emit('showUpdateAlert', { log: 'visible' })
	assert.equal(events.at(-1).data.log, 'visible')
	f.native.raw({ action: 'log', type: 'warn', log: 'preserved', generation: f.native.generation })
	assert.deepEqual(events.at(-1), { action: 'log', type: 'warn', log: 'preserved' })
	const lateC = f.native.queue({ action: 'init', data: 'invalid', generation: f.native.generation })
	f.facade.destroy()
	lateC()
	f.facade.sendAction('response', { requestKey: 'x', error: null, response: null })
	assert.equal(f.native.sent.length, 0)
	remove(); removeOther()
	assert.equal(f.native.listeners.size, 0)
})

await test('overlapping init calls each settle once; a retired timeout cannot clear the new init', async () => {
	const f = createSourceFixture()
	const a = observe(f.adapter.adaptLxMusicScript(script('A')))
	const oldRuntime = f.adapter.inspectRuntime()
	const oldTimeout = [...f.clock.timers.values()][0].callback
	const oldGeneration = f.native.generation
	f.clock.advance(5000)
	const b = observe(f.adapter.adaptLxMusicScript(script('B')))
	const current = f.adapter.inspectRuntime()
	assertRetired(f, oldRuntime)
	oldTimeout()
	f.native.init(oldGeneration)
	assert.notEqual(current.init, null)
	f.clock.advance(7000)
	f.native.init()
	f.native.init()
	await Promise.all([a.done, b.done])
	assert.equal(a.status, 'rejected')
	assert.equal(b.status, 'fulfilled')
	assert.equal(a.count, 1); assert.equal(b.count, 1)
	assert.equal(f.clock.timers.size, 0)
	assert.equal(f.native.listeners.size, 1)
	f.facade.destroy()
	assertRetired(f, current)
	const failed = observe(f.adapter.adaptLxMusicScript(script('timeout')))
	const failedRuntime = f.adapter.inspectRuntime()
	f.clock.advance(10000)
	await failed.done
	assert.match(failed.error.message, /初始化超时/)
	assertRetired(f, failedRuntime)
	const early = observe(f.adapter.adaptLxMusicScript(script('early failure')))
	const earlyRuntime = f.adapter.inspectRuntime()
	f.native.init(undefined, { status: false, errorMessage: 'fixture init failure', info: null })
	await early.done
	assert.equal(early.error.message, 'fixture init failure')
	assertRetired(f, earlyRuntime)
})

await test('same business request key has distinct attempts and unchanged script request context', async () => {
	const f = createSourceFixture()
	const api = await f.initialized('requests')
	const runtime = f.adapter.inspectRuntime()
	const a = observe(api.getMusicUrl('Title', 'Artist', 'song', 'flac',
		{ requestKey: 'shared', requestType: 'preload', timeoutMs: 10 }))
	const b = observe(api.getMusicUrl('Title', 'Artist', 'song', '320k',
		{ requestKey: 'shared', requestType: 'current', timeoutMs: 100 }))
	const [aWire, bWire] = f.native.sent.map(sent => sent.data.requestKey)
	assert.notEqual(aWire, bWire)
	for (const [sent, quality, requestType] of [
		[f.native.sent[0], 'flac', 'preload'], [f.native.sent[1], '320k', 'current'],
	]) {
		assert.equal(sent.generation, f.native.generation)
		assert.equal(sent.data.data.action, 'musicUrl')
		assert.equal(sent.data.data.source, 'tx')
		assert.equal(sent.data.data.info.type, quality)
		assert.deepEqual(sent.data.data.info.requestContext, { requestKey: 'shared', requestType })
		assert.deepEqual(sent.data.data.info.musicInfo, {
			id: 'song', songmid: 'song', title: 'Title', name: 'Title', singer: 'Artist',
			artist: 'Artist', source: 'tx',
		})
	}
	f.clock.advance(10)
	await a.done
	assert.equal(a.status, 'rejected')
	assert.equal(runtime.pendingRequests.size, 1)
	assert.equal(runtime.settledRequestTypes.size, 1)
	f.native.emit('response', { requestKey: aWire, status: false, errorMessage: 'late preload' })
	assert.equal(runtime.pendingRequests.size, 1)
	assert.equal(runtime.settledRequestTypes.size, 0)
	assert.equal(f.logs.filter(log => log.level === 'error').length, 0)
	f.native.emit('response', success(bWire, 'https://example.test/right'))
	await b.done
	assert.equal(b.value, 'https://example.test/right')
	assert.equal(a.count, 1); assert.equal(b.count, 1)
	assert.equal(f.clock.timers.size, 0)
	f.facade.destroy(); assertRetired(f, runtime)
})

await test('runtime replacement rejects old music once and an old API cannot call the replacement', async () => {
	const f = createSourceFixture()
	const apiA = await f.initialized('A')
	const oldRuntime = f.adapter.inspectRuntime()
	const oldGeneration = f.native.generation
	const old = observe(apiA.getMusicUrl('A', 'artist', 'id', '128k', { requestKey: 'same' }))
	const oldKey = f.native.sent.at(-1).data.requestKey
	const apiB = await f.initialized('B')
	await old.done
	assert.equal(old.status, 'rejected')
	assertRetired(f, oldRuntime)
	const current = observe(apiB.getMusicUrl('B', 'artist', 'id', '128k', { requestKey: 'same' }))
	const key = f.native.sent.at(-1).data.requestKey
	f.native.emit('response', success(oldKey, 'https://example.test/old'), oldGeneration)
	assert.equal(f.adapter.inspectRuntime().pendingRequests.size, 1)
	const count = f.native.sent.length
	await assert.rejects(apiA.getMusicUrl('stale', '', '', ''), /已销毁/)
	assert.equal(f.native.sent.length, count)
	f.native.emit('response', success(key, 'https://example.test/new'))
	await current.done
	assert.equal(current.value, 'https://example.test/new')
	const runtime = f.adapter.inspectRuntime()
	const timed = observe(apiB.getMusicUrl('timed', '', '', '128k', { timeoutMs: 1 }))
	f.clock.advance(1); await timed.done
	assert.equal(runtime.settledRequestTypes.size, 1)
	f.facade.destroy(); f.facade.destroy()
	assertRetired(f, runtime)
	assert.equal(old.count, 1)
})

await test('music errors and a synchronous bridge failure settle and clear their request timer', async () => {
	const f = createSourceFixture()
	const api = await f.initialized('errors')
	for (const [response, expected] of [
		[{ status: false, errorMessage: 'source failure' }, 'source failure'],
		[{ status: true, result: { action: 'musicUrl', data: { url: 'file:///invalid' } } }, 'Script returned invalid musicUrl'],
	]) {
		const result = observe(api.getMusicUrl('title', 'artist', 'id', '128k'))
		f.native.emit('response', { requestKey: f.native.sent.at(-1).data.requestKey, ...response })
		await result.done
		assert.equal(result.error.message, expected)
		assert.equal(f.adapter.inspectRuntime().pendingRequests.size, 0)
		assert.equal(f.clock.timers.size, 0)
	}
	f.native.sendAction = () => { throw new Error('native send failure') }
	await assert.rejects(api.getMusicUrl('title', 'artist', 'id', '128k'), /native send failure/)
	assert.equal(f.adapter.inspectRuntime().pendingRequests.size, 0)
	assert.equal(f.clock.timers.size, 0)
	f.facade.destroy()
})

await test('HTTP same-key replacement owns its controller/timeout through late completion', async () => {
	const work = []
	const f = createSourceFixture({ fetch: (url, options) => {
		const pending = deferred(); work.push({ ...pending, options }); return pending.promise
	} })
	await f.initialized('HTTP overlap')
	f.native.emit('request', request('same'))
	const oldTimeout = [...f.clock.timers.values()][0].callback
	f.native.emit('request', request('same'))
	assert.equal(work[0].options.signal.aborted, true)
	oldTimeout()
	assert.equal(work[1].options.signal.aborted, false)
	work[0].resolve(new Response('late'))
	await flush()
	assert.equal(f.native.sent.length, 0)
	assert.equal(f.adapter.inspectRuntime().pendingHttpRequests.size, 1)
	work[1].resolve(new Response('{"ok":false}', { status: 503, statusText: 'Unavailable',
		headers: { 'content-type': 'application/json', 'x-fixture': 'yes' } }))
	await flush()
	assert.equal(f.native.sent.length, 1)
	assert.deepEqual(f.native.sent[0].data.response.body, { ok: false })
	assert.equal(f.native.sent[0].data.response.statusCode, 503)
	assert.equal(f.native.sent[0].data.error, null)
	assert.equal(f.clock.timers.size, 0)
	f.facade.destroy()
})

await test('business cancellation/timeout rejects late child HTTP, while initialization HTTP has a bounded default', async () => {
	for (const ending of ['abort', 'timeout']) {
		const work = []
		const f = createSourceFixture({fetch: (_url, options) => { const pending = deferred(); work.push({...pending, options}); return pending.promise }})
		const ready = f.adapter.adaptLxMusicScript('/** @name init-http */\nlx.on(lx.EVENT_NAMES.request, () => {})')
		f.native.emit('request', request('init', {timeout:0}))
		assert.equal(work.length, 1, 'Unparented initialization HTTP must remain allowed')
		assert.equal([...f.clock.timers.values()].some(timer => timer.delay === 15000), true)
		work[0].resolve(new Response('init'))
		await flush()
		f.native.init(undefined, {info:{sources:{tx:{type:'music',actions:['musicUrl'],qualitys:['128k']}}}})
		const api = await ready, controller = new AbortController()
		const result = observe(api.getMusicUrl('Title','Artist','mid','128k',{signal:controller.signal,timeoutMs:10}))
		const parentRequestKey = f.native.sent.at(-1).data.requestKey
		f.native.emit('request', {...request('child',{timeout:0}), parentRequestKey})
		assert.equal(work.length, 2)
		if (ending === 'abort') controller.abort()
		else f.clock.advance(10)
		await result.done
		assert.equal(result.status,'rejected')
		assert.equal(work[1].options.signal.aborted,true)
		assert.equal(f.adapter.inspectRuntime().pendingHttpRequests.size,0)
		f.native.emit('request', {...request('late'),parentRequestKey})
		assert.equal(work.length,2,'Late parented request must not fetch')
		assert.equal(f.native.sent.at(-1).data.error,'SOURCE_REQUEST_SETTLED')
		f.native.emit('request', request('default',{timeout:undefined}))
		assert.equal(work.length,3)
		f.clock.advance(15000)
		assert.equal(work[2].options.signal.aborted,true)
		assert.equal(f.adapter.inspectRuntime().pendingHttpRequests.size,0)
		work[1].reject(new Error('late aborted child'))
		work[2].reject(new Error('late default timeout'))
		await flush()
		f.facade.destroy()
		assert.equal(f.clock.timers.size,0)
	}
})

await test('both real preload VMs propagate wire parents through async HTTP and host cancellation', async () => {
	for (const filename of ['ios/CyMusic/user-api-preload.js', 'src/helpers/userApi/user-api-preload.js']) {
		for (const ending of ['abort', 'timeout']) {
			const work = [], events = []
			const f = createSourceFixture({ fetch: (url, options) => {
				const pending = deferred()
				work.push({ ...pending, url, options })
				return pending.promise
			} })
			const ready = f.adapter.adaptLxMusicScript(script('VM HTTP'))
			const context = vm.createContext({ __lx_native_call__: (_key, action, json) => {
				const data = JSON.parse(json)
				events.push({ action, data })
				f.native.emit(action, data)
			} })
			vm.runInContext(readFileSync(new URL('../' + filename, import.meta.url), 'utf8'), context)
			const send = f.native.sendAction.bind(f.native)
			f.native.sendAction = (action, data, generation) => {
				send(action, data, generation)
				context.__lx_native__('key', action, data)
			}
			vm.runInContext(`lx_setup('key', 'id', 'fixture', '', '', '', '', '');
				const api = globalThis.lx || globalThis.lxu;
				api.request('https://example.test/init', {}, () => {});
				api.on(api.EVENT_NAMES.request, async () => {
					await Promise.resolve();
					api.request('https://example.test/child', {}, () => {});
					await new Promise(resolve => { globalThis.resume = resolve });
					api.request('https://example.test/late', {}, () => {});
					return 'https://example.test/audio';
				});
				api.send(api.EVENT_NAMES.inited, { sources: {
					tx: { type: 'music', actions: ['musicUrl'], qualitys: ['128k'] }
				} });`, context)
			const api = await ready
			assert.equal(events.find(event => event.action === 'request').data.parentRequestKey, undefined)
			assert.equal(work.length, 1, 'Initialization HTTP must be usable without a parent')
			f.clock.advance(14999)
			assert.equal(work[0].options.signal.aborted, false)
			f.clock.advance(1)
			assert.equal(work[0].options.signal.aborted, true, 'Omitted timeout defaults to 15s')
			const controller = new AbortController()
			const result = observe(api.getMusicUrl('Title', 'Artist', 'mid', '128k', {
				requestKey: 'business-key', requestType: 'preload', signal: controller.signal, timeoutMs: 50,
			}))
			const wire = f.native.sent.at(-1).data.requestKey
			await flush()
			const child = events.filter(event => event.action === 'request').at(-1).data
			assert.equal(child.parentRequestKey, wire)
			assert.notEqual(wire, 'business-key')
			assert.equal(child.requestType, 'preload')
			assert.equal(work.length, 2)
			if (ending === 'abort') controller.abort()
			else f.clock.advance(50)
			await result.done
			assert.equal(result.status, 'rejected')
			assert.equal(work[1].options.signal.aborted, true)
			assert.equal(f.adapter.inspectRuntime().pendingHttpRequests.size, 0)
			vm.runInContext('resume()', context)
			await flush()
			const late = events.filter(event => event.action === 'request').at(-1).data
			assert.equal(late.parentRequestKey, wire)
			assert.equal(work.length, 2, 'Late HTTP from timed-out/cancelled VM handler must not fetch')
			assert.equal(f.native.sent.find(event => event.data.requestKey === late.requestKey).data.error, 'SOURCE_REQUEST_SETTLED')
			for (const pending of work) pending.reject(new Error('late transport rejection'))
			await flush()
			f.facade.destroy()
			assert.equal(f.clock.timers.size, 0)
		}
	}
})

await test('direct destroy clears actual HTTP maps/timers and ignores delayed body and finally', async () => {
	const work = []
	const f = createSourceFixture({ fetch: (url, options) => {
		const body = deferred(); work.push({ body, options })
		return Promise.resolve({ status: 200, statusText: 'OK', headers: new Headers(), text: () => body.promise })
	} })
	await f.initialized('A')
	const oldRuntime = f.adapter.inspectRuntime()
	f.native.emit('request', request('same'))
	await flush()
	f.facade.destroy()
	assert.equal(work[0].options.signal.aborted, true)
	assertRetired(f, oldRuntime)
	await f.initialized('B')
	f.native.emit('request', request('same'))
	work[0].body.resolve('late A body')
	await flush()
	assert.equal(f.native.sent.length, 0)
	assert.equal(f.adapter.inspectRuntime().pendingHttpRequests.size, 1)
	work[1].body.resolve('B body')
	await flush()
	assert.equal(f.native.sent[0].data.response.body, 'B body')
	assert.equal(f.native.sent[0].generation, f.native.generation)
	f.facade.destroy()
})

await test('explicit HTTP cancellation and timeout abort once and release handles immediately', async () => {
	const work = []
	const f = createSourceFixture({ fetch: (url, options) => {
		const pending = deferred(); work.push({ ...pending, options }); return pending.promise
	} })
	await f.initialized('cancel')
	f.native.emit('request', request('cancel'))
	f.native.emit('cancelRequest', 'cancel')
	f.native.emit('cancelRequest', 'cancel')
	assert.equal(work[0].options.signal.aborted, true)
	assert.equal(f.clock.timers.size, 0)
	assert.equal(f.adapter.inspectRuntime().pendingHttpRequests.size, 0)
	assert.equal(f.native.sent.length, 1)
	assert.equal(f.native.sent[0].data.response, null)
	assert.equal(typeof f.native.sent[0].data.error, 'string')
	work[0].reject(new Error('late abort'))
	await flush()
	assert.equal(f.native.sent.length, 1)
	f.native.emit('request', request('timeout', { timeout: 90000 }))
	assert.equal([...f.clock.timers.values()][0].delay, 60000)
	f.clock.advance(60000)
	assert.equal(work[1].options.signal.aborted, true)
	assert.equal(f.clock.timers.size, 0)
	assert.equal(f.adapter.inspectRuntime().pendingHttpRequests.size, 0)
	assert.equal(f.native.sent.length, 2)
	work[1].resolve(new Response('too late'))
	await flush()
	assert.equal(f.native.sent.length, 2)
	f.facade.destroy()
})

await test('real local HTTP preserves status/body/binary/form/errors and closes retired transport', async () => {
	let delayedStarted = false, delayedClosed = false, delayedFinished = false
	const server = http.createServer(async (incoming, response) => {
		if (incoming.url === '/delay') {
			delayedStarted = true
			response.on('close', () => { delayedClosed = true })
			response.on('finish', () => { delayedFinished = true })
			return
		}
		if (incoming.url === '/reset') { incoming.socket.destroy(); return }
		const chunks = []
		for await (const chunk of incoming) chunks.push(chunk)
		if (incoming.url === '/binary') { response.end(Buffer.from([0, 127, 128, 255])); return }
		response.setHeader('content-type', 'application/json')
		if (incoming.url === '/bad-json') { response.end('plain fallback'); return }
		if (incoming.url === '/503') response.statusCode = 503
		response.end(JSON.stringify({ method: incoming.method, body: Buffer.concat(chunks).toString(),
			contentType: incoming.headers['content-type'] ?? null }))
	})
	server.listen(0, '127.0.0.1')
	await once(server, 'listening')
	const base = `http://127.0.0.1:${server.address().port}`
	const f = createSourceFixture()
	try {
		await f.initialized('HTTP real')
		const call = async (route, options) => {
			const index = f.native.sent.length
			f.native.emit('request', request(`http-${index}`, options, base + route))
			await waitFor(() => f.native.sent.length > index)
			return f.native.sent[index].data
		}
		assert.equal((await call('/503')).response.statusCode, 503)
		assert.equal((await call('/bad-json')).response.body, 'plain fallback')
		assert.equal((await call('/binary', { binary: true })).response.body, 'AH+A/w==')
		assert.equal((await call('/echo', { method: 'POST', data: { x: '音源' } })).response.body.body, '{"x":"音源"}')
		assert.equal((await call('/echo', { method: 'POST', body: 'chosen', data: 'ignored' })).response.body.body, 'chosen')
		const form = (await call('/echo', { method: 'POST', form: { a: '中 & %', b: 2 } })).response.body
		assert.equal(form.body, 'a=%E4%B8%AD+%26+%25&b=2')
		assert.equal(form.contentType, 'application/x-www-form-urlencoded')
		assert.equal((await call('/echo', { method: 'POST', formData: 'custom=form' })).response.body.body, 'custom=form')
		assert.equal((await call('/echo', { method: 'GET', body: 'ignored' })).response.body.body, '')
		assert.equal((await call('/echo', { method: 'HEAD', body: 'ignored' })).response.body, '')
		const failed = await call('/reset')
		assert.equal(failed.response, null)
		assert.equal(typeof failed.error, 'string')
		assert.equal(f.adapter.inspectRuntime().pendingHttpRequests.size, 0)
		assert.equal(f.clock.timers.size, 0)
		const sent = f.native.sent.length
		f.native.emit('request', request('retired', {}, base + '/delay'))
		await waitFor(() => delayedStarted)
		const runtime = f.adapter.inspectRuntime()
		f.facade.destroy()
		assertRetired(f, runtime)
		await waitFor(() => delayedClosed)
		assert.equal(delayedFinished, false)
		assert.equal(f.native.sent.length, sent)
	} finally {
		f.facade.destroy()
		server.closeAllConnections()
		await new Promise(resolve => server.close(resolve))
	}
})

await test('CommonJS import still executes its four-argument host protocol', async () => {
	const f = createSourceFixture()
	const importer = f.load('src/helpers/userApi/importMusicSource')
	const api = await importer.createMusicApiFromScript(`
		module.exports.id = 'commonjs'; module.exports.name = 'CommonJS';
		module.exports.getMusicUrl = (title, artist, id, quality) =>
			Promise.resolve('https://example.test/' + [title, artist, id, quality].join('/'))
	`)
	assert.equal(api.scriptType, 'cymusic')
	assert.equal(api.id, 'commonjs')
	assert.equal(await api.getMusicUrl('title', 'artist', 'id', '320k'), 'https://example.test/title/artist/id/320k')
	assert.equal(f.native.loads.length, 0)
	await assert.rejects(importer.createMusicApiFromScript('module.exports = {}'), /getMusicUrl/)
})

console.log(JSON.stringify({ suite: 'source-host', checks, passed: checks.every(check => check.passed) }, null, 2))
if (checks.some(check => !check.passed)) process.exitCode = 1
