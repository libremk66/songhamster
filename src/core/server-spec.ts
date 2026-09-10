/** 媒体服务器接入规格：字段/提示/探测能力——连接容器页与服务端共用一份，避免两处各写一套 */

export interface ServerFieldSpec {
  /** 表单字段名（与 config 段同名字段一一对应） */
  k: string
  label: string
  ph?: string
  /** 密码型（输入框打码） */
  password?: boolean
  /** 独占一行（如媒体库根路径） */
  wide?: boolean
  hint?: string
}

export interface ServerSpec {
  key: 'emby' | 'jellyfin' | 'navidrome' | 'daoliyu' | 'subsonic'
  label: string
  /** 压缩标签（选项卡上用） */
  short: string
  fields: ServerFieldSpec[]
  /** 媒体库探测接口；null = 该协议无媒体库概念（如 Subsonic） */
  probePath: string | null
  /** 该类型是否用 API key（否则用户名+密码） */
  apiKeyAuth: boolean
}

const ROOT_FIELD: ServerFieldSpec = {
  k: 'libraryRoot',
  label: '媒体库根路径',
  wide: true,
  hint: '媒体服务器视角的路径（用于匹配媒体库 + 把宿主机路径换算过去）',
}

export const SERVER_SPECS: ServerSpec[] = [
  {
    key: 'emby',
    label: 'Emby',
    short: 'Emby',
    apiKeyAuth: true,
    probePath: '/api/emby/probe',
    fields: [
      { k: 'baseUrl', label: '服务器地址', ph: 'http://127.0.0.1:8096' },
      { k: 'apiKey', label: 'API key', password: true, hint: 'Emby 后台 → 设置 → API 密钥' },
      { ...ROOT_FIELD, ph: '如 /D8/MOVIEPILOT/MUSIC/.../LXSERVER/king' },
    ],
  },
  {
    key: 'jellyfin',
    label: 'Jellyfin',
    short: 'Jellyfin',
    apiKeyAuth: true,
    probePath: '/api/jellyfin/probe',
    fields: [
      { k: 'baseUrl', label: '服务器地址', ph: 'http://127.0.0.1:8096' },
      { k: 'apiKey', label: 'API key', password: true },
      { ...ROOT_FIELD, ph: 'Jellyfin 容器/服务视角的路径' },
    ],
  },
  {
    key: 'navidrome',
    label: 'Navidrome',
    short: 'Navidrome',
    apiKeyAuth: false,
    probePath: '/api/navidrome/probe',
    fields: [
      { k: 'baseUrl', label: '服务器地址', ph: 'http://127.0.0.1:4533' },
      { k: 'username', label: '用户名' },
      { k: 'password', label: '密码', password: true },
      { ...ROOT_FIELD, ph: 'Navidrome 音乐文件夹视角的路径' },
    ],
  },
  {
    key: 'daoliyu',
    label: '道理鱼',
    short: '道理鱼',
    apiKeyAuth: false,
    probePath: '/api/daoliyu/probe',
    fields: [
      { k: 'baseUrl', label: '服务器地址', ph: 'http://127.0.0.1:8080' },
      { k: 'username', label: '管理员邮箱' },
      { k: 'password', label: '密码', password: true },
      { ...ROOT_FIELD, ph: '与下载目录同源（目录驱动，落盘即入库）' },
    ],
  },
  {
    key: 'subsonic',
    label: 'Subsonic（飞牛/音云等）',
    short: 'Subsonic',
    apiKeyAuth: false,
    probePath: null,
    fields: [
      { k: 'baseUrl', label: '服务器地址', ph: 'http://127.0.0.1:4533（根地址，无需 /rest）' },
      { k: 'username', label: '用户名' },
      { k: 'password', label: '密码', password: true },
    ],
  },
]

export function specOf(type: string): ServerSpec | undefined {
  return SERVER_SPECS.find((s) => s.key === type)
}
