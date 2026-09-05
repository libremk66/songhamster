import { loadConfig } from './config.js'
import { getDb } from './store/db.js'
import * as repo from './store/repo.js'
import { LxServerAdapter } from './adapters/lxserver.js'
import { EmbyAdapter } from './adapters/emby.js'
import { SyncEngine } from './core/sync-engine.js'

const [, , cmd, ...args] = process.argv
const config = loadConfig()
getDb()
const lx = new LxServerAdapter(() => config)
const emby = new EmbyAdapter(() => config)

function arg(name: string): string | undefined {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}

async function main(): Promise<void> {
  switch (cmd) {
    case 'add': {
      const key = arg('key')
      const name = arg('name')
      if (!key) throw new Error('用法: cli add --key loveList --name "我喜欢的" [--emby "LX我喜欢的"] [--mode incremental|full] [--cron "0 6 * * *"]')
      const embyIds = arg('emby') ? [arg('emby')!] : []
      const id = repo.createTask({
        lxPlaylistKey: key,
        lxPlaylistName: name ?? key,
        embyTargetPlaylistIds: embyIds,
        createSameNamePlaylist: true,
        cronExpr: arg('cron') ?? null,
        syncMode: (arg('mode') as any) ?? 'incremental',
      })
      console.log(`任务已创建: id=${id} key=${key}`)
      break
    }
    case 'list': {
      for (const t of repo.listTasks()) {
        console.log(`#${t.id} | ${t.lxPlaylistName} (${t.lxPlaylistKey}) | ${t.syncMode} | cron=${t.cronExpr ?? '-'} | enabled=${t.enabled} | last=${t.lastResult ?? '-'}`)
      }
      break
    }
    case 'run': {
      const id = Number(arg('id'))
      const engine = new SyncEngine(() => config, lx, emby)
      const r = await engine.runTask(id, 'manual')
      console.log(`\n结果: ${r}`)
      break
    }
    case 'playlists': {
      const ps = await lx.listPlaylists()
      for (const p of ps) console.log(`key=${p.key} | ${p.name} | ${p.songCount} 首`)
      break
    }
    case 'lsongs': {
      const songs = await lx.getSongs(arg('key') ?? 'loveList')
      for (const s of songs) console.log(`${s.songKey} | ${s.name} | ${s.singer} | qualities=${s.qualities.join(',')}`)
      break
    }
    default:
      console.log('用法: cli <add|list|run|playlists|lsongs> [--key xxx] [--id N] [--name xxx] [--emby xxx] [--mode incremental|full]')
  }
}

main().catch((e) => {
  console.error('[cli]', e.message)
  process.exit(1)
})
