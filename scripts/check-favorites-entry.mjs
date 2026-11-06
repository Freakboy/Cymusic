import { assert, checks, loadModule } from './native-services-fixture.mjs'

const suite = checks()
const React = {
	createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
	useMemo: (fn) => fn(),
}
const colors = { icon: '#111', primary: '#f34' }
const walk = (node, predicate) => {
	if (!node || typeof node !== 'object') return undefined
	if (predicate(node)) return node
	for (const child of node.props?.children?.flat(Infinity) || []) {
		const match = walk(child, predicate)
		if (match) return match
	}
}

await suite.check('add playlist has a real 44pt button and pushes the import route on its first press', () => {
	const calls = []
	const Button = loadModule('src/components/AddPlayListButton.tsx', {
		react: React,
		'expo-router': { router: { push: (path) => calls.push(path), navigate: () => {} } },
		'@expo/vector-icons': { MaterialCommunityIcons: 'Icon' },
		'@/hooks/useAppTheme': { useThemeColors: () => colors },
		'@/utils/i18n': { t: (key) => key },
		'react-native': { View: 'View', Pressable: 'Pressable', Keyboard: { dismiss() {} } },
	}).default
	const tree = Button()
	const button = walk(tree, (node) => node.type === 'Pressable')
	assert.ok(button, 'Icon Text must not own the header tap')
	assert.equal(button.props.accessibilityRole, 'button')
	assert(button.props.style.minWidth >= 44 && button.props.style.minHeight >= 44)
	button.props.onPress()
	assert.deepEqual(calls, ['/(modals)/importPlayList'])
})

await suite.check('saved playlists precede favorite/local entries without mutating storage order', () => {
	const playlists = [{ id: 'remote:QQ:42', name: 'QQ', title: 'QQ' }, { id: 'remote:Netease:1', name: 'WY', title: 'WY' }]
	let searchOwners = 0
	const Screen = loadModule('src/app/(tabs)/favorites/index.tsx', {
		react: React,
		'@/assets/local.png': 'local.png',
		'@/components/PlaylistsList': { PlaylistsList: 'PlaylistsList' },
		'@/constants/tokens': { screenPadding: { horizontal: 24 } },
		'@/helpers/trackPlayerIndex': { playListsStore: { useValue: () => playlists } },
		'@/hooks/useNavigationSearch': { useNavigationSearch: () => { searchOwners++; return '' } },
		'@/styles': { useDefaultStyles: () => ({ container: { flex: 1 } }) },
		'@/utils/i18n': { t: (key) => key },
		'expo-router': { router: { push() {} } },
		'react-native': { Image: { resolveAssetSource: () => ({ uri: 'file:///local.png' }) }, ScrollView: 'ScrollView', View: 'View' },
		'@/helpers/remotePlaylistStore': { refreshRemotePlaylist: async () => {} },
	}, { React }).default
	const tree = Screen()
	const list = walk(tree, (node) => node.type === 'PlaylistsList')
	assert.deepEqual(Array.from(list.props.playlists, (item) => item.id), ['remote:QQ:42', 'remote:Netease:1', 'favorites', 'local'])
	assert.equal(playlists.length, 2)
	assert.equal(searchOwners, 0, 'Only PlaylistsList should install the native search bar, not its parent too')
})

suite.finish()
