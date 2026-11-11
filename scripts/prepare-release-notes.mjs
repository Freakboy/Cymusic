import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const semver = '(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)'
const tagPattern = new RegExp(`^v(${semver})(?:-build([1-9]\\d*))?(?:-(alpha|beta|rc)\\.([1-9]\\d*))?$`)
const shaPattern = /^[a-f0-9]{40}$/
export function parseReleaseTag(tag) {
	const match = typeof tag === 'string' && tag.match(tagPattern)
	if (!match) throw new Error('Invalid release tag: use vX.Y.Z[-buildN][-(alpha|beta|rc).N]')
	return { tag, version: match[1], build: match[5], prerelease: !!match[6] }
}
export function extractReleaseNotes(changelog, version) {
	const lines = changelog.replace(/\r\n/g, '\n').split('\n')
	const escaped = version.replace(/\./g, '\\.')
	const heading = new RegExp(`^##\\s+(?:\\[v?${escaped}\\]|v?${escaped})(?:\\s.*)?$`)
	const matches = lines.flatMap((line, i) => heading.test(line) ? [i] : [])
	if (matches.length !== 1) throw new Error(`CHANGELOG must contain exactly one ## [${version}] section`)
	const start = matches[0] + 1
	let end = lines.findIndex((line, i) => i >= start && /^##\s/.test(line))
	if (end < 0) end = lines.length
	const notes = lines.slice(start, end).join('\n').trim()
	if (notes.length < 80 || notes.split('\n').filter(line => line.trim()).length < 2)
		throw new Error(`CHANGELOG ${version} needs detailed release notes, not an empty/stub section`)
	return notes
}
const command = (program, args) => execFileSync(program, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
export function verifyRef(env = process.env, run = command) {
	const tag = env.RELEASE_TAG || ''
	if (!['push', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME)) throw new Error('Only push/dispatch builds are allowed')
	if (env.GITHUB_EVENT_NAME === 'push' && env.GITHUB_REF !== 'refs/heads/main'
		&& env.GITHUB_REF !== `refs/tags/${tag}`) throw new Error('Unexpected push ref')
	if (env.GITHUB_EVENT_NAME === 'push' && env.GITHUB_REF?.startsWith('refs/tags/') && !tag) throw new Error('Tag missing')
	if (tag) parseReleaseTag(tag)
	if (!shaPattern.test(env.GITHUB_SHA || '')) throw new Error('Invalid workflow SHA')
	const sha = run('git', ['rev-parse', `${env.GITHUB_SHA}^{commit}`])
	if (!shaPattern.test(sha) || run('git', ['rev-parse', 'HEAD']) !== sha) throw new Error('Checkout does not match workflow SHA')
	if (tag && run('git', ['rev-parse', `refs/tags/${tag}^{commit}`]) !== sha) throw new Error('Release tag commit must equal workflow SHA')
	return { tag, sha }
}
const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
function regularFile(file) {
	if (!fs.lstatSync(file).isFile()) throw new Error(`Not a regular file: ${file}`)
}
export function prepareArtifacts(env = process.env, run = command) {
	const { tag, sha } = verifyRef(env, run)
	const version = env.BUILT_VERSION, build = env.BUILT_BUILD
	if (!new RegExp(`^${semver}$`).test(version || '') || !/^[1-9]\d*$/.test(build || '')) throw new Error('Invalid built Info.plist version/build')
	const release = tag ? parseReleaseTag(tag) : null
	if (release && (release.version !== version || release.build && release.build !== build)) throw new Error('Tag does not match built Info.plist version/build')
	const ipa = `CyMusic-${version}-build${build}-unsigned.ipa`
	if (env.IPA_NAME !== ipa) throw new Error('Unexpected/unsafe IPA filename')
	regularFile(ipa)
	const dir = env.ARTIFACT_DIR || 'release-artifacts'
	fs.mkdirSync(dir, { recursive: true })
	fs.copyFileSync(ipa, path.join(dir, ipa))
	const manifest = { schema: 'cymusic.ios-release', version: 1, tag, sha,
		appVersion: version, build, ipa, sha256: digest(path.join(dir, ipa)), prerelease: release?.prerelease ?? false }
	fs.writeFileSync(path.join(dir, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
	fs.writeFileSync(path.join(dir, 'SHA256SUMS'), `${manifest.sha256}  ${ipa}\n`)
	if (release) fs.writeFileSync(path.join(dir, 'release-notes.md'), formatNotes(manifest,
		extractReleaseNotes(fs.readFileSync('CHANGELOG.md', 'utf8'), version)))
	return manifest
}
function marker(m) { return `<!-- cymusic-release:${m.tag}:${m.sha} -->` }
function formatNotes(m, details) {
	return `${details}\n\n---\n\n## Download / 安装说明\n\n- App version: ${m.appVersion}; build: ${m.build}\n- Commit: \`${m.sha}\`\n- IPA: \`${m.ipa}\` (unsigned; LiveContainer-compatible packaging, not App Store signing).\n- Verify the download with \`shasum -a 256 -c SHA256SUMS\`.\n\n${marker(m)}\n`
}
export function verifyArtifacts(dir, expected, details) {
	const manifestPath = path.join(dir, 'release-manifest.json')
	regularFile(manifestPath)
	const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
	const release = parseReleaseTag(expected.tag)
	if (m.schema !== 'cymusic.ios-release' || m.version !== 1 || m.sha !== expected.sha || m.tag !== expected.tag
		|| m.appVersion !== release.version || !/^[1-9]\d*$/.test(m.build)
		|| release.build && m.build !== release.build || m.prerelease !== release.prerelease
		|| m.ipa !== `CyMusic-${release.version}-build${m.build}-unsigned.ipa`
		|| !/^[a-f0-9]{64}$/.test(m.sha256)) throw new Error('Artifact identity/version mismatch')
	for (const name of [m.ipa, 'SHA256SUMS', 'release-notes.md']) regularFile(path.join(dir, name))
	if (digest(path.join(dir, m.ipa)) !== m.sha256
		|| fs.readFileSync(path.join(dir, 'SHA256SUMS'), 'utf8') !== `${m.sha256}  ${m.ipa}\n`
		|| fs.readFileSync(path.join(dir, 'release-notes.md'), 'utf8') !== formatNotes(m, details)) throw new Error('Artifact checksum/notes mismatch')
	return m
}
function remoteTagSha(repo, tag, gh) {
	let ref = JSON.parse(gh(['api', `repos/${repo}/git/ref/tags/${tag}`])).object
	for (let depth = 0; depth < 8 && ref.type === 'tag'; depth++) ref = JSON.parse(gh(['api', `repos/${repo}/git/tags/${ref.sha}`])).object
	if (ref.type !== 'commit' || !shaPattern.test(ref.sha)) throw new Error('Cannot resolve remote tag commit')
	return ref.sha
}
/** Immutable identity + byte-for-byte existing asset checks. Never use --clobber. */
export function publishRelease(env = process.env, run = command) {
	const expected = verifyRef(env, run)
	if (!expected.tag) throw new Error('No release tag requested')
	const dir = env.ARTIFACT_DIR || 'release-artifacts'
	const m = verifyArtifacts(dir, expected, extractReleaseNotes(fs.readFileSync('CHANGELOG.md', 'utf8'), parseReleaseTag(expected.tag).version))
	const repo = env.GITHUB_REPOSITORY
	if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '')) throw new Error('Invalid repository')
	const gh = args => run('gh', [...args, '--repo', repo])
	// gh api takes a repo in its endpoint rather than supporting --repo.
	const api = args => run('gh', args)
	if (remoteTagSha(repo, m.tag, api) !== m.sha) throw new Error('Remote tag moved since build')
	let existing
	try { existing = JSON.parse(api(['api', `repos/${repo}/releases/tags/${m.tag}`])) }
	catch (error) { if (!/HTTP 404/.test(String(error.stderr))) throw error }
	if (existing && ((existing.body?.match(/<!-- cymusic-release:[^\n]*? -->/g) || []).join('\n') !== marker(m)
		|| existing.tag_name !== m.tag)) throw new Error('Existing Release has a different or unverified commit identity')
	const assets = [m.ipa, 'SHA256SUMS', 'release-manifest.json']
	const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cymusic-release-'))
	try {
		const missing = []
		for (const name of assets) {
			if (existing?.assets?.some(asset => asset.name === name)) {
				gh(['release', 'download', m.tag, '--pattern', name, '--dir', temp])
				regularFile(path.join(temp, name))
				if (digest(path.join(temp, name)) !== digest(path.join(dir, name))) throw new Error(`Existing Release asset differs: ${name}; use a new build tag`)
			} else missing.push(path.join(dir, name))
		}
		// Recheck just before mutation as well; never create a missing tag.
		if (remoteTagSha(repo, m.tag, api) !== m.sha) throw new Error('Remote tag moved before publication')
		if (!existing) gh(['release', 'create', m.tag, '--verify-tag', '--target', m.sha, '--draft',
			'--title', m.tag, '--notes-file', path.join(dir, 'release-notes.md'), ...(m.prerelease ? ['--prerelease'] : [])])
		if (missing.length) gh(['release', 'upload', m.tag, ...missing])
		gh(['release', 'edit', m.tag, '--draft=false', `--prerelease=${m.prerelease}`, '--title', m.tag,
			'--notes-file', path.join(dir, 'release-notes.md')])
	} finally { fs.rmSync(temp, { recursive: true, force: true }) }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const mode = process.argv[2]
		if (mode === '--verify-ref') {
			const { tag, sha } = verifyRef()
			if (tag) extractReleaseNotes(fs.readFileSync('CHANGELOG.md', 'utf8'), parseReleaseTag(tag).version)
			if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `release_tag=${tag}\nsha=${sha}\n`)
		} else if (mode === '--prepare') prepareArtifacts()
		else if (mode === '--publish') publishRelease()
		else throw new Error('Expected --verify-ref, --prepare or --publish')
	} catch (error) { console.error(error.message); process.exitCode = 1 }
}
