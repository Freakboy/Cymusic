// node scripts/probe-source-platforms.mjs [tx|wy|kg|kw|mg|all] [title] [artist] [album] [duration]
// CYMUSIC_PROBE_REPLAY=/tmp/cymusic-platform-probe-... replays saved responses without network.
// One request per platform, serially. Raw responses are kept outside the checkout.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const root = fileURLToPath(new URL('../', import.meta.url))
const modules = new Map()
function load(filename) {
	if (modules.has(filename)) return modules.get(filename).exports
	const module = { exports: {} }
	modules.set(filename, module)
	const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
			esModuleInterop: true,
		},
	}).outputText
	new Function('require', 'module', 'exports', source)(
		(specifier) => {
			if (specifier.startsWith('.'))
				return load(path.resolve(path.dirname(filename), specifier + '.ts'))
			if (specifier.startsWith('@/'))
				return load(path.join(root, 'src', specifier.slice(2) + '.ts'))
			return require(specifier)
		},
		module,
		module.exports,
	)
	return module.exports
}
const { RESOLUTION_PLATFORMS, platformSearchRequest, decodeCandidates, selectPlatformMatch } = load(
	path.join(root, 'src/player/sourceResolver/platforms.ts'),
)
const selected = process.argv[2] || 'all'
if (selected !== 'all' && !RESOLUTION_PLATFORMS.includes(selected))
	throw new Error('Unknown platform')
const title = process.argv[3] || '稻香',
	artist = process.argv[4] || '周杰伦'
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'cymusic-platform-probe-'))
const results = []
for (const platform of selected === 'all' ? RESOLUTION_PLATFORMS : [selected]) {
	const request = platformSearchRequest(platform, `${title} ${artist}`)
	let result
	try {
		const saved =
			process.env.CYMUSIC_PROBE_REPLAY &&
			JSON.parse(
				fs.readFileSync(path.join(process.env.CYMUSIC_PROBE_REPLAY, platform + '.json'), 'utf8'),
			)
		const response = saved
			? { status: saved.status, data: saved.body }
			: await require('axios').request({ ...request, timeout: 12000, validateStatus: () => true })
		fs.writeFileSync(
			path.join(output, platform + '.json'),
			JSON.stringify({ request, status: response.status, body: response.data }, null, 2),
		)
		if (response.status !== 200) throw new Error(`HTTP ${response.status}`)
		const candidates = decodeCandidates(platform, response.data)
		const matched = selectPlatformMatch(
			{ title, artist, album: process.argv[5] || '', duration: Number(process.argv[6] || 0) },
			candidates,
		)
		result = {
			platform,
			state: saved ? 'replayed' : 'online',
			candidates: candidates.length,
			matched,
			playable: 'not-tested',
		}
	} catch (error) {
		result = {
			platform,
			state: 'failed',
			error: error.message,
			cause: error.cause?.message,
			playable: 'not-tested',
		}
	}
	results.push(result)
	console.log(JSON.stringify(result))
}
fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2))
console.log(`Evidence: ${output}`)
