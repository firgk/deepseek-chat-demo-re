import { createChatServer } from './server.mjs'

try {
  const port = Number(process.env.PORT || '3000')
  const server = await createChatServer()
  server.once('error', () => {
    process.stderr.write('Unable to listen on port ' + port + '.\n')
    process.exitCode = 1
  })
  server.listen(port, process.env.HOST || '127.0.0.1', () => {
    process.stdout.write('Chat server listening on port ' + server.address().port + '.\n')
  })
} catch (error) {
  process.stderr.write(error.message + '\n')
  process.exitCode = 1
}
