import { test } from 'node:test'
import assert from 'node:assert/strict'
import { splitArgs, resolveLaunch, RIMWORLD_APPID } from '../src/host/launch.js'

test('splitArgs honours quotes', () => {
  assert.deepEqual(splitArgs('"C:\\Games\\Rim World\\a.exe" -x "y z" \'q\''), ['C:\\Games\\Rim World\\a.exe', '-x', 'y z', 'q'])
  assert.deepEqual(splitArgs(''), [])
  assert.deepEqual(splitArgs('a ""'), ['a', ''])
})

test('resolveLaunch modes', async () => {
  const steam = await resolveLaunch({ mode: 'steam' })
  assert.ok(steam.args.join(' ').includes('steam://rungameid/' + RIMWORLD_APPID))
  const steamExe = await resolveLaunch({ mode: 'steam', steamPath: '/usr/bin/steam', args: '-logfile x' })
  assert.deepEqual([steamExe.cmd, ...steamExe.args], ['/usr/bin/steam', '-applaunch', RIMWORLD_APPID, '-logfile', 'x'])
  const custom = await resolveLaunch({ mode: 'custom', command: 'flatpak run com.valvesoftware.Steam', args: '-a' }, '/g')
  assert.deepEqual([custom.cmd, ...custom.args], ['flatpak', 'run', 'com.valvesoftware.Steam', '-a'])
  const direct = await resolveLaunch({ mode: 'direct', executable: '/opt/rw/RimWorldLinux', args: '-b' })
  assert.equal(direct.cmd, '/opt/rw/RimWorldLinux')
  await assert.rejects(resolveLaunch({ mode: 'custom', command: '' }))
  await assert.rejects(resolveLaunch({ mode: 'direct' }, '/nonexistent'))
})

test('resolveLaunch passes -quicktest in every mode', async () => {
  const s = await resolveLaunch({ mode: 'steam' }, null, { extraArgs: ['-quicktest'] })
  assert.ok(s.args.join(' ').includes(`steam://run/${RIMWORLD_APPID}//-quicktest/`))
  const se = await resolveLaunch({ mode: 'steam', steamPath: '/usr/bin/steam' }, null, { extraArgs: ['-quicktest'] })
  assert.deepEqual(se.args, ['-applaunch', RIMWORLD_APPID, '-quicktest'])
  const d = await resolveLaunch({ mode: 'direct', executable: '/opt/rw/RimWorldLinux', args: '-b' }, null, { extraArgs: ['-quicktest'] })
  assert.deepEqual(d.args, ['-b', '-quicktest'])
})
