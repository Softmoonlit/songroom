export type MusicPlatformId = "netease" | "qq" | "qishui" | "kugou";

export type MusicPlatformInfo = {
  id: MusicPlatformId;
  name: string;
  description: string;
  status: "active" | "coming-soon";
  statusText: string;
};

export const MUSIC_PLATFORMS: MusicPlatformInfo[] = [
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
    description: "支持导入 QQ 音乐歌单与逐首公共点歌",
    status: "coming-soon",
    statusText: "即将支持"
  },
  {
    id: "qishui",
    name: "汽水音乐",
    description: "支持汽水音乐账号授权与收藏同步",
    status: "coming-soon",
    statusText: "即将支持"
  },
  {
    id: "kugou",
    name: "酷狗音乐",
    description: "支持酷狗音乐账号授权与歌单协作",
    status: "coming-soon",
    statusText: "即将支持"
  }
];

export const FUTURE_PLATFORMS = MUSIC_PLATFORMS.filter(p => p.status === "coming-soon");
