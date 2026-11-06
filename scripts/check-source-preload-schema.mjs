import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

for (const filename of [
	'ios/CyMusic/user-api-preload.js',
	'src/helpers/userApi/user-api-preload.js',
]) {
	const events = []
	const context = vm.createContext({
		__lx_native_call__: (_key, action, json) => events.push({ action, data: JSON.parse(json) }),
	})
	vm.runInContext(fs.readFileSync(new URL('../' + filename, import.meta.url), 'utf8'), context)
	vm.runInContext(
		`lx_setup('key', 'id', 'name', '', '', '', '', '');
		const api = globalThis.lx || globalThis.lxu;
		globalThis.sourceCalls = 0;
		api.on(api.EVENT_NAMES.request, async ({info}) => { sourceCalls++; return info.response });
		api.send(api.EVENT_NAMES.inited, {sources: Object.fromEntries(['tx','wy','kg','kw','mg','evil'].map(source => [source, {type:'music', actions:['musicUrl','lyric','pic','search','evil'], qualitys:['128k','evil']}]))});`,
		context,
	)
	await new Promise((resolve) => setImmediate(resolve))
	const init = events.find((event) => event.action === 'init')
	assert.deepEqual(Object.keys(init.data.info.sources).sort(), ['kg', 'kw', 'mg', 'tx', 'wy'])
	for (const [source, capability] of Object.entries(init.data.info.sources)) {
		assert.deepEqual(capability.actions, source === 'tx' ? ['musicUrl', 'lyric'] : ['musicUrl'])
		assert.deepEqual(capability.qualitys, ['128k'])
	}
	for (const source of ['tx', 'wy', 'kg', 'kw', 'mg']) {
		const request = {
			requestKey: source,
			data: {
				source,
				action: 'musicUrl',
				info: {
					type: '128k',
					response: {
						url: 'https://audio.test/a',
						headers: { Referer: 'test' },
						userAgent: 'agent',
						ignored: 'drop',
					},
				},
			},
		}
		context.__lx_native__('key', 'request', JSON.stringify(request))
		await new Promise((resolve) => setImmediate(resolve))
		const result = events.find(
			(event) => event.action === 'response' && event.data.requestKey === source,
		).data
		assert.equal(result.status, true)
		assert.equal(result.result.data.headers.Referer, 'test')
		assert.equal(result.result.data.userAgent, 'agent')
		assert.equal(result.result.data.ignored, undefined)
	}
	for (const [key, source, action, response] of [
		['legacy', 'tx', 'musicUrl', 'https://audio.test/a'],
		['bad-source', 'evil', 'musicUrl', 'https://audio.test/a'],
		['bad-action', 'tx', 'evil', 'https://audio.test/a'],
		['bad-pic', 'tx', 'pic', 'https://audio.test/a'],
		['bad-search', 'tx', 'search', []],
		...['wy', 'kg', 'kw', 'mg'].map(source => ['bad-lyric-' + source, source, 'lyric', { lyric: 'original' }]),
		[
			'bad-header',
			'tx',
			'musicUrl',
			{ url: 'https://audio.test/a', headers: { Referer: 'bad\r\nvalue' } },
		],
	]) {
		const calls = vm.runInContext('sourceCalls', context)
		context.__lx_native__(
			'key',
			'request',
			JSON.stringify({
				requestKey: key,
				data: { source, action, info: { type: '128k', response } },
			}),
		)
		await new Promise((resolve) => setImmediate(resolve))
		assert.equal(
			events.find((event) => event.action === 'response' && event.data.requestKey === key).data
				.status,
			key === 'legacy',
		)
		assert.equal(vm.runInContext('sourceCalls', context), calls + (['legacy', 'bad-header'].includes(key) ? 1 : 0), 'Unsupported actions must not invoke the source')
	}
	assert.equal(
		vm.runInContext('Object.getOwnPropertyDescriptor(api, "request").writable', context),
		false,
	)
	assert.throws(() => vm.runInContext('Function("return 1")', context), /not allowed|not available/)
	assert.throws(() => vm.runInContext('eval("1")', context), /not available/)
	console.log(
		`PASS ${filename}: five sources, action/quality allowlist, bounded headers and sandbox guards`,
	)
}
