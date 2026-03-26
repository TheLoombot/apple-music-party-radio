/**
 * One-time script to generate an Apple Music Developer Token.
 * Run this from the project root:
 *
 *   node scripts/generate-token.mjs
 *
 * Then copy the output into VITE_APPLE_DEVELOPER_TOKEN in your .env file.
 * The token is valid for 180 days.
 */
import 'dotenv/config'
import jwt from 'jsonwebtoken'
import fs from 'fs'
import path from 'path'

const { APPLE_TEAM_ID, APPLE_KEY_ID, APPLE_PRIVATE_KEY_PATH } = process.env

if (!APPLE_TEAM_ID || !APPLE_KEY_ID || !APPLE_PRIVATE_KEY_PATH) {
  console.error('Missing required env vars. Copy .env.example to .env and fill in:')
  console.error('  APPLE_TEAM_ID, APPLE_KEY_ID, APPLE_PRIVATE_KEY_PATH')
  process.exit(1)
}

const keyPath = path.resolve(APPLE_PRIVATE_KEY_PATH)
if (!fs.existsSync(keyPath)) {
  console.error(`Private key not found at: ${keyPath}`)
  process.exit(1)
}

const privateKey = fs.readFileSync(keyPath, 'utf8')

const token = jwt.sign({}, privateKey, {
  algorithm: 'ES256',
  expiresIn: '180d',
  issuer: APPLE_TEAM_ID,
  header: { alg: 'ES256', kid: APPLE_KEY_ID }
})

console.log('\n✓ Developer Token generated (valid 180 days):\n')
console.log(token)
console.log('\nAdd this to your .env file as:\n')
console.log(`VITE_APPLE_DEVELOPER_TOKEN=${token}\n`)
