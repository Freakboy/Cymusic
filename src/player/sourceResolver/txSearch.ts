import CryptoJS from 'crypto-js'

// LX mobile tx/utils/crypto.js zzcSign and tx/musicSearch.js desktop search envelope.
export function txSearchRequest(keyword: string) {
	const data = {
		comm: {
			ct: '19',
			cv: '2151',
			_channelid: '0',
			_os_version: '6.2.9200-2',
			patch: '118',
			uin: '0',
			tmeAppID: 'qqmusic',
			tmeLoginType: 0,
		},
		req_1: {
			module: 'music.search.SearchCgiService',
			method: 'DoSearchForQQMusicDesktop',
			param: {
				grp: 1,
				num_per_page: 20,
				page_num: 1,
				query: keyword,
				remoteplace: 'txt.newclient.top',
				search_type: 0,
				searchid:
					Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16))
						.join('')
						.toUpperCase() + String(Math.floor(Math.random() * 100000)).padStart(5, '0'),
			},
		},
	}
	const hash = CryptoJS.SHA1(JSON.stringify(data)).toString()
	const pick = (indexes: number[]) => indexes.map((index) => hash[index]).join('')
	const scramble = [
		89, 39, 179, 150, 218, 82, 58, 252, 177, 52, 186, 123, 120, 64, 242, 133, 143, 161, 121, 179,
	]
	const bytes = scramble
		.map((value, index) =>
			(value ^ parseInt(hash.slice(index * 2, index * 2 + 2), 16)).toString(16).padStart(2, '0'),
		)
		.join('')
	const base64 = CryptoJS.enc.Base64.stringify(CryptoJS.enc.Hex.parse(bytes)).replace(/[/+=]/g, '')
	const sign =
		`zzc${pick([23, 14, 6, 36, 16, 40, 7, 19])}${base64}${pick([16, 1, 32, 12, 19, 27, 8, 5])}`.toLowerCase()
	return {
		url: `https://u.y.qq.com/cgi-bin/musics.fcg?sign=${sign}`,
		method: 'POST',
		headers: { 'User-Agent': 'QQMusic 14090508(android 12)' },
		data,
	}
}
