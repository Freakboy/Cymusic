// Anonymous official endpoints only; print summaries, never lyric bodies.
import assert from 'node:assert/strict'

for (const [id, expected] of [['186016', 'available'], ['5308028', 'instrumental']]) {
	for (const endpoint of ['song/lyric/v1', 'song/lyric']) {
		const query = 'lv=-1&kv=-1&tv=-1&rv=-1&yv=-1'
		const url = `https://music.163.com/api/${endpoint}?id=${id}&${query}`
		const response = await fetch(url, { signal: AbortSignal.timeout(8000) })
		const data = await response.json()
		const lines = (data.lrc?.lyric || '').split('\n').filter((line) => line.trim() && !line.trim().startsWith('{')).length
		const yrcLines = (data.yrc?.lyric || '').split('\n').filter((line) => /^\[\d+,\d+\]\(\d+,\d+,\d+\)/.test(line.trim())).length
		const instrumental = data.nolyric === true || data.pureMusic === true
		console.log(JSON.stringify({ id, endpoint, http: response.status, code: data.code, lines, yrcLines, nolyric: data.nolyric, pureMusic: data.pureMusic, uncollected: data.uncollected }))
		assert.equal(data.code, 200)
		assert.ok(expected === 'instrumental' ? instrumental : lines > 0)
	}
}
