import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { closeSync, mkdirSync, openSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const digest = value => createHash('sha256').update(value).digest('hex')
const text = (value, max = 200) => typeof value === 'string' && value.trim() && value.length <= max

/** Server-owned account and session index. DSH identifiers are never an authorization source. */
export class AccountStore {
  constructor(path = ':memory:') {
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      const handle = openSync(path, 'a', 0o600)
      closeSync(handle)
    }
    this.db = new DatabaseSync(path)
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, workspace_id TEXT UNIQUE, backend_ref TEXT,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1))
      );
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, display_name TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS identities (
        issuer TEXT NOT NULL, subject TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id),
        PRIMARY KEY(issuer,subject)
      );
      CREATE TABLE IF NOT EXISTS pending_identities (
        issuer TEXT NOT NULL, subject TEXT NOT NULL, display_name TEXT NOT NULL,
        first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL,
        PRIMARY KEY(issuer,subject)
      );
      CREATE TABLE IF NOT EXISTS memberships (
        account_id TEXT NOT NULL REFERENCES accounts(id), user_id TEXT NOT NULL REFERENCES users(id),
        role TEXT NOT NULL CHECK(role IN ('member','admin')), active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
        PRIMARY KEY(account_id,user_id)
      );
      CREATE TABLE IF NOT EXISTS browser_sessions (
        token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
        account_id TEXT NOT NULL REFERENCES accounts(id), csrf_hash TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS research_sessions (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id),
        request_id TEXT NOT NULL, dsh_session_id TEXT UNIQUE, title TEXT NOT NULL,
        created_at INTEGER NOT NULL, UNIQUE(account_id,request_id)
      );
      CREATE INDEX IF NOT EXISTS sessions_by_account ON research_sessions(account_id,created_at DESC);
      CREATE TABLE IF NOT EXISTS session_preferences (
        account_id TEXT NOT NULL REFERENCES accounts(id), session_id TEXT NOT NULL,
        title_override TEXT, pinned INTEGER NOT NULL DEFAULT 0 CHECK(pinned IN (0,1)),
        favorite INTEGER NOT NULL DEFAULT 0 CHECK(favorite IN (0,1)),
        archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
        PRIMARY KEY(account_id,session_id)
      );
      CREATE TABLE IF NOT EXISTS session_share_links (
        id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE,
        account_id TEXT NOT NULL REFERENCES accounts(id), session_id TEXT NOT NULL,
        creator_user_id TEXT NOT NULL REFERENCES users(id),
        permission TEXT NOT NULL CHECK(permission IN ('read','collaborate')),
        preview INTEGER NOT NULL DEFAULT 0 CHECK(preview IN (0,1)),
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS share_links_by_session ON session_share_links(account_id,session_id,created_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS one_account_per_backend ON accounts(backend_ref) WHERE backend_ref IS NOT NULL;
    `)
    if (!this.db.prepare('PRAGMA table_info(session_preferences)').all().some(column => column.name === 'archived'))
      this.db.exec('ALTER TABLE session_preferences ADD COLUMN archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1))')
  }

  close() { this.db.close() }

  provisionAccount({ id = randomUUID(), slug }) {
    if (!text(slug, 64) || !/^[a-z0-9][a-z0-9-]*$/.test(slug)) throw new Error('invalid account slug')
    this.db.prepare('INSERT INTO accounts(id,slug) VALUES (?,?)').run(id, slug)
    return id
  }

  provisionCustomerAccount({ id = randomUUID(), slug, workspaceId, backendRef }) {
    if (!text(slug, 64) || !/^[a-z0-9][a-z0-9-]*$/.test(slug)
      || !text(workspaceId, 256) || !text(backendRef, 64)
      || !/^[a-z0-9][a-z0-9-]*$/.test(backendRef) || backendRef === 'default') throw new Error('invalid customer account')
    this.db.prepare('INSERT INTO accounts(id,slug,workspace_id,backend_ref) VALUES (?,?,?,?)')
      .run(id, slug, workspaceId, backendRef)
    return id
  }

  bindWorkspace(accountId, workspaceId) {
    if (!text(workspaceId, 256)) throw new Error('invalid workspace')
    const result = this.db.prepare('UPDATE accounts SET workspace_id=? WHERE id=? AND (workspace_id IS NULL OR workspace_id=?)').run(workspaceId, accountId, workspaceId)
    if (result.changes !== 1) throw new Error('account workspace binding denied')
  }

  bindBackend(accountId, backendRef) {
    if (!text(backendRef, 64) || !/^[a-z0-9][a-z0-9-]*$/.test(backendRef) || backendRef === 'default') throw new Error('invalid backend reference')
    const result = this.db.prepare('UPDATE accounts SET backend_ref=? WHERE id=?').run(backendRef, accountId)
    if (result.changes !== 1) throw new Error('account unavailable')
  }

  /** Explicit provisioning only: a matching email or name never links an identity. */
  provisionMember({ accountId, issuer, subject, displayName, role = 'member', userId = randomUUID() }) {
    if (!text(issuer, 512) || !text(subject, 512) || !text(displayName) || !['member', 'admin'].includes(role)) throw new Error('invalid member')
    if (!this.db.prepare('SELECT 1 FROM accounts WHERE id=?').get(accountId)) throw new Error('account unavailable')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('INSERT INTO users(id,display_name) VALUES (?,?)').run(userId, displayName)
      this.db.prepare('INSERT INTO identities(issuer,subject,user_id) VALUES (?,?,?)').run(issuer, subject, userId)
      this.db.prepare('INSERT INTO memberships(account_id,user_id,role) VALUES (?,?,?)').run(accountId, userId, role)
      this.db.prepare('DELETE FROM pending_identities WHERE issuer=? AND subject=?').run(issuer, subject)
      this.db.exec('COMMIT')
      return userId
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  issueBrowserSession({ issuer, subject, accountId, ttlMs = 8 * 60 * 60 * 1000 }) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > 24 * 60 * 60 * 1000) throw new Error('invalid session lifetime')
    const principal = this.db.prepare(`SELECT u.id AS userId,u.display_name AS displayName,m.role,a.id AS accountId,a.slug
      FROM identities i JOIN users u ON u.id=i.user_id
      JOIN memberships m ON m.user_id=u.id JOIN accounts a ON a.id=m.account_id
      WHERE i.issuer=? AND i.subject=? AND a.id=? AND a.enabled=1 AND m.active=1`).get(issuer, subject, accountId)
    if (!principal) return undefined
    const token = randomBytes(32).toString('base64url')
    const csrf = randomBytes(32).toString('base64url')
    const expiresAt = Date.now() + ttlMs
    this.db.prepare('INSERT INTO browser_sessions(token_hash,user_id,account_id,csrf_hash,expires_at) VALUES (?,?,?,?,?)')
      .run(digest(token), principal.userId, accountId, digest(csrf), expiresAt)
    return { token, csrf, expiresAt, principal }
  }

  accountForIdentity(issuer, subject) {
    const rows = this.db.prepare(`SELECT a.id AS accountId,a.slug FROM identities i
      JOIN memberships m ON m.user_id=i.user_id JOIN accounts a ON a.id=m.account_id
      WHERE i.issuer=? AND i.subject=? AND m.active=1 AND a.enabled=1 ORDER BY a.id LIMIT 2`).all(issuer, subject)
    if (rows.length > 1) throw new Error('account selection required')
    return rows[0]
  }

  recordPendingIdentity({ issuer, subject, displayName }) {
    if (!text(issuer, 512) || !text(subject, 512) || !text(displayName)) throw new Error('invalid identity')
    const now = Date.now()
    this.db.prepare(`INSERT INTO pending_identities(issuer,subject,display_name,first_seen,last_seen) VALUES (?,?,?,?,?)
      ON CONFLICT(issuer,subject) DO UPDATE SET display_name=excluded.display_name,last_seen=excluded.last_seen`)
      .run(issuer, subject, displayName, now, now)
  }

  listPendingIdentities() {
    return this.db.prepare('SELECT issuer,subject,display_name AS displayName,first_seen AS firstSeen,last_seen AS lastSeen FROM pending_identities ORDER BY last_seen DESC LIMIT 100').all()
  }

  resolveBrowserSession(token) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined
    return this.db.prepare(`SELECT u.id AS userId,u.display_name AS displayName,m.role,a.id AS accountId,a.slug,a.workspace_id AS workspaceId,a.backend_ref AS backendRef
      FROM browser_sessions s JOIN users u ON u.id=s.user_id
      JOIN memberships m ON m.user_id=u.id AND m.account_id=s.account_id
      JOIN accounts a ON a.id=s.account_id
      WHERE s.token_hash=? AND s.expires_at>? AND a.enabled=1 AND m.active=1`).get(digest(token), Date.now())
  }

  verifyCsrf(token, csrf) {
    if (typeof csrf !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(csrf) || !this.resolveBrowserSession(token)) return false
    return !!this.db.prepare('SELECT 1 FROM browser_sessions WHERE token_hash=? AND csrf_hash=?').get(digest(token), digest(csrf))
  }

  revokeBrowserSession(token) {
    if (typeof token === 'string') this.db.prepare('DELETE FROM browser_sessions WHERE token_hash=?').run(digest(token))
  }

  createResearchSession({ principal, requestId, title = '新会话' }) {
    if (!principal?.accountId || !text(requestId, 128) || !text(title)) throw new Error('invalid session request')
    if (!this.resolveMember(principal)) throw new Error('membership revoked')
    const existing = this.db.prepare('SELECT * FROM research_sessions WHERE account_id=? AND request_id=?').get(principal.accountId, requestId)
    if (existing) return existing
    const id = randomUUID()
    this.db.prepare('INSERT INTO research_sessions(id,account_id,request_id,title,created_at) VALUES (?,?,?,?,?)')
      .run(id, principal.accountId, requestId, title, Date.now())
    return this.getResearchSession(principal, id)
  }

  setAutomaticSessionTitle(principal, id, title) {
    if (!this.resolveMember(principal) || !text(title, 100)) return false
    return this.db.prepare(`UPDATE research_sessions SET title=?
      WHERE id=? AND account_id=? AND title='新会话'
      AND NOT EXISTS (SELECT 1 FROM session_preferences
        WHERE account_id=? AND session_id=? AND title_override IS NOT NULL)`)
      .run(title, id, principal.accountId, principal.accountId, id).changes === 1
  }

  resolveMember(principal) {
    return this.db.prepare(`SELECT 1 FROM memberships m JOIN accounts a ON a.id=m.account_id
      WHERE m.user_id=? AND m.account_id=? AND m.active=1 AND a.enabled=1`).get(principal.userId, principal.accountId)
  }

  getResearchSession(principal, id) {
    if (!this.resolveMember(principal)) return undefined
    return this.db.prepare('SELECT * FROM research_sessions WHERE id=? AND account_id=?').get(id, principal.accountId)
  }

  listResearchSessions(principal) {
    if (!this.resolveMember(principal)) return []
    return this.db.prepare('SELECT id,title,created_at AS createdAt FROM research_sessions WHERE account_id=? AND dsh_session_id IS NOT NULL ORDER BY created_at DESC LIMIT 100')
      .all(principal.accountId)
  }

  sessionPreference(principal, id) {
    if (!this.resolveMember(principal)) return undefined
    return this.db.prepare('SELECT title_override AS titleOverride,pinned,favorite,archived FROM session_preferences WHERE account_id=? AND session_id=?')
      .get(principal.accountId, id)
  }

  updateSessionPreference(principal, id, changes) {
    if (!this.resolveMember(principal)) throw new Error('account unavailable')
    const previous = this.sessionPreference(principal, id) ?? { titleOverride: null, pinned: 0, favorite: 0, archived: 0 }
    const title = Object.hasOwn(changes, 'title') ? changes.title : previous.titleOverride
    const pinned = Object.hasOwn(changes, 'pinned') ? Number(changes.pinned) : previous.pinned
    const favorite = Object.hasOwn(changes, 'favorite') ? Number(changes.favorite) : previous.favorite
    const archived = Object.hasOwn(changes, 'archived') ? Number(changes.archived) : previous.archived
    this.db.prepare(`INSERT INTO session_preferences(account_id,session_id,title_override,pinned,favorite,archived) VALUES (?,?,?,?,?,?)
      ON CONFLICT(account_id,session_id) DO UPDATE SET title_override=excluded.title_override,
      pinned=excluded.pinned,favorite=excluded.favorite,archived=excluded.archived`).run(principal.accountId, id, title, pinned, favorite, archived)
    return { titleOverride: title, pinned: !!pinned, favorite: !!favorite, archived: !!archived }
  }

  createShareLink(principal, sessionId, { permission = 'read', days = 7, preview = false } = {}) {
    if (!this.resolveMember(principal) || typeof sessionId !== 'string' || !/^[0-9a-f-]{36}$/i.test(sessionId)
      || !['read', 'collaborate'].includes(permission) || !Number.isSafeInteger(days) || days < 1 || days > 365
      || (preview && permission !== 'read')) throw new Error('invalid share link')
    const id = randomUUID()
    const token = randomBytes(32).toString('base64url')
    const createdAt = Date.now()
    const expiresAt = createdAt + days * 24 * 60 * 60 * 1000
    this.db.prepare(`INSERT INTO session_share_links
      (id,token_hash,account_id,session_id,creator_user_id,permission,preview,created_at,expires_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(id, digest(token), principal.accountId, sessionId, principal.userId,
      permission, Number(preview), createdAt, expiresAt)
    return { id, token, sessionId, permission, preview, createdAt, expiresAt }
  }

  resolveShareLink(token) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined
    return this.db.prepare(`SELECT l.id AS shareId,l.account_id AS accountId,l.session_id AS sessionId,
      l.permission,l.preview,l.expires_at AS expiresAt,a.slug,a.workspace_id AS workspaceId,a.backend_ref AS backendRef
      FROM session_share_links l JOIN accounts a ON a.id=l.account_id
      JOIN memberships m ON m.account_id=l.account_id AND m.user_id=l.creator_user_id
      WHERE l.token_hash=? AND l.expires_at>? AND l.revoked_at IS NULL AND a.enabled=1 AND m.active=1`)
      .get(digest(token), Date.now())
  }

  listShareLinks(principal, sessionId) {
    if (!this.resolveMember(principal)) return []
    return this.db.prepare(`SELECT id,permission,preview,created_at AS createdAt,expires_at AS expiresAt,
      revoked_at AS revokedAt FROM session_share_links
      WHERE account_id=? AND session_id=? ORDER BY created_at DESC LIMIT 50`).all(principal.accountId, sessionId)
  }

  revokeShareLink(principal, id) {
    if (!this.resolveMember(principal) || typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) return false
    return this.db.prepare(`UPDATE session_share_links SET revoked_at=?
      WHERE id=? AND account_id=? AND revoked_at IS NULL`).run(Date.now(), id, principal.accountId).changes === 1
  }

  getSharedResearchSession(share, id) {
    if (!share || share.sessionId !== id) return undefined
    return this.db.prepare(`SELECT s.*,COALESCE(p.title_override,s.title) AS sharedTitle
      FROM research_sessions s LEFT JOIN session_preferences p ON p.account_id=s.account_id AND p.session_id=s.id
      WHERE s.id=? AND s.account_id=? AND s.dsh_session_id IS NOT NULL`).get(id, share.accountId)
  }

  bindDshSession(principal, id, dshSessionId) {
    if (!this.resolveMember(principal) || !text(dshSessionId, 256)) throw new Error('session binding denied')
    const changed = this.db.prepare(`UPDATE research_sessions SET dsh_session_id=?
      WHERE id=? AND account_id=? AND (dsh_session_id IS NULL OR dsh_session_id=?)`)
      .run(dshSessionId, id, principal.accountId, dshSessionId)
    if (changed.changes !== 1) throw new Error('session binding denied')
  }

  setMembershipActive(accountId, userId, active) {
    const result = this.db.prepare('UPDATE memberships SET active=? WHERE account_id=? AND user_id=?').run(active ? 1 : 0, accountId, userId)
    if (result.changes !== 1) throw new Error('membership unavailable')
  }
}
