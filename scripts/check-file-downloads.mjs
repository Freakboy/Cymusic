// Run: node scripts/check-file-downloads.mjs
// Real HTTP and disk I/O exercise production callers and the installed Expo legacy
// DownloadResumable class. Only its native transport and modern File boundary are mocked.
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import {
	createFixture,
	deferred,
	exists,
	item,
	projectRoot,
	uri,
	write,
} from './file-system-fixture.mjs'

const fixture = createFixture()
const checks = []
const test = async (name, action) => {
	try {
		await action()
		checks.push({ name, passed: true })
	} catch (error) {
		checks.push({ name, passed: false, error: error.stack })
	}
}
const server = createServer((request, response) => {
	if (request.url === '/transport-error') {
		response.writeHead(200, { 'Content-Length': '1000' })
		response.write('partial')
		setImmediate(() => response.destroy())
		return
	}
	const status = Number(request.url.slice(1))
	const body = status === 204 ? '' : `audio-fixture-${status}`
	response.writeHead(status, {
		'Content-Type': 'audio/mpeg',
		'Content-Length': Buffer.byteLength(body),
	})
	response.end(body)
})

async function httpDownload({ url, fileUri, options, progress }) {
	assert.equal(options.sessionType, 1, 'Use the foreground Expo session')
	const response = await fetch(url)
	await write(fileURLToPath(fileUri), '')
	let bytesWritten = 0
	for await (const chunk of response.body ?? []) {
		await fsp.appendFile(fileURLToPath(fileUri), chunk)
		bytesWritten += chunk.byteLength
		progress({
			totalBytesWritten: bytesWritten,
			totalBytesExpectedToWrite: Number(response.headers.get('content-length') ?? -1),
		})
	}
	return { uri: fileUri, status: response.status, headers: {}, mimeType: 'audio/mpeg' }
}
const httpRuntime = () => {
	const h = fixture.runtime({ realCache: true })
	h.hooks.download = httpDownload
	return h
}
const assertClean = async (h) => {
	assert.equal(h.progressListeners.size, 0)
	assert.equal(h.calls.cancellations.length, h.calls.downloads.length)
	for (const { fileUri } of h.calls.downloads)
		assert.equal(await exists(fileURLToPath(fileUri)), false)
}

async function main() {
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
	const baseUrl = `http://127.0.0.1:${server.address().port}`
	for (const status of [200, 201, 204, 206, 404, 500])
		await test(`HTTP ${status}: atomically commit nonempty 200 only`, async () => {
			const h = httpRuntime()
			const cache = h.load('src/player/CacheManager.ts')
			const track = item(`status-${status}#%23`, `${baseUrl}/${status}`, { platform: 'fixture' })
			const localPath = cache.getLocalFilePath(track)
			assert.match(localPath.slice(cache.cacheDir.length), /^v2-[a-f0-9]{64}\.mp3$/)
			const rawTarget = fileURLToPath(cache.getCacheFileUri(localPath))
			assert.equal(cache.getCacheFileUri(localPath), uri(rawTarget))
			if (status === 200) assert.equal(await cache.downloadToCache(track), localPath)
			else await assert.rejects(cache.downloadToCache(track), /EMPTY_OR_FAILED_CACHE_DOWNLOAD/)
			assert.equal(await exists(rawTarget), status === 200)
			if (status === 200) assert.equal(await fsp.readFile(rawTarget, 'utf8'), 'audio-fixture-200')
			assert.equal(await cache.isCached(track), status === 200)
			assert.equal(h.calls.moves.length, status === 200 ? 1 : 0)
			assert.equal(h.calls.downloads.length, 1)
			assert.equal(h.calls.writes.length, 0)
			assert(!h.calls.temporaryDeletes.includes(uri(rawTarget)))
			await assertClean(h)
		})
	await test('valid v2 cache is reused without transport or overwrite, including failing remote URLs', async () => {
		const h = httpRuntime()
		const cache = h.load('src/player/CacheManager.ts')
		const track = item('reuse#%23', `${baseUrl}/500`, { platform: 'fixture' })
		const localPath = cache.getLocalFilePath(track)
		const target = fileURLToPath(cache.getCacheFileUri(localPath))
		await write(target, 'previous-valid-audio')
		assert.equal(await cache.downloadToCache(track), localPath)
		assert.equal(await cache.isCached(track), true)
		assert.equal(await fsp.readFile(target, 'utf8'), 'previous-valid-audio')
		assert.equal(h.calls.downloads.length, 0)
		assert.equal(h.calls.moves.length, 0)
		assert.equal(h.calls.deletes.length, 0)
		assert.equal(h.calls.writes.length, 0)
	})
	await test('empty 200 bytes never become a readable cache entry and a retry can commit', async () => {
		const h = httpRuntime()
		const cache = h.load('src/player/CacheManager.ts')
		const track = item('empty-200', `${baseUrl}/200`)
		h.hooks.download = async ({ fileUri }) => {
			await write(fileURLToPath(fileUri), '')
			return { status: 200, uri: fileUri }
		}
		await assert.rejects(cache.downloadToCache(track), /EMPTY_OR_FAILED_CACHE_DOWNLOAD/)
		assert.equal(await cache.findCachedPath(track), undefined)
		assert.equal(h.calls.moves.length, 0)
		await assertClean(h)
		h.hooks.download = httpDownload
		assert.equal(await cache.downloadToCache(track), cache.getLocalFilePath(track))
		assert.equal(await cache.isCached(track), true)
		assert.equal(h.calls.downloads.length, 2)
		await assertClean(h)
	})
	await test('shared cache downloads keep one writer when one consumer cancels', async () => {
		const h = httpRuntime(), entered = deferred(), finish = deferred()
		const cache = h.load('src/player/CacheManager.ts')
		const track = item('shared-writer', `${baseUrl}/200`)
		h.hooks.download = async (request) => {
			const result = await httpDownload(request)
			entered.resolve()
			await finish.promise
			return result
		}
		const controller = new AbortController()
		const first = cache.downloadToCache(track, { signal: controller.signal })
		const cancelled = assert.rejects(first, /CACHE_CANCELLED/)
		const second = cache.downloadToCache(track)
		await entered.promise
		controller.abort()
		await cancelled
		assert.equal(h.calls.downloads.length, 1)
		assert.equal(h.calls.cancellations.length, 0, 'A live consumer still owns the shared writer')
		assert.equal(await cache.isCached(track), false)
		finish.resolve()
		assert.equal(await second, cache.getLocalFilePath(track))
		assert.equal(await cache.isCached(track), true)
		await assertClean(h)
	})
	await test('source contents and quality isolate cache destinations and preserve transport headers', async () => {
		const h = httpRuntime()
		const cache = h.load('src/player/CacheManager.ts')
		const track = item('identity', `${baseUrl}/200`, { headers: { Authorization: 'fixture-token' }, userAgent: 'fixture-agent' })
		const paths = []
		for (const [script, quality] of [['first', '128k'], ['second', '128k'], ['second', 'flac']]) {
			h.stores.musicApiSelectedStore.setValue({ id: 'same-id', script })
			h.stores.qualityStore.setValue(quality)
			paths.push(await cache.downloadToCache(track))
			assert.equal(await cache.isCached(track), true)
		}
		assert.equal(new Set(paths).size, 3)
		assert.match(paths[2], /\.flac$/)
		assert.equal(h.calls.downloads.length, 3)
		for (const request of h.calls.downloads) assert.deepEqual(request.options.headers, { Authorization: 'fixture-token', 'User-Agent': 'fixture-agent' })
		await assertClean(h)
	})
	for (const outcome of [
		200,
		201,
		204,
		206,
		404,
		500,
		'transport-error',
		'null',
		'undefined',
		'move-error',
	])
		await test(`manual import: ${outcome} follows its existing success/error branch`, async () => {
			const h = httpRuntime()
			const track = item(
				`manual-${outcome}`,
				`${baseUrl}/${typeof outcome === 'number' ? outcome : outcome === 'transport-error' ? outcome : 200}`,
				{ platform: 'fixture' },
			)
			if (outcome === 'null' || outcome === 'undefined')
				h.hooks.download = async ({ fileUri }) => {
					await write(fileURLToPath(fileUri), 'partial')
					return outcome === 'null' ? null : undefined
				}
			if (outcome === 'move-error')
				h.hooks.move = async () => {
					throw new Error('Injected move failure')
				}
			const cache = h.load('src/player/CacheManager.ts')
			await h.load('src/helpers/trackPlayerIndex.ts').default.cacheAndImportMusic(track)
			const records = h.stores.importedLocalMusicStore.getValue() || []
			if (outcome === 200) {
				assert.deepEqual(
					records.map(({ id, url }) => ({ id, url })),
					[{ id: track.id, url: cache.getLocalFilePath(track) }],
				)
				assert.equal(h.calls.alerts.length, 1)
				assert.equal(
					await fsp.readFile(fileURLToPath(cache.getCacheFileUri(records[0].url)), 'utf8'),
					'audio-fixture-200',
				)
			} else {
				assert.deepEqual(records, [])
				assert.equal(h.calls.alerts.length, 0)
				assert.equal(h.calls.writes.length, 0)
				assert.equal(h.calls.errors.length, 1)
				assert.equal(await cache.isCached(track), false)
			}
			await assertClean(h)
		})
	await test('automatic download rethrows the original transport/move error', async () => {
		for (const phase of ['download', 'move']) {
			const h = httpRuntime()
			const primary = new Error(`Injected ${phase} failure`)
			h.hooks[phase] = async (request) => {
				if (phase === 'download') await write(fileURLToPath(request.fileUri), 'partial')
				throw primary
			}
			const cache = h.load('src/player/CacheManager.ts')
			await assert.rejects(
				cache.downloadToCache(item(`auto-${phase}`, `${baseUrl}/200`)),
				(error) => error === primary,
			)
			assert.equal(h.calls.errors.length, 0, 'Cache owner propagates errors; its caller logs them')
			assert.equal(await cache.isCached(item(`auto-${phase}`, `${baseUrl}/200`)), false)
			await assertClean(h)
		}
	})
	await test('existing cache with literal hash/percent names imports without another request', async () => {
		const h = httpRuntime()
		const cache = h.load('src/player/CacheManager.ts')
		const track = item('already#%23', `${baseUrl}/500`, { platform: 'fixture' })
		const localPath = `${cache.cacheDir}fixture_already#%23.mp3`
		await write(`${fixture.documents}/musicCache/fixture_already#%23.mp3`, 'already-cached')
		await h.load('src/helpers/trackPlayerIndex.ts').default.cacheAndImportMusic(track)
		assert.equal(h.stores.importedLocalMusicStore.getValue()[0].url, localPath)
		assert.equal(cache.getLocalFilePath(track), localPath, 'Discovery retains the legacy stored path')
		assert.equal(h.calls.downloads.length, 0)
		assert.equal(h.calls.alerts.length, 1)
	})
	await test('manual import waits for the final move before writing its record', async () => {
		const h = httpRuntime()
		const track = item('await-move', `${baseUrl}/200`)
		const cache = h.load('src/player/CacheManager.ts')
		const entered = deferred(),
			finish = deferred()
		h.hooks.move = async () => {
			entered.resolve()
			await finish.promise
		}
		const pending = h
			.load('src/helpers/trackPlayerIndex.ts')
			.default.cacheAndImportMusic(track)
		await entered.promise
		assert.equal(await cache.isCached(track), false, 'Readers cannot see the staging file')
		const move = h.calls.moves[0]
		assert.equal(await exists(fileURLToPath(move.from)), true)
		assert.equal(await exists(fileURLToPath(move.to)), false)
		assert.equal(fileURLToPath(move.from).slice(0, fileURLToPath(move.from).lastIndexOf('/')),
			fileURLToPath(move.to).slice(0, fileURLToPath(move.to).lastIndexOf('/')))
		assert.equal(h.calls.writes.length, 0)
		assert.equal(h.calls.alerts.length, 0)
		finish.resolve()
		await pending
		assert.equal(h.calls.writes.length, 1)
		assert.equal(await cache.isCached(track), true)
		assert.equal(await fsp.readFile(fileURLToPath(move.to), 'utf8'), 'audio-fixture-200')
		await assertClean(h)
	})
	await test('cleanup errors preserve the original rejection and are logged', async () => {
		const h = httpRuntime()
		const primary = new Error('Primary transport error'),
			cancelError = new Error('Cancel cleanup'),
			deleteError = new Error('Temporary cleanup')
		h.hooks.download = async ({ fileUri }) => {
			await write(fileURLToPath(fileUri), 'partial')
			throw primary
		}
		h.hooks.cancel = async () => {
			throw cancelError
		}
		h.hooks.temporaryDelete = () => {
			throw deleteError
		}
		await assert.rejects(
			h
				.load('src/helpers/fileDownload.ts')
				.downloadFile(`${baseUrl}/200`, uri(`${fixture.documents}/never-committed.mp3`)),
			(error) => error === primary,
		)
		assert.deepEqual(
			h.calls.errors.map((entry) => entry[1]),
			[cancelError, deleteError],
		)
		assert.equal(h.progressListeners.size, 0)
		assert.equal(await exists(`${fixture.documents}/never-committed.mp3`), false)
	})
	await test('successful final bytes survive cancellation and cleanup-query errors', async () => {
		const h = httpRuntime()
		const cancelError = new Error('Cancel cleanup'),
			queryError = new Error('Cleanup info')
		h.hooks.cancel = async () => {
			throw cancelError
		}
		h.expoFs.Paths.info = () => {
			throw queryError
		}
		const target = `${fixture.documents}/successful-cleanup.mp3`
		await h.load('src/helpers/fileDownload.ts').downloadFile(`${baseUrl}/200`, uri(target))
		assert.equal(await fsp.readFile(target, 'utf8'), 'audio-fixture-200')
		assert.deepEqual(
			h.calls.errors.map((entry) => entry[1]),
			[cancelError, queryError],
		)
		assert.equal(h.progressListeners.size, 0)
	})
	await test('repeated downloads do not retain progress listeners or temporary files', async () => {
		const h = httpRuntime()
		const download = h.load('src/helpers/fileDownload.ts').downloadFile
		const samples = []
		for (let index = 0; index < 8; index++) {
			await download(`${baseUrl}/200`, uri(`${fixture.documents}/repeated.mp3`), (progress) =>
				samples.push(progress),
			)
			await assertClean(h)
		}
		assert(
			samples.every(
				(progress) =>
					progress.bytesWritten === progress.contentLength && progress.contentLength > 0,
			),
		)
		assert.equal(samples.length, 8)
		assert.equal(new Set(h.calls.downloads.map(({ fileUri }) => fileUri)).size, 8)
		assert.equal(
			await fsp.readFile(`${fixture.documents}/repeated.mp3`, 'utf8'),
			'audio-fixture-200',
		)
	})
	await test('unknown response length does not emit an invented percentage', async () => {
		const h = httpRuntime(),
			samples = []
		h.hooks.download = async ({ fileUri, progress }) => {
			await write(fileURLToPath(fileUri), 'audio')
			progress({ totalBytesWritten: 5, totalBytesExpectedToWrite: -1 })
			return { status: 200 }
		}
		await h
			.load('src/helpers/fileDownload.ts')
			.downloadFile(`${baseUrl}/200`, uri(`${fixture.documents}/unknown-length.mp3`), (progress) =>
				samples.push(progress),
			)
		assert.deepEqual(samples, [])
		await assertClean(h)
	})
	await test('interleaved requests to one target have independent temporary files and cleanup', async () => {
		const h = httpRuntime(),
			readyGood = deferred(),
			readyBad = deferred(),
			releaseGood = deferred(),
			releaseBad = deferred()
		h.hooks.download = async (request) => {
			const result = await httpDownload(request)
			if (result.status === 200) {
				readyGood.resolve()
				await releaseGood.promise
			} else {
				readyBad.resolve()
				await releaseBad.promise
			}
			return result
		}
		const download = h.load('src/helpers/fileDownload.ts').downloadFile
		const target = `${fixture.documents}/concurrent-download.mp3`
		const good = download(`${baseUrl}/200`, uri(target))
		const bad = download(`${baseUrl}/500`, uri(target)).catch((error) => error)
		await Promise.all([readyGood.promise, readyBad.promise])
		assert.equal(h.progressListeners.size, 2)
		assert.equal(new Set(h.calls.downloads.map(({ fileUri }) => fileUri)).size, 2)
		releaseGood.resolve()
		await good
		assert.equal(await fsp.readFile(target, 'utf8'), 'audio-fixture-200')
		releaseBad.resolve()
		assert.match((await bad).message, /状态码: 500/)
		assert.equal(await fsp.readFile(target, 'utf8'), 'audio-fixture-200')
		await assertClean(h)
	})

	const sourceManagement = await fsp.readFile(`${projectRoot}/src/app/(modals)/sourceManagement.tsx`, 'utf8')
	assert.match(sourceManagement, /getDocumentAsync/)
	assert.match(sourceManagement, /importManagedSource/)
	await test('source manager keeps the native document picker and managed import path', async () => {
		assert.match(sourceManagement, /copyToCacheDirectory: true/)
		assert.match(sourceManagement, /await importManagedSource\(await new File\(result\.assets\[0\]\.uri\)\.text\(\)/)
	})
}

main()
	.catch((error) => checks.push({ name: 'fixture setup', passed: false, error: error.stack }))
	.finally(async () => {
		server.closeAllConnections()
		await new Promise((resolve) => server.close(resolve))
		await fixture.dispose()
		const failed = checks.filter((check) => !check.passed)
		console.log(
			JSON.stringify(
				{
					check: 'file-downloads-and-picker',
					passed: checks.length - failed.length,
					failed: failed.length,
					failures: failed,
					limitations: [
						'Transport/file mocks do not establish iOS URLSession defaults, Expo native integration, or atomic overwrite on move failure.',
					],
				},
				null,
				2,
			),
		)
		if (failed.length) process.exitCode = 1
	})
