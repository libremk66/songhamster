import path from 'node:path'
import type { AppConfig } from '../config.js'

/** Emby 条目路径 → 本项目可操作路径；映射不了返回 null */
export function localizeEmbyPath(cfg: AppConfig, embyPath: string): string | null {
  if (!embyPath || !cfg.lxserver.downloadRoot) return null
  const dl = cfg.lxserver.downloadRoot.replace(/\/+$/, '')
  const lib = cfg.emby.libraryRoot?.replace(/\/+$/, '')
  if (!lib) return null
  let rest = ''
  if (embyPath.startsWith(lib + '/')) {
    rest = embyPath.slice(lib.length) // 媒体库文件夹内
  } else {
    // 不在媒体库文件夹下：尝试按共享根推导（libraryRoot 与 downloadRoot 同源的前提）
    return null
  }
  // rest 形如 /歌单同步/我喜欢的/x.flac 或 /我喜欢的/x.flac
  if (rest.startsWith('/歌单同步')) return dl + rest
  return dl + '/歌单同步' + rest
}

/**
 * `localizeEmbyPath` 的逆运算：本地路径 → **媒体服务器视角**的路径。
 * 用途：入库时用「按路径精确查」定位条目（Emby 支持 /Items?Path= ），
 * 比按歌名搜再过滤可靠得多——常见歌名（如「此刻」）能搜出 55 条同名/含此词的歌，
 * 目标可能排在几十位之后，按歌名搜的小 limit 根本取不到（实测踩到）。
 * 不在 downloadRoot 下 / 未配置库根 → null（调用方回退到按歌名搜）。
 */
export function toServerPath(cfg: AppConfig, localPath: string): string | null {
  if (!localPath || !cfg.lxserver.downloadRoot) return null
  const dl = cfg.lxserver.downloadRoot.replace(/\/+$/, '')
  const lib = cfg.emby.libraryRoot?.replace(/\/+$/, '')
  if (!lib) return null
  if (!localPath.startsWith(dl + '/')) return null
  let rest = localPath.slice(dl.length) // 形如 /歌单同步/我喜欢的/x.flac
  if (rest.startsWith('/歌单同步')) rest = rest.slice('/歌单同步'.length)
  return lib + rest
}

