import { nowLanguage } from '@/utils/i18n'
const en = {
	heading: 'Song information', title: 'Title', artist: 'Artist', album: 'Album', id: 'Original platform ID',
	originalPlatform: 'Original platform', quality: 'Confirmed quality', format: 'Format (extension inference)',
	size: 'Local file size', script: 'Source script', sourcePlatform: 'Playback platform', location: 'Playback location',
	unknown: 'Unknown', local: 'Local file', cache: 'Local cache', remote: 'Remote audio', close: 'Done',
}
const zh: typeof en = {
	heading: '歌曲信息', title: '标题', artist: '歌手', album: '专辑', id: '原平台 ID',
	originalPlatform: '原平台', quality: '已确认音质', format: '格式（扩展名推测）',
	size: '本地文件大小', script: '实际音源脚本', sourcePlatform: '播放源平台', location: '播放位置',
	unknown: '未知', local: '本地文件', cache: '本地缓存', remote: '远程音频', close: '完成',
}
export const useSongInformationText = () => nowLanguage.useValue() === 'zh' ? zh : en
