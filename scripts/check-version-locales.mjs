import assert from 'node:assert/strict'
import fs from 'node:fs'

const json = (path) => JSON.parse(fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'))
const text = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const version = json('package.json').version
const app = json('app.json').expo
assert.equal(app.version, version)
const plist = text('ios/CyMusic/Info.plist')
assert.equal(plist.match(/<key>CFBundleShortVersionString<\/key>\s*<string>(.*?)<\/string>/)?.[1], version)
assert.equal(plist.match(/<key>CFBundleVersion<\/key>\s*<string>(.*?)<\/string>/)?.[1], app.ios.buildNumber)
const project = text('ios/CyMusic.xcodeproj/project.pbxproj')
const marketingVersions = [...project.matchAll(/MARKETING_VERSION = ([^;]+);/g)].map((item) => item[1])
assert.equal(marketingVersions.length, 4)
assert(marketingVersions.every((value) => value === version))
assert([...project.matchAll(/CURRENT_PROJECT_VERSION = ([^;]+);/g)].every((item) => item[1] === app.ios.buildNumber))
for (const lang of ['zh', 'en']) {
	const locale = json(`src/locales/${lang}.json`)
	for (const key of ['yes', 'no']) assert.equal(typeof locale.settings.actions.preloadNextTrack?.[key], 'string', `${lang}: missing preload ${key}`)
}
console.log(`PASS version ${version} (${app.ios.buildNumber}) and preload translations`)
