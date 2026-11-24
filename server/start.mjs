import { fileURLToPath } from 'node:url'
import { loadListenOptions } from './config.mjs'
import { createChatServer } from './server.mjs'

try {
  const configPath = fileURLToPath(new URL('../.config', import.meta.url))
  const { host, port } = await loadListenOptions(configPath)
  const server = await createChatServer({ configPath })
  server.once('error', () => {
    process.stderr.write('Unable to listen on port ' + port + '.\n')
    process.exitCode = 1
  })
  server.listen(port, host, () => {
    process.stdout.write('Chat server listening on port ' + server.address().port + '.\n')
  })
} catch (error) {
  process.stderr.write(error.message + '\n')
  process.exitCode = 1
}
