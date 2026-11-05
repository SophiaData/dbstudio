/** 独立 Node 进程的存储策略；不导入 Electron 或 safeStorage。 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { constants, closeSync, fstatSync, mkdirSync, openSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { SecretCipher } from '../main/ConnectionStore'
import type { HttpServerStartupEnv } from '../main/server/http-server-config'

export function readStandaloneDataDir(env: HttpServerStartupEnv): string {
  const baseDir = env['DBSTUDIO_HTTP_DATA_DIR']?.trim()
  if (!baseDir || !isAbsolute(baseDir)) throw new Error('DBSTUDIO_HTTP_DATA_DIR 必须是显式的绝对路径')
  mkdirSync(baseDir, { recursive: true, mode: 0o700 })
  const info = statSync(baseDir)
  if (!info.isDirectory() || (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) {
    throw new Error('DBSTUDIO_HTTP_DATA_DIR 必须是仅当前用户可访问的目录（0700）')
  }
  return baseDir
}

function readKeyFile(path: string): string {
  let fd: number | undefined
  try {
    // 禁止跟随最后一级软链接，限制文件权限与大小；错误不附带路径、内容或 cause。
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    const info = fstatSync(fd)
    if (!info.isFile() || info.size > 128 || (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) throw new Error()
    return readFileSync(fd, 'utf8').trim()
  } catch {
    throw new Error('DBSTUDIO_HTTP_SECRET_KEY_FILE 必须是仅当前用户可读的 base64 key 文件（0600）')
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

export function createStandaloneSecretCipher(env: HttpServerStartupEnv): SecretCipher | null {
  const mode = env['DBSTUDIO_HTTP_SECRETS_MODE']?.trim()
  const keyEnv = env['DBSTUDIO_HTTP_SECRET_KEY_BASE64']
  const keyFile = env['DBSTUDIO_HTTP_SECRET_KEY_FILE']?.trim()
  if (mode === 'disabled') {
    if (keyEnv !== undefined || keyFile) throw new Error('disabled 凭据存储模式不能同时配置 key')
    return null
  }
  if (mode !== 'encrypted') throw new Error('必须显式配置 DBSTUDIO_HTTP_SECRETS_MODE=encrypted 或 disabled')
  if ((keyEnv !== undefined) === Boolean(keyFile)) {
    throw new Error('encrypted 模式必须且只能配置 SECRET_KEY_BASE64 或 SECRET_KEY_FILE')
  }
  const encoded = keyFile ? readKeyFile(keyFile) : keyEnv!
  if (!/^[A-Za-z0-9+/]{43}=$/.test(encoded)) throw new Error('HTTP secret key 必须是 32 字节的标准 base64')
  const key = Buffer.from(encoded, 'base64')
  if (key.length !== 32 || key.toString('base64') !== encoded) throw new Error('HTTP secret key 必须是 32 字节的标准 base64')
  // version(1) + nonce(12) + authTag(16) + ciphertext；key 始终只保留在进程内存。
  const aad = Buffer.from('dbstudio-http-secret-v1', 'utf8')
  return {
    encrypt(plain) {
      const nonce = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, nonce)
      cipher.setAAD(aad)
      const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
      return Buffer.concat([Buffer.from([1]), nonce, cipher.getAuthTag(), encrypted])
    },
    decrypt(payload) {
      try {
        if (payload.length < 29 || payload[0] !== 1) throw new Error()
        const decipher = createDecipheriv('aes-256-gcm', key, payload.subarray(1, 13))
        decipher.setAAD(aad)
        decipher.setAuthTag(payload.subarray(13, 29))
        return Buffer.concat([decipher.update(payload.subarray(29)), decipher.final()]).toString('utf8')
      } catch {
        throw new Error('HTTP 凭据解密失败')
      }
    }
  }
}
