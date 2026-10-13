import { AccountStore } from '../account-store.mjs'

/** One JSON command on stdin, so identities do not appear in the process list. */
if (!process.env.ACCOUNT_DB_PATH?.startsWith('/')) throw new Error('ACCOUNT_DB_PATH must be configured')
process.umask(0o077)
const chunks = []
let size = 0
for await (const chunk of process.stdin) {
  size += chunk.length
  if (size > 8_000) throw new Error('provisioning request too large')
  chunks.push(chunk)
}
const command = JSON.parse(Buffer.concat(chunks).toString('utf8'))
const store = new AccountStore(process.env.ACCOUNT_DB_PATH)
try {
  if (command.action === 'create-account') {
    const accountId = store.provisionCustomerAccount(command)
    process.stdout.write(JSON.stringify({ accountId }) + '\n')
  } else if (command.action === 'add-member') {
    const userId = store.provisionMember(command)
    process.stdout.write(JSON.stringify({ userId }) + '\n')
  } else if (command.action === 'deactivate-member') {
    store.setMembershipActive(command.accountId, command.userId, false)
    process.stdout.write('{"ok":true}\n')
  } else if (command.action === 'list-pending') {
    process.stdout.write(JSON.stringify({ identities: store.listPendingIdentities() }) + '\n')
  } else {
    throw new Error('unknown provisioning action')
  }
} finally { store.close() }
