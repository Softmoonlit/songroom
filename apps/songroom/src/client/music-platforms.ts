export type MusicPlatformId = "netease" | "qq" | "qishui" | "kugou";

export type MusicPlatformInfo = {
  id: MusicPlatformId;
  name: string;
  description: string;
  status: "active" | "coming-soon";
  statusText: string;
};

export const MUSIC_PLATFORMS: readonly MusicPlatformInfo[] = [
  {
    id: "netease",
    name: "网易云音乐",
    description: "当前主播放源，支持房间公共歌单与逐首点歌",
    status: "active",
    statusText: "已支持"
  },
  {
    id: "qq",
    name: "QQ 音乐",
    description: "主流音乐流媒体平台支持",
    status: "coming-soon",
    statusText: "即将支持"
  },
  {
    id: "qishui",
    name: "汽水音乐",
    description: "个性化潮流音乐平台支持",
    status: "coming-soon",
    statusText: "即将支持"
  },
  {
    id: "kugou",
    name: "酷狗音乐",
    description: "海量伴奏曲库音乐平台支持",
    status: "coming-soon",
    statusText: "即将支持"
  }
] as const;

export const FUTURE_PLATFORMS = MUSIC_PLATFORMS.filter(p => p.status === "coming-soon");

export function getMusicPlatform(id: MusicPlatformId): MusicPlatformInfo {
  const platform = MUSIC_PLATFORMS.find(p => p.id === id);
  if (!platform) {
    throw new Error(`未知的音乐平台标识: ${id}`);
  }
  return platform;
}
