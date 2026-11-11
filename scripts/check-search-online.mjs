// Optional network smoke test: node scripts/check-search-online.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import axios from 'axios'
import CryptoJS from 'crypto-js'

const exports = {}
const txExports = {}
vm.runInNewContext(
	ts.transpileModule(
		readFileSync(new URL('../src/player/sourceResolver/txSearch.ts', import.meta.url), 'utf8'),
		{ compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
	).outputText,
	{ exports: txExports, require: () => CryptoJS },
)
let response
const transport = {
	post: async (...args) => {
		response = undefined
		const result = await axios.post(...args)
		response = result.data
		return result
	},
}
vm.runInNewContext(
	ts.transpileModule(
		readFileSync(new URL('../src/helpers/searchAll.ts', import.meta.url), 'utf8'),
		{
			compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
		},
	).outputText,
	{
		exports,
		require: (name) => {
			if (name === 'crypto-js') return CryptoJS
			if (name === '@/player/sourceResolver/txSearch') return txExports
			assert.equal(name, 'axios')
			return transport
		},
	},
)
for (const [query, type] of [
	['晴天', 'songs'],
	['周杰伦', 'songs'],
	['周杰伦', 'artists'],
	['周杰伦', 'albums'],
	['周杰伦', 'playlists'],
]) {
	try {
		const result = await exports.default(query, 1, type)
		assert.ok(result.data.length > 0, `${type}: ${query} must return results`)
		console.log(`PASS: ${type} ${query}: ${result.data.length} results, hasMore=${result.hasMore}`)
	} catch (error) {
		process.exitCode = 1
		console.error(
			`FAIL: ${type} ${query}: ${error.message}; code=${response?.code}, searchCode=${response?.req_1?.code}`,
		)
	}
}
