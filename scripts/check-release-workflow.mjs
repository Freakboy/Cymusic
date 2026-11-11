import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { assert, checks } from './native-services-fixture.mjs'
import { parseReleaseTag, extractReleaseNotes, verifyRef, prepareArtifacts, verifyArtifacts, publishRelease } from './prepare-release-notes.mjs'

const require = createRequire(import.meta.url)
const { parse } = require('yaml')
const { check, finish } = checks()
const sha = 'a'.repeat(40), other = 'b'.repeat(40)
const notes = '### Fixes\n\n- Detailed playback recovery changes preserving user intent and avoiding stale requests.\n- Artwork repair, configuration migration and regression checks for this particular app version.'
const changelog = `# Changelog\n\n## [Unreleased]\n\nNot shipped yet.\n\n## [1.2.1] - 2026-11-12\n\n${notes}\n\n## [1.2.0]\n\nOld version notes that must never ship with this version.\n`
const env = (extra = {}) => ({ GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/tags/v1.2.1-build2',
	GITHUB_SHA: sha, RELEASE_TAG: 'v1.2.1-build2', BUILT_VERSION: '1.2.1', BUILT_BUILD: '2',
	IPA_NAME: 'CyMusic-1.2.1-build2-unsigned.ipa', ARTIFACT_DIR: 'release-artifacts', GITHUB_REPOSITORY: 'owner/Cymusic', ...extra })
function gitRun(_program, args) {
	assert.equal(_program, 'git')
	assert.equal(args[0], 'rev-parse')
	return sha
}
function workspace(callback) {
	fs.mkdirSync('/tmp/opencode', { recursive: true })
	const dir = fs.mkdtempSync('/tmp/opencode/cymusic-release-test-')
	const before = process.cwd()
	try {
		process.chdir(dir)
		fs.writeFileSync('CHANGELOG.md', changelog)
		fs.writeFileSync('CyMusic-1.2.1-build2-unsigned.ipa', 'fixture IPA bytes, no real build')
		return callback(dir)
	} finally { process.chdir(before); fs.rmSync(dir, { recursive: true, force: true }) }
}

await check('workflow keeps main/tag/manual builds; only successful tag/manual request can publish, never PR', () => {
	const workflow = parse(fs.readFileSync('.github/workflows/build-ios.yml', 'utf8'))
	assert.deepEqual(workflow.on.push.branches, ['main'])
	assert.deepEqual(workflow.on.push.tags, ['v*'])
	assert.equal(workflow.on.workflow_dispatch.inputs.release_tag.type, 'string')
	assert.equal(workflow.on.workflow_dispatch.inputs.release_tag.required, false)
	assert.match(workflow.jobs.build.env.RELEASE_TAG, /github.event_name == 'push' && github.ref_type == 'tag'/,
		'manual checkout of a tag without release_tag must still be artifact-only')
	assert.equal(workflow.on.pull_request, undefined)
	assert.deepEqual(workflow.permissions, { contents: 'read' })
	assert.equal(workflow.jobs.build.permissions?.contents ?? workflow.permissions.contents, 'read')
	assert.deepEqual(workflow.jobs.publish.permissions, { contents: 'write' })
	assert.equal(workflow.jobs.publish.needs, 'build')
	assert.match(workflow.jobs.publish.if, /needs.build.result == 'success'/)
	assert.match(workflow.jobs.publish.if, /needs.build.outputs.release_tag != ''/)
	assert.match(workflow.jobs.publish.if, /refs\/tags\/v/)
	assert.match(workflow.jobs.publish.if, /workflow_dispatch/)
	assert.equal(workflow.jobs.publish.concurrency['cancel-in-progress'], false)
	for (const job of Object.values(workflow.jobs)) for (const step of job.steps) {
		if (step.run) assert.ok(!step.run.includes('${{'), 'all untrusted input goes through env, not shell interpolation')
		if (step.uses === 'actions/checkout@v4') {
			assert.equal(step.with['persist-credentials'], false)
			assert.equal(step.with['fetch-depth'], 0)
			assert.match(step.with.ref, /sha/)
		}
	}
	assert.equal(workflow.jobs.build['runs-on'], 'macos-26')
	assert.equal(workflow.jobs.build.env.DEVELOPER_DIR, '/Applications/Xcode_26.6.app/Contents/Developer')
	assert.ok(workflow.jobs.build.steps.some(step => step.with?.['node-version'] === '24.19.0'))
	assert.ok(workflow.jobs.build.steps.some(step => step.run?.includes('cocoapods --version 1.16.2')))
	assert.ok(workflow.jobs.build.steps.some(step => step.run?.includes('pod _1.16.2_ install --deployment')))
	assert.ok(workflow.jobs.build.steps.some(step => step.uses === 'actions/upload-artifact@v4' && step.with.path === 'release-artifacts/'))
	assert.ok(workflow.jobs.publish.steps.some(step => step.uses === 'actions/download-artifact@v4'))
})

await check('tag syntax, explicit build and prerelease rules are strict and reject injection/ambiguous versions', () => {
	assert.deepEqual(parseReleaseTag('v1.2.1'), { tag: 'v1.2.1', version: '1.2.1', build: undefined, prerelease: false })
	assert.equal(parseReleaseTag('v1.2.1-build2').build, '2')
	for (const tag of ['v1.2.1-rc.1', 'v1.2.1-build2-beta.3', 'v0.0.0-alpha.1']) assert.equal(parseReleaseTag(tag).prerelease, true)
	for (const tag of ['v1', '1.2.1', 'v1.2.1-build0', 'v01.2.1', 'v1.2.1-dev', 'v1.2.1+2',
		'v1.2.1-build2;touch x', 'v1.2.1\nsha=bad', '--delete', 'v1.2.1/../main', 'v1.2.1-rc.0']) assert.throws(() => parseReleaseTag(tag))
})

await check('detailed notes come only from the exact CHANGELOG version and reject missing/duplicate/stub sections', () => {
	assert.equal(extractReleaseNotes(changelog, '1.2.1'), notes)
	assert.equal(extractReleaseNotes(changelog.replace('## [1.2.1]', '## v1.2.1'), '1.2.1'), notes)
	assert.ok(!extractReleaseNotes(changelog, '1.2.1').includes('Unreleased'))
	assert.throws(() => extractReleaseNotes(changelog, '1.2.2'))
	assert.throws(() => extractReleaseNotes(`${changelog}\n## [1.2.1]\n${notes}`, '1.2.1'))
	assert.throws(() => extractReleaseNotes('## [1.2.1]\nTODO', '1.2.1'))
	assert.throws(() => extractReleaseNotes(`## [1.2.10]\n${notes}`, '1.2.1'))
})

await check('ref verification permits artifact-only main/manual, but refuses wrong checkout/tag commit/PR before gh', () => {
	assert.deepEqual(verifyRef(env(), gitRun), { tag: 'v1.2.1-build2', sha })
	assert.equal(verifyRef(env({ GITHUB_REF: 'refs/heads/main', RELEASE_TAG: '' }), gitRun).tag, '')
	assert.equal(verifyRef(env({ GITHUB_EVENT_NAME: 'workflow_dispatch', RELEASE_TAG: '' }), gitRun).tag, '')
	assert.throws(() => verifyRef(env({ GITHUB_EVENT_NAME: 'pull_request' }), gitRun))
	assert.throws(() => verifyRef(env({ GITHUB_SHA: 'main;echo bad' }), gitRun))
	assert.throws(() => verifyRef(env({ GITHUB_REF: 'refs/heads/dev', RELEASE_TAG: '' }), gitRun))
	assert.throws(() => verifyRef(env(), (_p, args) => args[1] === 'HEAD' ? other : sha), /Checkout/)
	assert.throws(() => verifyRef(env({ GITHUB_EVENT_NAME: 'workflow_dispatch' }), (_p, args) =>
		args[1].startsWith('refs/tags/') ? other : sha), /tag commit/)
	let called = false
	assert.throws(() => verifyRef(env({ RELEASE_TAG: 'v1.2.1;whoami' }), () => { called = true; return sha }))
	assert.equal(called, false)
})

await check('artifact identity uses actual plist inputs, safe names, exact SHA256 and detailed notes; no changelog needed on main', () => workspace(() => {
	const m = prepareArtifacts(env(), gitRun)
	assert.equal(m.build, '2')
	assert.equal(m.sha, sha)
	assert.equal(verifyArtifacts('release-artifacts', { tag: m.tag, sha }, notes).ipa, m.ipa)
	assert.match(fs.readFileSync('release-artifacts/release-notes.md', 'utf8'), /Detailed playback recovery/)
	assert.throws(() => prepareArtifacts(env({ BUILT_VERSION: '1.2.2', IPA_NAME: 'CyMusic-1.2.2-build2-unsigned.ipa' }), gitRun), /Info.plist/)
	assert.throws(() => prepareArtifacts(env({ BUILT_BUILD: '3' }), gitRun), /Info.plist/)
	assert.throws(() => prepareArtifacts(env({ IPA_NAME: '../unsafe.ipa' }), gitRun), /filename/)
	assert.throws(() => verifyArtifacts('release-artifacts', { tag: m.tag, sha: other }, notes), /identity/)
	fs.appendFileSync('release-artifacts/SHA256SUMS', 'tampered')
	assert.throws(() => verifyArtifacts('release-artifacts', { tag: m.tag, sha }, notes), /checksum/)
	prepareArtifacts(env(), gitRun)
	fs.appendFileSync(`release-artifacts/${m.ipa}`, 'tampered')
	assert.throws(() => verifyArtifacts('release-artifacts', { tag: m.tag, sha }, notes), /checksum/)
	fs.unlinkSync('CHANGELOG.md')
	assert.equal(prepareArtifacts(env({ RELEASE_TAG: '', GITHUB_REF: 'refs/heads/main', ARTIFACT_DIR: 'main-artifacts' }), gitRun).tag, '')
	assert.equal(fs.existsSync('main-artifacts/release-notes.md'), false)
}))

function ghMock(existing, { remote = sha, mismatch, annotated = false } = {}) {
	const calls = []
	const run = (program, args) => {
		if (program === 'git') return gitRun(program, args)
		assert.equal(program, 'gh')
		calls.push(args)
		if (args[0] === 'api') {
			if (args[1].includes('/git/ref/')) return JSON.stringify({ object: { type: annotated ? 'tag' : 'commit', sha: remote } })
			if (args[1].includes('/git/tags/')) return JSON.stringify({ object: { type: 'commit', sha: remote } })
			if (!existing) { const error = new Error('not found'); error.stderr = 'gh: Not Found (HTTP 404)'; throw error }
			return JSON.stringify(existing)
		}
		if (args[1] === 'download') {
			const name = args[args.indexOf('--pattern') + 1], dir = args[args.indexOf('--dir') + 1]
			fs.copyFileSync(path.join('release-artifacts', name), path.join(dir, name))
			if (name === mismatch) fs.appendFileSync(path.join(dir, name), 'old different bytes')
		}
		return ''
	}
	return { calls, run }
}
await check('publishing creates draft, uploads IPA/checksum/identity, then publishes; stable and prerelease explicit', () => workspace(() => {
	for (const tag of ['v1.2.1-build2', 'v1.2.1-build2-rc.1']) {
		prepareArtifacts(env({ RELEASE_TAG: tag, GITHUB_REF: `refs/tags/${tag}` }), gitRun)
		const mock = ghMock(null, { annotated: true })
		publishRelease(env({ RELEASE_TAG: tag, GITHUB_REF: `refs/tags/${tag}` }), mock.run)
		const mutations = mock.calls.filter(args => args[0] === 'release')
		assert.deepEqual(mutations.map(args => args[1]), ['create', 'upload', 'edit'])
		assert.ok(mutations[0].includes('--verify-tag'))
		assert.ok(mutations[0].includes('--draft'))
		assert.ok(mutations[0].includes(sha))
		assert.equal(mutations[0].includes('--prerelease'), tag.includes('-rc.'))
		assert.ok(mutations[1].some(arg => arg.endsWith('.ipa')))
		assert.ok(mutations[1].some(arg => arg.endsWith('/SHA256SUMS')))
		assert.ok(mutations[1].some(arg => arg.endsWith('/release-manifest.json')))
		assert.ok(mutations[2].includes(`--prerelease=${tag.includes('-rc.')}`))
		assert.ok(mock.calls.every(args => !args.includes('--clobber') && !args.includes('--generate-notes')))
	}
}))

await check('repeat tag is idempotent only with matching commit and bytes; retag/foreign release/changed assets fail before mutation', () => workspace(() => {
	const m = prepareArtifacts(env(), gitRun)
	const existing = { tag_name: m.tag, body: fs.readFileSync('release-artifacts/release-notes.md', 'utf8'),
		assets: [m.ipa, 'SHA256SUMS', 'release-manifest.json'].map(name => ({ name })) }
	const repeat = ghMock(existing)
	publishRelease(env(), repeat.run)
	assert.deepEqual(repeat.calls.filter(args => args[0] === 'release').map(args => args[1]), ['download', 'download', 'download', 'edit'])
	for (const mock of [ghMock(existing, { remote: other }), ghMock({ ...existing, body: 'foreign release' }),
		ghMock({ ...existing, body: `${existing.body}\n<!-- cymusic-release:${m.tag}:${other} -->` }),
		ghMock(existing, { mismatch: m.ipa }), ghMock(existing, { mismatch: 'release-manifest.json' })]) {
		assert.throws(() => publishRelease(env(), mock.run))
		assert.equal(mock.calls.some(args => ['create', 'upload', 'edit'].includes(args[1])), false)
	}
}))

await check('API permissions failures and missing detail refuse publication; no implicit tag creation or foreign upload', () => workspace(() => {
	prepareArtifacts(env(), gitRun)
	const mock = ghMock(null)
	assert.throws(() => publishRelease(env(), (program, args) => {
		if (program === 'gh' && args[0] === 'api' && args[1].includes('/releases/')) {
			const error = new Error('forbidden'); error.stderr = 'HTTP 403'; throw error
		}
		return mock.run(program, args)
	}), /forbidden/)
	assert.equal(mock.calls.some(args => args[0] === 'release'), false)
	fs.writeFileSync('CHANGELOG.md', '## [1.2.1]\nTODO')
	assert.throws(() => publishRelease(env(), mock.run), /detailed/)
	assert.equal(mock.calls.some(args => args[0] === 'release'), false)
}))

finish()
