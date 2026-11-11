import { assert, loadModule } from './native-services-fixture.mjs'
import { readFileSync } from 'node:fs'
const { isNewerRelease } = loadModule('src/helpers/releaseVersion.ts', {})
assert.equal(isNewerRelease('v1.2.1', '1.2.1', '2'), false)
assert.equal(isNewerRelease('v1.2.1-build2', '1.2.1', '2'), false)
assert.equal(isNewerRelease('v1.2.1-build3', '1.2.1', '2'), true)
assert.equal(isNewerRelease('v1.2.1-build1', '1.2.1', '2'), false)
assert.equal(isNewerRelease('v1.2.1-build3', '1.2.1'), false)
assert.equal(isNewerRelease('v1.10.0', '1.9.9', '99'), true)
assert.equal(isNewerRelease('v1.1.9-build999', '1.2.1', '2'), false)
assert.equal(isNewerRelease('v2.0.0', '1.2.1', '2'), true)
assert.equal(isNewerRelease('v1.2.1-build2.1', '1.2.1', '2'), true)
for (const value of [undefined, 'junk', 'v1.2.1-beta', 'v1.2.1;echo bad']) {
	assert.throws(() => isNewerRelease(value, '1.2.1', '2'))
}
const settings = readFileSync(new URL('../src/app/(modals)/settingModal.tsx', import.meta.url), 'utf8')
assert.ok(settings.includes('https://api.github.com/repos/Freakboy/Cymusic/releases/latest'))
assert.ok(settings.includes('isNewerRelease(latestVersion, CURRENT_VERSION, Constants.expoConfig?.ios?.buildNumber)'))
console.log('PASS release version comparison: prefix, ordering, build suffix, invalid tags')
